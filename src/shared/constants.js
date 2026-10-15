/**
 * ImageGrab 全局常量：消息类型、存储键、默认设置、限制与状态枚举的单一来源。
 *
 * 该文件不依赖任何 DOM API，因此 content script、service worker、offscreen 文档
 * 与结果页都可以安全 import。
 */

export const EXT = Object.freeze({
  key: 'imagegrab',
  name: 'ImageGrab',
  displayName: '图提取 ImageGrab',
  logPrefix: '[ImageGrab]',
  version: '1.0.0'
});

/** content script ↔ service worker 之间的一次性消息。 */
export const MSG = Object.freeze({
  /** content → SW：一次提取完成，payload 里带图片列表 */
  EXTRACT_DONE: 'IG_EXTRACT_DONE',
  /** content → SW：源页面即将卸载（刷新/关闭/跳走） */
  SOURCE_UNLOADED: 'IG_SOURCE_UNLOADED',
  /** content → SW：请求页面内 canvas 回退转换 */
  CONVERT_IN_PAGE: 'IG_CONVERT_IN_PAGE',
  /**
   * content → SW：打开/聚焦某个会话的结果页。
   * content script 拿不到 chrome.tabs（浏览器只给内容脚本开放 storage / runtime 等少数 API），
   * 所以开标签页这件事必须交给 service worker 做。
   */
  OPEN_RESULTS: 'IG_OPEN_RESULTS',
  /** 排障：SW Console 里发 IG_DIAGNOSTICS 查看会话/端口/offscreen 状态 */
  DIAGNOSTICS: 'IG_DIAGNOSTICS'
});

/** 扩展内部消息的投递目标，用于把发给 offscreen 的消息和发给 SW 的消息区分开。 */
export const TARGET = Object.freeze({
  offscreen: 'offscreen',
  sw: 'service-worker'
});

/** service worker → offscreen 文档。 */
export const OFFSCREEN_MSG = Object.freeze({
  /** 抓取 URL 并转成 PNG blob 地址 */
  CONVERT: 'CONVERT',
  /** 把页内 canvas 回传的字节包装成 blob 地址 */
  BLOB_FROM_BYTES: 'BLOB_FROM_BYTES',
  /** 释放 blob 地址 */
  REVOKE: 'REVOKE',
  /** 健康检查 */
  PING: 'PING'
});

/** 结果页长连接的端口名与指令。 */
export const PORT_NAME = 'ig-batch';

/** results → service worker */
export const PORT_CMD = Object.freeze({
  INIT: 'INIT',
  START_DOWNLOAD: 'START_DOWNLOAD',
  CANCEL: 'CANCEL',
  RESUME: 'RESUME',
  REFRESH: 'REFRESH',
  FOCUS_SOURCE: 'FOCUS_SOURCE'
});

/** service worker → results */
export const PORT_PUSH = Object.freeze({
  /** 对 PORT_CMD 的应答 { reqId, ok, error, data } */
  ACK: 'ACK',
  /** 全量状态 { state } */
  STATE: 'STATE',
  /** 单张图片状态变化 { itemId, status, error, filename } */
  ITEM_PROGRESS: 'ITEM_PROGRESS',
  /** 任务汇总变化 { job } */
  JOB_UPDATE: 'JOB_UPDATE',
  /** 批次结束 { job, summary } */
  BATCH_DONE: 'BATCH_DONE',
  /** 源页面存活状态 { sid, sourceAlive } */
  SOURCE_STATE: 'SOURCE_STATE',
  /** 会话已被回收 */
  SESSION_GONE: 'SESSION_GONE',
  /** 非致命错误提示 { error } */
  ERROR: 'ERROR'
});

