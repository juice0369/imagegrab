/**
 * 结果页逻辑：读会话 → 渲染网格 → 选择交互 → 通过长连接驱动批量下载 → 回显进度与失败原因。
 *
 * 数据来源是 chrome.storage.session（不是 content script、也不是内存），所以刷新页面不丢数据。
 */

import {
  PORT_NAME,
  PORT_CMD,
  PORT_PUSH,
  ITEM_STATUS,
  JOB_STATUS,
  FILTER_REASONS,
  SIZE_FILTERS,
  describeError
} from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { isContextInvalidated, isExtensionAlive } from '../shared/messaging.js';
import { buildFilename } from '../shared/url-utils.js';
import { sessionStore } from '../background/session-store.js';
import { createGrid } from './grid.js';

const log = createLogger('results');

/** 扩展被重新加载后，本页的旧代码再也连不上后台；唯一出路是刷新本页。 */
const CONTEXT_DEAD_TEXT = describeError('CONTEXT_INVALIDATED');

/**
 * 所有展示给用户的失败文案都必须走这里。
 *
 * chrome API 在上下文失效时抛的是英文原文（`Extension context invalidated.`），
 * 直接往界面上贴等于什么都没说；换成 ERROR_CODES 里的中文提示，并明确指出要刷新本页。
 */
function describeFailure(err) {
  if (isContextInvalidated(err)) return CONTEXT_DEAD_TEXT;
  return err?.message || String(err || describeError(''));
}

const els = {};
const state = {
  sid: null,
  session: null,
  job: null,
  selected: new Set(),
  itemStatus: {},
  filters: { size: 'all', status: 'all', scope: 'all' },
  visible: [],
  thumbFailed: new Set(),
  port: null,
  requestSeq: 0,
  pendingRequests: new Map(),
  reconnectAttempts: 0,
  reconnectTimer: null,
  lastSummary: null
};

const grid = createGrid({
  container: null, // cacheElements 之后再设置
  onAction: (action, ...args) => handleGridAction(action, ...args)
});

/* ────────────────────────── 启动 ────────────────────────── */

async function main() {
  cacheElements();
  grid.setContainer?.(els.grid);

  // 扩展被重载过：storage.session 里的旧会话也已清空，直接用「请刷新本页」的界面代替一串英文报错
  if (!isExtensionAlive()) {
    showEmpty('reloaded');
    return;
  }

  const params = new URLSearchParams(location.search);
  state.sid = params.get('sid');
  if (!state.sid) {
    const latest = await sessionStore.latest();
    state.sid = latest?.sid || null;
    log.info(`URL 未带 sid，使用最近一次会话：${state.sid || '（无）'}`);
  }

  wireUi();

  if (!state.sid) {
    showEmpty('none');
    return;
  }

  await loadSession();
  if (!state.session) {
    showEmpty('gone');
    return;
  }

  state.selected = new Set(defaultSelection());
  render();
  connect();
}

function cacheElements() {
  const ids = [
    'session-summary',
    'banner',
    'notice',
    'toolbar',
    'runbar',
    'job-status',
    'progress-wrap',
    'progress-bar',
    'btn-source',
    'btn-reload',
    'btn-refresh',
    'btn-select-all',
    'btn-invert',
    'btn-select-none',
    'btn-select-failed',
    'filter-size',
    'filter-status',
    'filter-scope',
    'visible-count',
    'btn-download',
    'btn-resume',
    'btn-cancel',
    'grid',
    'empty',
    'footer-hint'
  ];
  for (const id of ids) els[id] = document.getElementById(id);
  grid.setContainer?.(els.grid);
}

async function loadSession() {
  state.session = await sessionStore.get(state.sid);
  if (!state.session) return;
  const job = latestJobOf(state.session);
  state.job = job;
  state.itemStatus = { ...(job?.itemStatus || {}) };
}

function latestJobOf(session) {
  const jobs = Object.values(session?.jobs || {});
  if (!jobs.length) return null;
  return jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
}

