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

/** 上下文失效的专用错误工厂：文案直接取 ERROR_CODES，保证 UI 里不会露出英文原文。 */
export function createContextInvalidatedError() {
  return Object.assign(new Error(ERROR_CODES.CONTEXT_INVALIDATED), { code: 'CONTEXT_INVALIDATED' });
}

/**
 * 判断一个错误是不是「扩展上下文已失效」。
 *
 * 成因只有一个：扩展被重新加载 / 更新后，页面里旧的 content script 与结果页被孤立，
 * 之后任何 chrome.* 调用都会被浏览器拒绝（原文是 `Extension context invalidated.`）。
 * 它和普通的网络失败不同 —— 重试没有意义，唯一的出路是刷新页面让新脚本重新注入，
 * 所以 UI 必须区别对待。
 */
export function isContextInvalidated(err) {
  if (!err) return false;
  if (err.code === 'CONTEXT_INVALIDATED') return true;
  return /Extension context invalidated/i.test(err.message || '');
}

/**
 * 浏览器自己抛的几句内部错误原文。
 *
 * 这些是 chrome.* 的运行时错误，不是本扩展的文案，直接贴到界面上等于什么都没说
 * （用户看到的正是 `Extension context invalidated.`），统一换成 ERROR_CODES 里的中文。
 */
const CHROME_INTERNAL_TEXT_RE =
  /^(?:Extension context invalidated|Could not establish connection|Receiving end does not exist|The message port closed before a response was received|A listener indicated an asynchronous response)/i;

/** 把各种形态的失败原因归一化成带 code 的 Error。 */
export function toError(reason, code = 'UNKNOWN') {
  const error =
    reason instanceof Error
      ? (reason.code ? reason : Object.assign(reason, { code }))
      : Object.assign(new Error((typeof reason === 'string' ? reason : JSON.stringify(reason)) || ERROR_CODES.UNKNOWN), {
          code
        });
  const text = error.message || '';
  // 浏览器原文自带准确语义，比调用方传进来的通用错误码更可信
  if (/Extension context invalidated/i.test(text)) error.code = 'CONTEXT_INVALIDATED';
  if (CHROME_INTERNAL_TEXT_RE.test(text)) error.message = ERROR_CODES[error.code] || ERROR_CODES.UNKNOWN;
  return error;
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
  // 先自检：扩展被重新加载后 chrome.runtime.sendMessage 会同步抛错，
  // 与其等它抛英文错误，不如直接给出「请刷新页面」的可执行提示。
  if (!isExtensionAlive()) throw createContextInvalidatedError();

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
  if (!isExtensionAlive()) throw createContextInvalidatedError();

  const task = (async () => {
    let response;
    try {
      response = await chrome.tabs.sendMessage(tabId, message, typeof frameId === 'number' ? { frameId } : undefined);
    } catch (err) {
      const text = err?.message || '';
      const code = /Receiving end does not exist|Could not establish connection/i.test(text) ? 'PAGE_GONE' : inferCode(text);
      throw toError(err, code);
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
