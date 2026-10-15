/**
 * DOM 扫描器：把页面上「已经存在」的图片地址尽可能完整地收集出来。
 *
 * 覆盖：img[src] / img[srcset] / source[srcset] / picture / 各种 data-* 懒加载属性 /
 * a[href] 指向图片 / 元素 style 里的 background-image / 计算样式里的 background-image /
 * shadowRoot（递归）/ 同源 iframe（递归）/ video[poster]。
 *
 * 产出的是「原始记录」，过滤交给 image-filter.js。
 */

import { DEFAULT_SETTINGS } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { normalizeUrl, pickLargestFromSrcset, isImageUrl } from '../shared/url-utils.js';

const log = createLogger('scan');

/** 懒加载图片常见的属性名。 */
const LAZY_URL_ATTRS = [
  'data-src',
  'data-lazy-src',
  'data-original',
  'data-original-src',
  'data-ks-lazyload',
  'data-lazyload-src',
  'data-url',
  'data-image',
  'data-img',
  'data-echo',
  'data-actualsrc',
  'data-background-image',
  'data-hi-res-src'
];

const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset', 'data-original-set'];

/** 装饰性区域的判定选择器（命中即整张图丢掉）。 */
export const DECORATION_ANCESTOR_SELECTOR = [
  'header',
  'footer',
  'nav',
  '[class*="logo" i]',
  '[id*="logo" i]',
  '[class*="avatar" i]',
  '[class*="icon" i]',
  '[class*="qrcode" i]',
  '[class*="qr-code" i]',
  '[class*="share" i]',
  '[class*="sprite" i]',
  '[class*="placeholder" i]',
  '[class*="thumb-nav" i]'
].join(',');

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'LINK',
  'META',
  'HEAD',
  'TITLE',
  'NOSCRIPT',
  'TEMPLATE',
  'BR',
  'CANVAS',
  'MAP',
  'AREA',
  'TRACK',
  'SOURCE'
]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 向上（含跨 shadow 边界）找出装饰性祖先。 */
export function findDecorationAncestor(element, maxDepth = 12) {
  let node = element;
  let depth = 0;
  while (node && depth < maxDepth) {
    if (node.nodeType === 1) {
      try {
        if (node.matches?.(DECORATION_ANCESTOR_SELECTOR)) {
          return node.tagName.toLowerCase() + (node.className ? `.${String(node.className).split(/\s+/)[0]}` : '');
        }
      } catch {
        /* 某些特殊元素不支持 matches */
      }
      if (node.tagName === 'BODY' || node.tagName === 'HTML') return null;
    }
    if (node.parentElement) {
      node = node.parentElement;
    } else {
      const root = node.getRootNode?.();
      node = root && root.host ? root.host : null;
    }
    depth += 1;
  }
  return null;
}

/** 记录节点的位置信息。 */
function rectOf(element) {
  try {
    const rect = element.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  } catch {
    return { width: 0, height: 0 };
  }
}

/** 逐个属性把懒加载地址挖出来。 */
function collectLazyAttributes(element, ctx) {
  for (const attr of LAZY_URL_ATTRS) {
    const value = element.getAttribute?.(attr);
    if (value && /^(?:https?:|\/\/|\.{0,2}\/|data:)/i.test(value.trim())) {
      ctx.add(value, `lazy:${attr}`, element);
    }
  }
  for (const attr of LAZY_SRCSET_ATTRS) {
    const value = element.getAttribute?.(attr);
    if (value) {
      const best = pickLargestFromSrcset(value, ctx.baseUrl);
      if (best) ctx.add(best, `lazy-srcset:${attr}`, element);
    }
  }
}

