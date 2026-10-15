/**
 * 零依赖的资源生成脚本：产出扩展图标与本地测试页需要的图片。
 *
 * 用法：node tools/make-assets.mjs
 *
 * 自己手写 PNG 编码（zlib + PNG chunk），这样仓库里不需要任何图形工具或依赖，
 * 图标与测试图也可以随时重新生成。
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ───────────────────────── PNG 编码 ───────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ───────────────────────── 极简光栅器 ───────────────────────── */

function hslToRgb(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = Math.min(1, Math.max(0, saturation));
  const l = Math.min(1, Math.max(0, lightness));
  if (s === 0) {
    const value = Math.round(l * 255);
    return [value, value, value];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  return [
    Math.round(channel(h + 1 / 3) * 255),
    Math.round(channel(h) * 255),
    Math.round(channel(h - 1 / 3) * 255)
  ];
}

/** layers：从下到上依次调用，返回 null 表示这一层不覆盖该采样点。 */
function render(width, height, layers, { samples = 2 } = {}) {
  const out = new Uint8Array(width * height * 4);
  const total = samples * samples;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          let color = [0, 0, 0, 0];
          for (const layer of layers) {
            const value = layer(px, py, width, height);
            if (value) color = value;
          }
          sumR += color[0] * color[3];
          sumG += color[1] * color[3];
          sumB += color[2] * color[3];
          sumA += color[3];
        }
      }
      const index = (y * width + x) * 4;
      if (sumA > 0) {
        out[index] = Math.round(sumR / sumA);
        out[index + 1] = Math.round(sumG / sumA);
        out[index + 2] = Math.round(sumB / sumA);
      }
      out[index + 3] = Math.round((sumA / total) * 255);
    }
  }
  return out;
}

/* ───────────────────────── 几何图形 ───────────────────────── */

const inRect = (px, py, x, y, w, h) => px >= x && px < x + w && py >= y && py < y + h;