/** 默认勾选：没成功过、也没原格式降级过的图片；被过滤的条目要用户自己勾，避免误把图标也下载下来。 */
function defaultSelection() {
  return (state.session?.images || [])
    .filter((item) => {
      if (item.filterReason) return false;
      const status = state.itemStatus[item.id]?.status;
      return status !== ITEM_STATUS.DONE && status !== ITEM_STATUS.FALLBACK;
    })
    .map((item) => item.id);
}

/** 只计「可下载」的条目：被过滤的卡片不参与进度与「继续下载」的统计。 */
function downloadableImages() {
  return (state.session?.images || []).filter((item) => !item.filterReason);
}

function filteredImages() {
  return (state.session?.images || []).filter((item) => Boolean(item.filterReason));
}

/** 可下载条目里的第几张（1 起）：用于「与第 N 张重复」这类说明。 */
function keptOrdinalOf(itemId) {
  if (!itemId) return 0;
  const index = downloadableImages().findIndex((item) => item.id === itemId);
  return index >= 0 ? index + 1 : 0;
}

/* ───────────────────── 长连接（results ↔ SW） ───────────────────── */

function connect() {
  if (!isExtensionAlive()) {
    setNotice('error', CONTEXT_DEAD_TEXT);
    return;
  }
  let port;
  try {
    port = chrome.runtime.connect({ name: PORT_NAME });
  } catch (err) {
    scheduleReconnect(err);
    return;
  }
  state.port = port;
  state.reconnectAttempts = 0;

  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    state.port = null;
    // 断开的两种成因要分清：扩展被重载（只能刷新）与 SW 被回收（可以重连）
    const dead = !isExtensionAlive();
    const reason = dead ? CONTEXT_DEAD_TEXT : '与后台的连接已断开';
    for (const entry of state.pendingRequests.values()) entry.reject(new Error(reason));
    state.pendingRequests.clear();
    if (dead) {
      setNotice('error', CONTEXT_DEAD_TEXT);
      return;
    }
    scheduleReconnect();
  });

  port.postMessage({ cmd: PORT_CMD.INIT, sid: state.sid });
}

function scheduleReconnect(cause) {
  if (!isExtensionAlive()) {
    setNotice('error', CONTEXT_DEAD_TEXT);
    return;
  }
  if (state.reconnectTimer) return;
  if (state.reconnectAttempts >= 5) {
    setNotice('error', '与后台的连接已断开（Service Worker 可能被回收）。请刷新本页（F5）后重试。');
    return;
  }
  state.reconnectAttempts += 1;
  setStatusline(`正在重连后台（第 ${state.reconnectAttempts} 次）…`);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect();
  }, 1200);
  if (cause) log.warn('连接断开', cause);
}

function onPortMessage(message) {
  if (!message || typeof message.type !== 'string') return;
  switch (message.type) {
    case PORT_PUSH.ACK: {
      const entry = state.pendingRequests.get(message.reqId);
      if (!entry) return;
      state.pendingRequests.delete(message.reqId);
      if (message.ok) {
        entry.resolve(message.data || {});
      } else {
        const error = new Error(message.error?.message || '操作失败');
        error.code = message.error?.code;
        entry.reject(error);
      }
      return;
    }

    case PORT_PUSH.STATE: {
      applyState(message.state);
      return;
    }

    case PORT_PUSH.ITEM_PROGRESS: {
      state.itemStatus[message.itemId] = {
        status: message.status,
        error: message.error || null,
        message: message.message || '',
        filename: message.filename || '',
        via: message.via || '',
        width: message.width || 0,
        height: message.height || 0
      };
      grid.update(message.itemId);
      updateCounts();
      updateRunbar();
      return;
    }

    case PORT_PUSH.JOB_UPDATE: {
      state.job = message.job;
      mergeItemStatus(message.job?.itemStatus);
      updateCounts();
      updateRunbar();
      renderSummary();
      return;
    }

    case PORT_PUSH.BATCH_DONE: {
      if (message.job) {
        state.job = message.job;
        mergeItemStatus(message.job.itemStatus);
      }
      state.lastSummary = message.summary || null;
      grid.refreshAll();
      updateCounts();
      updateRunbar();
      renderSummary();
      renderNoticeForSummary(message.summary);
      return;
    }

    case PORT_PUSH.SOURCE_STATE: {
      if (state.session) state.session.sourceAlive = message.sourceAlive;
      renderBanner();
      return;
    }

    case PORT_PUSH.SESSION_GONE: {
      showEmpty('gone');
      return;
    }

    case PORT_PUSH.ERROR: {
      setNotice('warn', `后台提示：${message.error?.message || '未知问题'}`);
      return;
    }

    default:
      log.debug('未处理的推送', message.type);
  }
}

