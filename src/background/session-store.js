/**
 * 会话存储：提取结果只存「图片 URL + 元数据」（几百张也不过百 KB 级），
 * 天然适合 chrome.storage.session —— 浏览器重启即清空，不落盘。
 *
 * 会话结构：
 * {
 *   sid, pageUrl, pageTitle, platformId, platformName,
 *   createdAt, updatedAt, sourceTabId, sourceAlive, resultsTabIds: [],
 *   settings, filterStats, downloadSequence,
 *   images: [ { id, url, rawUrl, source, kind, ext, domWidth, domHeight, naturalWidth, naturalHeight, alt, alternates } ],
 *   jobs: { [jobId]: { id, status, createdAt, finishedAt, stats, nextSequence, itemStatus: { [itemId]: {...} } } }
 * }
 *
 * `downloadSequence` 是「下一个文件名编号」的游标（1 起），让同一会话里的多批下载连着编号
 * （001…003、004…005），而不是每批都从 001 重来撞名成「商品图_001 (1).png」。
 */

import { STORAGE_KEYS, SESSION_LIMITS, JOB_STATUS } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('store');

/** 串行化读改写，避免并发写入互相覆盖。 */
let chain = Promise.resolve();

function withLock(task) {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function readAll() {
  try {
    const data = await chrome.storage.session.get(STORAGE_KEYS.sessions);
    const all = data?.[STORAGE_KEYS.sessions];
    return all && typeof all === 'object' ? all : {};
  } catch (err) {
    log.warn('读取会话失败', err);
    return {};
  }
}

async function writeAll(sessions) {
  try {
    await chrome.storage.session.set({ [STORAGE_KEYS.sessions]: sessions });
  } catch (err) {
    log.error('写入会话失败', err);
    throw err;
  }
}

/** 移除过期与超量的会话，返回被移除的 sid 列表。 */
function prune(sessions) {
  const now = Date.now();
  const removed = [];
  for (const [sid, session] of Object.entries(sessions)) {
    if (!session || now - (session.createdAt || 0) > SESSION_LIMITS.ttlMs) {
      delete sessions[sid];
      removed.push(sid);
    }
  }
  const sorted = Object.entries(sessions).sort((a, b) => (b[1]?.createdAt || 0) - (a[1]?.createdAt || 0));
  for (const [sid] of sorted.slice(SESSION_LIMITS.maxSessions)) {
    delete sessions[sid];
    removed.push(sid);
  }
  return removed;
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt || null,
    stats: job.stats,
    nextSequence: job.nextSequence || 1,
    itemStatus: job.itemStatus
  };
}

export const sessionStore = {
  /** 新建会话，返回写入后的会话对象。 */
  async create(input) {
    return withLock(async () => {
      const sessions = await readAll();
      const now = Date.now();
      const session = {
        sid: input.sid,
        pageUrl: input.pageUrl || '',
        pageTitle: input.pageTitle || '',
        platformId: input.platformId || 'default',
        platformName: input.platformName || '未知站点',
        createdAt: now,
        updatedAt: now,
        sourceTabId: input.sourceTabId ?? null,
        sourceAlive: true,
        resultsTabIds: [],
        settings: input.settings || {},
        filterStats: input.filterStats || null,
        images: Array.isArray(input.images) ? input.images : [],
        jobs: {}
      };
      sessions[session.sid] = session;
      prune(sessions);
      await writeAll(sessions);
      log.info(`已创建会话 ${session.sid}，图片 ${session.images.length} 张`);
      return session;
    });
  },

  async get(sid) {
    if (!sid) return null;
    const sessions = await readAll();
    return sessions[sid] || null;
  },

  /** 按创建时间倒序列出所有会话。 */
  async list() {
    const sessions = await readAll();
    return Object.values(sessions).sort((a, b) => (b?.createdAt || 0) - (a?.createdAt || 0));
  },

  async latest() {
    const list = await this.list();
    return list[0] || null;
  },

  /** patch 可以是对象，也可以是 (session) => patch。返回更新后的会话。 */
  async update(sid, patch) {
    return withLock(async () => {
      const sessions = await readAll();
      const session = sessions[sid];
      if (!session) return null;
      const delta = typeof patch === 'function' ? patch(session) : patch;
      Object.assign(session, delta, { updatedAt: Date.now() });
      await writeAll(sessions);
      return session;
    });
  },

  /**
   * 写入任务的某个条目的状态。
   * @returns {Promise<object|null>} 更新后的 job（不存在时返回 null）
   */
  async saveJob(sid, job) {
    return withLock(async () => {
      const sessions = await readAll();
      const session = sessions[sid];
      if (!session) return null;
      session.jobs = session.jobs || {};
      session.jobs[job.id] = publicJob(job);
      session.updatedAt = Date.now();
      // 会话里只保留最近 5 个任务，避免无限膨胀
      const jobs = Object.entries(session.jobs).sort((a, b) => (b[1]?.createdAt || 0) - (a[1]?.createdAt || 0));
      for (const [jobId] of jobs.slice(5)) delete session.jobs[jobId];
      await writeAll(sessions);
      return session.jobs[job.id];
    });
  },

  async remove(sid) {
    return withLock(async () => {
      const sessions = await readAll();
      if (!sessions[sid]) return false;
      delete sessions[sid];
      await writeAll(sessions);
      log.info(`已删除会话 ${sid}`);
      return true;
    });
  },

  /** 清理过期 / 超量会话，返回被清除的 sid 列表。 */
  async cleanupStale() {
    return withLock(async () => {
      const sessions = await readAll();
      const removed = prune(sessions);
      if (removed.length) {
        await writeAll(sessions);
        log.info(`清理过期会话：${removed.join(', ')}`);
      }
      return removed;
    });
  },

  /**
   * 处理 service worker 重启后的残留：把 running 的任务标记为 interrupted，
   * 并把「进行中」的条目退回 pending，这样结果页可以「继续下载」。
   */
  async markInterruptedJobs() {
    return withLock(async () => {
      const sessions = await readAll();
      let touched = 0;
      for (const session of Object.values(sessions)) {
        for (const job of Object.values(session.jobs || {})) {
          if (job?.status !== JOB_STATUS.RUNNING) continue;
          job.status = JOB_STATUS.INTERRUPTED;
          job.finishedAt = Date.now();
          for (const [itemId, info] of Object.entries(job.itemStatus || {})) {
            if (info.status === 'converting' || info.status === 'downloading' || info.status === 'pending') {
              job.itemStatus[itemId] = { ...info, status: 'pending', error: null, note: '任务中断，可继续下载' };
            }
          }
          touched += 1;
        }
      }
      if (touched) await writeAll(sessions);
      return touched;
    });
  },

  async clear() {
    try {
      await chrome.storage.session.clear();
      log.info('已清空 session 存储');
    } catch (err) {
      log.warn('清空 session 存储失败', err);
    }
  }
};
