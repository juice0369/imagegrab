# 排障手册

## 0. 先跑两个静态检查

```bash
node tools/check-syntax.mjs   # 语法 + 模块 import/export 一致性 + manifest/HTML 引用
node test/unit-check.mjs      # 提取、还原、去重、过滤、平台判定的纯逻辑断言
```

`check-syntax.mjs` 会把 export 名字与 import 名字对一遍。这类错误不会在语法检查阶段暴露，只会在真正执行到那行代码时抛 `TypeError`（例如某个分支只在“跨域回退”时才走到），所以先跑它最省事。

## 1. 四个可以看日志的地方

| 环境 | 打开方式 | 关心的日志 |
| --- | --- | --- |
| 商品详情页（内容脚本） | 页面 F12 → Console | `[ImageGrab][panel]` 的平台判定、扫描与过滤结果 |
| Service Worker | `chrome://extensions` → 扩展卡片「Service Worker」 | `[ImageGrab][sw]` 会话创建、批次开始/结束、下载失败 |
| 离屏文档 | `chrome://extensions` → 扩展卡片「检查视图 offscreen.html」 | `[ImageGrab][offscreen]` / `[ImageGrab][converter]` 的抓图与编码结果 |
| 结果页 | 结果页 F12 → Console | `[ImageGrab][results]` 的长连接消息、会话读取失败 |

Service Worker 的 Console 里可以直接手工排障：

```js
ImageGrabDebug.diagnostics()      // 会话、长连接、offscreen 状态一览
ImageGrabDebug.status()           // 有哪些会话、哪些任务在跑
ImageGrabDebug.jobs()             // 当前持有长连接的会话 id
await ImageGrabDebug.destroy(sid) // 手工回收某个会话
```

也可以发一次消息取同一份数据：`chrome.runtime.sendMessage({ type: 'IG_DIAGNOSTICS' })`。

## 2. 按钮不出现

1. 确认 URL 属于支持的平台域名：支持的域名下**所有页面**都会注入（首页、搜索页、列表页、详情页）。不在支持列表里的站点不注入，这是设计如此。
2. 域名匹配在 `src/content/platform-rules.js` 的 `PLATFORMS` 表里（`hostPattern`）、以及 `manifest.json` 的 `content_scripts.matches` + `web_accessible_resources.matches`。**三处都要有**：只改 `hostPattern` 而没改 `matches`，脚本根本不会注入；只改 `matches` 而没改 `hostPattern`，脚本注入了但认不出平台。
3. `isDetailPage`（商品详情页判定）**不影响按钮是否出现**，只影响按钮悬停提示与面板里的页面类型说明。加 `?imagegrab=1`（或 `#imagegrab=1`）会把当前页标记成详情页，日志里打印「通过 URL 参数强制标记为详情页（imagegrab=1）」。
4. 内容脚本以 `run_at: document_idle` 注入，页面刚打开就去看可能还没执行，等一秒或刷新。
5. 打开 `chrome://extensions`，看扩展卡片上是否有「错误」按钮。若清单引用的文件缺失或内容脚本有语法错误，浏览器会直接不注入。
6. 页面是 `file://` 打开的吗？`matches` 里只有 `http` / `https`，`file://` 不会注入（本地测试页请用 HTTP 服务器打开）。

## 3. 提示「模块加载失败」

内容脚本通过 `import(chrome.runtime.getURL('src/content/ui-panel.js'))` 动态加载模块，这些文件必须在 `manifest.json` 的 `web_accessible_resources` 里可访问。

- 新增 `src/content/` 或 `src/shared/` 下的模块**不用改清单**（通配符 `src/content/*.js`、`src/shared/*.js` 已覆盖）；
- 新增**其它目录**下的模块，必须把该目录加进 `web_accessible_resources`，并把这些文件自己也写进去（`ui-panel.js` 直接 import 的模块都会被浏览器按 `chrome-extension://` 地址请求）。

