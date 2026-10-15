/**
 * 静态检查脚本（零依赖，供开发时反复运行）：
 *   1. 用 `node --check` 把每个 JS 文件当 ESM 解析一遍，抓语法错误；
 *   2. 校验模块之间的 import / export 是否对得上（漏导出、名字写错、路径不存在）；
 *   3. 校验 manifest.json 是合法 JSON，且里面引用的文件真实存在；
 *   4. 校验 HTML 里引用的本地 css/js 真实存在。
 *
 * 用法：node tools/check-syntax.mjs
 *
 * 为什么要有第 2 步：ES Module 的错误导出名不会在“语法检查”阶段报错，
 * 只有真正加载那行代码时才会抛 TypeError。手工验证时很容易漏掉某个分支，
 * 所以这里用静态扫描提前拦住。
 */

import { readdirSync, readFileSync, statSync, existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'assets']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const jsFiles = files.filter((file) => extname(file) === '.js' || extname(file) === '.mjs').sort();
const htmlFiles = files.filter((file) => extname(file) === '.html').sort();

let problems = 0;
let warnings = 0;
const tmp = mkdtempSync(join(tmpdir(), 'imagegrab-check-'));

console.log('── 1. JavaScript 语法检查（按 ESM 解析） ───────────────');
for (const file of jsFiles) {
  const target = join(tmp, `${relative(ROOT, file).replace(/[\\/]/g, '_')}.mjs`);
  try {
    copyFileSync(file, target);
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    console.log(`  ok   ${relative(ROOT, file)}`);
  } catch (err) {
    problems += 1;
    const message = String(err.stderr || err.message).trim().split('\n').slice(0, 6).join('\n         ');
    console.log(`  FAIL ${relative(ROOT, file)}\n         ${message}`);
  }
}

/* ───────────────── 2. import / export 一致性 ───────────────── */

/**
 * 去掉注释后再做 import 扫描，否则注释里出现的示例代码（例如本文件顶部的
 * `export { a } from './x.js'`）会被当成真实引用，产生假报警。
 * 行注释只在 `//` 之前没有引号时才截断，避免误伤 `'https://...'` 这类字符串。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//');
      if (index < 0) return line;
      const before = line.slice(0, index);
      return /['"`]/.test(before) ? line : before;
    })
    .join('\n');
}

/** 收集一个模块导出的名字（静态扫描，覆盖本项目用到的写法）。 */
function collectExports(source, file) {
  const names = new Set();
  let hasDefault = false;
  let hasStar = false;

  const patterns = [
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+(?:async\s+)?function\s*\*\s*([A-Za-z_$][\w$]*)/g,
    /\bexport\s+class\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }

  // export { a, b as c } / export { a } from './x.js'
  for (const match of source.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const alias = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
      const name = alias ? alias[1] : trimmed;
      if (name) names.add(name);
    }
  }

  if (/\bexport\s+default\b/.test(source)) hasDefault = true;
  if (/\bexport\s*\*\s*from\b/.test(source)) hasStar = true;

  if (!names.size && !hasDefault && !hasStar && /\.(?:js|mjs)$/.test(file)) return { names, hasDefault, hasStar };
  return { names, hasDefault, hasStar };
}