function mergeItemStatus(itemStatus) {
  if (!itemStatus) return;
  for (const [itemId, info] of Object.entries(itemStatus)) {
    state.itemStatus[itemId] = { ...(state.itemStatus[itemId] || {}), ...info };
  }
}

function applyState(payload) {
  if (!payload?.session) {
    showEmpty('gone');
    return;
  }
  state.session = payload.session;
  state.job = payload.job || null;
  if (payload.job?.itemStatus) mergeItemStatus(payload.job.itemStatus);
  render();
}

/** 走长连接的请求/应答封装。 */
function request(cmd, payload = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const port = state.port;
    if (!port) {
      reject(new Error('与后台的连接尚未建立，请稍后重试'));
      return;
    }
    const reqId = ++state.requestSeq;
    const timer = setTimeout(() => {
      if (state.pendingRequests.delete(reqId)) reject(new Error('后台没有及时响应'));
    }, timeoutMs);
    state.pendingRequests.set(reqId, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });
    port.postMessage({ cmd, reqId, ...payload });
  });
}

/* ────────────────────────── 渲染 ────────────────────────── */

function render() {
  if (!state.session) return;
  els['empty'].hidden = true;
  els.toolbar.hidden = false;
  els.runbar.hidden = false;

  renderSummary();
  renderBanner();
  renderGrid();
  updateCounts();
  updateRunbar();
}

function renderSummary() {
  const session = state.session;
  const images = session.images || [];
  const kept = downloadableImages().length;
  const filtered = images.length - kept;
  const created = session.createdAt ? new Date(session.createdAt).toLocaleString() : '';
  // 编号在同一个会话里连续递增，所以这里显示的是「下一张会叫什么」，
  // 而不是固定的 001 —— 第二批下载不会又变成 001 (1)。
  const nextSequence = nextFileNameSequence();
  els['session-summary'].textContent =
    `${session.platformName || '未知站点'} · 共 ${images.length} 张图片` +
    `（可下载 ${kept} 张${filtered ? `，被过滤 ${filtered} 张` : ''}）` +
    `${session.pageTitle ? ` · ${truncate(session.pageTitle, 40)}` : ''}${created ? ` · ${created}` : ''}` +
    ` · 下一个文件名 ${buildFilename(nextSequence, 'png', session.settings || {})}`;
  els['footer-hint'].textContent = session.pageUrl ? `源页面：${session.pageUrl}` : '';
  els['btn-source'].hidden = !session.sourceTabId;
}

/** 下一个会用的文件名编号：优先用内存里任务的最新游标，其次用会话里持久化的。 */
function nextFileNameSequence() {
  const fromJob = Number(state.job?.nextSequence);
  if (Number.isFinite(fromJob) && fromJob >= 1) return Math.round(fromJob);
  const fromSession = Number(state.session?.downloadSequence);
  if (Number.isFinite(fromSession) && fromSession >= 1) return Math.round(fromSession);
  return 1;
}

