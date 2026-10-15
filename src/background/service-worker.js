/**
 * service worker：只做编排，不含算法。
 *
 * 职责：
 *  - 接收 content script 的提取结果，落 chrome.storage.session，开结果页；
 *  - 维护结果页长连接（只要结果页持着 port，SW 就不会被 MV3 回收，批量任务不会中途丢）；
 *  - 标签页生命周期：关掉结果页/源页面时的状态回收与临时数据清理；
 *  - 浏览器启动 / 扩展更新时清空残留会话。
 */

import {
  MSG,
  PORT_NAME,
  PORT_CMD,
  PORT_PUSH,
  TARGET,
  ITEM_STATUS,
  JOB_STATUS,
  RESULTS_PATH,
  SESSION_LIMITS,
  ERROR_CODES,
  describeError
} from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { respondAsync } from '../shared/messaging.js';
import { randomId } from '../shared/url-utils.js';
import { sessionStore } from './session-store.js';
import { cancelJob, dropJobsForSid, getRunningJob, jobSnapshot, releaseBlobsForSid, startDownload } from './download-manager.js';
import { ensureOffscreen, pingOffscreen } from './offscreen-manager.js';

const log = createLogger('sw');

/** sid → Set<port>（同一个会话可能被多个结果页持有） */
const sidPorts = new Map();
/** port → { sid } */
const portEntries = new Map();
/** sid → 回收倒计时 */
const sessionChecks = new Map();

/* ─────────────────────────── 启动清理 ─────────────────────────── */

async function bootstrap() {
  log.info('service worker 启动');
  try {
    await sessionStore.cleanupStale();
    const touched = await sessionStore.markInterruptedJobs();
    if (touched) log.info(`有 ${touched} 个任务在上次 SW 回收时中断，已标记为可继续`);
  } catch (err) {
    log.warn('启动清理失败', err);
  }
}

async function resetForNewRun(reason) {
  log.info(`清空临时数据（${reason}）`);
  for (const sid of [...sidPorts.keys()]) dropJobsForSid(sid);
  sidPorts.clear();
  await sessionStore.clear();
}

chrome.runtime.onStartup.addListener(() => void resetForNewRun('onStartup'));
chrome.runtime.onInstalled.addListener(() => void resetForNewRun('onInstalled'));

/* ───────────────────────────── 工具 ───────────────────────────── */

function resultsUrl(sid) {
  const base = chrome.runtime.getURL(RESULTS_PATH);
  return sid ? `${base}?sid=${encodeURIComponent(sid)}` : base;
}

function errorPayload(err) {
  return {
    code: err?.code || 'UNKNOWN',
    message: err?.message || String(err),
    attempts: err?.attempts || undefined
  };
}

function broadcast(sid, message) {
  const ports = sidPorts.get(sid);
  if (!ports) return;
  for (const port of ports) {
    try {
      port.postMessage(message);
    } catch (err) {
      log.debug('推送消息失败（端口可能已关闭）', err?.message);
    }
  }
}

function registerPort(sid, port) {
  if (!sidPorts.has(sid)) sidPorts.set(sid, new Set());
  sidPorts.get(sid).add(port);
  cancelSessionCheck(sid);
}

/* ─────────────────────── 会话回收（结果页关闭） ─────────────────────── */

function cancelSessionCheck(sid) {
  const entry = sessionChecks.get(sid);
  if (!entry) return;
  clearTimeout(entry.timer);
  sessionChecks.delete(sid);
}

function scheduleSessionCheck(sid, attempt = 0) {
  if (sessionChecks.has(sid)) return;
  const timer = setTimeout(async () => {
    sessionChecks.delete(sid);
    try {
      if (sidPorts.get(sid)?.size) return; // 又连上了（例如刷新页面），不回收
      const session = await sessionStore.get(sid);
      if (!session) return;
      // 还有任务在跑就再等一会儿，别把正在下载的任务掐掉
      if (getRunningJob(sid) && attempt < 20) {
        scheduleSessionCheck(sid, attempt + 1);
        return;
      }
      await destroySession(sid, '结果页已关闭');
    } catch (err) {
      log.warn('回收会话失败', err);
    }
  }, SESSION_LIMITS.resultsTabGraceMs);
  sessionChecks.set(sid, { timer, attempt });
}

async function destroySession(sid, reason) {
  try {
    cancelJob(sid);
  } catch (err) {
    log.debug('取消任务失败', err?.message);
  }
  dropJobsForSid(sid);
  try {
    const released = await releaseBlobsForSid(sid);
    if (released) log.info(`释放了 ${released} 个 blob 地址`);
  } catch (err) {
    log.debug('释放 blob 失败', err?.message);
  }
  await sessionStore.remove(sid);
  log.info(`回收会话 ${sid}：${reason}`);
}