/** 收集一个模块的静态 import。 */
function collectImports(source) {
  const out = [];
  const pattern = /\bimport\s+([^'"]+?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const clause = match[1].trim();
    const specifier = match[2];
    const named = [];
    const clauseMatch = /\{([\s\S]*?)\}/.exec(clause);
    if (clauseMatch) {
      for (const part of clauseMatch[1].split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
        named.push(asMatch ? { imported: asMatch[1], local: asMatch[2] } : { imported: trimmed, local: trimmed });
      }
    }
    const beforeBrace = clause.includes('{') ? clause.slice(0, clause.indexOf('{')).trim().replace(/,$/, '').trim() : clause;
    const hasDefault = Boolean(beforeBrace) && !beforeBrace.startsWith('*');
    const hasNamespace = beforeBrace.startsWith('*');
    out.push({ specifier, named, hasDefault, hasNamespace });
  }
  return out;
}

console.log('\n── 2. 模块 import / export 一致性 ─────────────────────');
const importedTargets = new Set();

for (const file of jsFiles) {
  const source = stripComments(readFileSync(file, 'utf8'));
  const imports = collectImports(source);
  for (const entry of imports) {
    if (!entry.specifier.startsWith('.')) continue; // 只检查本地模块
    const target = resolve(dirname(file), entry.specifier);
    importedTargets.add(target);
    const from = relative(ROOT, file);

    if (!existsSync(target)) {
      problems += 1;
      console.log(`  FAIL ${from} → ${entry.specifier} 不存在`);
      continue;
    }

    const exports = collectExports(stripComments(readFileSync(target, 'utf8')), target);
    const missing = entry.named.filter((item) => !exports.names.has(item.imported));
    if (missing.length) {
      problems += 1;
      console.log(`  FAIL ${from} 从 ${entry.specifier} 导入了不存在的导出：${missing.map((m) => m.imported).join('、')}`);
    } else if (entry.hasDefault && !exports.hasDefault && !exports.hasStar) {
      problems += 1;
      console.log(`  FAIL ${from} 使用了 ${entry.specifier} 的默认导出，但对方没有 export default`);
    } else {
      const count = entry.named.length + (entry.hasDefault ? 1 : 0) + (entry.hasNamespace ? 1 : 0);
      console.log(`  ok   ${from} → ${entry.specifier}（${count} 个引用）`);
    }
  }
}

// 反向检查：src/ 下没有任何人 import 的模块，通常是重构后的残留。
// 这里的入口清单 = 清单/HTML 直接加载的文件 + content-script.js 动态 import 的模块。
const ENTRY_POINTS = new Set([
  'src/background/service-worker.js',
  'src/content/content-script.js',
  // 声明式 content script 不支持 ESM，因此由 content-script.js 在运行时动态 import
  'src/content/ui-panel.js',
  // 由 offscreen.html / results.html 直接加载
  'src/offscreen/offscreen.js',
  'src/results/results.js'
]);
for (const file of jsFiles) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (!rel.startsWith('src/')) continue;
  if (ENTRY_POINTS.has(rel)) continue;
  if (!importedTargets.has(file)) {
    warnings += 1;
    console.log(`  WARN src 下没有任何模块 import 它：${rel}（是否为残留文件？）`);
  }
}

/* ───────────────────── 3. manifest.json ───────────────────── */

console.log('\n── 3. manifest.json 校验 ──────────────────────────────');
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  console.log(`  ok   JSON 合法，manifest_version=${manifest.manifest_version}，version=${manifest.version}`);
  if (manifest.manifest_version !== 3) {
    problems += 1;
    console.log('  FAIL manifest_version 必须是 3');
  }
} catch (err) {
  problems += 1;
  console.log(`  FAIL JSON 解析失败：${err.message}`);
}