function renderBanner() {
  const session = state.session;
  const stats = session.filterStats;
  const listed = filteredImages().length;
  const lines = [];

  if (session.sourceAlive === false) {
    lines.push('源页面已关闭：图片地址已经保存下来，不影响继续转换与下载。');
  }

  if (stats) {
    lines.push(
      `扫描到 ${stats.scanned} 个图片地址，保留 ${stats.kept} 张` +
        (stats.dropped ? `，过滤掉 ${stats.dropped} 张。` : '。')
    );
  }

  if (listed) {
    lines.push(
      `被过滤的 ${listed} 张也列在下面（灰色卡片，默认不勾选，卡片上标明了过滤原因），误判的可以手动勾选下载。` +
        (stats && stats.filteredTruncated ? `另有 ${stats.filteredTruncated} 张超出单次列出上限，没有列出来。` : '')
    );
  }

  const failed = state.thumbFailed.size;
  if (failed) {
    lines.push(`${failed} 张图片在这个页面里无法预览（可能已失效、需要登录或有防盗链），下载时也可能失败。`);
  }

  if (!lines.length && !(stats && stats.dropped)) {
    els.banner.hidden = true;
    return;
  }

  els.banner.hidden = false;
  els.banner.textContent = '';

  const title = document.createElement('p');
  title.className = 'banner-title';
  title.textContent = '提取情况';
  els.banner.appendChild(title);

  const list = document.createElement('ul');
  list.className = 'banner-lines';
  for (const line of lines) {
    const li = document.createElement('li');
    li.textContent = line;
    list.appendChild(li);
  }
  els.banner.appendChild(list);

  if (stats && stats.dropped) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '为什么图片比我预期的少？';
    details.appendChild(summary);
    const reasons = document.createElement('ul');
    reasons.className = 'reason-list';
    // 每类原因顺带说明「有没有列出来」，避免用户数不到卡片时以为是丢了数据
    const listedByReason = new Map();
    for (const item of filteredImages()) {
      listedByReason.set(item.filterReason, (listedByReason.get(item.filterReason) || 0) + 1);
    }
    for (const [key, value] of Object.entries(stats.reasons || {})) {
      if (!value) continue;
      const li = document.createElement('li');
      const shown = listedByReason.get(key) || 0;
      li.textContent = `${FILTER_REASONS[key] || key}：${value} 张${
        shown ? `（其中 ${shown} 张已列在下面）` : '（地址无法显示，没有列出）'
      }`;
      reasons.appendChild(li);
    }
    if (stats.truncated) {
      const li = document.createElement('li');
      li.textContent = `超过单次提取上限，未保留：${stats.truncated} 张`;
      reasons.appendChild(li);
    }
    if (stats.filteredTruncated) {
      const li = document.createElement('li');
      li.textContent = `被过滤的条目超出单次列出上限，未列出：${stats.filteredTruncated} 张`;
      reasons.appendChild(li);
    }
    if (!reasons.childElementCount) {
      const li = document.createElement('li');
      li.textContent = '没有条目被过滤。';
      reasons.appendChild(li);
    }
    details.appendChild(reasons);
    els.banner.appendChild(details);
  }
}

function computeVisible() {
  const images = state.session?.images || [];
  const sizeFilter = SIZE_FILTERS.find((entry) => entry.id === state.filters.size) || SIZE_FILTERS[0];
  const statusFilter = state.filters.status;
  const scope = state.filters.scope;

  return images.filter((item) => {
    // 范围：默认「全部」，也就是可下载的与被过滤的都在同一页里，用户随时能核对
    if (scope === 'kept' && item.filterReason) return false;
    if (scope === 'filtered' && !item.filterReason) return false;
    if (sizeFilter.min > 0) {
      const width = item.naturalWidth || item.domWidth || 0;
      const height = item.naturalHeight || item.domHeight || 0;
      const longEdge = Math.max(width, height);
      // 尺寸未知的条目始终显示，避免看起来像丢了数据
      if (longEdge > 0 && longEdge < sizeFilter.min) return false;
    }
    if (statusFilter === 'all') return true;
    const status = state.itemStatus[item.id]?.status || ITEM_STATUS.PENDING;
    if (statusFilter === 'failed') return status === ITEM_STATUS.FAILED;
    if (statusFilter === 'done') return status === ITEM_STATUS.DONE || status === ITEM_STATUS.FALLBACK;
    if (statusFilter === 'none') return status !== ITEM_STATUS.DONE && status !== ITEM_STATUS.FALLBACK && status !== ITEM_STATUS.FAILED;
    return true;
  });
}

