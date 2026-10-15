/**
 * 批量下载队列。
 *
 * 单张图片的处理链路：
 *   1) offscreen 抓图 → PNG blob（先试「原图还原地址」，失败再试页面上的原始地址）
 *   2) 失败 → 请求源页面做页内 canvas 回退（三态探测 CORS）
 *   3) 都失败 → 按原格式直接下载原始 URL，状态标记为「原格式」，不计入失败
 *   4) 下载后用 chrome.downloads.onChanged 等终态；NETWORK_ 与 SERVER_ 前缀的错误退避重试
 *   5) 无论成败都释放 blob 地址
 *
 * 并发默认 3；取消只停止调度新条目，已经开始的不打断（避免半截文件）。
 */

import { ITEM_STATUS, JOB_STATUS, MSG, PORT_PUSH, ERROR_CODES, DEFAULT_SETTINGS, describeError } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { assignSequences, buildFilename, joinDownloadPath, randomId } from '../shared/url-utils.js';
import { sendTabMessage } from '../shared/messaging.js';
import { blobFromBytes, convertRemote, revokeBlob } from './offscreen-manager.js';
import { sessionStore } from './session-store.js';

const log = createLogger('download');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 正在进行中的任务：jobId → job。 */
const activeJobs = new Map();

/* ───────────────────────────── 任务对象 ───────────────────────────── */

function createJob({ sid, ids, settings, nextSequence = 1 }) {
  const job = {
    id: randomId('job'),
    sid,
    status: JOB_STATUS.RUNNING,
    createdAt: Date.now(),
    finishedAt: null,
    ids: [...ids],
    queue: [...ids],
    items: new Map(),
    blobUrls: new Set(),
    cancelled: false,
    /** 这一批用完之后的下一个编号，结果页用它显示「下一个文件名」 */
    nextSequence,
    stats: { total: ids.length, processed: 0, succeeded: 0, failed: 0, fallback: 0, cancelled: 0 },
    settings
  };
  for (const id of ids) {
    job.items.set(id, { status: ITEM_STATUS.PENDING, error: null, message: '', filename: '', via: '', attempt: 0 });
  }
  activeJobs.set(job.id, job);
  return job;
}

function itemStatusObject(job) {
  const out = {};
  for (const [id, info] of job.items) {
    out[id] = {
      status: info.status,
      error: info.error || null,
      message: info.message || '',
      filename: info.filename || '',
      via: info.via || '',
      width: info.width || 0,
      height: info.height || 0
    };
  }
  return out;
}

/** 给结果页的「任务快照」。 */
export function jobSnapshot(job) {
  if (!job) return null;
  return {
    id: job.id,
    sid: job.sid,
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt || null,
    stats: { ...job.stats },
    nextSequence: job.nextSequence || 1,
    itemStatus: itemStatusObject(job)
  };
}

export function getJob(jobId) {
  return activeJobs.get(jobId) || null;
}

export function getRunningJob(sid) {
  for (const job of activeJobs.values()) {
    if (job.sid === sid && job.status === JOB_STATUS.RUNNING) return job;
  }
  return null;
}

export function dropJobsForSid(sid) {
  for (const [jobId, job] of [...activeJobs.entries()]) {
    if (job.sid !== sid) continue;
    job.cancelled = true;
    job.queue.length = 0;
    if (job.status === JOB_STATUS.RUNNING) job.status = JOB_STATUS.CANCELLED;
    activeJobs.delete(jobId);
  }
}

/* ───────────────────────────── 工具 ───────────────────────────── */

/** 把 chrome.downloads 的 error 字符串归类。 */
export function classifyDownloadError(error) {
  const text = String(error || '');
  if (!text) return 'DOWNLOAD_INTERRUPTED';
  if (text.startsWith('NETWORK_')) return 'NETWORK_ERROR';
  if (text.startsWith('SERVER_')) return 'SERVER_ERROR';
  if (text === 'USER_CANCELED' || text === 'USER_SHUTDOWN') return 'USER_CANCELED';
  if (text.startsWith('FILE_')) return 'FILE_ERROR';
  return 'DOWNLOAD_INTERRUPTED';
}