/* ───────────────────────── 标签页生命周期 ───────────────────────── */

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    try {
      const sessions = await sessionStore.list();
      for (const session of sessions) {
        if (Array.isArray(session.resultsTabIds) && session.resultsTabIds.includes(tabId)) {
          await sessionStore.update(session.sid, (current) => ({
            resultsTabIds: (current.resultsTabIds || []).filter((id) => id !== tabId)
          }));
          scheduleSessionCheck(session.sid);
        }
        if (session.sourceTabId === tabId && session.sourceAlive !== false) {
          await sessionStore.update(session.sid, { sourceAlive: false });
          broadcast(session.sid, { type: PORT_PUSH.SOURCE_STATE, sid: session.sid, sourceAlive: false });
          log.info(`会话 ${session.sid} 的源页面已关闭，数据保留，下载不受影响`);
        }
      }
    } catch (err) {
      log.warn('处理标签页关闭失败', err);
    }
  })();
});

chrome.action.onClicked.addListener(() => {
  void (async () => {
    const latest = await sessionStore.latest();
    await chrome.tabs.create({ url: resultsUrl(latest?.sid), active: true });
  })();
});

/* ─────────────────────── 一次性消息（content → SW） ─────────────────────── */

async function handleExtractDone(message, sender) {
  const payload = message.payload || {};
  const images = Array.isArray(payload.images) ? payload.images : [];
  if (!images.length) {
    throw Object.assign(new Error(describeError('NO_IMAGES')), { code: 'NO_IMAGES' });
  }

  await sessionStore.cleanupStale();
  const sid = payload.sid || randomId('sid');
  const session = await sessionStore.create({
    sid,
    pageUrl: payload.pageUrl,
    pageTitle: payload.pageTitle,
    platformId: payload.platformId,
    platformName: payload.platformName,
    images,
    filterStats: payload.filterStats,
    settings: payload.settings,
    sourceTabId: sender?.tab?.id ?? null
  });

  const tab = await chrome.tabs.create({ url: resultsUrl(sid), active: true });
  await sessionStore.update(sid, (current) => ({
    resultsTabIds: [...new Set([...(current.resultsTabIds || []), tab.id])]
  }));

  log.info(`提取完成：${session.images.length} 张，已打开结果页 tab=${tab.id}`);
  return { ok: true, sid, tabId: tab.id, count: session.images.length };
}

async function handleSourceUnloaded(message) {
  const sid = message.payload?.sid;
  if (!sid) return { ok: false, error: { code: 'SESSION_NOT_FOUND', message: '缺少 sid' } };
  await sessionStore.update(sid, { sourceAlive: false });
  broadcast(sid, { type: PORT_PUSH.SOURCE_STATE, sid, sourceAlive: false });
  return { ok: true };
}

/**
 * 打开（或聚焦）某个会话的结果页。
 *
 * 由 content script 请求：内容脚本没有 chrome.tabs，不能自己开标签页。
 * 已经开着的结果页会被聚焦并复用，避免同一个会话堆出多个标签。
 */
