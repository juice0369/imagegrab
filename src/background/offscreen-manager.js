/**
 * offscreen 文档管理。
 *
 * 为什么必须有 offscreen：
 *  - MV3 service worker 里没有 URL.createObjectURL（这也是 offscreen 的 BLOBS 用途）；
 *  - content script 造的 blob: 属于页面源，chrome.downloads 用不了；
 *  - offscreen 是扩展页，带 host_permissions 抓图不受页面 CORS 限制，
 *    产出的 blob:chrome-extension://<id>/… 可以直接交给 downloads API。
 */

import { OFFSCREEN_PATH, OFFSCREEN_MSG, TARGET } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { sendMessage } from '../shared/messaging.js';

const log = createLogger('offscreen');

let creatingPromise = null;

/** 判断 offscreen 文档是否已存在（Chrome 116+ 的 getContexts）。 */
export async function hasOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
    });
    return Array.isArray(contexts) && contexts.length > 0;
  } catch (err) {
    log.warn('getContexts 失败，按“不存在”处理', err);
    return false;
  }
}

/** 按需创建 offscreen 文档，并用全局 Promise 防并发重复创建。 */
export async function ensureOffscreen() {
  if (await hasOffscreen()) return true;
  if (!creatingPromise) {
    log.info('创建 offscreen 文档');
    creatingPromise = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['BLOBS'],
        justification: '把商品图统一转换为 PNG 需要创建 Blob 地址供下载使用'
      })
      .catch((err) => {
        // 并发创建时 Chrome 会报 already exists，视为成功
        if (!/already exists|Only a single offscreen/i.test(String(err?.message || err))) throw err;
      })
      .finally(() => {
        creatingPromise = null;
      });
  }
  await creatingPromise;
  return true;
}

export async function closeOffscreen() {
  if (!(await hasOffscreen())) return false;
  try {
    await chrome.offscreen.closeDocument();
    log.info('已关闭 offscreen 文档');
    return true;
  } catch (err) {
    log.warn('关闭 offscreen 文档失败', err);
    return false;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 调用 offscreen 并等待应答；刚创建的文档可能还没挂上监听器，失败重试一次。 */
async function callOffscreen(message, { timeoutMs = 30000 } = {}) {
  await ensureOffscreen();
  const payload = { ...message, target: TARGET.offscreen };
  try {
    return await sendMessage(payload, { timeoutMs });
  } catch (err) {
    if (err?.code === 'NO_RESPONSE' || err?.code === 'MESSAGE_FAILED') {
      await delay(150);
      return sendMessage(payload, { timeoutMs });
    }
    throw err;
  }
}

/** 让 offscreen 抓图并转 PNG，返回 { ok, blobUrl, width, height } 或 { ok:false, code, message }。 */
export function convertRemote(url, { timeoutMs = 30000 } = {}) {
  return callOffscreen({ type: OFFSCREEN_MSG.CONVERT, url, timeoutMs }, { timeoutMs });
}

/** 把页内 canvas 回传的 PNG 字节包装成 blob 地址。 */
export function blobFromBytes(bytes, mime = 'image/png') {
  return callOffscreen({ type: OFFSCREEN_MSG.BLOB_FROM_BYTES, bytes, mime }, { timeoutMs: 60000 });
}

/** 释放 blob 地址（用完就还，别占内存）。 */
export async function revokeBlob(blobUrl) {
  if (!blobUrl) return;
  try {
    await callOffscreen({ type: OFFSCREEN_MSG.REVOKE, blobUrl }, { timeoutMs: 15000 });
  } catch (err) {
    log.debug('释放 blob 失败（忽略）', blobUrl, err?.message);
  }
}

/** 批量释放。 */
export async function revokeBlobs(blobUrls = []) {
  const list = [...blobUrls].filter(Boolean);
  await Promise.all(list.map((url) => revokeBlob(url)));
}

/** offscreen 健康检查（排障用）。 */
export async function pingOffscreen() {
  try {
    return await callOffscreen({ type: OFFSCREEN_MSG.PING }, { timeoutMs: 8000 });
  } catch (err) {
    return { ok: false, code: err?.code || 'OFFSCREEN_ERROR', message: err?.message || String(err) };
  }
}