function isRetryable(code) {
  return code === 'NETWORK_ERROR' || code === 'SERVER_ERROR';
}

/** 等下载进入终态。 */
function waitForDownload(downloadId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const finish = (fn, payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        chrome.downloads.onChanged.removeListener(listener);
      } catch {
        /* 忽略 */
      }
      fn(payload);
    };

    const listener = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') finish(resolve, { state: 'complete' });
      else if (delta.state?.current === 'interrupted') {
        finish(resolve, { state: 'interrupted', error: delta.error?.current || 'INTERRUPTED' });
      } else if (delta.error?.current) {
        finish(resolve, { state: 'interrupted', error: delta.error.current });
      }
    };

    timer = setTimeout(async () => {
      // 超时后再查一次真实状态，避免误报
      try {
        const [item] = await chrome.downloads.search({ id: downloadId });
        if (item?.state === 'complete') return finish(resolve, { state: 'complete' });
        if (item?.state === 'interrupted') {
          return finish(resolve, { state: 'interrupted', error: item.error || 'INTERRUPTED' });
        }
      } catch {
        /* 继续走超时分支 */
      }
      finish(reject, Object.assign(new Error(ERROR_CODES.DOWNLOAD_TIMEOUT), { code: 'DOWNLOAD_TIMEOUT' }));
    }, timeoutMs);

    chrome.downloads.onChanged.addListener(listener);

    // 可能已经完成（几乎没有，但补一次查询更稳）
    chrome.downloads
      .search({ id: downloadId })
      .then(([item]) => {
        if (item?.state === 'complete') finish(resolve, { state: 'complete' });
        else if (item?.state === 'interrupted') finish(resolve, { state: 'interrupted', error: item.error || 'INTERRUPTED' });
      })
      .catch(() => {});
  });
}

/* ─────────────────────────── 转换逻辑 ─────────────────────────── */

function summarizeConvertAttempts(attempts) {
  const tainted = attempts.find((a) => a.code === 'TAINTED_CANVAS');
  if (tainted) return `${ERROR_CODES.TAINTED_CANVAS}（已尝试：${attempts.map((a) => a.label).join('、')}）`;
  const loadFailed = attempts.filter((a) => a.code === 'IMG_LOAD_FAILED');
  if (loadFailed.length && loadFailed.length === attempts.length) {
    return `${ERROR_CODES.IMG_LOAD_FAILED}（已尝试：${attempts.map((a) => a.label).join('、')}）`;
  }
  const first = attempts[0];
  if (first) return `${describeError(first.code, first.message)}（已尝试：${attempts.map((a) => a.label).join('、')}）`;
  return ERROR_CODES.CONVERT_FAILED;
}

/**
 * 转换一张图：offscreen 直连（原图地址 → 页面原始地址）→ 页内 canvas 回退。
 * 成功返回 { blobUrl, width, height, via, url }，失败抛 CONVERT_FAILED。
 */
