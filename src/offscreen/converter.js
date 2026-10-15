/**
 * 纯转换逻辑：抓图 → 解码 → 重绘 → PNG 编码。不依赖任何消息机制，方便单测。
 *
 * 三态探测（一定要做，不能只试一次）：
 *   1) 带 crossOrigin='anonymous' 加载：扩展页 + host_permissions 时不受页面 CORS 限制；
 *   2) 失败则去掉 crossOrigin 再试一次：这次能加载，但 canvas 可能被污染；
 *   3) 用 canvas.toBlob 是否抛异常判断污染。抛 SecurityError → TAINTED_CANVAS。
 * 这样最终给用户的错误提示才能区分「图挂了」和「跨域读不了」。
 */

import { MAX_PIXELS, ERROR_CODES } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('converter');

export const LOAD_TIMEOUT_MS = 20000;

function failure(code, message, extra = {}) {
  return Object.assign(new Error(message || ERROR_CODES[code] || code), { code, ...extra });
}

/** 加载图片：`referrerPolicy=no-referrer` 规避部分 CDN 的防盗链。 */
export function loadImage(url, { crossOrigin = true, timeoutMs = LOAD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'sync';

    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
    };

    timer = setTimeout(() => {
      cleanup();
      reject(failure('IMG_TIMEOUT', `图片加载超时（${Math.round(timeoutMs / 1000)}s）`, { url }));
    }, timeoutMs);

    img.onload = () => {
      cleanup();
      resolve(img);
    };
    img.onerror = () => {
      cleanup();
      reject(failure('IMG_LOAD_FAILED', ERROR_CODES.IMG_LOAD_FAILED, { url }));
    };

    img.src = url;
  });
}

/** 把已加载的图片重绘到 canvas 并编码成 PNG（超过 4096×4096 像素等比降采样）。 */
export async function toPngBlob(img) {
  const width = img.naturalWidth || img.width || 0;
  const height = img.naturalHeight || img.height || 0;
  if (!width || !height) throw failure('EMPTY_IMAGE', ERROR_CODES.EMPTY_IMAGE);

  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)));
  const canvasWidth = Math.max(1, Math.round(width * scale));
  const canvasHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw failure('PNG_ENCODE_FAILED', '无法创建 canvas 2d 上下文');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);

  const blob = await new Promise((resolve, reject) => {
    try {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(failure('PNG_ENCODE_FAILED', ERROR_CODES.PNG_ENCODE_FAILED));
      }, 'image/png');
    } catch (err) {
      // 污染的画布会在这里抛 SecurityError
      reject(failure('TAINTED_CANVAS', ERROR_CODES.TAINTED_CANVAS, { cause: String(err?.message || err) }));
    }
  });

  return { blob, width, height, canvasWidth, canvasHeight, scaled: scale < 1 };
}

/**
 * 抓取 url 并转成 PNG blob。
 * @returns {Promise<{blob: Blob, width: number, height: number, mode: string}>}
 */
export async function convertUrlToPng(url, { timeoutMs = LOAD_TIMEOUT_MS } = {}) {
  if (!url) throw failure('IMG_LOAD_FAILED', '缺少图片地址');
  if (/^(?:blob|file|chrome-extension):/i.test(url)) {
    throw failure('IMG_LOAD_FAILED', '不支持在扩展页加载该协议的图片');
  }

  const attempts = [];

  try {
    const img = await loadImage(url, { crossOrigin: true, timeoutMs });
    const result = await toPngBlob(img);
    return { ...result, mode: 'cors' };
  } catch (err) {
    attempts.push({ mode: 'cors', code: err.code, message: err.message });
    log.debug(`带 crossOrigin 加载失败（${err.code}），改为直连重试`);
  }

  try {
    const img = await loadImage(url, { crossOrigin: false, timeoutMs });
    const result = await toPngBlob(img);
    return { ...result, mode: 'nocors' };
  } catch (err) {
    attempts.push({ mode: 'nocors', code: err.code, message: err.message });
    const last = attempts[attempts.length - 1];
    throw failure(last?.code || 'IMG_LOAD_FAILED', last?.message, { attempts });
  }
}

/** 把页内 canvas 回传的字节包装成 Blob。 */
export function bytesToBlob(bytes, mime = 'image/png') {
  if (!bytes) throw failure('PNG_ENCODE_FAILED', '没有拿到图片字节');
  const view = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
  return new Blob([view], { type: mime || 'image/png' });
}