function renderGrid() {
  state.visible = computeVisible();
  grid.render(state.visible).catch((err) => log.error('渲染网格失败', err));
}

function handleGridAction(action, ...args) {
  switch (action) {
    case 'status':
      return state.itemStatus[args[0]] || { status: ITEM_STATUS.PENDING };
    case 'selected':
      return state.selected.has(args[0]);
    case 'toggle': {
      const [itemId, selected] = args;
      if (selected) state.selected.add(itemId);
      else state.selected.delete(itemId);
      grid.refreshSelection(itemId);
      updateCounts();
      return undefined;
    }
    case 'download-one':
      startDownload([args[0]]);
      return undefined;
    case 'thumb-error':
      if (!state.thumbFailed.has(args[0])) {
        state.thumbFailed.add(args[0]);
        renderBanner();
      }
      return undefined;
    case 'filter-note': {
      const item = (state.session?.images || []).find((candidate) => candidate.id === args[0]);
      if (!item?.filterReason) return '';
      const base = `已过滤：${FILTER_REASONS[item.filterReason] || item.filterReason}`;
      const ordinal = item.filterReason === 'duplicate' ? keptOrdinalOf(item.duplicateOf) : 0;
      return ordinal ? `${base}（与第 ${ordinal} 张相同）` : base;
    }
    case 'resize':
      return undefined;
    default:
      return undefined;
  }
}

function updateCounts() {
  const imageIds = new Set((state.session?.images || []).map((item) => item.id));
  for (const id of [...state.selected]) {
    if (!imageIds.has(id)) state.selected.delete(id);
  }
  const kept = downloadableImages();
  const selectedKept = kept.filter((item) => state.selected.has(item.id)).length;
  const extra = state.selected.size - selectedKept;
  els['visible-count'].textContent = `显示 ${state.visible.length} / ${imageIds.size}（可下载 ${kept.length}）`;
  const button = els['btn-download'];
  button.textContent = `下载选中（${state.selected.size}）${extra ? `，含 ${extra} 张被过滤的` : ''}`;
  button.disabled = state.selected.size === 0 || Boolean(runningJob());
}

function runningJob() {
  return state.job && state.job.status === JOB_STATUS.RUNNING ? state.job : null;
}

/**
 * 「还没处理完」的条目数：既没成功、也不是原格式降级过的。
 *
 * 这个口径必须和后台 RESUME 用的 `pendingItemIds()`（service-worker.js）一致，
 * 否则按钮会时有时无：后台愿意重跑的是「未完成 + 已取消 + 失败」，
 * 界面却只看 pending —— 点过一次「取消任务」之后，剩下的条目全都变成 cancelled，
 * pending 归零，按钮就此消失，用户再也没法继续下载。
 */
function unfinishedCount(counts = countStatuses()) {
  return counts.pending + counts.cancelled + counts.failed;
}

function countStatuses() {
  // 只统计「可下载」的条目：被过滤的卡片默认不参与下载，混进来会让进度与「继续下载」的数字失真
  const kept = downloadableImages();
  const counts = {
    total: kept.length,
    filtered: filteredImages().length,
    done: 0,
    fallback: 0,
    failed: 0,
    cancelled: 0,
    pending: 0
  };
  for (const item of kept) {
    const status = state.itemStatus[item.id]?.status || ITEM_STATUS.PENDING;
    if (status === ITEM_STATUS.DONE) counts.done += 1;
    else if (status === ITEM_STATUS.FALLBACK) counts.fallback += 1;
    else if (status === ITEM_STATUS.FAILED) counts.failed += 1;
    else if (status === ITEM_STATUS.CANCELLED) counts.cancelled += 1;
    else counts.pending += 1;
  }
  return counts;
}

