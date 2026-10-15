# 图提取 ImageGrab

一个 Manifest V3 的 Chrome 扩展：提取电商商品详情页里的商品图片，去重过滤后在新标签页里以网格展示，并把 JPG / JPEG / WebP / GIF / BMP 等格式统一转换成 PNG 批量下载。

- 纯原生 HTML / CSS / JavaScript（ES Module），**零依赖、零构建**，直接「加载已解压的扩展程序」即可安装。
- 只处理**当前已打开页面 DOM 中真实存在**的图片地址：不爬取、不遍历商品 ID、不绕过登录与鉴权、不搭建服务端代理、不保存任何密钥。
- 图片只在本机处理，不上传任何数据。提取结果只存在 `chrome.storage.session`（会话级临时数据），浏览器重启即清空。

## 支持的平台

| 平台 | 详情页形态 | 状态 |
| --- | --- | --- |
| 淘宝 | `item.taobao.com/item.htm?id=...` | 支持 |
| 天猫 | `detail.tmall.com/item.htm?id=...` | 支持 |
| 京东 | `item.jd.com/<sku>.html`、`item.m.jd.com/product/<sku>.html` | 支持 |
| 拼多多 | `mobile.yangkeduo.com/goods.html?goods_id=...` | 支持 |
| 拼多多商家后台 | `mms.pinduoduo.com/goods/...` | 支持 |
| 本地测试页 | `localhost`、`127.0.0.1` | 支持（仅供开发测试） |

平台判定与「缩略图地址还原为原图」的规则集中在 [src/content/platform-rules.js](src/content/platform-rules.js) 与 [src/shared/url-utils.js](src/shared/url-utils.js)，站点改版时通常只需要动这两处。

平台判定失效时的应急开关：在详情页地址后面加 `?imagegrab=1`（或 `#imagegrab=1`）可强制注入按钮。

## 安装步骤

1. 打开 Chrome，地址栏输入 `chrome://extensions` 并回车。
2. 打开右上角的「开发者模式」。
3. 点击左上角「加载已解压的扩展程序」，选择本项目的**根目录**（即包含 `manifest.json` 的那个目录）。
4. 加载成功后列表里会出现「图提取 ImageGrab」。
5. 建议固定到工具栏：点击地址栏右侧的拼图图标 → 固定「图提取 ImageGrab」。

要求 Chrome 116 或更高（用到 `chrome.runtime.getContexts` 与离屏文档）。

## 使用方法

1. 打开一个受支持的商品详情页（或将本地测试页用 HTTP 方式打开）。
2. 页面右下角出现「获取图片」悬浮按钮（可拖动，位置会被记住）。点击它。
3. 扩展会先滚动页面触发懒加载，然后扫描图片、补全地址、还原原图、去重并按规则过滤。
   - 有结果时自动打开结果页标签；
   - 一张都没提取到时，按钮旁的状态卡片会说明过滤明细（尺寸过小、命中图标关键字等）。
4. 在结果页中：
   - 默认已勾选所有「还没成功下载过」的图片；
   - 「全选 / 反选 / 取消选择 / 选中失败项」调整选择，也可逐张勾选或点卡片切换；
   - 「尺寸 / 状态」下拉可筛选列表，筛选只影响显示，不影响已勾选项；
   - 点「下载选中」开始批量下载，点「取消任务」停止（未开始的条目作废，已开始的不打断，避免半截文件）；
   - 每张卡片右下角也有「单张下载」；失败条目会出现「重试」。
5. 下载结果：
   - 统一转成 PNG，文件名形如 `商品图_001.png`，编号与结果页列表顺序一致；
   - 转换不了（跨域、防盗链、已失效）时会自动**按原格式下载**并标记为「原格式」，不计入失败；
   - 确实下载不了的标记为「失败」，卡片和顶部提示条都会写明原因。
6. 工具栏图标等价于「打开最近一次提取结果」；如果当前页面不受支持，可以先用页面上的按钮提取。

## 反馈机制（提取不到 / 读不到 / 转换失败 / 下载失败）

