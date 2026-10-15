/**
 * 平台声明表：URL 正则、详情页判定、原图还原规则、选择器提示。
 *
 * 「平台改版只改这一个文件」——正文扫描与过滤逻辑都是通用的，平台差异全部集中在这里。
 *
 * 按钮注入范围：**支持域名下的所有页面**都注入（首页、搜索页、列表页、详情页都算），
 * 因为「这个页面能不能提取图片」最终取决于页面上有没有图片，而不是页面类型。
 * `isDetailPage()` 只用来判断「这是不是商品详情页」，用于界面提示：
 * 不是详情页时会提醒用户提取到的是整页图片（列表/推荐位里的图会更多，过滤规则会照常拦）。
 */

import { ALI_RESIZE_SUFFIX_PATTERNS, JD_PATH_REPLACERS, PDD_QUERY_BLOCKLIST } from '../shared/url-utils.js';

const isTaobaoItemHost = (hostname) => /^item\.taobao\.com$/i.test(hostname);
const isTmallDetailHost = (hostname) => /^(?:[\w-]+\.)?detail\.tmall\.com$/i.test(hostname);
const isJdItemHost = (hostname) => /^item\.jd\.com$/i.test(hostname);
const isJdMobileItemHost = (hostname) => /^item\.m\.jd\.com$/i.test(hostname);
const isPddHost = (hostname) => /(?:^|\.)(?:yangkeduo|pinduoduo)\.com$/i.test(hostname);

/**
 * 每个平台：
 *  - id / name：标识与展示名
 *  - hostPattern：域名粗匹配，决定「这个站点归哪个平台」（命中即注入按钮）
 *  - isDetailPage(url)：判断这是不是商品详情页（只影响界面提示，不影响是否注入按钮）
 *  - detailHint：给用户看的详情页地址样式
 *  - originalRules：原图还原规则（见 shared/url-utils.js）
 */
export const PLATFORMS = Object.freeze([
  {
    id: 'taobao',
    name: '淘宝',
    hostPattern: /(?:^|\.)taobao\.com$/i,
    detailHint: 'item.taobao.com/item.htm?id=…',
    isDetailPage: (url) => isTaobaoItemHost(url.hostname) && /\/item\.htm$/i.test(url.pathname),
    originalRules: { suffixPatterns: ALI_RESIZE_SUFFIX_PATTERNS }
  },
  {
    id: 'tmall',
    name: '天猫',
    hostPattern: /(?:^|\.)tmall\.com$/i,
    detailHint: 'detail.tmall.com/item.htm?id=…',
    isDetailPage: (url) =>
      /\/item\.htm$/i.test(url.pathname) && (isTmallDetailHost(url.hostname) || url.searchParams.has('id')),
    originalRules: { suffixPatterns: ALI_RESIZE_SUFFIX_PATTERNS }
  },
  {
    id: 'jd',
    name: '京东',
    hostPattern: /(?:^|\.)jd\.com$/i,
    detailHint: 'item.jd.com/100012043978.html',
    isDetailPage: (url) =>
      (isJdItemHost(url.hostname) && /^\/\d+\.html$/.test(url.pathname)) ||
      (isJdMobileItemHost(url.hostname) && /^\/product\/\d+\.html$/.test(url.pathname)),
    originalRules: { suffixPatterns: [], pathReplacers: JD_PATH_REPLACERS }
  },
  {
    // 必须排在 pinduoduo 之前：后者的 hostPattern 也会匹配 mms.pinduoduo.com，
    // 写在后面就永远不会命中（FindPlatform 返回第一个匹配项）。
    id: 'pdd-merchant',
    name: '拼多多商家后台',
    hostPattern: /^mms\.pinduoduo\.com$/i,
    detailHint: 'mms.pinduoduo.com/goods/goods_detail?goods_id=…',
    isDetailPage: (url) => /\/(?:goods|goods_detail|goods-detail|goods-edit|goods_edit)/i.test(url.pathname),
    originalRules: { queryBlocklist: PDD_QUERY_BLOCKLIST }
  },
  {
    id: 'pinduoduo',
    name: '拼多多',
    hostPattern: /(?:^|\.)(?:yangkeduo|pinduoduo)\.com$/i,
    detailHint: 'mobile.yangkeduo.com/goods.html?goods_id=…',
    isDetailPage: (url) =>
      isPddHost(url.hostname) &&
      (/^\/(?:goods|goods2|goods\.html)$/i.test(url.pathname) ||
        /\/(?:goods|goods2)\.html$/i.test(url.pathname) ||
        url.searchParams.has('goods_id')),
    originalRules: { queryBlocklist: PDD_QUERY_BLOCKLIST }
  },
  {
    id: 'local-test',
    name: '本地测试页',
    hostPattern: /^(?:localhost|127\.0\.0\.1|\[::1\])$/i,
    detailHint: 'http://localhost:8000/test/test-page.html',
    // 本地测试页任何路径都注入，方便不依赖真实电商站点验证提取逻辑
    isDetailPage: () => true,
    originalRules: { suffixPatterns: ALI_RESIZE_SUFFIX_PATTERNS }
  }
]);

/** 找到站点所属平台，找不到返回 null。 */
export function findPlatform(href = typeof location !== 'undefined' ? location.href : '') {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return PLATFORMS.find((platform) => platform.hostPattern.test(url.hostname)) || null;
}

/**
 * 当前页面的状态：
 *  - supported：域名在支持列表里 —— 只要是支持的域名就注入按钮（首页、搜索页也算）
 *  - isDetail：看起来是商品详情页（仅用于界面提示；URL 里带 #imagegrab=1 或 ?imagegrab=1
 *    可以强制把它标成详情页）
 *  - pageHint：一句话说明当前页面类型，给面板用
 */
export function getPageState(href = typeof location !== 'undefined' ? location.href : '') {
  const platform = findPlatform(href);
  if (!platform) return { supported: false, isDetail: false, platform: null, forced: false, pageHint: '', url: href };
  const forced = /[?&#]imagegrab=1(?:&|$)/.test(href);
  let isDetail = false;
  try {
    isDetail = Boolean(platform.isDetailPage(new URL(href)));
  } catch {
    isDetail = false;
  }
  isDetail = isDetail || forced;
  const pageHint = isDetail
    ? `商品详情页（${platform.detailHint}）`
    : `${platform.name}的其它页面（不是商品详情页，提取的是整页可见图片）`;
  return { supported: true, isDetail, platform, forced, pageHint, url: href };
}

export function getPlatformId(href) {
  return getPageState(href).platform?.id || 'default';
}