async function convertImage(item, { settings, session }) {
  const attempts = [];
  const remoteCandidates = [];
  if (item.url) remoteCandidates.push({ url: item.url, label: '扩展直连原图地址' });
  if (item.rawUrl && item.rawUrl !== item.url) remoteCandidates.push({ url: item.rawUrl, label: '扩展直连页面原始地址' });

  for (const candidate of remoteCandidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await convertRemote(candidate.url, { timeoutMs: settings.convertTimeoutMs });
      if (result?.ok && result.blobUrl) {
        return { blobUrl: result.blobUrl, width: result.width, height: result.height, via: 'offscreen', url: candidate.url };
      }
      attempts.push({ label: candidate.label, code: result?.code || 'OFFSCREEN_ERROR', message: result?.message || '' });
    } catch (err) {
      attempts.push({ label: candidate.label, code: err?.code || 'OFFSCREEN_FAILED', message: err?.message || '' });
    }
  }

  // 页内 canvas 回退：需要源页面还活着
  if (session.sourceTabId && session.sourceAlive !== false) {
    const pageCandidates = [item.url, item.rawUrl].filter((url, index, list) => url && list.indexOf(url) === index);
    for (const url of pageCandidates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await sendTabMessage(
          session.sourceTabId,
          { type: MSG.CONVERT_IN_PAGE, url, timeoutMs: settings.convertTimeoutMs },
          { timeoutMs: settings.convertTimeoutMs + 5000 }
        );
        if (response?.ok && response.bytes) {
          // eslint-disable-next-line no-await-in-loop
          const uploaded = await blobFromBytes(response.bytes, response.mime || 'image/png');
          if (uploaded?.ok && uploaded.blobUrl) {
            return { blobUrl: uploaded.blobUrl, width: response.width, height: response.height, via: 'in-page', url };
          }
          attempts.push({ label: '页内回退上传', code: uploaded?.code || 'OFFSCREEN_ERROR', message: uploaded?.message || '' });
        } else {
          attempts.push({ label: '页内 canvas 回退', code: response?.code || 'PAGE_CONVERT_FAILED', message: response?.message || '' });
        }
      } catch (err) {
        attempts.push({ label: '页内 canvas 回退', code: err?.code || 'PAGE_CONVERT_FAILED', message: err?.message || '' });
      }
    }
  } else {
    attempts.push({ label: '页内 canvas 回退', code: 'PAGE_GONE', message: ERROR_CODES.PAGE_GONE });
  }

  const error = new Error(summarizeConvertAttempts(attempts));
  error.code = 'CONVERT_FAILED';
  error.attempts = attempts;
  throw error;
}

/* ─────────────────────────── 单张处理 ─────────────────────────── */

async function downloadWithRetry(url, filename, settings) {
  const maxRetries = Math.max(0, Math.min(5, num(settings.maxRetries, DEFAULT_SETTINGS.maxRetries)));
  const timeoutMs = Math.max(5000, num(settings.downloadTimeoutMs, DEFAULT_SETTINGS.downloadTimeoutMs));
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false
    });

    // eslint-disable-next-line no-await-in-loop
    const outcome = await waitForDownload(downloadId, timeoutMs);
    if (outcome.state === 'complete') return { downloadId, attempts: attempt + 1 };

    const code = classifyDownloadError(outcome.error);
    lastError = Object.assign(new Error(`${describeError(code, ERROR_CODES.DOWNLOAD_FAILED)}（${outcome.error}）`), {
      code,
      downloadError: outcome.error
    });
    if (!isRetryable(code) || attempt === maxRetries) break;
    log.warn(`下载失败将重试（第 ${attempt + 1} 次）：${outcome.error}`);
    // eslint-disable-next-line no-await-in-loop
    await delay(600 * (attempt + 1));
  }

  throw lastError || Object.assign(new Error(ERROR_CODES.DOWNLOAD_FAILED), { code: 'DOWNLOAD_FAILED' });
}