function updateRunbar() {
  const job = runningJob();
  const counts = countStatuses();
  const processed = counts.done + counts.fallback + counts.failed + counts.cancelled;
  const unfinished = unfinishedCount(counts);
  /**
   * 没跑过任何一批任务时不给「继续下载」。
   *
   * 那时它和「下载选中」是同一件事（默认勾选就等于全部未下载的条目），
   * 两个按钮都亮着反而让人以为之前有什么任务被中断了。
   */
  const canResume = !job && Boolean(state.job) && unfinished > 0;

  els['btn-cancel'].hidden = !job;
  els['btn-resume'].hidden = !canResume;

  if (job) {
    els['progress-wrap'].hidden = false;
    const ratio = job.stats?.total ? job.stats.processed / job.stats.total : 0;
    els['progress-bar'].style.width = `${Math.round(ratio * 100)}%`;
    setStatusline(
      `正在下载：已处理 ${job.stats?.processed || 0}/${job.stats?.total || counts.total} · ` +
        `成功 ${job.stats?.succeeded || 0} · 原格式 ${job.stats?.fallback || 0} · 失败 ${job.stats?.failed || 0}`
    );
    return;
  }

  if (state.job && state.job.status === JOB_STATUS.INTERRUPTED) {
    els['progress-wrap'].hidden = true;
    setStatusline(`上次任务被中断（Service Worker 被回收或浏览器关闭）。还有 ${unfinished} 张没处理，可以点「继续下载」。`);
    return;
  }

  if (state.job && state.job.status === JOB_STATUS.CANCELLED) {
    els['progress-wrap'].hidden = true;
    setStatusline(
      `任务已取消（已完成 ${counts.done} · 原格式 ${counts.fallback} · 失败 ${counts.failed} · 已取消 ${counts.cancelled}）。` +
        (unfinished ? `还有 ${unfinished} 张没处理，可以点「继续下载」。` : '')
    );
    return;
  }

  els['progress-wrap'].hidden = true;
  if (processed === 0) {
    if (counts.total) {
      setStatusline(
        `尚未开始下载。勾选后点「下载选中」${
          counts.filtered ? `（另有 ${counts.filtered} 张被过滤的，需要在卡片上手动勾选）` : ''
        }。`
      );
    } else if (counts.filtered) {
      setStatusline(`没有一张通过过滤规则；被过滤的 ${counts.filtered} 张列在下面，认为判断错了可以手动勾选下载。`);
    } else {
      setStatusline('没有可下载的图片。');
    }
    return;
  }
  setStatusline(
    `已完成 ${counts.done} · 原格式 ${counts.fallback} · 失败 ${counts.failed}` +
      `${counts.cancelled ? ` · 已取消 ${counts.cancelled}` : ''}${counts.pending ? ` · 待处理 ${counts.pending}` : ''}` +
      `${canResume ? '（点「继续下载」会重跑这些没完成的条目）' : ''}`
  );
}

function setStatusline(text) {
  els['job-status'].textContent = text;
}

function setNotice(tone, text) {
  els.notice.hidden = false;
  els.notice.dataset.tone = tone;
  els.notice.textContent = text;
}

function clearNotice() {
  els.notice.hidden = true;
  els.notice.textContent = '';
}

/** 批量结束后的反馈：把失败原因按类型归并，明确告诉用户为什么失败。 */
function renderNoticeForSummary(summary) {
  if (!summary) return;
  const counts = countStatuses();
  const groups = new Map();
  for (const [itemId, info] of Object.entries(state.itemStatus)) {
    if (info.status !== ITEM_STATUS.FAILED) continue;
    const code = info.error || 'DOWNLOAD_FAILED';
    if (!groups.has(code)) groups.set(code, { count: 0, message: info.message || describeError(code), files: [] });
    const group = groups.get(code);
    // 只在同一状态下用当前条目名举例
    const item = (state.session?.images || []).find((candidate) => candidate.id === itemId);
    group.count += 1;
    if (info.filename) group.files.push(info.filename);
    else if (item && group.files.length < 3) group.files.push(item.url.split('/').slice(-1)[0]);
  }

  const parts = [];
  parts.push(`批量下载结束：成功 ${counts.done} 张`);
  if (counts.fallback) parts.push(`原格式 ${counts.fallback} 张（转换受限，已按原格式下载，不算失败）`);
  parts.push(`失败 ${counts.failed} 张`);
  if (counts.cancelled) parts.push(`取消 ${counts.cancelled} 张`);

  let text = `${parts.join('，')}。`;
  if (groups.size) {
    const detail = [...groups.values()]
      .map((group) => `${group.count} 张：${truncate(group.message, 80)}${group.files.length ? `（例如 ${group.files.slice(0, 2).join('、')}）` : ''}`)
      .join('；');
    text += ` 失败原因：${detail}`;
  }
  // 有没跑完的条目就顺手说清楚「继续下载」在哪：取消任务之后最容易卡在这里
  const unfinished = unfinishedCount(counts);
  if (state.job && unfinished) text += ` 还有 ${unfinished} 张没完成，点「继续下载」可以重跑。`;

  setNotice(groups.size ? 'warn' : 'ok', text);
  log.info('批量任务结束', summary);
}