## 4. 提取数量明显偏少

结果页顶部提示条会给出「扫描到 N 个图片地址，保留 M 张，过滤掉 K 张」，展开「为什么图片比我预期的少？」可以看到每个原因的张数。原因关键字与中文说明见 `src/shared/constants.js` 的 `FILTER_REASONS`：

| 原因 | 含义 | 调整位置 |
| --- | --- | --- |
| `invalid` | 地址无效或协议不支持 | — |
| `data` | 体积过小的 `data:` 占位图（< 2048 字符） | `image-filter.js` 的 `DATA_PLACEHOLDER_MAX_LENGTH` |
| `url` | 命中图标/Logo/广告关键字黑名单 | `image-filter.js` 的 `URL_BLOCKLIST` |
| `context` | 位于页头、页脚、导航、logo/icon/avatar 等装饰区域内 | `image-scanner.js` 的 `DECORATION_ANCESTOR_SELECTOR` |
| `tiny` | 尺寸过小 | `constants.js` 的 `minWidth` / `minHeight` / `minDisplaySize` |
| `aspect` | 长宽比异常（细长条） | `constants.js` 的 `maxAspectRatio` |
| `duplicate` | 与已保留的图片重复 | `constants.js` 的 `dedupe` |

判定顺序（一条记录只记**第一个**命中的原因）：`invalid` → `data` → `context` → `url` → `tiny` → `aspect` → `duplicate`。装饰区域排在 URL 黑名单之前，因为「这张图在页头 / 页脚 / 导航里」是直接读到的 DOM 事实，比「文件名里带 logo」这类关键字更可信——footer 里的 `nav/logo.png` 会记成 `context`。想看别的顺序就调 `image-filter.js` 里这几个判断的先后（`test/unit-check.mjs` 的「被过滤的条目也要列出」分组盯着这一条）。

被过滤的条目**不会悄悄消失**：结果页会用灰色虚线卡片把它们列出来（默认不勾选、徽标写短标签、正文写完整原因，重复的会写明与第几张相同），误判的可以手动勾选下载。单次最多列出 `DEFAULT_SETTINGS.maxFilteredImages`（默认 500）张，超出的部分只在提示条的统计里计数——面板与结果页都会写明「另有 N 张没有列出来」。`invalid` 地址无法显示，只计数。

其它常见原因：

1. **懒加载没触发**：确认面板上的「扫描前自动滚动」是勾选状态（默认勾选，存在 `chrome.storage.local` 的 `ig:settings`；默认值见 `DEFAULT_SETTINGS.autoScroll`）。也可以点按钮前手动把页面滚到底再回来。
2. **图片在跨域 iframe 里**：浏览器安全边界，无法访问，属已知限制。
3. **closed 模式的 Shadow DOM**：`attachShadow({ mode: 'closed' })` 拿不到 shadowRoot。
4. **背景图在伪元素里**：`::before` / `::after` 的 `background-image` 本扩展不处理。
5. **图片是 CSS `image-set()` 或 `<picture>` 里没有 `srcset` 的 `source`**：只识别 `srcset` 与 `src`。

## 5. 提取数量明显偏多（混进了图标、二维码、水印）

1. `DECORATION_ANCESTOR_SELECTOR` 只覆盖常见的容器选择器模式，站点容器类名千奇百怪。找到目标图片的容器类名后补进该选择器即可。
2. 注意：**装饰区域判定对所有尺寸的图片都生效**，没有“大图豁免”。如果某张商品主图恰好位于 `class` 含 `icon` 之类的容器里，会被误杀——这时应从选择器里去掉对应模式，或改宽 `URL_BLOCKLIST`。
3. 水印、二维码这类图通常直接出现在商品图容器里，需要手工取消勾选，或在 `URL_BLOCKLIST` 里按地址特征加规则（例如 `/qrcode/i`、`/watermark/i` 已默认包含）。
4. **结果页卡片数远多于提示条里的「保留 N 张」**：先看「范围」下拉——默认是「全部（含被过滤）」，卡片数 = 可下载的 + 被过滤的，这是正常的。切到「只看可下载」后如果卡片数仍多于「保留 N 张」，那是网格分片渲染把同一批条目重复挂进了容器——`grid.js` 的 `batchRanges`（每批 60 张）如果步长写错，卡片数会变成 n + (n-1) + … 的三角级放大（59 条能膨胀成上千张卡片，越靠前的图重复越多）。修好后卡片数恒等于图片条目数，`node test/unit-check.mjs` 的分片断言会盯住这一点。