async function handleOpenResults(message) {
  const sid = message.payload?.sid;
  if (!sid) return { ok: false, error: { code: 'SESSION_NOT_FOUND', message: '缺少 sid' } };
  const session = await sessionStore.get(sid);
  if (!session) {
    return { ok: false, error: { code: 'SESSION_NOT_FOUND', message: describeError('SESSION_NOT_FOUND') } };
  }

  const alive = [];
  for (const tabId of session.resultsTabIds || []) {
    try {
      await chrome.tabs.get(tabId);
      alive.push(tabId);
    } catch {
      // 标签已经被关掉了，忽略
    }
  }

  if (alive.length) {
    const tab = await chrome.tabs.update(alive[0], { active: true });
    if (tab?.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    if (alive.length !== (session.resultsTabIds || []).length) {
      await sessionStore.update(sid, { resultsTabIds: alive });
    }
    return { ok: true, tabId: alive[0], reused: true };
  }

  const tab = await chrome.tabs.create({ url: resultsUrl(sid), active: true });
  await sessionStore.update(sid, (current) => ({
    resultsTabIds: [...new Set([...(current.resultsTabIds || []), tab.id])]
  }));
  return { ok: true, tabId: tab.id, reused: false };
}

/** 排障入口：在 SW 的 Console 里执行 chrome.runtime.sendMessage({type:'IG_DIAGNOSTICS'}) */
async function handleDiagnostics() {
  const sessions = await sessionStore.list();
  const offscreen = await pingOffscreen();
  return {
    ok: true,
    version: chrome.runtime.getManifest().version,
    sessions: sessions.map((session) => ({
      sid: session.sid,
      platform: session.platformName,
      images: session.images?.length || 0,
      sourceAlive: session.sourceAlive,
      resultsTabIds: session.resultsTabIds,
      jobs: Object.values(session.jobs || {}).map((job) => ({ id: job.id, status: job.status, stats: job.stats }))
    })),
    ports: [...sidPorts.entries()].map(([sid, ports]) => ({ sid, ports: ports.size })),
    offscreen
  };
}

const MESSAGE_HANDLERS = {
  [MSG.EXTRACT_DONE]: handleExtractDone,
  [MSG.SOURCE_UNLOADED]: handleSourceUnloaded,
  [MSG.OPEN_RESULTS]: handleOpenResults,
  [MSG.DIAGNOSTICS]: handleDiagnostics
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;
  // 发给 offscreen 的消息与 SW 无关，直接无视（否则会把应答抢走）
  if (message.target === TARGET.offscreen) return undefined;
  const handler = MESSAGE_HANDLERS[message.type];
  if (!handler) return undefined;
  return respondAsync(() => handler(message, sender), sendResponse);
});

/* ───────────────────── 结果页长连接（results ↔ SW） ───────────────────── */

function publicSession(session) {
  if (!session) return null;
  const { jobs, ...rest } = session;
  return rest;
}

function latestJobOf(session) {
  const jobs = Object.values(session?.jobs || {});
  if (!jobs.length) return null;
  return jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
}

async function buildState(sid) {
  const session = await sessionStore.get(sid);
  if (!session) return null;
  const running = getRunningJob(sid);
  const job = running ? jobSnapshot(running) : latestJobOf(session);
  if (running) {
    // 内存里的任务才是权威状态，回填到快照
    return { session: publicSession(session), job: { ...job, status: running.status } };
  }
  return { session: publicSession(session), job };
}

/** 计算「继续下载」需要重跑的条目：没成功、也不是原格式降级过的。 */
function pendingItemIds(session) {
  const job = latestJobOf(session);
  const statuses = job?.itemStatus || {};
  return (session.images || [])
    .filter((item) => {
      const status = statuses[item.id]?.status;
      return status !== ITEM_STATUS.DONE && status !== ITEM_STATUS.FALLBACK;
    })
    .map((item) => item.id);
}

async function runDownload(sid, ids, port) {
  const session = await sessionStore.get(sid);
  if (!session) {
    const error = { code: 'SESSION_NOT_FOUND', message: describeError('SESSION_NOT_FOUND') };
    port.postMessage({ type: PORT_PUSH.SESSION_GONE, sid, error });
    return { ok: false, error };
  }

  const validIds = ids.filter((id) => (session.images || []).some((item) => item.id === id));
  if (!validIds.length) {
    return { ok: false, error: { code: 'NO_SELECTION', message: describeError('NO_SELECTION') } };
  }
  if (getRunningJob(sid)) {
    return { ok: false, error: { code: 'JOB_RUNNING', message: describeError('JOB_RUNNING') } };
  }

  // 提前把 offscreen 准备好；失败也不拦：后面还有页内回退与原格式降级两条路
  try {
    await ensureOffscreen();
  } catch (err) {
    log.warn('offscreen 创建失败，将走页内回退或原格式降级', err);
    broadcast(sid, {
      type: PORT_PUSH.ERROR,
      error: { code: 'OFFSCREEN_ERROR', message: '后台转换服务不可用，将尝试页内回退与原格式降级' }
    });
  }

  void startDownload({
    session,
    ids: validIds,
    emit: (event) => broadcast(sid, event)
  }).catch((err) => {
    log.error('批量任务异常结束', err);
    broadcast(sid, { type: PORT_PUSH.ERROR, error: errorPayload(err) });
    broadcast(sid, { type: PORT_PUSH.BATCH_DONE, job: null, summary: { failed: validIds.length, total: validIds.length } });
  });

  return { ok: true, data: { accepted: validIds.length } };
}