function showEmpty(kind) {
  els.toolbar.hidden = true;
  els.runbar.hidden = true;
  els.banner.hidden = true;
  els.grid.textContent = '';
  els.empty.hidden = false;
  els.empty.textContent = '';

  const title = document.createElement('h2');
  const paragraph = document.createElement('p');

  if (kind === 'gone') {
    els['session-summary'].textContent = '提取结果已失效';
    title.textContent = '这批提取结果已经失效';
    paragraph.append(
      document.createTextNode('可能原因：浏览器重启、扩展重新加载、会话超过 2 小时，或结果页被关闭后数据已回收。请回到商品详情页，点击右下角的 ')
    );
    const code = document.createElement('code');
    code.textContent = '获取图片';
    paragraph.append(code, document.createTextNode(' 重新提取。'));
  } else if (kind === 'reloaded') {
    els['session-summary'].textContent = '扩展已重新加载';
    title.textContent = '扩展已重新加载，本页已和扩展断开';
    paragraph.append(
      document.createTextNode(
        '本页是在旧版本的扩展下打开的，已经没有权限读写扩展数据（浏览器把这种状态报成「扩展上下文已失效」）。扩展重载后这批会话数据也已清空，点右上角「刷新页面」重新加载本页；如果提示结果已失效，回到商品详情页重新点一次「获取图片」即可。'
      )
    );
  } else {
    els['session-summary'].textContent = '还没有提取记录';
    title.textContent = '还没有提取记录';
    paragraph.append(document.createTextNode('打开商品详情页（或本地测试页 '));
    const code = document.createElement('code');
    code.textContent = 'http://localhost:8000/test/test-page.html';
    paragraph.append(code, document.createTextNode('），点击页面右下角的「获取图片」按钮即可开始。'));
  }

  els.empty.append(title, paragraph);
  setStatusline('等待新的提取任务。');
}

/* ────────────────────────── 交互 ────────────────────────── */

/**
 * 「全选 / 反选」作用的对象。
 *
 * 默认只在「可下载」的条目里挑：被过滤的（图标、占位图、过小的图…）只列出来供核对，
 * 要用户手动勾选，避免点一下「全选」就把上百个图标一起下载下来。
 * 当「范围」切到「只看被过滤」时，列表里本来就只有被过滤的条目，这两个按钮自然作用在它们身上。
 */
function bulkTargets() {
  if (state.filters.scope === 'filtered') return state.visible;
  return state.visible.filter((item) => !item.filterReason);
}