## 6. 结果页提示「会话数据已过期」

`chrome.storage.session` 是会话级存储，以下情况会丢数据：

- 浏览器重启；
- 在 `chrome://extensions` 里重载/更新扩展；
- 关闭结果页标签（宽限 30 秒后主动删除该会话）；
- 会话创建超过 2 小时，或会话总数超过 10 个（自动淘汰最旧的）。

回到商品页重新提取即可。相关阈值见 `src/shared/constants.js` 的 `SESSION_LIMITS`。

## 6.1 面板 / 结果页提示「扩展已重新加载」（原文 `Extension context invalidated.`）

**现象**：点「获取图片」后卡片显示这句英文，或者结果页整页提示「扩展已重新加载，本页已和扩展断开」。

**成因**：这句话是浏览器抛的，不是本扩展的文案。扩展一旦被重载或更新，已经打开的页面里那份旧代码就被**孤立**了——`chrome.runtime.id` 变成 `undefined`，之后任何 `chrome.*` 调用都会被拒绝。旧代码无法在页面内自愈，唯一的出路是刷新页面让新脚本重新注入。

**触发场景**：在 `chrome://extensions` 点了「重新加载」，然后没有刷新商品页就直接点按钮；或者扩展在后台自动更新，而结果页一直开着。

**处理**：

1. 面板上的按钮会变成「需刷新页面」，卡片里给了「刷新页面」按钮，点一下就恢复；
2. 结果页右上角有「刷新页面」按钮；
3. 注意刷新后会话数据通常已随重载被清空，若提示「提取结果已失效」，回商品页重新提取。

**控制台里会看到什么**：这条提示打在**页面自己的 Console**（例如 www.taobao.com），不是扩展的 Service Worker 控制台 —— 内容脚本的日志按设计就落在宿主页面里。被动自检（切回标签页、页面被重绘）只记一条 `debug`，因为那不是用户操作失败；只有你点了「获取图片」/「打开结果页」才发现失效时，才记一条 `warn`（`扩展已重新加载，本页的 content script 已失效，需要刷新页面后重试`），那才是排障要看的一条。两档各记一次，不会刷屏。

**修复方式（避免再次露出英文原文）**：

| 位置 | 做法 |
| --- | --- |
| `src/shared/messaging.js` | `isExtensionAlive()` / `isContextInvalidated()` / `createContextInvalidatedError()`；`toError()` 会把 `CONTEXT_INVALIDATED` 的错误信息统一换成 `ERROR_CODES.CONTEXT_INVALIDATED` 的中文文案 |
| `src/content/ui-panel.js` | `reportContextInvalidated({ showCard, passive })`：按钮切到「需刷新页面」并给出「刷新页面」按钮；`visibilitychange` / `MutationObserver` 走 `passive: true`（只记 `debug`），用户点按钮才发现失效的路径记 `warn`，避免往站点控制台里丢扩展的警告 |
| `src/results/results.js` | `describeFailure()` 统一出口；上下文失效时直接进 `showEmpty('reloaded')`，不再显示英文报错 |

排查时若又看到裸的 `Extension context invalidated.`，说明有一处新加的 UI 文案没走 `describeError()` / `describeFailure()`，补上即可。相关断言见 `test/unit-check.mjs` 的「上下文失效」分组。

