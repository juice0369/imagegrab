/**
 * 纯字符串 URL 工具：补全相对地址、分类、srcset 解析、原图还原、去重键、文件名清洗。
 * 这里刻意不碰任何 DOM API，所以 content script 与 service worker 都能直接 import。
 */

/** 明确不支持 / 无法复用的协议。 */
const UNSUPPORTED_SCHEME_RE =
  /^(?:javascript|mailto|tel|about|chrome|chrome-extension|moz-extension|edge|blob|file|ftp|ftps|data:text|ws|wss):/i;

/** 常见图片扩展名。 */
export const IMAGE_EXT_RE = /\.(?:jpe?g|png|webp|gif|bmp|avif|svg|ico|tiff?)(?:$|[?#])/i;

/**
 * 阿里系 CDN（alicdn / taobaocdn / tbcdn）的尺寸后缀。
 *
 * 每一项是 `[正则, 替换]`：替换串必须保留被匹配到的 `.扩展名`，否则
 * `a_400x400.png` 会被削成没有扩展名的 `a`（下载时连文件类型都判不出来）。
 * 例：`O1CN01abc.jpg_400x400.jpg` → `O1CN01abc.jpg`，`a_50x50xz.jpg` → `a.jpg`,
 * `a_400x400.png` → `a.png`。
 *
 * 注意：规则可能误伤本来就带 `_宽x高` 的文件名，因此转换与下载都会先试还原地址、
 * 失败再退回页面上的原始地址（见 download-manager 的双地址回退）。
 */
export const ALI_RESIZE_SUFFIX_PATTERNS = [
  // 形如 `xxx.jpg_400x400.jpg` → `xxx.jpg`：原图地址自己已经带扩展名，整段后缀删掉
  [/(\.(?:jpe?g|png|webp|gif))_\d+x\d+(?:xz|q\d+)?(?:_\d+x\d+)*\.(?:jpe?g|png|webp|gif)$/i, '$1'],
  // 形如 `xxx_400x400.png` → `xxx.png`：只有一份扩展名，必须保留它
  [/_\d+x\d+(?:xz|q\d+)?(?:_\d+x\d+)*(\.(?:jpe?g|png|webp|gif))$/i, '$1'],
  [/(\.(?:jpe?g|png|webp|gif))_q\d+\.(?:jpe?g|png|webp|gif)$/i, '$1'],
  [/_(?:q\d+)(\.(?:jpe?g|png|webp|gif))$/i, '$1'],
  [/(\.(?:jpe?g|png|webp|gif))_(?:sum|s\d{2,4}|b|ba)\.(?:jpe?g|png|webp|gif)$/i, '$1'],
  [/_(?:sum|s\d{2,4}|b|ba)(\.(?:jpe?g|png|webp|gif))$/i, '$1'],
  [/(\.(?:jpe?g|png|webp))_\.webp$/i, '$1'],
  [/(\.(?:jpe?g|png|webp))\.webp$/i, '$1']
];

/** 京东图片 URL 的路径级还原：`/n5/` → `/n0/`（n0 为原图），`s450x450_jfs` → `jfs`。 */
export const JD_PATH_REPLACERS = [
  [/\/n\d+\//i, '/n0/'],
  [/([/_])s\d+x\d+_/gi, '$1'],
  [/\/imgzone\//i, '/n0/']
];

/** 拼多多图片查询串里与缩放 / 水印相关的参数，还原原图时整段去掉。 */
export const PDD_QUERY_BLOCKLIST = [
  /imageMogr2/i,
  /thumbnail/i,
  /imageView2/i,
  /watermark/i,
  /x-oss-process/i,
  /image_process/i
];

/**
 * 与图片内容**无关**的查询参数：淘宝/天猫的埋点（spm、ali_trackid）、
 * 各种缓存刷新参数（t、_、timestamp）、常见 UTM 埋点。
 *
 * 这些参数不影响返回哪一张图，但会进入去重键。淘宝给图片挂 `?spm=…` 是常态，
 * 如果不在这里丢掉，同一张商品图会因为埋点不同而被当成好几张，结果页就会重复。
 */
export const TRACKING_QUERY_RE = [
  /^spm(?:[_-].*)?$/i,
  /^ali_trackid$/i,
  /^ali_refid$/i,
  /^ali_redirect$/i,
  /^scm$/i,
  /^abbucket$/i,
  /^from$/i,
  /^source$/i,
  /^t$/i,
  /^ts$/i,
  /^_$/i,
  /^timestamp$/i,
  /^utms?_.+$/i,
  /^wh_(?:source|cmPID|refpid|pvid|bts)$/i,
  /^bx_/i,
  /^cvid$/i
];

/**
 * 阿里系 CDN 的「容器路径」别名。
 *
 * 同一个文件在阿里 CDN 上有多条等价路径，最典型的是商品图同时以这两种形式出现：
 *   https://img.alicdn.com/imgextra/i2/<uid>/O1CN01xxx.jpg
 *   https://gw.alicdn.com/bao/uploaded/i2/<uid>/O1CN01xxx.jpg
 * 两者是同一张图，只是走了不同的 CDN 入口。这里把容器段统一去掉，
 * 只留下真正标识资源的 `iN/<uid>/<文件名>`，否则同一张图会在结果页里出现两次。
 *
 * 只在阿里系 CDN 上启用（见 CDN_RULES），不会作用于普通站点。
 */
export const ALI_PATH_CONTAINER_RE = /\/(?:bao\/uploaded|imgextra|img\/ibank|kf)\//gi;

/**
 * 已知图片 CDN 的归一化规则：
 *  - host：主机名正则（含各子域）
 *  - key：归一后的主机标识（同时抹掉 http/https 差异）
 *  - pathAlias：可选的路径别名正则，用于抹掉同一 CDN 的等价容器路径
 *
 * 只归一「已知图片 CDN」。不同站点上的同名路径完全可能是两张不同的图
 * （例如 localhost 与 127.0.0.1），所以不做通用的跨域 / 跨路径合并。
 */
export const CDN_RULES = [
  { host: /^(?:[\w-]+\.)*alicdn\.com$/i, key: 'cdn:alicdn.com', pathAlias: ALI_PATH_CONTAINER_RE },
  { host: /^(?:[\w-]+\.)*taobaocdn\.com$/i, key: 'cdn:taobaocdn.com', pathAlias: ALI_PATH_CONTAINER_RE },
  { host: /^(?:[\w-]+\.)*tbcdn\.cn$/i, key: 'cdn:tbcdn.cn', pathAlias: ALI_PATH_CONTAINER_RE },
  { host: /^(?:[\w-]+\.)*360buyimg\.com$/i, key: 'cdn:360buyimg.com' },
  { host: /^(?:[\w-]+\.)*pddpic\.com$/i, key: 'cdn:pddpic.com' }
];

/**
 * 归一「主机名 + 路径」。
 * 命中已知 CDN 时返回归一后的主机标识与路径；否则原样返回（只规范化斜杠）。
 */
function canonicalize(origin, path) {
  const separator = origin.indexOf('://');
  const host = separator >= 0 ? origin.slice(separator + 3) : origin;
  for (const rule of CDN_RULES) {
    if (!rule.host.test(host)) continue;
    const normalizedPath = rule.pathAlias ? path.replace(rule.pathAlias, '/') : path;
    return { origin: rule.key, path: normalizedPath.replace(/\/{2,}/g, '/') };
  }
  return { origin, path };
}

/** 按平台给出的原图还原规则。平台改版时只需要动这里。 */
export const ORIGINAL_RULES = Object.freeze({
  taobao: { suffixPatterns: ALI_RESIZE_SUFFIX_PATTERNS },
  tmall: { suffixPatterns: ALI_RESIZE_SUFFIX_PATTERNS },
  jd: { pathReplacers: JD_PATH_REPLACERS },
  pinduoduo: { queryBlocklist: PDD_QUERY_BLOCKLIST },
  'pdd-merchant': { queryBlocklist: PDD_QUERY_BLOCKLIST },
  'local-test': { suffixPatterns: ALI_RESIZE_SUFFIX_PATTERNS },
  default: { suffixPatterns: ALI_RESIZE_SUFFIX_PATTERNS }
});

export function getOriginalRules(platformId) {
  return ORIGINAL_RULES[platformId] || ORIGINAL_RULES.default;
}

/** 把 URL 拆成路径与 ?query#hash 两部分。 */
export function splitUrl(url) {
  const text = String(url || '');
  const index = text.search(/[?#]/);
  if (index < 0) return { path: text, tail: '' };
  return { path: text.slice(0, index), tail: text.slice(index) };
}

function filterQueryParams(tail, blocklist) {
  if (!tail || !blocklist || !blocklist.length) return tail;
  const hashIndex = tail.indexOf('#');
  const hash = hashIndex >= 0 ? tail.slice(hashIndex) : '';
  const beforeHash = hashIndex >= 0 ? tail.slice(0, hashIndex) : tail;
  if (!beforeHash.startsWith('?')) return tail;
  const kept = beforeHash
    .slice(1)
    .split('&')
    .filter((pair) => pair && !blocklist.some((re) => re.test(pair)));
  return (kept.length ? `?${kept.join('&')}` : '') + hash;
}

/**
 * 把缩略图地址还原成（推测的）原图地址。
 * 无法还原或不是 http(s) 时原样返回。
 */
export function restoreOriginalUrl(url, rules, { maxRounds = 3 } = {}) {
  if (!url || !/^https?:/i.test(url) || !rules) return url;
  const { path, tail } = splitUrl(url);
  let nextPath = path;

  if (Array.isArray(rules.pathReplacers)) {
    for (const [pattern, replacement] of rules.pathReplacers) {
      nextPath = nextPath.replace(pattern, replacement);
    }
  }

  if (Array.isArray(rules.suffixPatterns)) {
    // 阿里系的尺寸后缀可能叠加（xxx.jpg_400x400.jpg_.webp），所以要循环剥离。
    // 每一项可以是 `[正则, 替换]`，也可以只给正则（等价于替换成空串）。
    for (let round = 0; round < maxRounds; round += 1) {
      let changed = false;
      for (const entry of rules.suffixPatterns) {
        const [pattern, replacement] = Array.isArray(entry) ? entry : [entry, ''];
        const candidate = nextPath.replace(pattern, replacement);
        if (candidate !== nextPath) {
          nextPath = candidate;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  const nextTail = Array.isArray(rules.queryBlocklist) ? filterQueryParams(tail, rules.queryBlocklist) : tail;
  return nextPath + nextTail;
}

/** 生成去重键：忽略缩放参数、hash 与大小写差异。 */
/**
 * 丢掉「与图片内容无关」的查询参数（埋点、缓存刷新）。
 *
 * 与 filterQueryParams 的区别：这里**只看参数名**，不看参数值。
 * 埋点参数的特征在名字上（`spm`、`t`、`_`），值里是随机的追踪串，
 * 拿整个 `键=值` 去匹配锚定正则会永远匹配不上。
 */
function stripTrackingParams(tail) {
  if (!tail) return tail;
  const hashIndex = tail.indexOf('#');
  const hash = hashIndex >= 0 ? tail.slice(hashIndex) : '';
  const beforeHash = hashIndex >= 0 ? tail.slice(0, hashIndex) : tail;
  if (!beforeHash.startsWith('?')) return tail;
  const kept = beforeHash
    .slice(1)
    .split('&')
    .filter((pair) => {
      if (!pair) return false;
      const name = pair.split('=')[0];
      return !TRACKING_QUERY_RE.some((re) => re.test(name));
    });
  return (kept.length ? `?${kept.join('&')}` : '') + hash;
}

/**
 * 生成去重键：忽略缩放参数、埋点/缓存参数、hash、CDN 子域与等价容器路径、大小写差异。
 *
 * 让哪些 URL 视为「同一张图」完全由这个函数决定，所以它是重复条目的唯一关口。
 */
export function makeDedupeKey(url) {
  if (!url) return '';
  if (url.startsWith('data:')) return `data:${url.length}:${url.slice(0, 96)}`;
  const match = /^(https?:\/\/[^/?#]+)([^?#]*)([\s\S]*)$/i.exec(url);
  if (!match) return url;
  const rawPath = (match[2] || '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  const { origin, path } = canonicalize(match[1].toLowerCase(), rawPath);
  let tail = match[3] || '';
  // 先丢缩放 / 水印这类真的「改变输出」的转换参数，再丢埋点与缓存刷新参数
  tail = filterQueryParams(tail, PDD_QUERY_BLOCKLIST);
  tail = stripTrackingParams(tail);
  tail = tail.replace(/#.*$/, '');
  return origin + path + tail;
}

/** 取 URL 的图片扩展名，取不到时返回 fallback。 */
export function getExtensionFromUrl(url, fallback = '') {
  if (!url || typeof url !== 'string') return fallback;
  const { path } = splitUrl(url.startsWith('data:') ? '' : url);
  const match = /\.([a-z0-9]{2,5})$/i.exec(path);
  if (!match) return fallback;
  const ext = match[1].toLowerCase();
  return IMAGE_EXT_RE.test(`x.${ext}`) ? ext : fallback;
}

/** 是否是「看起来就是图片」的地址（用于 a[href] 的判断）。 */
export function isImageUrl(url) {
  return typeof url === 'string' && IMAGE_EXT_RE.test(splitUrl(url).path);
}

/**
 * 把页面里拿到的地址补全成绝对地址。
 * 返回 null 表示这个地址不可用（协议不支持、空串、纯锚点等）。
 */
export function normalizeUrl(raw, baseUrl) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;
  // 兼容 CSS 里的 url("...") 写法
  const cssUrl = /^url\(\s*(.*?)\s*\)$/i.exec(value);
  if (cssUrl) value = cssUrl[1].trim();
  value = value.replace(/^["']|["']$/g, '').trim();
  if (!value || value.startsWith('#')) return null;
  if (UNSUPPORTED_SCHEME_RE.test(value)) return null;
  if (value.startsWith('data:')) {
    // 只有 `data:,` 之前有内容、逗号之后还有负载时才可用；`data:image/gif;base64,` 这种空负载无法解码
    const comma = value.indexOf(',');
    return comma >= 0 && value.slice(comma + 1).trim().length > 0 ? value : null;
  }
  if (value.startsWith('//')) {
    try {
      return new URL(`https:${value}`).href;
    } catch {
      return null;
    }
  }
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return null;
  }
}

/** 地址分类：http / data / invalid。 */
export function classifyUrl(url) {
  if (!url) return 'invalid';
  if (url.startsWith('data:')) return 'data';
  if (/^https?:/i.test(url)) return 'http';
  return 'invalid';
}

function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

function descriptorInfo(descriptor) {
  const w = /^(\d+)w$/.exec(descriptor);
  if (w) return { w: Number(w[1]), x: null };
  const x = /^([\d.]+)x$/.exec(descriptor);
  if (x) return { w: null, x: Number(x[1]) };
  return { w: null, x: null };
}

/**
 * 按 HTML 规范解析 srcset：URL 段的非空白字符都是 URL 的一部分（逗号可以出现在 URL 内部），
 * 描述符读到下一个逗号为止。
 */
export function parseSrcset(srcset, baseUrl) {
  const out = [];
  if (typeof srcset !== 'string' || !srcset.trim()) return out;
  const text = srcset;
  const length = text.length;
  let i = 0;

  while (i < length) {
    while (i < length && (isWhitespace(text[i]) || text[i] === ',')) i += 1;
    if (i >= length) break;

    let urlEnd = i;
    while (urlEnd < length && !isWhitespace(text[urlEnd])) urlEnd += 1;
    const urlPart = text.slice(i, urlEnd);
    i = urlEnd;

    let descriptorEnd = i;
    while (descriptorEnd < length && text[descriptorEnd] !== ',') descriptorEnd += 1;
    const descriptor = text.slice(i, descriptorEnd).trim();
    i = descriptorEnd + 1;

    const url = urlPart.replace(/,+$/, '');
    if (!url) continue;
    const resolved = baseUrl ? normalizeUrl(url, baseUrl) : url;
    if (!resolved) continue;
    out.push({ url: resolved, descriptor, ...descriptorInfo(descriptor) });
  }
  return out;
}

/** 从 srcset 里挑最大候选：优先比较 w 描述符，其次 x 描述符，最后取最后一个。 */
export function pickLargestFromSrcset(srcset, baseUrl) {
  const candidates = parseSrcset(srcset, baseUrl);
  if (!candidates.length) return null;
  const byWidth = candidates.filter((c) => c.w);
  if (byWidth.length) return byWidth.reduce((a, b) => (b.w > a.w ? b : a)).url;
  const byDensity = candidates.filter((c) => c.x);
  if (byDensity.length) return byDensity.reduce((a, b) => (b.x > a.x ? b : a)).url;
  return candidates[candidates.length - 1].url;
}

/** 清洗文件名里不能出现的字符。 */
export function sanitizeFilename(name, fallback = 'file') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]+/g, '')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned || fallback;
}

/** 生成下载文件名：`商品图_001.png`。 */
export function buildFilename(index, extension, settings) {
  const prefix = sanitizeFilename(settings?.filenamePrefix || '商品图', '商品图');
  const pad = Math.max(1, Number(settings?.filenamePad) || 3);
  const ext = String(extension || 'png').replace(/^\./, '').toLowerCase() || 'png';
  const seq = String(Math.max(1, Number(index) || 1)).padStart(pad, '0');
  return `${prefix}_${seq}.${ext}`;
}

/**
 * 拼接下载路径（含可选的子目录）。
 *
 * 逐段清洗：丢掉空段、`.` 与 `..`，把各段里的非法字符换成下划线。
 * 必须在丢掉 `..` **之后**再决定首尾斜杠，否则 `../etc` 会变成 `/etc`——
 * 以 `/` 开头的 filename 会被 chrome.downloads 拒绝（它要求相对路径）。
 */
export function joinDownloadPath(subfolder, filename) {
  const dir = String(subfolder || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .map((segment) => sanitizeFilename(segment, ''))
    .filter(Boolean)
    .join('/');
  return dir ? `${dir}/${filename}` : filename;
}

/** 生成一个短随机 id。 */
export function randomId(prefix = 'id') {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}