function inRoundRect(px, py, x, y, w, h, radius) {
  if (!inRect(px, py, x, y, w, h)) return false;
  const r = Math.min(radius, w / 2, h / 2);
  const nearLeft = px < x + r;
  const nearRight = px > x + w - r;
  const nearTop = py < y + r;
  const nearBottom = py > y + h - r;
  if ((!nearLeft && !nearRight) || (!nearTop && !nearBottom)) return true;
  const cx = nearLeft ? x + r : x + w - r;
  const cy = nearTop ? y + r : y + h - r;
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

const inCircle = (px, py, cx, cy, radius) => (px - cx) ** 2 + (py - cy) ** 2 <= radius * radius;

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

const GOLD = [255, 214, 102];
const WHITE = [255, 255, 255];

/* ───────────────────────── 图标 ───────────────────────── */

function iconLayers(size) {
  const radius = size * 0.24;
  const base = hslToRgb(228, 0.78, 0.55);
  const accent = hslToRgb(268, 0.7, 0.5);

  const frameMargin = size * 0.21;
  const frameWidth = size - frameMargin * 2;
  const frameHeight = size * 0.56;
  const frameY = (size - frameHeight) / 2;
  const frameRadius = size * 0.1;

  const sunRadius = frameWidth * 0.1;
  const sunX = frameMargin + frameWidth * 0.27;
  const sunY = frameY + frameHeight * 0.3;

  const mountainBase = frameY + frameHeight;
  const mountainTopA = mountainBase - frameHeight * 0.58;
  const mountainTopB = mountainBase - frameHeight * 0.36;

  return [
    // 底：圆角方形渐变
    (px, py) => {
      if (!inRoundRect(px, py, 0, 0, size, size, radius)) return null;
      const t = Math.min(1, Math.max(0, (px / size) * 0.55 + (py / size) * 0.45));
      return [
        Math.round(base[0] + (accent[0] - base[0]) * t),
        Math.round(base[1] + (accent[1] - base[1]) * t),
        Math.round(base[2] + (accent[2] - base[2]) * t),
        1
      ];
    },
    // 白色相框（浅色底）
    (px, py) => (inRoundRect(px, py, frameMargin, frameY, frameWidth, frameHeight, frameRadius) ? [238, 242, 255, 1] : null),
    // 太阳
    (px, py) => (inCircle(px, py, sunX, sunY, sunRadius) ? GOLD : null),
    // 远山
    (px, py) =>
      inTriangle(px, py, frameMargin - size * 0.02, mountainBase, frameMargin + frameWidth * 0.52, mountainTopA, frameMargin + frameWidth * 0.78, mountainBase)
        ? hslToRgb(210, 0.62, 0.62)
        : null,
    // 近山
    (px, py) =>
      inTriangle(px, py, frameMargin + frameWidth * 0.28, mountainBase, frameMargin + frameWidth * 0.68, mountainTopB, frameMargin + frameWidth * 1.05, mountainBase)
        ? [40, 73, 190, 1]
        : null,
    // 白色高光边
    (px, py) => {
      const inner = inRoundRect(px, py, frameMargin + size * 0.035, frameY + size * 0.035, frameWidth - size * 0.07, frameHeight - size * 0.07, frameRadius * 0.7);
      return !inner && inRoundRect(px, py, frameMargin, frameY, frameWidth, frameHeight, frameRadius) ? WHITE : null;
    }
  ];
}

/* ───────────────────────── 测试图 ───────────────────────── */

function photoLayers(width, height, hueA, hueB, markers) {
  const layers = [
    (px, py, w, h) => {
      const t = Math.min(1, Math.max(0, (px / w) * 0.65 + (py / h) * 0.35));
      const hue = hueA + (hueB - hueA) * t;
      return [...hslToRgb(hue, 0.5 + 0.15 * t, 0.62 - 0.24 * t), 1];
    },
    // 细网格线，缩放后也能看出图像被正确重绘
    (px, py) => (Math.round(px) % 64 === 0 || Math.round(py) % 64 === 0 ? [255, 255, 255, 0.12] : null)
  ];

  const radius = Math.min(width, height) * 0.12;
  const step = Math.min(width, height) * 0.22;
  const startX = width / 2 - ((markers - 1) * step) / 2;
  for (let i = 0; i < markers; i += 1) {
    const cx = startX + i * step;
    const cy = height / 2;
    layers.push((px, py) => (inCircle(px, py, cx, cy, radius) ? [...WHITE, 0.9] : null));
    layers.push((px, py) => (inCircle(px, py, cx, cy, radius * 0.55) ? [40, 73, 190, 1] : null));
  }
  return layers;
}

/* ───────────────────────── 写出 ───────────────────────── */

function writePng(relativePath, width, height, layers, options) {
  const rgba = render(width, height, layers, options);
  const target = join(ROOT, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, encodePng(width, height, rgba));
  const size = statSync(target).size;
  console.log(`${relativePath.padEnd(34)} ${String(width).padStart(4)}×${String(height).padEnd(4)}  ${(size / 1024).toFixed(1)} KB`);
}

console.log('── 扩展图标 ──────────────────────────────');
for (const size of [16, 48, 128]) {
  writePng(`assets/icons/icon${size}.png`, size, size, iconLayers(size), { samples: size <= 48 ? 3 : 2 });
}

console.log('── 本地测试页图片 ────────────────────────');
writePng('test/images/photo-a.png', 600, 400, photoLayers(600, 400, 205, 265, 1), { samples: 1 });
writePng('test/images/photo-a_400x400.png', 400, 400, photoLayers(400, 400, 205, 265, 1), { samples: 1 });
writePng('test/images/photo-b.png', 800, 600, photoLayers(800, 600, 25, 330, 2), { samples: 1 });
writePng('test/images/photo-c.png', 1024, 768, photoLayers(1024, 768, 145, 200, 3), { samples: 1 });
writePng('test/images/photo-large.png', 1600, 1200, photoLayers(1600, 1200, 275, 320, 4), { samples: 1 });
writePng('test/images/photo-small.png', 40, 40, photoLayers(40, 40, 0, 40, 1), { samples: 2 });
writePng('test/images/logo-site.png', 160, 48, photoLayers(160, 48, 210, 250, 1), { samples: 2 });
writePng('test/images/spacer-1x1.png', 1, 1, [() => [0, 0, 0, 0]], { samples: 1 });
writePng('test/images/banner-wide.png', 1200, 100, photoLayers(1200, 100, 190, 240, 5), { samples: 1 });
writePng('test/images/bg-hero.png', 900, 300, photoLayers(900, 300, 35, 95, 2), { samples: 1 });
writePng('test/images/bg-tile.png', 600, 200, photoLayers(600, 200, 300, 260, 1), { samples: 1 });
writePng('test/images/photo-footer.png', 500, 500, photoLayers(500, 500, 120, 170, 1), { samples: 1 });
writePng('test/images/lazy-one.png', 640, 480, photoLayers(640, 480, 5, 60, 2), { samples: 1 });
writePng('test/images/lazy-two.png', 720, 540, photoLayers(720, 540, 165, 215, 3), { samples: 1 });
writePng('test/images/photo-dup.png', 500, 400, photoLayers(500, 400, 250, 290, 1), { samples: 1 });
writePng('test/images/srcset-small.png', 320, 240, photoLayers(320, 240, 60, 90, 1), { samples: 1 });
writePng('test/images/srcset-large.png', 1280, 960, photoLayers(1280, 960, 60, 90, 5), { samples: 1 });
writePng('test/images/frame-image.png', 480, 360, photoLayers(480, 360, 200, 230, 2), { samples: 1 });
writePng('test/images/shadow-image.png', 560, 420, photoLayers(560, 420, 320, 350, 3), { samples: 1 });

console.log('\n完成：图标与测试图已生成。');