| 情况 | 界面反馈 | 相关实现 |
| --- | --- | --- |
| 一张图都没提取到 | 面板卡片显示「没有找到可提取的图片」，并展开「过滤详情」按原因列出张数（地址无效、占位 data 图、命中图标/logo 黑名单、位于装饰区域、尺寸过小、长宽比异常、重复） | `ui-panel.js` → `describeFilterStats` / `FILTER_REASONS` |
| 图片数量比预期少 | 结果页顶部提示条给出「扫描到 N 个地址，保留 M 张，过滤掉 K 张」，可展开「为什么图片比我预期的少？」看每个原因的具体张数 | `results.js` → `renderBanner` |
| 部分图片读不到 | 缩略图位置显示「无法预览（可能已失效或需要登录）」，顶部提示条汇总「N 张图片在这个页面里无法预览」 | `grid.js` → `img.error`；`results.js` → `thumbFailed` |
| 跨域导致无法转 PNG | 该条降级为原格式下载，标记「原格式」，卡片写明「转换失败：跨域限制导致画布无法读取…；已按原格式下载」，批量结束的汇总里单列「原格式 N 张（不算失败）」 | `download-manager.js`、`converter.js`（三态探测）、`inpage-converter.js` |
| 下载失败 | 卡片标红「失败：<原因>」并出现「重试」；批量结束按错误类型归并，例如「3 张：图片加载失败（404、防盗链或需要登录）…（例如 商品图_007.png）」 | `download-manager.js` → `describeError`；`results.js` → `renderNoticeForSummary` |
| 结果页数据失效 | 显示「这批提取结果已经失效」并说明原因（浏览器重启、扩展重载、超过 2 小时、结果页关闭后回收） | `results.js` → `showEmpty('gone')` |
| 后台连接断开 | 状态行显示「正在重连后台（第 N 次）」，5 次失败后提示重新加载本页 | `results.js` → `scheduleReconnect` |

## 目录结构

```
g/
├── manifest.json                MV3 清单：权限、内容脚本、结果页资源声明
├── assets/icons/                扩展图标（由 tools/make-assets.mjs 生成）
├── src/
│   ├── background/              Service Worker：编排、会话存储、下载队列、离屏文档管理
│   ├── content/                 内容脚本：悬浮面板、页面扫描、地址处理、页内转换回退
│   ├── offscreen/               离屏文档：图片解码、canvas 重绘、PNG 编码、blob 地址
│   ├── results/                 结果页：响应式网格、选择交互、进度与错误反馈
│   └── shared/                  共享常量、日志、消息封装、URL 工具
├── test/
│   ├── test-page.html           本地测试页（不依赖真实电商网站）
│   ├── test-page.js             测试页自身的懒加载与 Shadow DOM 脚本
│   ├── test-frame.html          同源 iframe 测试页
│   ├── images/                  测试图片（由 tools/make-assets.mjs 生成）
│   ├── no-cors-server.mjs       「无 CORS 头」图片服务器，用于验证降级链路
│   ├── unit-check.mjs           纯逻辑自检（136 条断言，不需要浏览器）
│   └── fixture-server.md        本地夹具服务器的启动说明
├── tools/
│   ├── make-assets.mjs          生成图标与测试图片（可重复执行）
│   └── check-syntax.mjs         静态检查：语法、import/export 一致性、清单、HTML 引用、消息类型覆盖
└── docs/
    ├── testing.md               完整测试步骤
    └── troubleshooting.md       排障手册
```

## 权限说明

| 权限 | 用途 | 是否必需 |
| --- | --- | --- |
| `downloads` | 调用 `chrome.downloads.download` 保存图片 | 必需 |
| `offscreen` | 创建离屏文档，在扩展页里把图片转成 PNG 并生成 blob 地址（MV3 的 Service Worker 没有 `URL.createObjectURL`） | 必需 |
| `storage` | `chrome.storage.session` 存临时提取结果，`chrome.storage.local` 存按钮位置与设置 | 必需 |
| `host_permissions` | 让离屏文档以扩展身份抓取图片字节，不受页面 CORS 限制 | 按平台最小范围声明 |

`host_permissions` 只声明各平台页面域名与图片 CDN（`alicdn.com`、`taobaocdn.com`、`tbcdn.cn`、`360buyimg.com`、`pddpic.com`），**不包含 `<all_urls>`**。未覆盖的域名会退化为「页面内 canvas 转换」，失败则按原格式下载。

扩展**不申请** `scripting`、`tabs`、`activeTab`、`webRequest` 等权限。

