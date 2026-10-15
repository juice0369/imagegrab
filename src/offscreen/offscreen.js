/**
 * offscreen 文档的宿主：收消息 → 转换 → 产出 blob 地址 → 回传。
 * 同时维护 blob 地址表，用完即释放；另有 10 分钟兜底回收，防止异常路径漏掉释放。
 */

import { OFFSCREEN_MSG, TARGET, BLOB_TTL_MS, ERROR_CODES } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { convertUrlToPng, bytesToBlob, LOAD_TIMEOUT_MS } from './converter.js';

const log = createLogger('offscreen');

/** blobUrl → { blob, createdAt, bytes } */
const blobRegistry = new Map();

function respondError(err) {
  return {
    ok: false,
    code: err?.code || 'OFFSCREEN_ERROR',
    message: err?.message || String(err),
    attempts: err?.attempts || undefined
  };
}

async function handle(message) {
  switch (message.type) {
    case OFFSCREEN_MSG.CONVERT: {
      const started = Date.now();
      const result = await convertUrlToPng(message.url, {
        timeoutMs: Number(message.timeoutMs) > 0 ? Number(message.timeoutMs) : LOAD_TIMEOUT_MS
      });
      const blobUrl = URL.createObjectURL(result.blob);
      blobRegistry.set(blobUrl, { blob: result.blob, createdAt: Date.now(), bytes: result.blob.size });
      log.info(
        `转换成功（${result.mode}）：${result.width}×${result.height}` +
          `${result.scaled ? `（已降采样到 ${result.canvasWidth}×${result.canvasHeight}）` : ''}，` +
          `${(result.blob.size / 1024).toFixed(0)}KB，耗时 ${Date.now() - started}ms`
      );
      return {
        ok: true,
        blobUrl,
        width: result.width,
        height: result.height,
        canvasWidth: result.canvasWidth,
        canvasHeight: result.canvasHeight,
        scaled: result.scaled,
        mode: result.mode,
        bytes: result.blob.size,
        mime: 'image/png'
      };
    }

    case OFFSCREEN_MSG.BLOB_FROM_BYTES: {
      const blob = bytesToBlob(message.bytes, message.mime || 'image/png');
      const blobUrl = URL.createObjectURL(blob);
      blobRegistry.set(blobUrl, { blob, createdAt: Date.now(), bytes: blob.size });
      log.info(`已接收页内回传的 PNG：${(blob.size / 1024).toFixed(0)}KB`);
      return { ok: true, blobUrl, bytes: blob.size, mime: blob.type };
    }

    case OFFSCREEN_MSG.REVOKE: {
      const revoked = revoke(message.blobUrl);
      return { ok: true, revoked };
    }

    case OFFSCREEN_MSG.PING:
      return { ok: true, blobs: blobRegistry.size, uptimeMs: Math.round(performance.now()) };

    default:
      return { ok: false, code: ERROR_CODES.UNKNOWN_TYPE, message: `未知消息类型：${message?.type}` };
  }
}

function revoke(blobUrl) {
  if (!blobUrl || !blobRegistry.has(blobUrl)) return false;
  try {
    URL.revokeObjectURL(blobUrl);
  } catch (err) {
    log.debug('revokeObjectURL 失败（忽略）', err?.message);
  }
  blobRegistry.delete(blobUrl);
  return true;
}

/** 兜底清理：正常情况下 SW 会在下载结束后主动 REVOKE。 */
function sweep() {
  const now = Date.now();
  let count = 0;
  for (const [blobUrl, info] of [...blobRegistry.entries()]) {
    if (now - info.createdAt > BLOB_TTL_MS) {
      revoke(blobUrl);
      count += 1;
    }
  }
  if (count) log.info(`兜底回收了 ${count} 个超期 blob 地址`);
}

setInterval(sweep, 2 * 60 * 1000);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== TARGET.offscreen) return undefined;
  handle(message)
    .then(sendResponse)
    .catch((err) => {
      log.warn(`处理 ${message.type} 失败：${err?.code || ''} ${err?.message || err}`);
      sendResponse(respondError(err));
    });
  return true; // 异步应答
});

log.info('offscreen 文档已就绪');
