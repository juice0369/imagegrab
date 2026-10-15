/**
 * 带开关与作用域前缀的日志。所有日志都带 [ImageGrab] 前缀，方便在
 * service worker / offscreen / 结果页的 Console 里过滤。
 */

import { EXT } from './constants.js';

let enabled = true;

/** 生产环境可以调用 setLogEnabled(false) 关掉 debug/info/warn。 */
export function setLogEnabled(value) {
  enabled = Boolean(value);
}

export function isLogEnabled() {
  return enabled;
}

function emit(level, scope, args) {
  // 错误永远输出，便于排障
  if (!enabled && level !== 'error') return;
  const prefix = scope ? `${EXT.logPrefix}[${scope}]` : EXT.logPrefix;
  const fn = typeof console[level] === 'function' ? console[level] : console.log;
  try {
    fn.call(console, prefix, ...args);
  } catch {
    /* console 不可用时静默 */
  }
}

export function createLogger(scope = '') {
  return {
    debug: (...args) => emit('debug', scope, args),
    info: (...args) => emit('info', scope, args),
    warn: (...args) => emit('warn', scope, args),
    error: (...args) => emit('error', scope, args),
    scoped: (sub) => createLogger(scope ? `${scope}:${sub}` : sub)
  };
}

export const logger = createLogger('');

/** 把任意异常整理成一行字符串，用于状态行与错误提示。 */
export function errText(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  const code = err.code ? `${err.code}: ` : '';
  return `${code}${err.message || String(err)}`;
}