> 开发提示：`http://localhost/*` 与 `content_scripts.matches` 里的 `localhost` / `127.0.0.1` 只是为了本地测试页，正式发布前可以删掉。注意 `http://127.0.0.1/*` 刻意**没有**放进 `host_permissions`，用来验证页内回退路径（见下文测试方法）。

## 测试方法

### 0. 离线自检（不需要浏览器，最快）

```bash
node test/unit-check.mjs     # 地址补全、srcset、原图还原、去重、过滤、平台判定、文案完整性
node tools/check-syntax.mjs  # 语法、模块 import/export 一致性、manifest 与 HTML 文件引用、消息类型覆盖
```

`check-syntax.mjs` 会检查两类「语法层面查不出来、只在运行时炸」的错误：每个模块的导出与别人 import 的名字是否对得上（错了会抛 `TypeError`），以及每个消息类型是否既有发出方、又登记了处理方（错了会报「未知消息类型」）。

### 1. 本地测试页（不需要真实电商网站）

测试页覆盖了普通图片、`srcset` / `picture`、`data-src` 懒加载、背景图（行内 style 与 CSS 类）、小图与 1×1 占位、Logo 与图标、重复图片、同源 iframe、open 模式 Shadow DOM、404 图片，以及一张来自 `127.0.0.1` 的无 CORS 图。

```bash
# 在项目根目录执行（页面里用的是相对路径 images/...，所以不要 --directory test）
python -m http.server 8000
```

然后打开 `http://localhost:8000/test/test-page.html`。

**预期：结果页显示 14 张图片。** 逐项核对测试页里的对照表：

| 场景 | 预期 |
| --- | --- |
| `photo-a` / `photo-b` / `photo-c` / `photo-large` | 全部保留，尺寸与真实像素一致 |
| `srcset` / `picture` | 只保留最大候选 `srcset-large.png`，`srcset-small.png` 不出现 |
| 懒加载 | `lazy-one.png`、`lazy-two.png` 都在（关闭「扫描前自动滚动」时可能缺失） |
| 背景图 | `bg-hero.png`（行内 style）与 `bg-tile.png`（CSS 类）都在 |
| 重复 | `photo-dup.png` 只有 1 条；`photo-a_400x400.png` 不出现，已还原并合并进 `photo-a.png` |
| 应该被过滤 | `photo-small.png`、`spacer-1x1.png`、`logo-site.png`、`banner-wide.png`、`photo-footer.png`、页眉里的装饰图、内联 SVG 占位图都不出现 |
| 404 | `missing-on-purpose.png` 在列表里，缩略图显示「无法预览」 |
| 同源 iframe / Shadow DOM | `frame-image.png`、`shadow-image.png` 都在 |
| 顶部提示条 | 「扫描到 N 个图片地址，保留 14 张，过滤掉 M 张」，可展开看各原因张数 |

### 2. 验证跨域降级链路

`127.0.0.1` 与 `localhost` 是不同源，且 `127.0.0.1` 不在 `host_permissions` 里，正好模拟「CDN 不返回 CORS 头」：

```bash
# 另开一个终端
node test/no-cors-server.mjs        # 默认监听 8001，提供 http://127.0.0.1:8001/no-cors.png
```

- 不启动它：该图在结果页显示「无法预览」，单独下载会失败并给出「图片加载失败…」。
- 启动它：扩展直连失败（无 host 权限）→ 页内 canvas 回退被污染 → 自动**按原格式下载**，卡片标记「原格式」，失败数不增加。

### 3. 真实平台验证

1. 四个平台各开一个商品详情页，确认按钮出现、数量合理（不含 Logo、图标、占位图）。
2. 各平台首页 / 搜索页确认按钮**不出现**。
3. 页内切换商品（单页应用路由）后再次点击，确认会新建会话而不是复用旧数据。
4. 滚到底触发大量懒加载后再提取，确认这些图片被收集。

完整的逐项清单见 [docs/testing.md](docs/testing.md)，出问题看 [docs/troubleshooting.md](docs/troubleshooting.md)。

### 4. 图标与测试图片重新生成

图标与测试图片都是本项目用脚本生成的（自己写 PNG 编码，无第三方依赖），可以随时重建：

```bash
node tools/make-assets.mjs
```

## 已知限制