async function handlePortMessage(port, entry, message) {
  const reqId = message?.reqId ?? null;
  const ack = (ok, error, data) => {
    try {
      port.postMessage({ type: PORT_PUSH.ACK, reqId, ok, error: error || null, data: data ?? null });
    } catch (err) {
      log.debug('回执失败', err?.message);
    }
  };

  try {
    switch (message?.cmd) {
      case PORT_CMD.INIT: {
        const sid = message.sid || null;
        entry.sid = sid;
        if (!sid) {
          ack(false, { code: 'SESSION_NOT_FOUND', message: '缺少会话 id' });
          return;
        }
        registerPort(sid, port);
        const state = await buildState(sid);
        if (!state) {
          port.postMessage({ type: PORT_PUSH.SESSION_GONE, sid });
          ack(false, { code: 'SESSION_NOT_FOUND', message: describeError('SESSION_NOT_FOUND') });
          return;
        }
        port.postMessage({ type: PORT_PUSH.STATE, state });
        ack(true, null, { sid });
        return;
      }

      case PORT_CMD.START_DOWNLOAD: {
        const result = await runDownload(entry.sid, Array.isArray(message.ids) ? message.ids : [], port);
        ack(result.ok, result.error, result.data);
        return;
      }

      case PORT_CMD.RESUME: {
        const session = await sessionStore.get(entry.sid);
        if (!session) {
          port.postMessage({ type: PORT_PUSH.SESSION_GONE, sid: entry.sid });
          ack(false, { code: 'SESSION_NOT_FOUND', message: describeError('SESSION_NOT_FOUND') });
          return;
        }
        const ids = pendingItemIds(session);
        if (!ids.length) {
          ack(false, { code: 'NO_SELECTION', message: '没有需要继续下载的图片' });
          return;
        }
        const result = await runDownload(entry.sid, ids, port);
        ack(result.ok, result.error, { ...(result.data || {}), ids });
        return;
      }

      case PORT_CMD.CANCEL: {
        const job = cancelJob(entry.sid);
        if (!job) {
          ack(false, { code: 'UNKNOWN', message: '当前没有进行中的任务' });
          return;
        }
        broadcast(entry.sid, { type: PORT_PUSH.JOB_UPDATE, job });
        ack(true, null, { job });
        return;
      }

      case PORT_CMD.REFRESH: {
        const state = await buildState(entry.sid);
        if (!state) {
          port.postMessage({ type: PORT_PUSH.SESSION_GONE, sid: entry.sid });
          ack(false, { code: 'SESSION_NOT_FOUND', message: describeError('SESSION_NOT_FOUND') });
          return;
        }
        port.postMessage({ type: PORT_PUSH.STATE, state });
        ack(true, null, { sid: entry.sid });
        return;
      }

      case PORT_CMD.FOCUS_SOURCE: {
        const session = await sessionStore.get(entry.sid);
        const tabId = session?.sourceTabId;
        if (!tabId) {
          ack(false, { code: 'PAGE_GONE', message: '源页面已关闭' });
          return;
        }
        try {
          const tab = await chrome.tabs.get(tabId);
          await chrome.tabs.update(tabId, { active: true });
          if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
          ack(true, null, { tabId });
        } catch (err) {
          ack(false, { code: 'PAGE_GONE', message: '源页面已关闭' });
        }
        return;
      }

      default:
        ack(false, { code: 'UNKNOWN_CMD', message: `${ERROR_CODES.UNKNOWN_CMD}：${message?.cmd}` });
    }
  } catch (err) {
    log.error('处理结果页指令失败', message?.cmd, err);
    ack(false, errorPayload(err));
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  log.info('结果页已连接');
  const entry = { sid: null };
  portEntries.set(port, entry);

  port.onMessage.addListener((message) => {
    void handlePortMessage(port, entry, message);
  });

  port.onDisconnect.addListener(() => {
    portEntries.delete(port);
    const sid = entry.sid;
    if (!sid) return;
    const ports = sidPorts.get(sid);
    ports?.delete(port);
    if (ports && ports.size === 0) {
      sidPorts.delete(sid);
      log.info(`会话 ${sid} 的结果页已断开，${SESSION_LIMITS.resultsTabGraceMs / 1000}s 后检查是否需要回收`);
      scheduleSessionCheck(sid);
    }
  });
});

void bootstrap();

// 暴露给 SW Console 手工排障用（例如强制回收某个会话）
globalThis.ImageGrabDebug = {
  store: sessionStore,
  jobs: () => [...sidPorts.keys()],
  destroy: (sid) => destroySession(sid, '手动清理'),
  diagnostics: handleDiagnostics,
  status: () => ({
    sessions: sessionStore.list(),
    ports: [...sidPorts.keys()],
    running: [...sidPorts.keys()].map((sid) => getRunningJob(sid)?.id).filter(Boolean)
  }),
  jobStatus: JOB_STATUS
};