async function processItem(job, itemId, ctx) {
  const { session, settings, emit } = ctx;
  const item = session.images.find((candidate) => candidate.id === itemId);
  if (!item) {
    setItem(job, itemId, ITEM_STATUS.FAILED, { code: 'ITEM_NOT_FOUND', message: ERROR_CODES.ITEM_NOT_FOUND }, ctx);
    return;
  }

  const sequence = ctx.sequenceById.get(itemId) || 1;
  setItem(job, itemId, ITEM_STATUS.CONVERTING, { message: '正在转换…' }, ctx);

  let converted = null;
  let convertError = null;
  try {
    converted = await convertImage(item, { settings, session });
    if (converted?.blobUrl) job.blobUrls.add(converted.blobUrl);
  } catch (err) {
    convertError = err;
    log.debug(`转换失败，将按原格式降级：${item.url}`, err?.message);
  }

  const useFallback = !converted;
  const extension = useFallback ? item.ext || 'jpg' : 'png';
  const filename = joinDownloadPath(settings.subfolder, buildFilename(sequence, extension, settings));
  const downloadUrl = useFallback ? item.url : converted.blobUrl;

  if (!useFallback) {
    setItem(job, itemId, ITEM_STATUS.DOWNLOADING, { filename, via: converted.via, width: converted.width, height: converted.height, message: `正在下载（${converted.via === 'in-page' ? '页内回退' : '扩展直连'}）` }, ctx);
  } else {
    setItem(job, itemId, ITEM_STATUS.DOWNLOADING, { filename, via: 'original', message: '转换失败，按原格式下载' }, ctx);
  }

  try {
    await downloadWithRetry(downloadUrl, filename, settings);
    if (useFallback) {
      setItem(job, itemId, ITEM_STATUS.FALLBACK, {
        filename,
        via: 'original',
        code: convertError?.code || 'CONVERT_FAILED',
        message: `${convertError?.message || ERROR_CODES.CONVERT_FAILED}；已按原格式下载（.${extension}）`
      }, ctx);
    } else {
      setItem(job, itemId, ITEM_STATUS.DONE, {
        filename,
        via: converted.via,
        width: converted.width,
        height: converted.height,
        message: `已保存 ${filename}`
      }, ctx);
    }
  } catch (err) {
    const code = err?.code || 'DOWNLOAD_FAILED';
    const parts = [describeError(code, err?.message)];
    if (convertError) parts.unshift(`转换失败：${convertError.message}`);
    setItem(job, itemId, ITEM_STATUS.FAILED, { code, filename, message: parts.join('；') }, ctx);
  } finally {
    if (converted?.blobUrl) {
      job.blobUrls.delete(converted.blobUrl);
      await revokeBlob(converted.blobUrl);
    }
  }
}

/** 更新单条状态并推送进度（节流由 ctx 统一控制）。 */
function setItem(job, itemId, status, extra = {}, ctx) {
  const info = job.items.get(itemId);
  if (!info) return;
  const previous = info.status;
  Object.assign(info, { status, error: extra.code || null, message: extra.message || '', ...extra });

  const terminal = [ITEM_STATUS.DONE, ITEM_STATUS.FALLBACK, ITEM_STATUS.FAILED, ITEM_STATUS.CANCELLED];
  if (previous === status && terminal.includes(status)) return;

  if (terminal.includes(status)) {
    job.stats.processed += 1;
    if (status === ITEM_STATUS.DONE) job.stats.succeeded += 1;
    else if (status === ITEM_STATUS.FALLBACK) job.stats.fallback += 1;
    else if (status === ITEM_STATUS.FAILED) job.stats.failed += 1;
    else if (status === ITEM_STATUS.CANCELLED) job.stats.cancelled += 1;
  }

  ctx.emit({
    type: PORT_PUSH.ITEM_PROGRESS,
    itemId,
    status,
    error: info.error,
    message: info.message,
    filename: info.filename,
    via: info.via,
    width: info.width,
    height: info.height
  });
  ctx.scheduleFlush();
}

/* ─────────────────────────── 队列调度 ─────────────────────────── */

async function worker(ctx) {
  const { job } = ctx;
  for (;;) {
    if (job.cancelled) return;
    const itemId = job.queue.shift();
    if (itemId === undefined) return;
    try {
      // eslint-disable-next-line no-await-in-loop
      await processItem(job, itemId, ctx);
    } catch (err) {
      log.error('处理图片时出现未捕获异常', itemId, err);
      setItem(job, itemId, ITEM_STATUS.FAILED, { code: err?.code || 'UNKNOWN', message: err?.message || String(err) }, ctx);
    }
  }
}

/**
 * 启动一批下载。
 *
 * 文件名编号在同一个会话里**连续递增**：先下 3 张、再下 2 张，得到 `商品图_001~003.png` 与
 * `商品图_004~005.png`；每批都从 001 重来会撞名成「商品图_001 (1).png」，看着像没按顺序编号。
 * 批内顺序与结果页列表顺序一致（结果页传进来的 ids 就是列表顺序）。
 *
 * @param {{session: object, ids: string[], emit: (event: object) => void}} options
 * @returns {Promise<object>} 任务快照
 */