function wireUi() {
  els['btn-select-all'].addEventListener('click', () => {
    for (const item of bulkTargets()) state.selected.add(item.id);
    applySelection();
  });

  els['btn-invert'].addEventListener('click', () => {
    for (const item of bulkTargets()) {
      if (state.selected.has(item.id)) state.selected.delete(item.id);
      else state.selected.add(item.id);
    }
    applySelection();
  });

  els['btn-select-none'].addEventListener('click', () => {
    state.selected.clear();
    applySelection();
  });

  els['btn-select-failed'].addEventListener('click', () => {
    const failed = Object.entries(state.itemStatus)
      .filter(([, info]) => info.status === ITEM_STATUS.FAILED)
      .map(([itemId]) => itemId);
    if (!failed.length) {
      setNotice('warn', '当前没有失败的条目。');
      return;
    }
    state.selected = new Set(failed);
    applySelection();
    setNotice('ok', `已选中 ${failed.length} 个失败条目，可直接点「下载选中」重试。`);
  });

  els['filter-size'].addEventListener('change', (event) => {
    state.filters.size = event.target.value;
    renderGrid();
    updateCounts();
  });

  els['filter-status'].addEventListener('change', (event) => {
    state.filters.status = event.target.value;
    renderGrid();
    updateCounts();
  });

  els['filter-scope'].addEventListener('change', (event) => {
    state.filters.scope = event.target.value;
    renderGrid();
    updateCounts();
  });

  els['btn-download'].addEventListener('click', () => {
    const ids = orderedSelection();
    startDownload(ids);
  });

  els['btn-resume'].addEventListener('click', async () => {
    clearNotice();
    try {
      const data = await request(PORT_CMD.RESUME, {});
      setNotice('ok', `已继续下载 ${data?.ids?.length ?? ''} 张未完成的图片。`);
    } catch (err) {
      setNotice('error', `继续下载失败：${describeFailure(err)}`);
    }
  });

  els['btn-cancel'].addEventListener('click', async () => {
    try {
      await request(PORT_CMD.CANCEL, {});
      setNotice('warn', '已取消：未开始的条目标为「已取消」，已经开始的不打断（避免半截文件）。点「继续下载」可以接着下这些没完成的。');
    } catch (err) {
      setNotice('error', `取消失败：${describeFailure(err)}`);
    }
  });

  els['btn-source'].addEventListener('click', async () => {
    try {
      await request(PORT_CMD.FOCUS_SOURCE, {});
    } catch (err) {
      setNotice('error', `无法切到源页面：${describeFailure(err)}`);
    }
  });

  els['btn-reload'].addEventListener('click', async () => {
    clearNotice();
    state.thumbFailed.clear();
    try {
      await request(PORT_CMD.REFRESH, {});
    } catch (err) {
      setNotice('error', `重新读取失败：${describeFailure(err)}`);
    }
  });

  // 扩展被重新加载后本页的一切都失效，刷新是唯一的恢复手段，所以给它一个固定入口
  els['btn-refresh'].addEventListener('click', () => location.reload());

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      event.preventDefault();
      for (const item of state.visible) state.selected.add(item.id);
      applySelection();
    }
  });
}

function applySelection() {
  grid.refreshAll(state.visible.map((item) => item.id));
  updateCounts();
}

/** 按界面顺序（也就是用户看到的顺序）返回选中项。 */
function orderedSelection() {
  const order = (state.session?.images || []).map((item) => item.id);
  return order.filter((itemId) => state.selected.has(itemId));
}

async function startDownload(ids) {
  if (!ids.length) {
    setNotice('warn', '请先勾选要下载的图片。');
    return;
  }
  clearNotice();
  for (const itemId of ids) {
    state.itemStatus[itemId] = {
      ...(state.itemStatus[itemId] || {}),
      status: ITEM_STATUS.PENDING,
      message: '排队中…',
      error: null
    };
  }
  grid.refreshAll(ids);
  updateCounts();
  setStatusline(`已提交 ${ids.length} 张，正在准备转换…`);
  try {
    await request(PORT_CMD.START_DOWNLOAD, { ids });
  } catch (err) {
    setNotice('error', `下载任务没有启动：${describeFailure(err)}`);
    setStatusline('任务未启动，可修改选择后重试。');
  }
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

main().catch((err) => {
  log.error('结果页初始化失败', err);
  // 扩展被重载导致的失败重试也没用，直接给出「刷新本页」的整页提示
  if (isContextInvalidated(err)) {
    showEmpty('reloaded');
    return;
  }
  setNotice('error', `结果页初始化失败：${describeFailure(err)}`);
});
