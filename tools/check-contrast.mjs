/**
 * 官网配色对比度检查（零依赖，供改样式后反复运行）。
 *
 * 用法：node tools/check-contrast.mjs
 *
 * 为什么要单独检查：docs/assets/site.css 里的颜色都是设计令牌，
 * 改一个 --amber 可能悄悄把某处小字号文字压到 WCAG AA 以下。
 * 这里直接解析 site.css 的 :root 取出真实令牌值（而不是另抄一份），
 * 再按「前景 / 背景」的实际搭配算对比度，低于 4.5:1 就报错退出。
 *
 * 判定口径：正文与界面文字按 WCAG 2.1 AA 的 4.5:1；
 * 纯装饰性图形（进度条、分隔线、示意图里的色块）不纳入检查。
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

/**
 * 实际出现在页面上的前景 / 背景搭配。
 * where 写清用在哪个选择器上，方便出错时直接定位。
 */
const PAIRS = [
  ['--ink', '--cream', 'h1/h2/h3、卡片标题'],
  ['--ink-2', '--cream', 'body 正文'],
  ['--ink-2', '--surface', '卡片内的说明文字'],
  ['--muted', '--cream', 'hero 副标题、段落'],
  ['--muted', '--cream-2', 'section--tint 里的段落'],
  ['--muted', '--surface', '卡片与 FAQ 正文'],
  ['--brand', '--cream', '正文里的链接'],
  ['--brand', '--amber-tint', '导航悬停背景 + .callout strong'],
  ['--eyebrow', '--cream', '.eyebrow 眉标题（小字号）'],
  ['--eyebrow', '--cream-2', '.eyebrow 在浅色分区的底上'],
  ['--warn', '--surface', '.step__note 警示文字'],
];

/** 白字按钮与语义色药丸，前景是写死的值，所以单独列。 */
const LITERAL_PAIRS = [
  ['#ffffff', '--brand', '主按钮文字'],
  ['#ffffff', '--brand-hover', '主按钮悬停文字'],
  ['#1f6247', '--ok-soft', '.pill--ok'],
  ['#8a5511', '--warn-soft', '.pill--warn'],
  ['#d9cfc2', '--ink', '页脚正文'],
  ['#f6d9b8', '--ink', '页脚链接'],
  ['#b3a698', '--ink', '页脚版权行'],
];

const tokens = readTokens(readFileSync(CSS, 'utf8'));

function resolveColor(value) {
  if (value.startsWith('#')) return value;
  const found = tokens[value];
  if (!found) throw new Error(`site.css 里没有这个颜色令牌：${value}`);
  return found;
}

console.log('── 官网配色对比度（WCAG 2.1 AA 正文 4.5:1）─────────────');

let failed = 0;
const rows = [...PAIRS, ...LITERAL_PAIRS];

for (const [fgToken, bgToken, where] of rows) {
  const fg = resolveColor(fgToken);
  const bg = resolveColor(bgToken);
  const value = ratio(fg, bg);
  const ok = value >= 4.5;
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${value.toFixed(2).padStart(5)}  ${fgToken} on ${bgToken}  — ${where}`);
}

console.log(
  failed === 0
    ? '\n全部通过（所有正文搭配 ≥ 4.5:1）。'
    : `\n有 ${failed} 处不达标，请调整 site.css 里的颜色令牌。`
);
process.exitCode = failed === 0 ? 0 : 1;
