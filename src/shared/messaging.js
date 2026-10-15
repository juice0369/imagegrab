/**
 * chrome.runtime 消息的 Promise 封装：统一超时、统一错误码归一化。
 * 依赖 chrome.* API，可被 content script / service worker / 结果页使用。
 */

import { ERROR_CODES } from './constants.js';

/** 判断扩展上下文是否还有效（扩展重载后 content script 里的 chrome.runtime.id 会变成 undefined）。 */
export function isExtensionAlive() {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

/** 把各种形态的失败原因归一化成带 code 的 Error。 */
export function toError(reason, code = 'UNKNOWN') {
  if (reason instanceof Error) {
    if (!reason.code) reason.code = code;
    return reason;
  }
  const message = typeof reason === 'string' ? reason : JSON.stringify(reason);
  return Object.assign(new Error(message || ERROR_CODES.UNKNOWN), { code });
}

/** 依据 chrome 的报错文本推断更准确的错误码。 */
function inferCode(message) {
  const text = String(message || '');
  if (/Extension context invalidated/i.test(text)) return 'CONTEXT_INVALIDATED';
  if (/Receiving end does not exist|Could not establish connection/i.test(text)) return 'NO_RESPONSE';
  if (/message port closed|port closed before a response/i.test(text)) return 'MESSAGE_FAILED';
  return 'MESSAGE_FAILED';
}

/** 给 Promise 加超时（chrome 的 API 在 SW 被回收时可能永远不 resolve）。 */
export function withTimeout(promise, ms, code = 'TIMEOUT', message = '操作超时') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 发送一次性消息并等待应答。 */
export async function sendMessage(message, { timeoutMs = 10000 } = {}) {
  const task = (async () => {
    let response;
    try {
      response = await chrome.runtime.sendMessage(message);
    } catch (err) {
      throw toError(err, inferCode(err?.message));
    }
    if (response === undefined) {
      throw Object.assign(new Error(ERROR_CODES.NO_RESPONSE), { code: 'NO_RESPONSE' });
    }
    return response;
  })();
  try {
    return await withTimeout(task, timeoutMs, 'MESSAGE_TIMEOUT', ERROR_CODES.MESSAGE_TIMEOUT);
  } catch (err) {
    throw toError(err, err?.code || 'MESSAGE_FAILED');
  }
}

/** 向指定标签页的 content script 发送消息。 */
export async function sendTabMessage(tabId, message, { timeoutMs = 60000, frameId = 0 } = {}) {
  const task = (async () => {
    let response;
    try {
      response = await chrome.tabs.sendMessage(tabId, message, typeof frameId === 'number' ? { frameId } : undefined);
    } catch (err) {
      throw toError(err, /Receiving end does not exist/i.test(err?.message || '') ? 'PAGE_GONE' : 'MESSAGE_FAILED');
    }
    if (response === undefined) {
      throw Object.assign(new Error(ERROR_CODES.NO_RESPONSE), { code: 'NO_RESPONSE' });
    }
    return response;
  })();
  try {
    return await withTimeout(task, timeoutMs, 'MESSAGE_TIMEOUT', ERROR_CODES.MESSAGE_TIMEOUT);
  } catch (err) {
    throw toError(err, err?.code || 'MESSAGE_FAILED');
  }
}

/**
 * 在 onMessage 监听器里发送异步应答的便捷包装。
 * 返回 true 表示“稍后应答”，这是 Chrome 要求的写法。
 */
export function respondAsync(fn, sendResponse) {
  Promise.resolve()
    .then(fn)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: { code: err?.code || 'UNKNOWN', message: err?.message || String(err) } }));
  return true;
}