- **跨域与防盗链**：部分图片 CDN 会校验 `Referer` 或要求登录态。扩展依次尝试「离屏抓取 → 页内 canvas 回退 → 原格式下载」，仍失败的会在卡片上标明原因。
- **画布污染**：既没有 host 权限、又不返回 CORS 头的跨域图片，浏览器不允许读取像素，无法转 PNG，只能按原格式下载。
- **跨域 iframe**：浏览器安全边界，内容脚本无法访问，这类图片不会被提取（界面上会明确说明，不会静默漏图）。
- **closed 模式的 Shadow DOM**：`attachShadow({ mode: 'closed' })` 无法访问，这类图片不会被提取。伪元素（`::before` / `::after`）里的背景图同样不支持。
- **懒加载**：默认扫描前自动滚动预热（可在面板上关闭，或改 [src/shared/constants.js](src/shared/constants.js) 里的 `DEFAULT_SETTINGS.autoScroll`），步数上限 30 步。极端无限滚动的页面仍可能漏图。
- **过滤可能误杀**：以「商品图」为默认目标，Logo、图标、1×1 占位、细长条、装饰区域内的图片会被过滤。若某商品主图恰好又小又细长，可在 `constants.js` 调低 `minWidth` / `minHeight` / `maxAspectRatio`。
- **数量与体积上限**：单页最多提取 500 张（`maxImages`）；画布像素上限 4096×4096，更大的图会等比降采样后再编码。
- **尺寸标注**：已还原为原图的条目，下载前显示的是页面上的尺寸或「约 N × M（展示尺寸）」；没有真实尺寸的不会参与尺寸筛选（始终显示）。
- **一次只能跑一个批次**：批量进行中不能发起单张下载，需先完成或取消。
- **临时数据的有效性**：结果页关闭会回收会话数据；浏览器重启、扩展重载都会清空；超过 2 小时或超过 10 个会话会被自动淘汰。
- **重名处理**：同名文件由 Chrome 自动追加序号（`商品图_001 (1).png`），不会覆盖已有文件。
- **技术前提**：依赖离屏文档与 `chrome.runtime.getContexts`，要求 Chrome 116+。未在 Edge / Brave 等其它 Chromium 浏览器上完整验证。
- **合规边界**：仅供学习与个人使用。请遵守目标站点的 robots 协议与用户协议，不要用于批量抓取或商业转载。

## 常见问题

**点了按钮但提示「没有找到可提取的图片」**
展开状态卡片里的「过滤详情」看是哪个原因。常见原因是页面还没加载完、商品图确实很小，或者图片在跨域 iframe 里。先把页面滚一遍再点一次。

**结果页显示「会话数据已过期」**
提取结果只存在于当前浏览器会话。浏览器重启、扩展重载、关闭结果页、超过 2 小时都会清理，请回到商品页重新提取。

**下载出来的图片比网页上看到的小**
说明该条是从缩略图地址还原的原图，但原图地址已失效，于是回退下载了页面上的实际地址。卡片上的「原格式」标记和尺寸标注会反映最终结果。

**批量下载中途看到「与扩展后台的连接已断开」**
Service Worker 被浏览器回收导致任务中断。刷新结果页后点「继续下载」即可，只需重跑未完成与失败的条目。

**工具栏图标点了没反应/最近结果页是空的**
工具栏图标打开的是最近一次提取结果；没有会话时结果页会提示「还没有提取记录」，回到详情页点页面上的按钮即可。

## 开发约定

- 关键逻辑与每个导出函数都有中文注释；
- 所有阈值、上限、消息类型、错误文案集中在 [src/shared/constants.js](src/shared/constants.js)；
- 平台差异集中在 [src/content/platform-rules.js](src/content/platform-rules.js) 与原图还原规则（`src/shared/url-utils.js` 的 `ALI_RESIZE_SUFFIX_PATTERNS` / `JD_PATH_REPLACERS` / `PDD_QUERY_BLOCKLIST`）；
- 内容脚本侧全为 ES Module：声明式 content script 不支持 ESM，因此 [src/content/content-script.js](src/content/content-script.js) 只是一个 classic 引导脚本，用 `import()` 动态加载 `ui-panel.js`（新增 `src/content/` / `src/shared/` 下的模块无需改清单，通配符已覆盖；新增**其它目录**的模块才需要加进 `web_accessible_resources`）；
- 改动后请跑一遍 `node test/unit-check.mjs` 与 `node tools/check-syntax.mjs`。

## 许可

仅供学习与个人使用。
