/**
 * 页内 canvas 回退转换。
 *
 * 用在扩展侧（offscreen）抓图失败的场景：由当前页面自己去加载图片再转 PNG，
 * 成功后把 PNG 字节（ArrayBuffer）通过 sendMessage 结构化克隆回传给 SW，
 * 由 offscreen 包装成 blob 地址。这里刻意不传 blob 地址 —— 页面创建的
 * `blob:` 属于页面源，chrome.downloads 用不了。
 *
 * 三态探测（必须的）：带 crossOrigin 尝试 → 失败则去掉 crossOrigin 重试 →
 * 用 toBlob 是否抛异常判断 canvas 是否被污染。
 */

import { MAX_PIXELS, MAX_TRANSFER_BYTES, ERROR_CODES } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('inpage');

export const PER_IMAGE_TIMEOUT_MS = 20000;

function failure(code, message, extra = {}) {
  return Object.assign(new Error(message || ERROR_CODES[code] || code), { code, ...extra });
}

/** 加载图片（不插入 DOM，避免影响页面布局）。 */
export function loadImageElement(url, { crossOrigin = false, timeoutMs = PER_IMAGE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';

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
      reject(failure('IMG_LOAD_FAILED', '图片加载失败（404、防盗链或需要登录）', { url }));
    };

    img.src = url;
  });
}

/** 把已加载的 img 画到 canvas 并编码成 PNG。 */
export async function encodeImageToPng(img) {
  const width = img.naturalWidth || img.width || 0;
  const height = img.naturalHeight || img.height || 0;
  if (!width || !height) throw failure('EMPTY_IMAGE', '图片尺寸为 0，无法解码');

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
        else reject(failure('PNG_ENCODE_FAILED', 'PNG 编码失败'));
      }, 'image/png');
    } catch (err) {
      // 污染的画布会在这里抛 SecurityError
      reject(failure('TAINTED_CANVAS', '画布被跨域图片污染，无法读取像素', { cause: String(err?.message || err) }));
    }
  });

  return { blob, width, height, scaled: scale < 1 };
}

/**
 * 页内转换入口。
 * @returns {Promise<{ok: true, bytes: ArrayBuffer, width: number, height: number, mime: string, mode: string, bytesLength: number}
 *   | {ok: false, code: string, message: string}>}
 */
export async function convertInPage(url, { timeoutMs = PER_IMAGE_TIMEOUT_MS } = {}) {
  if (!url || !/^https?:/i.test(url)) {
    return { ok: false, code: 'PAGE_CONVERT_FAILED', message: '页内回退只支持 http(s) 图片地址' };
  }

  const attempts = [];

  // 第一态：带 crossOrigin（如果对方返回 CORS 头，画布一定干净）
  try {
    const img = await loadImageElement(url, { crossOrigin: true, timeoutMs });
    const result = await encodeImageToPng(img);
    return finish(result, 'cors');
  } catch (err) {
    attempts.push({ mode: 'cors', code: err.code, message: err.message });
    log.debug('带 crossOrigin 的页内转换失败，去掉 crossOrigin 重试', err.code);
  }

  // 第二态：不带 crossOrigin（可能被污染）
  try {
    const img = await loadImageElement(url, { crossOrigin: false, timeoutMs });
    const result = await encodeImageToPng(img);
    return finish(result, 'nocors');
  } catch (err) {
    attempts.push({ mode: 'nocors', code: err.code, message: err.message });
    log.debug('页内转换最终失败', err.code);
    const last = attempts[attempts.length - 1];
    return {
      ok: false,
      code: last?.code || 'PAGE_CONVERT_FAILED',
      message: last?.message || '页内 canvas 回退失败',
      attempts
    };
  }

  async function finish(result, mode) {
    const bytes = await result.blob.arrayBuffer();
    if (bytes.byteLength > MAX_TRANSFER_BYTES) {
      return {
        ok: false,
        code: 'PNG_TOO_LARGE',
        message: `转换后的 PNG 有 ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB，超过单次传输上限`,
        attempts
      };
    }
    log.info(`页内转换成功（${mode}）：${result.width}×${result.height}，${(bytes.byteLength / 1024).toFixed(0)}KB`);
    return {
      ok: true,
      bytes,
      width: result.width,
      height: result.height,
      mime: 'image/png',
      mode,
      scaled: result.scaled,
      bytesLength: bytes.byteLength
    };
  }
}

/** 处理 SW 发来的 IG_CONVERT_IN_PAGE 请求，返回给 sendResponse 的对象。 */
export async function handleConvertInPageRequest(message) {
  const result = await convertInPage(message?.url, { timeoutMs: message?.timeoutMs });
  if (result.ok) {
    return {
      ok: true,
      bytes: result.bytes,
      width: result.width,
      height: result.height,
      mime: result.mime,
      mode: result.mode,
      bytesLength: result.bytesLength
    };
  }
  return { ok: false, code: result.code, message: result.message, attempts: result.attempts };
}
