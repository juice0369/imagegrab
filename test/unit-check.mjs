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
const messaging = await load('src/shared/messaging.js');
const platformRules = await load('src/content/platform-rules.js');
const imageFilter = await load('src/content/image-filter.js');
const grid = await load('src/results/grid.js');
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

/** 断言 Promise 一定失败（可选：指定期望的错误码）。 */
async function rejects(label, promise, code) {
  try {
    await promise;
  } catch (err) {
    if (code === undefined || err?.code === code) {
      passed += 1;
      return;
    }
    failures.push(
      `${currentGroup} › ${label}\n      期望错误码：${JSON.stringify(code)}\n      实际错误码：${JSON.stringify(err?.code)}`
    );
    return;
  }
  failures.push(`${currentGroup} › ${label}\n      期望：失败\n      实际：成功返回`);
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

// 淘宝/天猫会给图片挂埋点与缓存刷新参数，同一张图必须归并成一条——
// 否则结果页里就会出现「一批图片反复出现多次」。这里把每种写法都钉住。
const dupBase = 'https://img.alicdn.com/imgextra/i1/1234567/O1CN01abcXYZ.jpg';
const dupBaseKey = urlUtils.makeDedupeKey(urlUtils.restoreOriginalUrl(dupBase, aliRules));
const dupVariants = [
  ['尺寸后缀', 'https://img.alicdn.com/imgextra/i1/1234567/O1CN01abcXYZ.jpg_400x400.jpg'],
  ['webp 变体', 'https://img.alicdn.com/imgextra/i1/1234567/O1CN01abcXYZ.jpg_.webp'],
  ['spm 埋点', 'https://img.alicdn.com/imgextra/i1/1234567/O1CN01abcXYZ.jpg?spm=a1z10.3-b.w4011-1234.56'],
  ['多个埋点并存', 'https://img.alicdn.com/imgextra/i1/1234567/O1CN01abcXYZ.jpg?spm=a1z10.3-b.w4011-1234.56&ali_trackid=2:mm_123'],
  ['缓存刷新 t 参数', 'https://img.alicdn.com/imgextra/i1/1234567/O1CN01abcXYZ.jpg?t=1699999999'],
  ['缓存刷新 _ 参数', 'https://img.alicdn.com/imgextra/i1/1234567/O1CN01abcXYZ.jpg?_=1699999999'],
  ['utm 埋点', 'https://img.alicdn.com/imgextra/i1/1234567/O1CN01abcXYZ.jpg?utm_source=detail'],
  ['换子域 gw', 'https://gw.alicdn.com/imgextra/i1/1234567/O1CN01abcXYZ.jpg'],
  ['换子域 cbu01', 'https://cbu01.alicdn.com/imgextra/i1/1234567/O1CN01abcXYZ.jpg'],
  ['换协议 http', 'http://img.alicdn.com/imgextra/i1/1234567/O1CN01abcXYZ.jpg'],
  ['后缀 + 埋点叠加', 'https://img.alicdn.com/imgextra/i1/1234567/O1CN01abcXYZ.jpg_50x50xz.jpg?spm=a1z10.3-b.w4011-1234.56']
];
for (const [label, variant] of dupVariants) {
  eq(`淘宝重复写法归并（${label}）`, urlUtils.makeDedupeKey(urlUtils.restoreOriginalUrl(variant, aliRules)), dupBaseKey);
}

// 用户上报的真实案例：同一张商品图在阿里 CDN 上有两条等价入口路径。
// `/bao/uploaded/` 与 `/imgextra/` 是同一文件的两种容器路径，必须归并成一条。
const aliImgextra = 'https://img.alicdn.com/imgextra/i2/2221069160645/O1CN01qwZiH0MMQIJ1chua_!!2221069160645.jpg';
const aliBaoUploaded = 'https://gw.alicdn.com/bao/uploaded/i2/2221069160645/O1CN01qwZiH0MMQIJ1chua_!!2221069160645.jpg';
eq(
  'imgextra 与 bao/uploaded 是同一张图',
  urlUtils.makeDedupeKey(aliBaoUploaded),
  urlUtils.makeDedupeKey(aliImgextra)
);
eq(
  '两种入口 + 缩略图后缀 + 埋点仍然归并',
  urlUtils.makeDedupeKey(urlUtils.restoreOriginalUrl(`${aliBaoUploaded}_400x400.jpg?spm=a1z10.3-b.w4011-1234.56`, aliRules)),
  urlUtils.makeDedupeKey(aliImgextra)
);
notEq(
  '换一个文件名仍然算两张（不能过度合并）',
  urlUtils.makeDedupeKey('https://gw.alicdn.com/bao/uploaded/i2/2221069160645/O1CN01qwZiH0MMQIJ1chua_!!2221069160645.jpg'),
  urlUtils.makeDedupeKey('https://gw.alicdn.com/bao/uploaded/i2/2221069160645/O1CN01qwZiH0MMQIJ1chuB_!!2221069160645.jpg')
);
notEq(
  '换一个卖家目录仍然算两张',
  urlUtils.makeDedupeKey('https://img.alicdn.com/imgextra/i2/2221069160645/x_!!2221069160645.jpg'),
  urlUtils.makeDedupeKey('https://img.alicdn.com/imgextra/i2/2221069160646/x_!!2221069160646.jpg')
);

// 反向：真的不同的图绝不能被合并。归一化只针对已知 CDN 与已知埋点参数。
notEq(
  '不同文件名不归并',
  urlUtils.makeDedupeKey('https://img.alicdn.com/imgextra/i1/1234567/O1CN01abcXYZ.jpg'),
  urlUtils.makeDedupeKey('https://img.alicdn.com/imgextra/i1/1234567/O1CN01abcZZZ.jpg')
);
notEq(
  '不同商品目录不归并',
  urlUtils.makeDedupeKey('https://img.alicdn.com/imgextra/i1/1234567/x.jpg'),
  urlUtils.makeDedupeKey('https://img.alicdn.com/imgextra/i1/7654321/x.jpg')
);
notEq(
  '未知参数仍参与区分（不做激进合并）',
  urlUtils.makeDedupeKey('https://img.alicdn.com/a/b.jpg?variant=1'),
  urlUtils.makeDedupeKey('https://img.alicdn.com/a/b.jpg?variant=2')
);
notEq(
  '非已知 CDN 不跨域归并',
  urlUtils.makeDedupeKey('https://img.example.com/a/b.jpg'),
  urlUtils.makeDedupeKey('https://cdn.example.com/a/b.jpg')
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

/* 文件名编号：同一个会话里必须连续（001…003、004…005），不能每批都从 001 重来 */

group('文件名编号连续递增');
const firstBatch = urlUtils.assignSequences(['a', 'b', 'c'], 1);
eq('第一批从 001 开始', firstBatch.byId.get('a'), 1);
eq('批内按列表顺序递增', firstBatch.byId.get('c'), 3);
eq('第一批之后的游标是 4', firstBatch.next, 4);

const secondBatch = urlUtils.assignSequences(['d', 'e'], firstBatch.next);
eq('第二批接着上一批编号（不会又回到 1）', secondBatch.byId.get('d'), 4);
eq('第二批最后一个编号', secondBatch.byId.get('e'), 5);
eq('第二批之后的游标是 6', secondBatch.next, 6);
eq(
  '两批拼起来的文件名是 001—005，没有重名',
  [...firstBatch.byId.values(), ...secondBatch.byId.values()]
    .map((index) => urlUtils.buildFilename(index, 'png', {}))
    .join(','),
  '商品图_001.png,商品图_002.png,商品图_003.png,商品图_004.png,商品图_005.png'
);

const single = urlUtils.assignSequences(['x'], secondBatch.next);
eq('单张下载也接着编号', single.byId.get('x'), 6);
eq('单张下载不占用多余编号', single.next, 7);

const emptyBatch = urlUtils.assignSequences([], 7);
eq('空批次不推进游标', emptyBatch.next, 7);
eq('空批次没有编号', emptyBatch.byId.size, 0);

const badCursor = urlUtils.assignSequences(['a'], 0);
eq('游标非法（0）时回到 1', badCursor.byId.get('a'), 1);
eq('游标非数字时回到 1', urlUtils.assignSequences(['a'], Number.NaN).byId.get('a'), 1);
eq('游标为字符串数字时按数字处理', urlUtils.assignSequences(['a'], '12').byId.get('a'), 12);

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
  const state = platformRules.getPageState(href);
  // 首页 / 搜索页也注入按钮（页面类型只影响提示），所以「受支持」必须为 true
  eq(`首页/搜索页也注入 ${href}`, state.supported, true);
  eq(`首页/搜索页不当作详情页 ${href}`, state.isDetail, false);
  ok(`首页/搜索页给出提示文案 ${href}`, typeof state.pageHint === 'string' && state.pageHint.length > 0);
}

eq('未知站点不受支持', platformRules.getPageState('https://example.com/goods.html?goods_id=1').supported, false);
eq('file:// 不受支持', platformRules.getPageState('file:///C:/x.html').supported, false);
eq('未知站点没有提示文案', platformRules.getPageState('https://example.com/').pageHint, '');
const forced = platformRules.getPageState('https://www.taobao.com/?imagegrab=1');
eq('imagegrab=1 强制标记为详情页', forced.isDetail, true);
eq('强制标记会被记下来', forced.forced, true);

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

/* ───────── 7.1 被过滤的条目也要能显示（灰色卡片 + 过滤原因） ───────── */

group('被过滤的条目也要列出');
const contextDrop = runFilter([record({ rawUrl: 'https://img.alicdn.com/nav/logo.png', decorationAncestor: 'footer' })]);
eq('装饰区域内的图片被列出', contextDrop.filtered.length, 1);
eq('列出时带上过滤原因', contextDrop.filtered[0]?.filterReason, 'context');
eq('列出的地址就是页面上的地址', contextDrop.filtered[0]?.url, 'https://img.alicdn.com/nav/logo.png');
eq('列出的条目也是可下载结构（有 ext / source）', Boolean(contextDrop.filtered[0]?.ext && contextDrop.filtered[0]?.source), true);
eq('可下载列表依然为空', contextDrop.items.length, 0);
eq('统计里记录了列出数量', contextDrop.stats.listed, 1);

const tinyDrop = runFilter([record({ naturalWidth: 90, naturalHeight: 90 })]);
eq('尺寸过小的条目被列出', tinyDrop.filtered[0]?.filterReason, 'tiny');
eq('尺寸信息被保留（结果页要显示它）', tinyDrop.filtered[0]?.naturalWidth, 90);

const aspectDrop = runFilter([record({ naturalWidth: 1400, naturalHeight: 200 })]);
eq('长宽比异常的条目被列出', aspectDrop.filtered[0]?.filterReason, 'aspect');

const urlDrop = runFilter([record({ rawUrl: 'https://img.alicdn.com/logo/site-2x.png' })]);
eq('命中黑名单的条目被列出', urlDrop.filtered[0]?.filterReason, 'url');

// 重复条目要指认它和哪一张重复，结果页才能写出「与第 N 张相同」
const dupPair = runFilter([record({}), record({})]);
eq('重复条目被列出', dupPair.filtered[0]?.filterReason, 'duplicate');
eq('重复条目指认了保留的那一张', dupPair.filtered[0]?.duplicateOf, dupPair.items[0]?.id);

// 地址无效的条目没有可显示的地址，只能计数、不能列卡片
const invalidDrop = runFilter([record({ rawUrl: 'javascript:void(0)' })]);
eq('无效地址不列卡片', invalidDrop.filtered.length, 0);
eq('无效地址仍然计数', invalidDrop.stats.reasons.invalid, 1);
eq('列出数量与 filtered 长度一致', invalidDrop.stats.listed, invalidDrop.filtered.length);

// data: 占位图是可显示的（结果页会显示成 1×1 的小图，尺寸文字会说明）
const dataDrop = runFilter([record({ rawUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' })]);
eq('data: 占位图被列出', dataDrop.filtered[0]?.filterReason, 'data');
eq('data: 条目的扩展名能被识别', dataDrop.filtered[0]?.ext, 'gif');

// 未过滤的图片必须保持原编号，下载文件名才不会因为「多列了被过滤的卡片」而错位
const numbering = runFilter([
  record({ rawUrl: 'https://img.alicdn.com/goods/keep-1.jpg' }),
  record({ rawUrl: 'https://img.alicdn.com/goods/tiny-1.jpg', naturalWidth: 50, naturalHeight: 50 }),
  record({ rawUrl: 'https://img.alicdn.com/goods/keep-2.jpg' })
]);
eq('保留的条目仍是 1、2 号', `${numbering.items[0].id},${numbering.items[1].id}`, 'img_1,img_2');
eq('被过滤的条目拿到独立 id', numbering.filtered[0]?.id, 'img_3');
const allIds = [...numbering.items, ...numbering.filtered].map((item) => item.id);
eq('两类条目的 id 不重复', new Set(allIds).size, allIds.length);

// 每个被列出的原因都必须有中文说明与短标签，否则卡片上会露出英文键名
const listedReasons = [
  ...contextDrop.filtered,
  ...tinyDrop.filtered,
  ...aspectDrop.filtered,
  ...urlDrop.filtered,
  ...dupPair.filtered,
  ...dataDrop.filtered
].map((item) => item.filterReason);
ok('列出的原因都有中文说明', listedReasons.every((reason) => Boolean(constants.FILTER_REASONS[reason])));
ok('列出的原因都有短标签', listedReasons.every((reason) => Boolean(constants.FILTER_REASON_SHORT[reason])));

const capped = runFilter(
  Array.from({ length: 5 }, (_, index) => record({ rawUrl: `https://img.alicdn.com/icons/x${index}.png`, naturalWidth: 40, naturalHeight: 40 })),
  { settings: { ...constants.DEFAULT_SETTINGS, maxFilteredImages: 2 } }
);
eq('列出的被过滤条目有上限', capped.filtered.length, 2);
eq('超出的部分被记为未列出', capped.stats.filteredTruncated, 3);

const statsText = imageFilter.describeFilterStats(contextDrop.stats, constants.FILTER_REASONS);
ok('统计文案会说明被过滤的也列出来了', statsText.includes('也列在结果页里'));

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

/* ─────────────────── 9. 结果页分片渲染（batchRanges） ─────────────────── */

group('结果页分片渲染 batchRanges');
eq('不足一批时只有一段', JSON.stringify(grid.batchRanges(16, 60)), JSON.stringify([[0, 16]]));
eq('正好一批', JSON.stringify(grid.batchRanges(60, 60)), JSON.stringify([[0, 60]]));
eq('多批带余数', JSON.stringify(grid.batchRanges(150, 60)), JSON.stringify([[0, 60], [60, 120], [120, 150]]));
eq('空列表没有分段', grid.batchRanges(0, 60).length, 0);
eq('非法的批大小兜底为 1', JSON.stringify(grid.batchRanges(3, 0)), JSON.stringify([[0, 1], [1, 2], [2, 3]]));

// 这是「59 张图在结果页里变成上千张卡片」那个缺陷的回归断言：
// 分段必须互不重叠、不留空洞，且每个下标恰好出现一次。
for (const [total, size] of [[1, 60], [59, 60], [61, 60], [500, 60], [7, 3], [2, 1]]) {
  const ranges = grid.batchRanges(total, size);
  const covered = [];
  for (const [start, end] of ranges) for (let index = start; index < end; index += 1) covered.push(index);
  eq(`${total} 条 / 每批 ${size}：覆盖次数等于条目数`, covered.length, total);
  eq(`${total} 条 / 每批 ${size}：没有下标被重复挂载`, new Set(covered).size, total);
  eq(
    `${total} 条 / 每批 ${size}：顺序从 0 连续到 ${total - 1}`,
    covered.join(','),
    Array.from({ length: total }, (_, index) => index).join(',')
  );
  ok(`${total} 条 / 每批 ${size}：每段不超过批大小且非空`, ranges.every(([start, end]) => end > start && end - start <= size));
}

/* ─────────────── 11. 上下文失效（Extension context invalidated） ─────────────── */

group('上下文失效');
// Node 里没有 chrome API，正好等价于「扩展被重载后 content script 里的 runtime.id 没了」
eq('没有 chrome API 时视为上下文不存在', messaging.isExtensionAlive(), false);

const rawEnglish = new Error('Extension context invalidated.');
eq('认识浏览器抛的英文原文', messaging.isContextInvalidated(rawEnglish), true);
eq('认识 CONTEXT_INVALIDATED 错误码', messaging.isContextInvalidated({ code: 'CONTEXT_INVALIDATED' }), true);
eq('普通错误不算上下文失效', messaging.isContextInvalidated(new Error('网络错误')), false);
eq('空值不算上下文失效', messaging.isContextInvalidated(null), false);
eq('字符串错误也算', messaging.isContextInvalidated(new Error('Uncaught Error: Extension context invalidated.')), true);

// 这是用户实际看到的那条报错：必须换成中文，并且明确告诉用户要刷新页面。
const normalized = messaging.toError(rawEnglish, 'MESSAGE_FAILED');
eq('英文原文被归一为 CONTEXT_INVALIDATED', normalized.code, 'CONTEXT_INVALIDATED');
eq('展示文案换成 ERROR_CODES 的中文', normalized.message, constants.ERROR_CODES.CONTEXT_INVALIDATED);
eq('界面里不再出现英文原文', normalized.message.includes('invalidated'), false);
eq('中文文案包含可执行的下一步', normalized.message.includes('刷新页面'), true);

await rejects('上下文失效时 sendMessage 立刻失败', messaging.sendMessage({ type: 'IG_DIAGNOSTICS' }), 'CONTEXT_INVALIDATED');
await rejects('上下文失效时 sendTabMessage 立刻失败', messaging.sendTabMessage(1, { type: 'X' }), 'CONTEXT_INVALIDATED');
const deadError = await messaging.sendMessage({ type: 'X' }).catch((err) => err);
eq('失败信息可以直接贴到界面上', deadError.message, constants.ERROR_CODES.CONTEXT_INVALIDATED);

// 同类问题：chrome 的另外两句运行时错误原文也不该出现在界面上
const noReceiver = messaging.toError(new Error('Could not establish connection. Receiving end does not exist.'), 'NO_RESPONSE');
eq('后台未响应的英文原文换成中文', noReceiver.message, constants.ERROR_CODES.NO_RESPONSE);
const portClosed = messaging.toError(new Error('The message port closed before a response was received.'), 'MESSAGE_FAILED');
eq('端口提前关闭的英文原文换成中文', portClosed.message, constants.ERROR_CODES.MESSAGE_FAILED);
const ownMessage = messaging.toError(new Error('图片加载失败（404、防盗链或需要登录）'), 'IMG_LOAD_FAILED');
eq('自己写的中文文案不会被覆盖', ownMessage.message, '图片加载失败（404、防盗链或需要登录）');

/* ─────────────────────────── 12. 配置自检 ─────────────────────────── */

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