if (manifest) {
  const required = [
    manifest.background?.service_worker,
    ...(manifest.content_scripts || []).flatMap((entry) => entry.js || []),
    ...(manifest.content_scripts || []).flatMap((entry) => entry.css || []),
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {})
  ].filter(Boolean);

  for (const entry of required) {
    if (existsSync(join(ROOT, entry))) {
      console.log(`  ok   ${entry}`);
    } else {
      problems += 1;
      console.log(`  FAIL 清单引用的文件不存在：${entry}`);
    }
  }

  for (const block of manifest.web_accessible_resources || []) {
    for (const resource of block.resources || []) {
      if (resource.includes('*')) {
        const dir = resolve(ROOT, dirname(resource));
        const extension = extname(resource);
        const hits = existsSync(dir)
          ? readdirSync(dir).filter((name) => (extension ? name.endsWith(extension) : true))
          : [];
        console.log(
          hits.length ? `  ok   ${resource}（匹配 ${hits.length} 个文件）` : `  WARN ${resource} 没有匹配到文件`
        );
        if (!hits.length) warnings += 1;
      } else if (existsSync(join(ROOT, resource))) {
        console.log(`  ok   ${resource}`);
      } else {
        problems += 1;
        console.log(`  FAIL web_accessible_resources 里的文件不存在：${resource}`);
      }
    }
  }

  const permissions = new Set(manifest.permissions || []);
  for (const permission of ['downloads', 'offscreen', 'storage']) {
    if (permissions.has(permission)) console.log(`  ok   权限 ${permission}`);
    else {
      problems += 1;
      console.log(`  FAIL 缺少权限：${permission}`);
    }
  }

  // content_scripts 的域名匹配必须被 host_permissions 覆盖，否则内容脚本注入了却抓不到图
  //
  // 例外：http://127.0.0.1/* 刻意不放进 host_permissions——它用来验证
  // 「扩展直连失败 → 页内 canvas 回退 → 原格式降级」这条路（见 docs/testing.md）。
  const INTENTIONALLY_UNCOVERED = new Set(['http://127.0.0.1/*']);
  const hostPatterns = manifest.host_permissions || [];
  const hostOrigins = hostPatterns.map((pattern) => pattern.replace(/\/\*$/, ''));
  for (const match of (manifest.content_scripts || []).flatMap((entry) => entry.matches || [])) {
    const origin = match.replace(/\/\*$/, '');
    const covered = hostOrigins.some((host) => host === origin || host === '<all_urls>');
    if (covered) {
      console.log(`  ok   content_scripts 的 ${match} 已被 host_permissions 覆盖`);
    } else if (INTENTIONALLY_UNCOVERED.has(match)) {
      console.log(`  info ${match} 刻意未授权（用于验证页内回退路径）`);
    } else {
      warnings += 1;
      console.log(`  WARN content_scripts 匹配 ${match}，但 host_permissions 没有对应条目（跨域抓图会退化到页内回退）`);
    }
  }

  console.log(
    `  info host_permissions 共 ${hostPatterns.length} 条，content_scripts 匹配 ${
      (manifest.content_scripts || []).flatMap((c) => c.matches || []).length
    } 条`
  );
}

/* ───────────────── 4. HTML 引用的本地资源 ───────────────── */

console.log('\n── 4. HTML 引用的本地资源 ─────────────────────────────');
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  const refs = [
    ...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g),
    ...html.matchAll(/<link[^>]+href=["']([^"']+)["']/g)
  ]
    .map((match) => match[1])
    .filter((ref) => !/^(?:https?:)?\/\//.test(ref));

  for (const ref of refs) {
    const target = resolve(dirname(file), ref);
    if (existsSync(target)) {
      console.log(`  ok   ${relative(ROOT, file)} → ${ref}`);
    } else {
      problems += 1;
      console.log(`  FAIL ${relative(ROOT, file)} → ${ref} 不存在`);
    }
  }
}

/* ───────────── 5. 消息类型的「发出方 ↔ 处理方」覆盖 ───────────── */

/**
 * 这一步专治一类只有运行时才暴露的 bug：常量里定义了消息类型、某处也真的发出去了，
 * 但接收方忘了在路由表（MESSAGE_HANDLERS / switch / 类型判断）里登记它。
 * 表现出来是运行时报「未知消息类型」，而语法检查和 import 检查都抓不到。
 *
 * 判定口径：
 *   发出 = 对象字面量里的 `type:` / `cmd:` / `target:` 值，或 request(ENUM.X) 这类调用；
 *   处理 = `[ENUM.X]:` 路由表项、`case ENUM.X:` 分支、`message.type !== ENUM.X` 判断。
 */
