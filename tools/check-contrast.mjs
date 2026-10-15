/**
 * 官网配色对比度检查（零依赖，供改样式后反复运行）。
 *
 * 用法：node tools/check-contrast.mjs
 *
 * 为什么要单独检查：docs/assets/site.css 里的颜色都是设计令牌，
 * 改一个 --muted 可能悄悄把某处文字压到 WCAG AA 以下。
 * 这里直接解析 site.css 的 :root 取出真实令牌值（而不是另抄一份），
 * 再按「前景 / 背景」的实际搭配算对比度。
 *
 * 判定分三档，对应 WCAG 2.1 的不同要求：
 *   1. 正文与界面文字：4.5:1（AA 普通字号）
 *   2. 大字号粗体（≥18.67px 且 ≥700）：3:1（AA 大字号）
 *      —— 主按钮的悬停色 #0077ed 上白字只有 4.32:1，因此按钮字号刻意放大到 19px/700，
 *         让它落进这一档；如果有人把按钮字号改小，这里不会报错，但网页就真的不达标了。
 *   3. 表示状态的纯图形：3:1
 *
 * 纯装饰性元素（分隔线 --line、深色区的 --line-dark、示意图里的色块与标签底）
 * 不承担信息传达，不纳入检查。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = join(ROOT, 'docs', 'assets', 'site.css');

/** 取出 :root 里的颜色令牌。 */
function readTokens(css) {
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
  if (!block) throw new Error('在 site.css 里找不到 :root 块');
  const tokens = {};
  for (const line of block[1].split('\n')) {
    const match = /^\s*(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(line);
    if (match) tokens[match[1]] = match[2];
  }
  return tokens;
}

function channel(value) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** 1. 正文与界面文字，要求 ≥ 4.5:1。 */
const TEXT_PAIRS = [
  ['--ink', '--surface', '白底上的 h1/h2/h3、卡片标题'],
  ['--ink', '--bg', '页面底色上的标题、页脚文字、FAQ 标题'],
  ['--muted', '--surface', '白底上的次要文字、卡片正文、FAQ 正文'],
  ['--muted', '--bg', '页面底色上的次要文字、眉标题、平台域名'],
  ['--blue', '--surface', '白底上的正文链接、三步流程的步骤标签'],
  ['--dark-ink', '--dark', '深色下载区的标题与正文'],
  ['--dark-ink', '--dark-surface', '深色卡片里的正文'],
  ['--dark-muted', '--dark', '深色下载区的次要文字'],
  ['--dark-muted', '--dark-surface', '深色卡片里的次要文字'],
];

/** 2. 大字号粗体（≥18.67px 且 ≥700），要求 ≥ 3:1。 */
const LARGE_TEXT_PAIRS = [['#ffffff', '--blue-hover', '主按钮悬停：字号 19px / 字重 700']];

/** 3. 表示状态的纯图形，要求 ≥ 3:1。 */
const GRAPHIC_PAIRS = [['--blue', '--bg', '三步流程的图标（装饰性，仍按 3:1 要求）']];

/** 前景写死、无法用令牌表达的白字，要求 ≥ 4.5:1。 */
const LITERAL_PAIRS = [
  ['#ffffff', '--blue', '主按钮文字、步骤序号、结果页示意图里的白字'],
  ['#ffffff', '--ink', '.skip-link'],
];

const tokens = readTokens(readFileSync(CSS, 'utf8'));

function resolveColor(value) {
  if (value.startsWith('#')) return value;
  const found = tokens[value];
  if (!found) throw new Error(`site.css 里没有这个颜色令牌：${value}`);
  return found;
}

const MIN_TEXT = 4.5;
const MIN_LARGE = 3;

console.log('── 官网配色对比度（WCAG 2.1 AA）──────────────────────────');

let failed = 0;

function check(groups, min, tier) {
  console.log(`\n[${tier}] 要求 ≥ ${min}:1`);
  for (const [fgToken, bgToken, where] of groups) {
    const value = ratio(resolveColor(fgToken), resolveColor(bgToken));
    const ok = value >= min;
    if (!ok) failed += 1;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${value.toFixed(2).padStart(5)}  ${fgToken} on ${bgToken}  — ${where}`
    );
  }
}

check(TEXT_PAIRS, MIN_TEXT, '正文 / 界面文字');
check(LARGE_TEXT_PAIRS, MIN_LARGE, '大字号粗体');
check(GRAPHIC_PAIRS, MIN_LARGE, '图形');
check(LITERAL_PAIRS, MIN_TEXT, '写死的白字');

console.log(
  failed === 0
    ? '\n全部通过。'
    : `\n有 ${failed} 处不达标，请调整 site.css 里的颜色令牌或字号。`
);
process.exitCode = failed === 0 ? 0 : 1;
