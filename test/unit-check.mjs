/**
 * 纯逻辑自检脚本（不需要浏览器、不需要装任何依赖）。
 *
 * 用法：
 *   node test/unit-check.mjs
 *
 * 为什么需要它：
 *   提取与过滤逻辑分散在若干 ES Module 里，用 Chrome 手工验证一次成本很高，
 *   而这些规则（地址补全、srcset 取最大候选、原图还原、去重、尺寸过滤、平台判定）
 *   一旦写错，表现出来往往只是“少了几张图”，很难发现。
 *
 *   本脚本把 src/ 原样拷到临时目录（补一个 {"type":"module"} 的 package.json，
 *   让 Node 直接按 ES Module 解析这些 .js），然后 import **生产代码本身** 做断言。
 *   注意：这里断言的是 src/ 下真实运行的模块，而不是复制出来的替身实现——
 *   否则测试通过也说明不了扩展的行为。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/** 把 src/ 原样复制到临时目录，并声明为 ES Module。 */
function prepareTempModules() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imagegrab-unit-'));

  const copyDir = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dest = path.join(to, entry.name);
      if (entry.isDirectory()) copyDir(src, dest);
      else fs.copyFileSync(src, dest);
    }
  };

  copyDir(path.join(root, 'src'), path.join(tmp, 'src'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  return tmp;
}

const tmpRoot = prepareTempModules();
const load = (relative) => import(pathToFileURL(path.join(tmpRoot, relative)).href);

const constants = await load('src/shared/constants.js');
const urlUtils = await load('src/shared/url-utils.js');
const platformRules = await load('src/content/platform-rules.js');
const imageFilter = await load('src/content/image-filter.js');
// 过滤逻辑会打日志，自检时关掉以免淹没断言结果
const { setLogEnabled } = await load('src/shared/logger.js');
setLogEnabled(false);

/* ─────────────────────────── 极简断言框架 ─────────────────────────── */

let passed = 0;
const failures = [];
let currentGroup = '';

const group = (name) => {
  currentGroup = name;
};

function eq(label, actual, expected) {
  if (actual === expected) {
    passed += 1;
    return;
  }
  failures.push(`${currentGroup} › ${label}\n      期望：${JSON.stringify(expected)}\n      实际：${JSON.stringify(actual)}`);
}

function ok(label, actual) {
  eq(label, Boolean(actual), true);
}

function notEq(label, actual, unexpected) {
  if (actual !== unexpected) {
    passed += 1;
    return;
  }
  failures.push(`${currentGroup} › ${label}\n      不应等于：${JSON.stringify(unexpected)}`);
}

/* ─────────────────────────── 1. 地址补全 ─────────────────────────── */

group('地址补全 normalizeUrl');
const PAGE = 'http://localhost:8000/test/test-page.html';

eq('相对路径补全', urlUtils.normalizeUrl('images/a.png', PAGE), 'http://localhost:8000/test/images/a.png');
eq('./ 前缀补全', urlUtils.normalizeUrl('./a.png', 'http://localhost:8000/test/x.html'), 'http://localhost:8000/test/a.png');
eq('根路径补全', urlUtils.normalizeUrl('/a.png', 'http://localhost:8000/test/x.html'), 'http://localhost:8000/a.png');
eq('协议相对地址补全', urlUtils.normalizeUrl('//cdn.example.com/a.png', 'https://example.com/'), 'https://cdn.example.com/a.png');
eq('CSS url() 与引号会被剥掉', urlUtils.normalizeUrl('url("images/a.png")', 'http://localhost:8000/'), 'http://localhost:8000/images/a.png');
eq('单引号写法同样处理', urlUtils.normalizeUrl("url('images/a.png')", 'http://localhost:8000/'), 'http://localhost:8000/images/a.png');

for (const value of ['', '   ', '#top', 'javascript:void(0)', 'mailto:a@b.com', 'blob:http://x/y', 'about:blank', 'data:image/gif;base64,']) {
  eq(`不可用地址返回 null：${value}`, urlUtils.normalizeUrl(value, 'http://localhost:8000/'), null);
}
eq(
  '有负载的 data URL 保留',
  urlUtils.normalizeUrl('data:image/png;base64,AAAA', PAGE),
  'data:image/png;base64,AAAA'
);

group('地址分类 classifyUrl');
eq('http 分类', urlUtils.classifyUrl('https://a.com/x.png'), 'http');
eq('data 分类', urlUtils.classifyUrl('data:image/png;base64,AAAA'), 'data');
eq('扩展协议判为无效', urlUtils.classifyUrl('chrome-extension://x/y.png'), 'invalid');
eq('空串判为无效', urlUtils.classifyUrl(''), 'invalid');

/* ─────────────────────────── 2. srcset ─────────────────────────── */

group('srcset 解析');
const srcset = urlUtils.parseSrcset('a.png 320w, b.png 800w, c.png 1024w', 'http://x/');
eq('候选数量', srcset.length, 3);
eq('宽度描述符取最大', urlUtils.pickLargestFromSrcset('a.png 320w, b.png 800w, c.png 1024w', 'http://x/'), 'http://x/c.png');
eq('密度描述符取最大', urlUtils.pickLargestFromSrcset('a.png 1x, b.png 2x, c.png 1.5x', 'http://x/'), 'http://x/b.png');
eq('无描述符的逗号分隔写法', urlUtils.pickLargestFromSrcset('a.png , b.png ', 'http://x/'), 'http://x/b.png');
eq('换行与空白能被容忍', urlUtils.pickLargestFromSrcset('\n  https://cdn.example.com/a.jpg 400w,\n  https://cdn.example.com/b.jpg 800w\n'), 'https://cdn.example.com/b.jpg');
eq('空值返回空数组', urlUtils.parseSrcset('', 'http://x/').length, 0);
const dataSrcset = urlUtils.parseSrcset('data:image/png;base64,AA,BB 1x', PAGE);
eq('data URL 内的逗号不被截断', dataSrcset.length, 1);
eq('data URL 完整保留', dataSrcset[0].url, 'data:image/png;base64,AA,BB');

/* ─────────────────────── 3. 原图还原（关键） ─────────────────────── */

group('原图还原 restoreOriginalUrl');
const aliRules = urlUtils.getOriginalRules('taobao');
const aliCases = [
  // 形如 <ext>_<size>.<ext>：整段后缀删掉
  ['https://img.alicdn.com/imgextra/i3/O1CN01abc.jpg_400x400.jpg', 'https://img.alicdn.com/imgextra/i3/O1CN01abc.jpg'],
  ['https://img.alicdn.com/imgextra/i3/O1CN01abc.jpg_50x50xz.jpg', 'https://img.alicdn.com/imgextra/i3/O1CN01abc.jpg'],
  ['https://img.alicdn.com/imgextra/i3/O1CN01abc.jpg_q75.jpg', 'https://img.alicdn.com/imgextra/i3/O1CN01abc.jpg'],
  ['https://img.alicdn.com/a_sum.jpg', 'https://img.alicdn.com/a.jpg'],
  ['https://img.alicdn.com/a.jpg_.webp', 'https://img.alicdn.com/a.jpg'],
  ['https://img.alicdn.com/a.jpg.webp', 'https://img.alicdn.com/a.jpg'],
  // 形如 <name>_<size>.<ext>：只有一份扩展名，必须保留，不能被削成没有后缀的 `a`
  ['https://img.alicdn.com/a_400x400.png', 'https://img.alicdn.com/a.png'],
  ['https://img.alicdn.com/goods/2024/x_800x800.jpg', 'https://img.alicdn.com/goods/2024/x.jpg']
];
for (const [input, expected] of aliCases) {
  eq(`阿里后缀剥离 ${input}`, urlUtils.restoreOriginalUrl(input, aliRules), expected);
}

eq(
  '本地测试页也套用尺寸后缀规则（保证缩略图能被去重）',
  urlUtils.restoreOriginalUrl('http://localhost:8000/test/images/photo-a_400x400.png', urlUtils.getOriginalRules('local-test')),
  'http://localhost:8000/test/images/photo-a.png'
);

for (const url of ['https://img.alicdn.com/a.jpg', 'https://img.alicdn.com/a-b_c.png', 'https://img.alicdn.com/2024/photo.webp']) {
  eq(`不误伤正常地址：${url}`, urlUtils.restoreOriginalUrl(url, aliRules), url);
}

const jdRules = urlUtils.getOriginalRules('jd');
eq(
  '京东 n5 → n0',
  urlUtils.restoreOriginalUrl('https://img14.360buyimg.com/n5/jfs/t1/12345/1.jpg', jdRules),
  'https://img14.360buyimg.com/n0/jfs/t1/12345/1.jpg'
);
eq(
  '京东 s450x450_ 前缀去掉',
  urlUtils.restoreOriginalUrl('https://img14.360buyimg.com/n5/s450x450_jfs/t1/12345/1.jpg', jdRules),
  'https://img14.360buyimg.com/n0/jfs/t1/12345/1.jpg'
);

const pddRules = urlUtils.getOriginalRules('pinduoduo');
eq(
  '拼多多剥离 imageMogr2',
  urlUtils.restoreOriginalUrl('https://img.pddpic.com/a/b.jpeg?imageMogr2/thumbnail/400x400', pddRules),
  'https://img.pddpic.com/a/b.jpeg'
);
eq(
  '拼多多只删缩放参数，其余查询参数保留',
  urlUtils.restoreOriginalUrl('https://img.pddpic.com/a/b.jpeg?goods_id=123&imageMogr2/thumbnail/400x400', pddRules),
  'https://img.pddpic.com/a/b.jpeg?goods_id=123'
);
eq(
  'data: 地址原样返回',
  urlUtils.restoreOriginalUrl('data:image/png;base64,AAAA', aliRules),
  'data:image/png;base64,AAAA'
);

/* ─────────────────────────── 4. 去重键 ─────────────────────────── */

group('去重键 makeDedupeKey');
eq(
  '忽略 host 大小写与重复斜杠',
  urlUtils.makeDedupeKey('https://IMG.AliCDN.com/a//b.jpg_400x400.jpg'),
  urlUtils.makeDedupeKey('https://img.alicdn.com/a/b.jpg_400x400.jpg')
);
eq(
  '忽略缩放查询串',
  urlUtils.makeDedupeKey('https://img.pddpic.com/a/b.jpeg?imageMogr2/thumbnail/400x400'),
  urlUtils.makeDedupeKey('https://img.pddpic.com/a/b.jpeg')
);
notEq('不同路径不去重', urlUtils.makeDedupeKey('https://img.alicdn.com/a.jpg'), urlUtils.makeDedupeKey('https://img.alicdn.com/b.jpg'));
notEq(
  '不同源不去重',
  urlUtils.makeDedupeKey('http://localhost:8000/images/photo-b.png'),
  urlUtils.makeDedupeKey('http://127.0.0.1:8001/images/photo-b.png')
);

/* ──────────────────── 5. 扩展名 / 文件名 / 路径安全 ──────────────────── */

group('扩展名与文件名');
eq('扩展名取小写', urlUtils.getExtensionFromUrl('https://x/a/b.JPG', 'png'), 'jpg');
eq('带 query 也能取到', urlUtils.getExtensionFromUrl('https://x/a/b.webp?x=1', 'png'), 'webp');
eq('取不到时用 fallback', urlUtils.getExtensionFromUrl('https://x/a/b', 'jpg'), 'jpg');
eq('非图片扩展名用 fallback', urlUtils.getExtensionFromUrl('https://x/a/page.html', 'jpg'), 'jpg');
eq('isImageUrl 认图片', urlUtils.isImageUrl('http://x/a/b.jpg?w=1'), true);
eq('isImageUrl 不认网页', urlUtils.isImageUrl('http://x/a/page.html'), false);

eq('文件名编号补零', urlUtils.buildFilename(1, 'png', { filenamePrefix: '商品图', filenamePad: 3 }), '商品图_001.png');
eq('多位数编号', urlUtils.buildFilename(42, 'jpg', { filenamePrefix: '商品图', filenamePad: 3 }), '商品图_042.jpg');
eq('扩展名带点也能处理', urlUtils.buildFilename(1, '.png', {}), '商品图_001.png');
eq('非法字符被替换', urlUtils.sanitizeFilename('a/b:c*d?.png'), 'a_b_c_d_.png');
eq('纯空白用 fallback', urlUtils.sanitizeFilename('   '), 'file');

eq('空子目录不拼路径', urlUtils.joinDownloadPath('', 'x.png'), 'x.png');
eq('子目录被保留', urlUtils.joinDownloadPath('ImageGrab/', 'x.png'), 'ImageGrab/x.png');
// 关键：`..` 必须在决定首尾斜杠之前丢掉，否则会得到以 `/` 开头的绝对路径，
// chrome.downloads 会直接拒绝这个 filename。
eq('上跳目录被清理，且不产生前导斜杠', urlUtils.joinDownloadPath('../etc', 'x.png'), 'etc/x.png');
eq('Windows 风格上跳目录同样清理', urlUtils.joinDownloadPath('..\\..\\win', 'x.png'), 'win/x.png');

/* ────────────────────── 6. 平台与详情页判定 ────────────────────── */

group('平台与详情页判定');
const pageCases = [
  ['https://item.taobao.com/item.htm?id=123', 'taobao', true],
  ['https://detail.tmall.com/item.htm?id=123', 'tmall', true],
  ['https://item.jd.com/100012043978.html', 'jd', true],
  ['https://mobile.yangkeduo.com/goods.html?goods_id=5', 'pinduoduo', true],
  ['https://mms.pinduoduo.com/goods/goods_detail?goods_id=1', 'pdd-merchant', true],
  ['http://localhost:8000/test/test-page.html', 'local-test', true],
  ['http://127.0.0.1:8000/test/test-page.html', 'local-test', true]
];
for (const [href, platformId, isDetail] of pageCases) {
  const state = platformRules.getPageState(href);
  eq(`平台识别 ${href}`, state.platform?.id ?? null, platformId);
  eq(`详情页判定 ${href}`, state.isDetail, isDetail);
  eq(`页面受支持 ${href}`, state.supported, true);
}

const notDetailCases = [
  'https://www.taobao.com/',
  'https://s.taobao.com/search?q=abc',
  'https://www.jd.com/',
  'https://mobile.yangkeduo.com/index.html'
];
for (const href of notDetailCases) {
  eq(`首页/搜索页不注入 ${href}`, platformRules.getPageState(href).isDetail, false);
}

eq('未知站点不受支持', platformRules.getPageState('https://example.com/goods.html?goods_id=1').supported, false);
eq('file:// 不受支持', platformRules.getPageState('file:///C:/x.html').supported, false);
const forced = platformRules.getPageState('https://www.taobao.com/?imagegrab=1');
eq('imagegrab=1 强制注入', forced.isDetail, true);
eq('强制注入会被标记', forced.forced, true);

/* ─────────────────────────── 7. 过滤规则 ─────────────────────────── */

group('过滤规则 filterRecords');
const record = (overrides) =>
  Object.assign(
    {
      rawUrl: 'https://img.alicdn.com/imgextra/goods.jpg',
      source: 'img.src',
      alt: '',
      domWidth: 400,
      domHeight: 400,
      naturalWidth: 800,
      naturalHeight: 800,
      decorationAncestor: null
    },
    overrides
  );

const runFilter = (records, options = {}) => imageFilter.filterRecords(records, { platformId: 'taobao', ...options });

eq('正常商品图保留', runFilter([record({})]).items.length, 1);
eq('命中 URL 关键字被过滤', runFilter([record({ rawUrl: 'https://a.com/logo/x.jpg' })]).stats.reasons.url, 1);
eq('SVG 被过滤', runFilter([record({ rawUrl: 'https://a.com/pic.svg' })]).stats.reasons.url, 1);
eq('原图过小被过滤', runFilter([record({ naturalWidth: 100, naturalHeight: 100 })]).stats.reasons.tiny, 1);
eq('长宽比异常被过滤', runFilter([record({ naturalWidth: 1200, naturalHeight: 200 })]).stats.reasons.aspect, 1);
eq('装饰区域内的图片被过滤', runFilter([record({ decorationAncestor: 'footer' })]).stats.reasons.context, 1);
eq('地址无效被过滤', runFilter([record({ rawUrl: 'javascript:void(0)' })]).stats.reasons.invalid, 1);

const tinyData = runFilter([record({ rawUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' })]);
eq('1×1 内联占位图被过滤', tinyData.stats.reasons.data, 1);
eq('较大的内联图保留', runFilter([record({ rawUrl: `data:image/png;base64,${'A'.repeat(4000)}`, naturalWidth: 300, naturalHeight: 300 })]).items.length, 1);

const dup = runFilter([record({}), record({})]);
eq('重复地址只保留一条', dup.items.length, 1);
eq('重复被计入 duplicate', dup.stats.reasons.duplicate, 1);

const thumbs = runFilter(
  [record({ rawUrl: 'http://localhost:8000/test/images/photo-a.png' }), record({ rawUrl: 'http://localhost:8000/test/images/photo-a_400x400.png' })],
  { platformId: 'local-test' }
);
eq('缩略图与原图合并为一条', thumbs.items.length, 1);
eq('合并后的地址是还原过的原图地址', thumbs.items[0]?.url, 'http://localhost:8000/test/images/photo-a.png');

const many = runFilter(Array.from({ length: 12 }, (_, index) => record({ rawUrl: `https://img.alicdn.com/goods/${index}.jpg` })), {
  settings: { ...constants.DEFAULT_SETTINGS, maxImages: 5 }
});
eq('超出上限被截断', many.items.length, 5);
eq('截断数量被记录', many.stats.truncated, 7);

const lazy = runFilter([record({ rawUrl: 'https://img.alicdn.com/lazy/one.jpg', naturalWidth: 0, naturalHeight: 0, domWidth: 700, domHeight: 500 })]);
eq('拿不到真实尺寸时按展示尺寸判断（大图保留）', lazy.items.length, 1);
eq('展示尺寸过小被过滤', runFilter([record({ rawUrl: 'https://img.alicdn.com/lazy/two.jpg', naturalWidth: 0, naturalHeight: 0, domWidth: 40, domHeight: 40 })]).stats.reasons.tiny, 1);

const described = imageFilter.describeFilterStats(dup.stats, constants.FILTER_REASONS);
ok('过滤统计有人话描述', described.includes('扫描到') && described.includes('保留'));

/* ────────────────────── 8. 文案与状态完整性 ────────────────────── */

group('文案与状态完整性');
for (const [key, label] of Object.entries(constants.FILTER_REASONS)) {
  ok(`过滤原因有中文说明：${key}`, typeof label === 'string' && label.length > 0);
}
for (const [key, label] of Object.entries(constants.ITEM_STATUS_LABEL)) {
  ok(`图片状态有中文说明：${key}`, typeof label === 'string' && label.length > 0);
}
eq(
  '每个图片状态都有对应文案（新增状态忘加文案会被这里拦住）',
  Object.values(constants.ITEM_STATUS).every((status) => Boolean(constants.ITEM_STATUS_LABEL[status])),
  true
);
eq('已知错误码翻译', constants.describeError('IMG_LOAD_FAILED'), constants.ERROR_CODES.IMG_LOAD_FAILED);
ok('未知错误码带原文', constants.describeError('SOMETHING_ELSE').includes('SOMETHING_ELSE'));
eq('空错误码的兜底文案', constants.describeError(''), constants.ERROR_CODES.UNKNOWN);

/* ─────────────────────────── 9. 配置自检 ─────────────────────────── */

group('配置自检');
eq('文件名零填充位数', constants.DEFAULT_SETTINGS.filenamePad, 3);
ok('并发数至少为 1', constants.DEFAULT_SETTINGS.concurrency >= 1);
ok('重试次数非负', constants.DEFAULT_SETTINGS.maxRetries >= 0);
ok('单页数量上限为正数', constants.DEFAULT_SETTINGS.maxImages > 0);
ok('画布像素上限不超过 4096×4096', constants.MAX_PIXELS <= 4096 * 4096);
ok('会话有效期为正数', constants.SESSION_LIMITS.ttlMs > 0);
ok('结果页地址指向真实文件', fs.existsSync(path.join(root, constants.RESULTS_PATH)));
ok('离屏文档地址指向真实文件', fs.existsSync(path.join(root, constants.OFFSCREEN_PATH)));

/* ─────────────────────────── 输出 ─────────────────────────── */

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`断言通过 ${passed} 项`);
if (failures.length) {
  console.error(`\n失败 ${failures.length} 项：`);
  failures.forEach((failure) => console.error(`  ✗ ${failure}`));
  process.exit(1);
}
console.log('全部逻辑自检通过 ✓');