/** 从 CSS background-image 值里取出所有 url()。 */
export function extractBackgroundUrls(backgroundImage) {
  if (!backgroundImage || backgroundImage === 'none') return [];
  const out = [];
  const re = /url\(([^)]+)\)/gi;
  let match;
  while ((match = re.exec(backgroundImage))) {
    const url = match[1].trim().replace(/^["']|["']$/g, '');
    if (url) out.push(url);
  }
  return out;
}

/**
 * 扫描整个文档，返回原始记录数组。
 * records: { rawUrl, source, tagName, domWidth, domHeight, naturalWidth, naturalHeight, decorationAncestor }
 */
export function scanDocument({ settings = DEFAULT_SETTINGS } = {}) {
  const records = [];
  const baseUrl = typeof location !== 'undefined' ? location.href : undefined;
  const seenKeys = new Set();

  const add = (element, rawUrl, source, extra = {}) => {
    const url = normalizeUrl(rawUrl, baseUrl);
    if (!url) return;
    const dedupeProbe = `${source}|${url}|${extra.role || ''}`;
    if (seenKeys.has(dedupeProbe)) return;
    seenKeys.add(dedupeProbe);
    const decorationAncestor = element ? findDecorationAncestor(element) : null;
    const rect = extra.rect || (element ? rectOf(element) : { width: 0, height: 0 });
    records.push({
      rawUrl: url,
      source,
      tagName: element?.tagName ? element.tagName.toLowerCase() : '',
      role: extra.role || '',
      domWidth: extra.domWidth ?? rect.width,
      domHeight: extra.domHeight ?? rect.height,
      naturalWidth: extra.naturalWidth ?? 0,
      naturalHeight: extra.naturalHeight ?? 0,
      decorationAncestor,
      alt: extra.alt || ''
    });
  };

  const visit = (element) => {
    const tag = element.tagName;

    if (tag === 'IMG') {
      const rect = rectOf(element);
      const naturalWidth = element.naturalWidth || 0;
      const naturalHeight = element.naturalHeight || 0;
      const extra = { rect, naturalWidth, naturalHeight, alt: element.getAttribute('alt') || '' };
      const picture = element.closest?.('picture');
      let bestFromPicture = null;
      if (picture) {
        for (const source of picture.querySelectorAll('source[srcset]')) {
          const best = pickLargestFromSrcset(source.getAttribute('srcset'), baseUrl);
          if (best) {
            bestFromPicture = best;
            break;
          }
        }
      }
      const srcsetBest = element.getAttribute('srcset') ? pickLargestFromSrcset(element.getAttribute('srcset'), baseUrl) : null;
      const lazySrcsetBest = pickLargestFromSrcset(
        LAZY_SRCSET_ATTRS.map((attr) => element.getAttribute(attr)).filter(Boolean).join(', '),
        baseUrl
      );
      const src = element.getAttribute('src') || element.currentSrc || '';

      // 同一个 <img> 只取「最大分辨率」的那一个候选，避免同一个画面出现多档尺寸的重复条目
      if (bestFromPicture) add(element, bestFromPicture, 'picture-source', extra);
      else if (srcsetBest) add(element, srcsetBest, 'srcset', extra);
      else if (lazySrcsetBest) add(element, lazySrcsetBest, 'lazy-srcset', extra);
      else if (src) add(element, src, 'img', extra);

      // data-* 懒加载地址单独收一遍（可能是完全不同的资源，交给去重处理）。
      //
      // 尺寸要小心：占位图还留在 src 里时，naturalWidth 反映的是占位图（常见是 1×1），
      // 不能拿它代表 data-src 指向的那张图，否则真实的大图会被当成「尺寸过小」误删。
      // 只有当元素当前加载的确实就是这个地址时，才采信它的真实像素尺寸。
      const currentSrc = normalizeUrl(element.getAttribute('src') || element.currentSrc || '', baseUrl);
      collectLazyAttributes(element, {
        baseUrl,
        add: (raw, source) => {
          const target = normalizeUrl(raw, baseUrl);
          const sameImage = Boolean(target) && currentSrc === target;
          add(element, raw, source, {
            ...extra,
            naturalWidth: sameImage ? extra.naturalWidth : 0,
            naturalHeight: sameImage ? extra.naturalHeight : 0
          });
        }
      });
      return;
    }

    if (tag === 'VIDEO') {
      const poster = element.getAttribute('poster');
      if (poster) add(element, poster, 'video-poster');
      return;
    }

    if (tag === 'A') {
      const href = element.getAttribute('href');
      if (href) {
        const normalized = normalizeUrl(href, baseUrl);
        if (normalized && isImageUrl(normalized)) add(element, normalized, 'link-href');
      }
      return;
    }

    // 内联 style 里的背景图：便宜且精确
    const inlineStyle = element.getAttribute?.('style');
    if (inlineStyle && /background/i.test(inlineStyle)) {
      for (const raw of extractBackgroundUrls(inlineStyle)) add(element, raw, 'inline-background');
    }
  };

  const walk = (root, depth = 0) => {
    if (!root || depth > 4) return;
    let elements = [];
    try {
      elements = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
    } catch {
      return;
    }
    for (const element of elements) {
      try {
        visit(element);
      } catch (err) {
        log.debug('visit 失败（忽略该元素）', err);
      }
      if (element.shadowRoot) walk(element.shadowRoot, depth + 1);
      if (element.tagName === 'IFRAME') {
        try {
          const doc = element.contentDocument;
          if (doc && doc.documentElement) walk(doc, depth + 1);
        } catch {
          // 跨域 iframe：浏览器安全边界，明确不处理
        }
      }
    }
  };

  const root = typeof document !== 'undefined' ? document : null;
  if (!root) return records;

  walk(root);
  // querySelectorAll('*') 不含 body/html，显式补一次（body 背景图很常见）
  for (const extraRoot of [root.body, root.documentElement]) {
    if (extraRoot) {
      try {
        visit(extraRoot);
      } catch {
        /* 忽略 */
      }
    }
  }

  // 计算样式里的背景图：先按面积过阈值，再取 getComputedStyle，避免全量调用导致卡顿
  scanComputedBackgrounds(root, add, settings);

  log.info(`扫描完成，原始记录 ${records.length} 条`);
  return records;
}

function scanComputedBackgrounds(root, add, settings) {
  const minArea = Number(settings.minAreaForBackgroundScan) || 0;
  const maxElements = Number(settings.maxBackgroundScanElements) || 3000;
  let elements;
  try {
    elements = Array.from(root.querySelectorAll('*'));
  } catch {
    return;
  }
  let examined = 0;
  for (const element of elements) {
    if (examined >= maxElements) {
      log.info(`背景图扫描达到元素上限 ${maxElements}，后续元素跳过`);
      break;
    }
    const tag = element.tagName;
    if (SKIP_TAGS.has(tag) || tag === 'IMG' || tag === 'svg') continue;
    examined += 1;
    let area = 0;
    try {
      area = element.clientWidth * element.clientHeight;
    } catch {
      area = 0;
    }
    if (area < minArea) continue;
    let backgroundImage = '';
    try {
      backgroundImage = window.getComputedStyle(element).backgroundImage || '';
    } catch {
      continue;
    }
    if (!backgroundImage || backgroundImage === 'none') continue;
    for (const raw of extractBackgroundUrls(backgroundImage)) add(element, raw, 'computed-background');
  }
}

/** 等待未完成的 img 加载（限时），让 naturalWidth 尽可能拿到真实尺寸。 */
async function waitForImages(container, timeoutMs) {
  const images = Array.from(container.querySelectorAll('img')).filter((img) => !img.complete);
  if (!images.length) return;
  await Promise.race([
    Promise.all(
      images.map(
        (img) =>
          new Promise((resolve) => {
            const done = () => {
              img.removeEventListener('load', done);
              img.removeEventListener('error', done);
              resolve();
            };
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
            setTimeout(done, timeoutMs);
          })
      )
    ),
    delay(timeoutMs + 200)
  ]);
}

/**
 * 懒加载预热：分步滚动到底再滚回原位，触发 IntersectionObserver 把 data-src 写进 src。
 */
export async function preloadByScrolling({ settings = DEFAULT_SETTINGS, onProgress = () => {} } = {}) {
  if (typeof window === 'undefined') return { steps: 0, restored: false };
  const stepDelayMs = Math.max(120, Number(settings.scrollStepDelayMs) || 400);
  const maxSteps = Math.max(1, Number(settings.scrollMaxSteps) || 30);
  const originalY = window.scrollY || 0;
  const viewportHeight = Math.max(200, window.innerHeight || 600);
  const docHeight = Math.max(
    document.documentElement?.scrollHeight || 0,
    document.body?.scrollHeight || 0,
    viewportHeight
  );
  const stepSize = viewportHeight * 0.85;
  const totalSteps = Math.min(maxSteps, Math.ceil(docHeight / stepSize) + 1);

  let steps = 0;
  try {
    for (let i = 0; i < totalSteps; i += 1) {
      const y = Math.min(Math.round(i * stepSize), Math.max(0, docHeight - viewportHeight));
      window.scrollTo({ top: y, left: 0, behavior: 'instant' });
      steps += 1;
      onProgress({ phase: 'scroll', step: steps, total: totalSteps });
      // eslint-disable-next-line no-await-in-loop
      await delay(stepDelayMs);
      if (y >= docHeight - viewportHeight - 1) break;
    }
    window.scrollTo({ top: docHeight, left: 0, behavior: 'instant' });
    await delay(Math.min(stepDelayMs, 300));
    await waitForImages(document, 800);
  } finally {
    window.scrollTo({ top: originalY, left: 0, behavior: 'instant' });
  }
  log.info(`懒加载预热完成：滚动 ${steps} 步，视口高 ${viewportHeight}，文档高 ${docHeight}`);
  return { steps, restored: true };
}

/** 扫描入口：可选预热 + DOM 扫描。 */
export async function scanPageImages({ settings = DEFAULT_SETTINGS, onProgress = () => {} } = {}) {
  if (settings.autoScroll) {
    await preloadByScrolling({ settings, onProgress });
  }
  onProgress({ phase: 'scan', step: 1, total: 1 });
  return scanDocument({ settings });
}