## 7. 单张图片下载失败

结果页卡片上会显示错误码对应的中文文案（原文见 `src/shared/constants.js` 的 `ERROR_CODES`，界面统一走 `describeError()`）。

| 卡片提示 | 错误码 | 含义与处理 |
| --- | --- | --- |
| 图片加载失败（404、防盗链或需要登录） | `IMG_LOAD_FAILED` | 图片地址已失效/需要登录/被防盗链拦截。刷新商品页后重新提取；若该 CDN 是常客，把它加进 `host_permissions` |
| 图片加载超时 | `IMG_TIMEOUT` | 网络太慢或图片服务器无响应，重试；必要时调大 `convertTimeoutMs` |
| 图片尺寸为 0，无法解码 | `EMPTY_IMAGE` | 占位图或 SVG 之类的异常资源 |
| 跨域限制导致画布无法读取 | `TAINTED_CANVAS` | 无 host 权限且对方不返回 CORS 头。加域名进 `host_permissions` 即可转 PNG，否则会自动降级为原格式 |
| 后台转换服务不可用 | `OFFSCREEN_ERROR` / `OFFSCREEN_FAILED` | 离屏文档创建或调用失败，查看离屏文档控制台；此时会走页内回退或原格式降级 |
| 源页面已关闭，无法使用页内回退 | `PAGE_GONE` | 详情页已关闭，刷新页面后重新提取 |
| 图片过大，超出单次传输上限 | `PNG_TOO_LARGE` | 页内回退传输超过 32MB（`MAX_TRANSFER_BYTES`），改用离屏直连或原格式下载 |
| 等待下载完成超时 | `DOWNLOAD_TIMEOUT` | 下载卡住，重试 |
| 写文件失败（路径或权限问题） | `FILE_ERROR` | 检查下载目录与浏览器的下载权限、磁盘空间 |
| 网络错误 / 服务器错误 | `NETWORK_ERROR` / `SERVER_ERROR` | 会自动退避重试（默认 2 次），仍失败则标记为失败 |
| 下载被中断 / 被取消 | `DOWNLOAD_INTERRUPTED` / `USER_CANCELED` | 用户操作或浏览器取消，不计入“转换失败” |

批量结束时的提示条会把失败项**按错误类型归并**并举例文件名，方便定位是哪一批地址有问题。

## 8. 所有图片都变成「原格式」

说明「离屏直连」与「页内 canvas 回退」两条转换路径整体都走不通，通常是 `host_permissions` 没覆盖图片 CDN：

1. 打开离屏文档控制台，找到 `[ImageGrab][converter]` 的失败日志，或看结果页卡片上「已尝试：扩展直连原图地址、扩展直连页面原始地址、页内 canvas 回退」的列举。
2. 从图片地址里取域名，加入 `manifest.json` 的 `host_permissions`。
3. 在 `chrome://extensions` 点「重新加载」使权限生效，并重新打开商品页。
4. 注意 `http://127.0.0.1/*` 是**故意**不授权的，用于验证降级链路，不要把它当成 bug。

## 9. 批量下载中途停止

1. 确认结果页标签没有被关闭或休眠：长连接负责保活，页面被丢弃会导致 Service Worker 被回收。
2. 看到「与扩展后台的连接已断开」时，刷新结果页后点「继续下载」即可——只会重跑未完成与失败的条目（`PORT_CMD.RESUME`）。
3. 若状态行显示「上次任务被中断」，说明 SW 在下载过程中被回收，`session-store` 已把进行中的条目退回 `pending`。
4. 自己点过「取消任务」也一样能接着下：未开始的条目会变成「已取消」，它们和失败的条目都算「没完成」，
   状态行与顶部提示条会写明还剩多少张，「继续下载」按钮一直在，点它只重跑这些条目。
5. Chrome 弹出「是否允许下载多个文件」时需要允许；安全软件也可能拦截批量下载，检查 `chrome://downloads`。

