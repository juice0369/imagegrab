/**
 * 过滤规则：URL 黑名单 + DOM 上下文黑名单 + 尺寸 / 长宽比阈值 + data: 占位图 + 去重。
 *
 * 输出「可直接下载的图片条目」，同时给出按原因分类的统计，方便排障：
 * 过滤统计会一路带到结果页，用户能看懂「为什么图片比我预想的少」。
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
    truncated: 0,
    reasons: { invalid: 0, data: 0, url: 0, context: 0, tiny: 0, aspect: 0, duplicate: 0 }
  };
}

/**
 * 过滤 + 去重。
 * @param {Array} records scanDocument() 的输出
 * @param {{settings?: object, platformId?: string}} options
 */
export function filterRecords(records = [], { settings = DEFAULT_SETTINGS, platformId = 'default' } = {}) {
  const stats = createStats(records.length);
  const rules = getOriginalRules(platformId);
  const byKey = new Map();
  const items = [];

  const drop = (reason) => {
    stats.reasons[reason] += 1;
    stats.dropped += 1;
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
        drop('data');
        continue;
      }
    } else if (URL_BLOCKLIST.some((re) => re.test(rawUrl))) {
      drop('url');
      continue;
    }

    if (record.decorationAncestor) {
      drop('context');
      continue;
    }

    const naturalWidth = Number(record.naturalWidth) || 0;
    const naturalHeight = Number(record.naturalHeight) || 0;
    const domWidth = Number(record.domWidth) || 0;
    const domHeight = Number(record.domHeight) || 0;
    const hasNatural = naturalWidth > 0 && naturalHeight > 0;

    if (hasNatural) {
      if (naturalWidth < settings.minWidth || naturalHeight < settings.minHeight) {
        drop('tiny');
        continue;
      }
      const ratio = naturalWidth / naturalHeight;
      if (ratio > settings.maxAspectRatio || ratio < 1 / settings.maxAspectRatio) {
        drop('aspect');
        continue;
      }
    } else {
      // 拿不到真实尺寸（懒加载 / 未加载 / 背景图）：用展示尺寸做近似判断
      const displayWidth = domWidth || 0;
      const displayHeight = domHeight || 0;
      if (displayWidth && displayHeight) {
        const minDisplay = Number(settings.minDisplaySize) || 0;
        if (displayWidth < minDisplay || displayHeight < minDisplay) {
          drop('tiny');
          continue;
        }
        const ratio = displayWidth / displayHeight;
        if (ratio > settings.maxAspectRatio || ratio < 1 / settings.maxAspectRatio) {
          drop('aspect');
          continue;
        }
      }
    }

    const url = kind === 'http' ? restoreOriginalUrl(rawUrl, rules) : rawUrl;
    const key = makeDedupeKey(url);

    const existing = byKey.get(key);
    if (settings.dedupe !== false && existing) {
      drop('duplicate');
      if (existing.alternates.length < SESSION_LIMITS.maxAlternateUrls && existing.rawUrl !== rawUrl && !existing.alternates.includes(rawUrl)) {
        existing.alternates.push(rawUrl);
      }
      continue;
    }

    const item = {
      id: `img_${items.length + 1}`,
      url,
      rawUrl,
      source: record.source,
      kind,
      ext: kind === 'data' ? sniffDataExtension(rawUrl) : getExtensionFromUrl(url, 'jpg'),
      alt: record.alt || '',
      domWidth,
      domHeight,
      naturalWidth,
      naturalHeight,
      alternates: []
    };

    byKey.set(key, item);
    items.push(item);
  }

  const maxImages = Math.max(1, Number(settings.maxImages) || 500);
  const limited = items.slice(0, maxImages);
  stats.truncated = Math.max(0, items.length - limited.length);
  stats.kept = limited.length;

  log.info(
    `过滤完成：扫描 ${stats.scanned} → 保留 ${stats.kept}（丢弃 ${stats.dropped}：` +
      Object.entries(stats.reasons)
        .filter(([, value]) => value > 0)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ') +
      '）'
  );

  return { items: limited, stats };
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
  if (!parts.length) return `扫描到 ${stats.scanned} 个地址，保留 ${stats.kept} 张`;
  return `扫描到 ${stats.scanned} 个地址，保留 ${stats.kept} 张，过滤掉 ${stats.dropped} 张（${parts.join('、')}）`;
}