export async function startDownload({ session, ids, emit }) {
  const settings = { ...DEFAULT_SETTINGS, ...session.settings };
  // 编号从会话游标接着往下排（同一批内顺序 = 结果页列表顺序）
  const { byId: sequenceById, next: nextSequence } = assignSequences(ids, session.downloadSequence);
  const job = createJob({ sid: session.sid, ids, settings, nextSequence });

  // 游标写回会话：这一批结束后下一批接着往后编号，刷新结果页也不会回退
  session.downloadSequence = nextSequence;
  sessionStore
    .update(session.sid, { downloadSequence: nextSequence })
    .catch((err) => log.debug('保存文件名编号游标失败', err));

  let flushTimer = null;
  let lastFlush = 0;
  const context = {
    job,
    session,
    settings,
    sequenceById,
    emit,
    scheduleFlush: () => {
      const now = Date.now();
      const run = () => {
        lastFlush = Date.now();
        emit({ type: 'JOB_UPDATE', job: jobSnapshot(job) });
        sessionStore.saveJob(session.sid, { ...job, itemStatus: itemStatusObject(job) }).catch((err) => log.debug('保存任务进度失败', err));
      };
      const wait = Math.max(0, 200 - (now - lastFlush));
      if (flushTimer) return;
      if (wait === 0) {
        run();
        return;
      }
      flushTimer = setTimeout(() => {
        flushTimer = null;
        run();
      }, wait);
    }
  };

  emit({ type: 'JOB_UPDATE', job: jobSnapshot(job) });

  const concurrency = Math.max(1, Math.min(num(settings.concurrency, DEFAULT_SETTINGS.concurrency), ids.length || 1));
  const workers = Array.from({ length: concurrency }, () => worker(context));
  await Promise.all(workers);

  if (flushTimer) clearTimeout(flushTimer);
  job.finishedAt = Date.now();
  job.status = job.cancelled ? JOB_STATUS.CANCELLED : JOB_STATUS.FINISHED;
  activeJobs.delete(job.id);
  await sessionStore.saveJob(session.sid, { ...job, itemStatus: itemStatusObject(job) }).catch(() => {});

  const summary = {
    jobId: job.id,
    sid: job.sid,
    total: job.stats.total,
    succeeded: job.stats.succeeded,
    fallback: job.stats.fallback,
    failed: job.stats.failed,
    cancelled: job.stats.cancelled,
    processed: job.stats.processed
  };
  emit({ type: 'BATCH_DONE', job: jobSnapshot(job), summary });
  log.info(
    `任务结束：成功 ${summary.succeeded}、原格式 ${summary.fallback}、失败 ${summary.failed}、取消 ${summary.cancelled}`
  );
  return jobSnapshot(job);
}

/** 取消任务：停止调度剩余条目，已经开始的不打断。 */
export function cancelJob(sid) {
  const job = getRunningJob(sid);
  if (!job) return null;
  job.cancelled = true;
  const remaining = job.queue.splice(0);
  for (const itemId of remaining) {
    const info = job.items.get(itemId);
    if (!info) continue;
    Object.assign(info, { status: ITEM_STATUS.CANCELLED, error: null, message: '用户取消了任务' });
    job.stats.processed += 1;
    job.stats.cancelled += 1;
  }
  log.info(`任务 ${job.id} 已取消，未开始的 ${remaining.length} 张已标记为取消`);
  return jobSnapshot(job);
}

/** 释放某个会话遗留的所有 blob 地址。 */
export async function releaseBlobsForSid(sid) {
  const urls = new Set();
  for (const job of activeJobs.values()) {
    if (job.sid === sid) for (const url of job.blobUrls) urls.add(url);
  }
  for (const url of urls) {
    // eslint-disable-next-line no-await-in-loop
    await revokeBlob(url);
  }
  return urls.size;
}