## 10. 下载的文件名不对

1. 编号从 `001` 开始、在**同一个会话里连续递增**：下过 14 张后再下 2 张，得到 `015`、`016`。游标存在会话的 `downloadSequence` 里（`startDownload` 用 `assignSequences()` 分配，下一批接着排）。结果页顶部的「下一个文件名」就是当前游标。
2. 出现 `商品图_001 (1).png`：说明这个编号在下载目录里已经存在。常见原因：重新提取（新会话，编号从 `001` 重来）、或重复勾同一张又下一次。Chrome 按 `conflictAction: 'uniquify'` 加序号，绝不覆盖用户文件。
3. 批内顺序 = 结果页列表顺序；列表被排序或筛选后，编号按当前顺序重新生成。
4. 前缀与补零位数在 `src/shared/constants.js` 的 `DEFAULT_SETTINGS.filenamePrefix` / `filenamePad`；也可以在 `subfolder` 里指定下载子目录（会自动丢掉 `..`，避免路径穿越）。

## 11. 平台改版后的 5 分钟排查

站点改版通常只影响两件事：**域名匹配**与**缩略图地址还原规则**。

1. **确认平台识别**：看页面控制台日志 `[ImageGrab][panel] … 平台：xxx`。显示「未识别」说明 `PLATFORMS` 里的 `hostPattern`（以及 `manifest.json` 的 `matches`）没匹配上新域名。
2. **确认页面类型提示**：按钮在但提示写着「不是商品详情页」，说明 `isDetailPage` 没匹配上——这**不影响提取**，只影响提示文案。详情页 URL 换形态时按新形态调整正则即可（例如详情页从 `/item.htm?id=` 变成 `/detail/<id>`）。
3. **确认原图还原**：抽一张缩略图地址，在 `node` 里验证：
   ```bash
   node -e "import('./src/shared/url-utils.js').then(m=>console.log(m.restoreOriginalUrl(process.argv[1], m.getOriginalRules('taobao'))))" "https://img.alicdn.com/xxx.jpg_400x400.jpg"
   ```
   期望输出 `https://img.alicdn.com/xxx.jpg`。若站点换了后缀格式，改 `ALI_RESIZE_SUFFIX_PATTERNS`（注意：**替换串必须保留扩展名**，否则会得到没有后缀的地址）。
4. **确认页面结构**：若商品图被装饰区域规则误杀，把对应容器选择器从 `DECORATION_ANCESTOR_SELECTOR` 里去掉。
5. 改完在 `chrome://extensions` 点「重新加载」，再走一遍 `docs/testing.md` 的对照表，并补一条 `test/unit-check.mjs` 断言。

## 12. 性能与资源边界

| 限制 | 默认值 | 位置 |
| --- | --- | --- |
| 单页提取上限 | 500 张 | `DEFAULT_SETTINGS.maxImages` |
| 画布像素上限 | 4096×4096，超出等比降采样 | `MAX_PIXELS` |
| 背景图扫描元素上限 | 3000 个，且只扫展示面积 ≥ 60×60 的元素 | `maxBackgroundScanElements` / `minAreaForBackgroundScan` |
| 懒加载滚动步数上限 | 30 步，每步 400ms | `scrollMaxSteps` / `scrollStepDelayMs` |
| 下载并发 | 3 张 | `DEFAULT_SETTINGS.concurrency` |
| 转换 / 下载超时 | 30s / 120s | `convertTimeoutMs` / `downloadTimeoutMs` |
| 下载失败重试 | 2 次（仅网络/服务器类错误） | `maxRetries` |
| blob 地址存活上限 | 10 分钟兜底回收（正常路径下载完即释放） | `BLOB_TTL_MS` |
| 页内回退单次传输上限 | 32MB | `MAX_TRANSFER_BYTES` |

如果提取时页面卡顿，优先关掉面板上的「扫描前自动滚动」，或调低 `maxBackgroundScanElements`。