console.log('\n── 5. 消息类型覆盖（发出方 ↔ 处理方）──────────────────');

/** 从 constants.js 里抽出各个 Object.freeze 枚举的成员名。 */
function collectEnums(source) {
  const enums = new Map();
  const block = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*Object\.freeze\(\s*\{([\s\S]*?)\n\}\);/g;
  for (const match of source.matchAll(block)) {
    const members = new Set();
    for (const member of match[2].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)) members.add(member[1]);
    if (members.size) enums.set(match[1], members);
  }
  return enums;
}

const enums = collectEnums(stripComments(readFileSync(join(ROOT, 'src/shared/constants.js'), 'utf8')));
const MESSAGE_ENUMS = ['MSG', 'OFFSCREEN_MSG', 'PORT_PUSH', 'PORT_CMD'];

/**
 * 这些类型刻意没有「代码内的发出方」——它们由人在 DevTools 里手工触发，
 * 所以只警告不判错。每一条都必须写清触发方式。
 */
const MANUAL_TRIGGERS = new Map([['MSG.DIAGNOSTICS', "SW Console：chrome.runtime.sendMessage({type:'IG_DIAGNOSTICS'})"]]);

const senders = new Map();
const receivers = new Map();
function remember(map, key, from) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(from);
}

for (const file of jsFiles) {
  const from = relative(ROOT, file).replace(/\\/g, '/');
  const source = stripComments(readFileSync(file, 'utf8'));
  for (const enumName of MESSAGE_ENUMS) {
    if (!enums.has(enumName)) continue;
    const name = `[A-Za-z_$][\\w$]*`;
    const sendPattern = new RegExp(`(?:\\b(?:type|cmd|target)\\s*:\\s*|\\brequest\\(\\s*)${enumName}\\.(${name})`, 'g');
    const handlePattern = new RegExp(
      `(?:\\[\\s*${enumName}\\.(${name})\\s*\\]\\s*:|\\bcase\\s+${enumName}\\.(${name})\\s*:|\\bmessage\\.type\\s*[!=]==\\s*${enumName}\\.(${name}))`,
      'g'
    );
    for (const match of source.matchAll(sendPattern)) remember(senders, `${enumName}.${match[1]}`, from);
    for (const match of source.matchAll(handlePattern)) {
      remember(receivers, `${enumName}.${match[1] || match[2] || match[3]}`, from);
    }
  }
}

for (const [enumName, members] of enums) {
  if (!MESSAGE_ENUMS.includes(enumName)) continue;
  for (const member of members) {
    const key = `${enumName}.${member}`;
    const who = senders.get(key);
    const where = receivers.get(key);
    const whoList = who ? [...who].join('、') : '';
    const whereList = where ? [...where].join('、') : '';
    if (who && !where) {
      problems += 1;
      console.log(`  FAIL ${key} 已发出（${whoList}），但没有任何地方注册处理它`);
    } else if (!who && where && MANUAL_TRIGGERS.has(key)) {
      console.log(`  info ${key} 由人工触发：${MANUAL_TRIGGERS.get(key)}`);
    } else if (!who && where) {
      warnings += 1;
      console.log(`  WARN ${key} 有处理方（${whereList}）但全项目找不到发出方`);
    } else if (!who && !where) {
      warnings += 1;
      console.log(`  WARN ${key} 已定义但从未使用`);
    } else {
      console.log(`  ok   ${key} 发出 ${who.size} 处 / 处理 ${where.size} 处`);
    }
  }
}

rmSync(tmp, { recursive: true, force: true });

const summary = [`问题 ${problems} 个`];
if (warnings) summary.push(`提醒 ${warnings} 个`);
console.log(`\n${problems === 0 ? `全部检查通过（${summary.join('，')}）。` : `发现 ${summary.join('，')}。`}`);
process.exitCode = problems === 0 ? 0 : 1;