/** 单张图片的下载/转换状态。 */
export const ITEM_STATUS = Object.freeze({
  PENDING: 'pending',
  CONVERTING: 'converting',
  DOWNLOADING: 'downloading',
  DONE: 'done',
  /** 转换失败但已按原格式下载成功，不计入失败 */
  FALLBACK: 'fallback',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

export const ITEM_STATUS_LABEL = Object.freeze({
  pending: '未下载',
  converting: '转换中…',
  downloading: '下载中…',
  done: '已完成',
  fallback: '原格式',
  failed: '失败',
  cancelled: '已取消'
});

/** 批量任务状态。 */
export const JOB_STATUS = Object.freeze({
  RUNNING: 'running',
  FINISHED: 'finished',
  CANCELLED: 'cancelled',
  /** service worker 被回收或浏览器中断，可继续下载 */
  INTERRUPTED: 'interrupted'
});

/** 错误码 → 用户可读文案。界面统一通过 describeError() 取文案。 */
export const ERROR_CODES = Object.freeze({
  IMG_LOAD_FAILED: '图片加载失败（404、防盗链或需要登录）',
  IMG_TIMEOUT: '图片加载超时',
  EMPTY_IMAGE: '图片尺寸为 0，无法解码（可能是占位图或 SVG）',
  PNG_ENCODE_FAILED: 'PNG 编码失败',
  TAINTED_CANVAS: '跨域限制导致画布无法读取（对方未返回 CORS 头）',
  CONVERT_FAILED: '所有转换路径都失败',
  PNG_TOO_LARGE: '图片过大，超出单次传输上限',
  OFFSCREEN_ERROR: '后台转换服务不可用',
  OFFSCREEN_FAILED: '后台转换服务调用失败',
  PAGE_GONE: '源页面已关闭，无法使用页内回退',
  PAGE_CONVERT_FAILED: '页内 canvas 回退失败',
  DOWNLOAD_TIMEOUT: '等待下载完成超时',
  DOWNLOAD_FAILED: '下载失败',
  DOWNLOAD_INTERRUPTED: '下载被中断',
  USER_CANCELED: '下载被取消',
  FILE_ERROR: '写文件失败（路径或权限问题）',
  NETWORK_ERROR: '网络错误',
  SERVER_ERROR: '服务器错误',
  ITEM_NOT_FOUND: '图片记录已不存在',
  JOB_RUNNING: '已有下载任务进行中，请先取消或等待完成',
  NO_SELECTION: '请先勾选要下载的图片',
  SESSION_NOT_FOUND: '提取结果已失效（浏览器重启或会话过期）',
  NO_IMAGES: '没有找到可提取的图片',
  MESSAGE_FAILED: '消息发送失败（后台未响应）',
  MESSAGE_TIMEOUT: '消息超时（后台可能已休眠）',
  NO_RESPONSE: '接收方没有响应',
  CONTEXT_INVALIDATED: '扩展已重新加载，请刷新页面后重试',
  UNKNOWN_CMD: '未知指令',
  UNKNOWN_TYPE: '未知消息类型',
  UNKNOWN: '未知错误'
});

/** 取错误码对应的用户可读文案。 */
export function describeError(code, fallback) {
  if (!code) return fallback || ERROR_CODES.UNKNOWN;
  return ERROR_CODES[code] || fallback || String(code);
}

/** 过滤原因 → 文案。结果页与面板上的统计都走这里。 */
export const FILTER_REASONS = Object.freeze({
  invalid: '地址无效或不受支持',
  data: '占位图（体积过小的 data: 图）',
  url: 'URL 命中图标 / logo / 广告黑名单',
  context: '位于导航、页脚、图标等装饰区域',
  tiny: '尺寸过小',
  aspect: '长宽比异常（细长条）',
  duplicate: '与其它图片重复'
});

/** 默认设置。结果页展示的编号、并发数、过滤阈值都来自这里。 */
export const DEFAULT_SETTINGS = Object.freeze({
  // 提取阶段的过滤阈值
  minWidth: 200,
  minHeight: 200,
  minDisplaySize: 60,
  maxAspectRatio: 5,
  maxImages: 500,
  dedupe: true,
  // 懒加载预热
  autoScroll: true,
  scrollStepDelayMs: 400,
  scrollMaxSteps: 30,
  // 背景图扫描
  minAreaForBackgroundScan: 60 * 60,
  maxBackgroundScanElements: 3000,
  // 下载阶段
  concurrency: 3,
  convertTimeoutMs: 30000,
  downloadTimeoutMs: 120000,
  maxRetries: 2,
  filenamePrefix: '商品图',
  filenamePad: 3,
  /** 下载子目录，留空表示直接放进浏览器默认下载目录 */
  subfolder: ''
});

export const SESSION_LIMITS = Object.freeze({
  /** 会话有效期 2 小时 */
  ttlMs: 2 * 60 * 60 * 1000,
  /** 最多保留的会话数 */
  maxSessions: 10,
  /** 结果页断开连接后的宽限时间（避免刷新页面就删数据） */
  resultsTabGraceMs: 30000,
  /** 传给结果页的单张图片附加来源数量上限 */
  maxAlternateUrls: 3
});

export const STORAGE_KEYS = Object.freeze({
  sessions: 'ig:sessions',
  settings: 'ig:settings',
  panelPos: 'ig:panelPos'
});

/** offscreen 文档地址（SW 与 results 都可能引用）。 */
export const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
/** 结果页地址（相对于扩展根目录）。 */
export const RESULTS_PATH = 'src/results/results.html';

/** offscreen 里 blob 地址的存活上限，超过即回收，避免长期占用内存。 */
export const BLOB_TTL_MS = 10 * 60 * 1000;

/** 单次 page → extension 传输的 PNG 字节上限（结构化克隆的性能保护）。 */
export const MAX_TRANSFER_BYTES = 32 * 1024 * 1024;

/** canvas 最大像素数，超过则等比降采样，防止内存爆炸。 */
export const MAX_PIXELS = 4096 * 4096;

/** 结果页的关键筛选档位（长边像素）。 */
export const SIZE_FILTERS = Object.freeze([
  { id: 'all', label: '全部', min: 0 },
  { id: 'w400', label: '长边 ≥ 400', min: 400 },
  { id: 'w800', label: '长边 ≥ 800', min: 800 },
  { id: 'w1200', label: '长边 ≥ 1200', min: 1200 }
]);

/** 状态筛选档位，对应 ITEM_STATUS。 */
export const STATUS_FILTERS = Object.freeze([
  { id: 'all', label: '全部' },
  { id: 'none', label: '未处理' },
  { id: 'failed', label: '失败' },
  { id: 'done', label: '已完成' }
]);
