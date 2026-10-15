#!/usr/bin/env node
/**
 * 把「可以正常运行的插件文件」打包成 docs/downloads/ImageGrab-v<版本>.zip，
 * 供官网（docs/index.html）的下载按钮以相对路径下载。
 *
 * 只收进扩展运行真正需要的文件：manifest.json、README.md、assets/、src/。
 * .git、docs、test、tools、.gitignore 以及各种编辑器产物一律排除；
 * 排除项一旦混进来就直接报错退出，而不是悄悄打进压缩包。
 *
 * 用 Node 内置的 zlib 手写 ZIP 容器（项目零依赖，不引入第三方打包库）：
 *   - 每个条目用 deflate 压缩，条目名统一使用正斜杠；
 *   - 文件名标记 UTF-8，中文路径在任何系统上解压都不会乱码；
 *   - 解压后会得到一个 ImageGrab-v<版本> 文件夹，直接用于「加载已解压的扩展程序」。
 *
 * 用法：node tools/make-extension-zip.mjs [版本号]
 */

import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = process.argv[2] || '1.0.0';
const FOLDER = `ImageGrab-v${VERSION}`;
const OUT_DIR = path.join(ROOT, 'docs', 'downloads');
const OUT_ZIP = path.join(OUT_DIR, `${FOLDER}.zip`);

/** 允许进包的顶层内容 */
const INCLUDE = ['manifest.json', 'README.md', 'assets', 'src'];

/** 任何一层出现这些名字就视为打包错误 */
const FORBIDDEN = new Set([
  '.git',
  '.gitignore',
  '.vscode',
  '.idea',
  'docs',
  'test',
  'tools',
  'node_modules',
  'package.json',
]);

/* ── 收集文件 ───────────────────────────────────────────── */

function collect(target, acc) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target).sort()) {
      collect(path.join(target, name), acc);
    }
    return acc;
  }
  acc.push(target);
  return acc;
}

const files = [];
for (const item of INCLUDE) {
  const full = path.join(ROOT, item);
  if (!fs.existsSync(full)) {
    console.error(`缺少打包所需文件：${full}`);
    process.exit(1);
  }
  collect(full, files);
}

// 校验：不允许出现排除项，也不允许符号链接（避免把仓库外的东西带进包）
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep);
  const bad = rel.find((part) => FORBIDDEN.has(part));
  if (bad) {
    console.error(`压缩包里出现了不该有的内容：${rel.join('/')}`);
    process.exit(1);
  }
  if (fs.lstatSync(file).isSymbolicLink()) {
    console.error(`压缩包里不允许有符号链接：${rel.join('/')}`);
    process.exit(1);
  }
}

if (!files.length) {
  console.error('没有找到任何可以打包的文件。');
  process.exit(1);
}

/* ── ZIP 容器 ───────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 转成 MS-DOS 的日期/时间格式（ZIP 头要求 1980 年起的本地时间） */
function dosStamp(date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  const timeBits = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dateBits = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: timeBits & 0xffff, date: dateBits & 0xffff };
}

const locals = [];
const centrals = [];
let offset = 0;

for (const file of files) {
  const name = `${FOLDER}/${path.relative(ROOT, file).split(path.sep).join('/')}`;
  const nameBuf = Buffer.from(name, 'utf8');
  const raw = fs.readFileSync(file);
  const deflated = deflateRawSync(raw, { level: 9 });
  const useDeflate = deflated.length < raw.length;
  const payload = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const sum = crc32(raw);
  const stamp = dosStamp(fs.statSync(file).mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
  local.writeUInt16LE(20, 4); // 解压所需版本
  local.writeUInt16LE(0x0800, 6); // 标记：文件名是 UTF-8
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(stamp.time, 10);
  local.writeUInt16LE(stamp.date, 12);
  local.writeUInt32LE(sum, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // 扩展字段长度

  locals.push(local, nameBuf, payload);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
  central.writeUInt16LE(20, 4); // 制作版本
  central.writeUInt16LE(20, 6); // 解压所需版本
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(stamp.time, 12);
  central.writeUInt16LE(stamp.date, 14);
  central.writeUInt32LE(sum, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30); // 扩展字段
  central.writeUInt16LE(0, 32); // 注释
  central.writeUInt16LE(0, 34); // 起始磁盘号
  central.writeUInt16LE(0, 36); // 内部属性
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // 外部属性：普通文件 rw-r--r--
  central.writeUInt32LE(offset, 42); // 本地文件头偏移

  centrals.push(central, nameBuf);
  offset += local.length + nameBuf.length + payload.length;
}

const centralSize = centrals.reduce((n, buf) => n + buf.length, 0);

const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0); // 中央目录结束签名
eocd.writeUInt16LE(0, 4); // 当前磁盘号
eocd.writeUInt16LE(0, 6); // 中央目录所在磁盘号
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralSize, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20); // 注释长度

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_ZIP, Buffer.concat([...locals, ...centrals, eocd]));

const bytes = fs.statSync(OUT_ZIP).size;
console.log(`已生成 ${path.relative(ROOT, OUT_ZIP)}`);
console.log(`条目 ${files.length} 个，体积 ${bytes} 字节（${(bytes / 1024).toFixed(1)} KB）`);
for (const file of files) {
  console.log(`  ${path.relative(ROOT, file).split(path.sep).join('/')}`);
}
