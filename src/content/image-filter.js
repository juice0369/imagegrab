/**
 * 过滤规则：URL 黑名单 + DOM 上下文黑名单 + 尺寸 / 长宽比阈值 + data: 占位图 + 去重。
 *
 * 判定顺序（一条记录只会记第一个命中的原因）：地址无效 → 小体积 data: 占位图 →
 * 装饰区域（页头 / 页脚 / 导航等）→ URL 黑名单 → 尺寸 → 长宽比 → 重复。
 *
 * 输出「可直接下载的图片条目」，同时给出按原因分类的统计，方便排障：
 * 过滤统计会一路带到结果页，用户能看懂「为什么图片比我预想的少」。
 * 被判掉的条目也一样返回（`filtered`），结果页会把它们灰着列出来，误判的可以手动勾选捞回。
 */

import { DEFAULT_SETTINGS, SESSION_LIMITS } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { classifyUrl, makeDedupeKey, restoreOriginalUrl, getExtensionFromUrl, getOriginalRules } from '../shared/url-utils.js';

const log = createLogger('filter');

/** URL 关键字黑名单：图标、占位图、广告位、水印等不属于商品图。 */
export const URL_BLOCKLIST = [
  /logo/i,
  /icon/i,
  /sprite/i,
  /placeholder/i,
  /avatar/i,
  /loading/i,
  /default[-_]/i,
  /blank/i,
  /spacer/i,
  /1x1/i,
  /qrcode/i,
  /qr[-_]?code/i,
  /barcode/i,
  /nav[-_]/i,
  /watermark/i,
  /badge/i,
  /coupon/i,
  /\/tag[_\-/]/i,
  /shipping/i,
  /payment/i,
  /credit[-_]?card/i,
  /\.svg(?:$|[?#])/i,
  /\.ico(?:$|[?#])/i
];

/** 体积小于该值的 data: 图基本是占位符。 */
const DATA_PLACEHOLDER_MAX_LENGTH = 2048;

function createStats(scanned) {
  return {
    scanned,
    kept: 0,
    dropped: 0,
    /** 被丢弃的条目里，有多少条仍然会列在结果页上（invalid 之类的地址无法显示，不计入） */
    listed: 0,
    truncated: 0,
    /** 被过滤的条目太多、没有全部列出的数量 */
    filteredTruncated: 0,
    reasons: { invalid: 0, data: 0, url: 0, context: 0, tiny: 0, aspect: 0, duplicate: 0 }
  };
}

/** 组装一条可以展示 / 下载的图片条目。过滤掉的条目只多一个 filterReason，其余结构完全一致。 */
function createItem(record, kind, url, { id, filterReason = '', duplicateOf = '' }) {
  const item = {
    id,
    url,
    rawUrl: record.rawUrl,
    source: record.source,
    kind,
    ext: kind === 'data' ? sniffDataExtension(record.rawUrl) : getExtensionFromUrl(url, 'jpg'),
    alt: record.alt || '',
    domWidth: Number(record.domWidth) || 0,
    domHeight: Number(record.domHeight) || 0,
    naturalWidth: Number(record.naturalWidth) || 0,
    naturalHeight: Number(record.naturalHeight) || 0,
    alternates: []
  };
  if (filterReason) item.filterReason = filterReason;
  if (duplicateOf) item.duplicateOf = duplicateOf;
  return item;
}

/**
 * 过滤 + 去重。
 *
 * 返回 `{ items, filtered, stats }`：
 *  - `items`：通过全部规则、可以下载的条目；
 *  - `filtered`：被规则拦下的条目（同一套结构，多一个 `filterReason`），
 *    结果页会把它们灰着列出来，让用户看到「少了哪些、为什么少」并有机会手动捞回来。
 *    只有 `invalid`（地址无效）不列出——它根本没有可显示的地址。
 */
export function filterRecords(records = [], { settings = DEFAULT_SETTINGS, platformId = 'default' } = {}) {
  const stats = createStats(records.length);
  const rules = getOriginalRules(platformId);
  const byKey = new Map();
  const items = [];
  /** 被丢弃的记录，循环结束后统一转成可展示的条目 */
  const rejected = [];
  let nextId = 1;

  const drop = (reason, record = null, extra = {}) => {
    stats.reasons[reason] += 1;
    stats.dropped += 1;
    if (record) rejected.push({ record, reason, ...extra });
  };

  for (const record of records) {
    const rawUrl = record.rawUrl;
    const kind = classifyUrl(rawUrl);

    if (kind === 'invalid') {
      drop('invalid');
      continue;
    }

    if (kind === 'data') {
      // 小体积 data: 图是占位符；大体积的当作真实图片保留（转换走 offscreen）
      if (rawUrl.length < DATA_PLACEHOLDER_MAX_LENGTH) {
        drop('data', record);
        continue;
      }
    } else {
      // 装饰区域先于 URL 黑名单判断：图片在不在页头 / 页脚 / 导航里是直接读到的 DOM 事实，
      // 比「文件名里带 logo」这类关键字更可信。footer 里的 nav/logo.png 会被记成「装饰区域」，
      // 而不是「URL 命中黑名单」——卡片上写「位于导航、页脚…」比写「命中 logo 关键字」更贴切，
      // 用户也更容易判断这条到底该不该捞回来。
      if (record.decorationAncestor) {
        drop('context', record);
        continue;
      }

      if (URL_BLOCKLIST.some((re) => re.test(rawUrl))) {
        drop('url', record);
        continue;
      }
    }

    const naturalWidth = Number(record.naturalWidth) || 0;
    const naturalHeight = Number(record.naturalHeight) || 0;
    const domWidth = Number(record.domWidth) || 0;
    const domHeight = Number(record.domHeight) || 0;
    const hasNatural = naturalWidth > 0 && naturalHeight > 0;

    if (hasNatural) {
      if (naturalWidth < settings.minWidth || naturalHeight < settings.minHeight) {
        drop('tiny', record);
        continue;
      }
      const ratio = naturalWidth / naturalHeight;
      if (ratio > settings.maxAspectRatio || ratio < 1 / settings.maxAspectRatio) {
        drop('aspect', record);
        continue;
      }
    } else {
      // 拿不到真实尺寸（懒加载 / 未加载 / 背景图）：用展示尺寸做近似判断
      const displayWidth = domWidth || 0;
      const displayHeight = domHeight || 0;
      if (displayWidth && displayHeight) {
        const minDisplay = Number(settings.minDisplaySize) || 0;
        if (displayWidth < minDisplay || displayHeight < minDisplay) {
          drop('tiny', record);
          continue;
        }
        const ratio = displayWidth / displayHeight;
        if (ratio > settings.maxAspectRatio || ratio < 1 / settings.maxAspectRatio) {
          drop('aspect', record);
          continue;
        }
      }
    }

    const url = kind === 'http' ? restoreOriginalUrl(rawUrl, rules) : rawUrl;
    const key = makeDedupeKey(url);

    const existing = byKey.get(key);
    if (settings.dedupe !== false && existing) {
      drop('duplicate', record, { duplicateOf: existing.id });
      if (existing.alternates.length < SESSION_LIMITS.maxAlternateUrls && existing.rawUrl !== rawUrl && !existing.alternates.includes(rawUrl)) {
        existing.alternates.push(rawUrl);
      }
      continue;
    }

    const item = createItem(record, kind, url, { id: `img_${nextId}` });
    nextId += 1;

    byKey.set(key, item);
    items.push(item);
  }

  const maxImages = Math.max(1, Number(settings.maxImages) || 500);
  const limited = items.slice(0, maxImages);
  stats.truncated = Math.max(0, items.length - limited.length);
  stats.kept = limited.length;

  // 被过滤的条目同样有上限：结果页要渲染它们，不能让长页面里的图标把会话撑爆
  const maxFiltered = Math.max(0, Number(settings.maxFilteredImages ?? DEFAULT_SETTINGS.maxFilteredImages));
  const listedRejected = rejected.slice(0, maxFiltered);
  stats.filteredTruncated = Math.max(0, rejected.length - listedRejected.length);
  const filtered = listedRejected.map(({ record, reason, duplicateOf }) => {
    const kind = classifyUrl(record.rawUrl);
    const url = kind === 'http' ? restoreOriginalUrl(record.rawUrl, rules) : record.rawUrl;
    const item = createItem(record, kind, url, { id: `img_${nextId}`, filterReason: reason, duplicateOf });
    nextId += 1;
    return item;
  });
  stats.listed = filtered.length;

  log.info(
    `过滤完成：扫描 ${stats.scanned} → 保留 ${stats.kept}（列出被过滤的 ${stats.listed}），丢弃 ${stats.dropped}：` +
      Object.entries(stats.reasons)
        .filter(([, value]) => value > 0)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')
  );

  return { items: limited, filtered, stats };
}

function sniffDataExtension(dataUrl) {
  const match = /^data:image\/([a-z0-9.+-]+);/i.exec(dataUrl);
  if (!match) return 'png';
  const mime = match[1].toLowerCase();
  if (mime === 'jpeg' || mime === 'jpg') return 'jpg';
  if (mime === 'svg+xml') return 'svg';
  return mime.replace(/[^a-z0-9]/g, '') || 'png';
}

/** 把过滤统计转成一句人话，面板与结果页共用。 */
export function describeFilterStats(stats, reasonLabels) {
  if (!stats) return '';
  const parts = Object.entries(stats.reasons || {})
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${value} 张${reasonLabels?.[key] || key}`);
  const listed = stats.listed ? `，其中 ${stats.listed} 张也列在结果页里（灰色卡片，默认不勾选）` : '';
  if (!parts.length) return `扫描到 ${stats.scanned} 个地址，保留 ${stats.kept} 张${listed}`;
  return `扫描到 ${stats.scanned} 个地址，保留 ${stats.kept} 张，过滤掉 ${stats.dropped} 张（${parts.join('、')}）${listed}`;
}
