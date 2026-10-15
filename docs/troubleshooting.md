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

1. 确认 URL 属于支持的平台，**并且**是商品详情页（首页、搜索页、购物车都不会注入，这是设计如此）。
2. 平台与详情页判定都在 `src/content/platform-rules.js` 的 `PLATFORMS` 表里（`hostPattern` 判域名、`isDetailPage` 判详情页）。站点改版导致 URL 形态变化时，改这两个字段即可。
3. 应急开关：在地址后面加 `?imagegrab=1`（或 `#imagegrab=1`）会强制注入，面板日志里会打印「通过 URL 参数强制注入」。
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
4. **结果页卡片数远多于提示条里的「保留 N 张」**：这不是提取多了，而是网格分片渲染把同一批条目重复挂进了容器——`grid.js` 的 `batchRanges`（每批 60 张）如果步长写错，卡片数会变成 n + (n-1) + … 的三角级放大（59 条能膨胀成上千张卡片，越靠前的图重复越多）。修好后卡片数恒等于图片条目数，`node test/unit-check.mjs` 的分片断言会盯住这一点。

## 6. 结果页提示「会话数据已过期」

`chrome.storage.session` 是会话级存储，以下情况会丢数据：

- 浏览器重启；
- 在 `chrome://extensions` 里重载/更新扩展；
- 关闭结果页标签（宽限 30 秒后主动删除该会话）；
- 会话创建超过 2 小时，或会话总数超过 10 个（自动淘汰最旧的）。

回到商品页重新提取即可。相关阈值见 `src/shared/constants.js` 的 `SESSION_LIMITS`。

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
4. Chrome 弹出「是否允许下载多个文件」时需要允许；安全软件也可能拦截批量下载，检查 `chrome://downloads`。

## 10. 下载的文件名不对

1. 形如 `商品图_001 (1).png`：下载目录已存在同名文件，Chrome 按 `conflictAction: 'uniquify'` 自动加序号（有意设计，绝不覆盖用户文件）。
2. 编号与结果页列表顺序一致；列表被排序或筛选后，编号按当前顺序重新生成。
3. 前缀与补零位数在 `src/shared/constants.js` 的 `DEFAULT_SETTINGS.filenamePrefix` / `filenamePad`；也可以在 `subfolder` 里指定下载子目录（会自动丢掉 `..`，避免路径穿越）。

## 11. 平台改版后的 5 分钟排查

站点改版通常只影响两件事：**详情页 URL 判定**与**缩略图地址还原规则**。

1. **确认平台识别**：看页面控制台日志 `[ImageGrab][panel] … 平台：xxx`。显示「未识别」说明 `PLATFORMS` 里的 `hostPattern` 没匹配上。
2. **确认详情页判定**：平台对但按钮不出现，说明 `isDetailPage` 失败。对比当前 URL 与正则，按新形态调整（例如详情页从 `/item.htm?id=` 变成 `/detail/<id>`）。
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
