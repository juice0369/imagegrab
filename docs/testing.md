# 测试步骤

按顺序做一遍即可覆盖全部功能路径。测试环境：Chrome 116+。

## 0. 准备

1. 打开 `chrome://extensions` → 右上角开启「开发者模式」→「加载已解压的扩展程序」→ 选择仓库根目录 `g/`。
2. 确认卡片上没有报错、点「Service Worker」进去 Console 能看到 `[ImageGrab] service worker 启动`。
3. 在仓库根目录起本地服务器：`python -m http.server 8000`（详见 `test/fixture-server.md`）。

## 1. 本地测试页（不依赖电商站点）

打开 `http://localhost:8000/test/test-page.html`。

- 右下角应出现「获取图片」悬浮按钮；2 秒后页面顶部显示「已检测到 ImageGrab 面板」。
- 拖动按钮到别处松手，刷新页面后位置应保持。
- 点击按钮，等待「滚动预热」跑完（会自动滚到底再回到原位）。

预期：结果页出现 **14 张**图片。逐项核对 `test/test-page.html` 里的对照表：

| 检查点 | 预期 |
| --- | --- |
| photo-a / photo-b / photo-c / photo-large | 都在，尺寸与文件名一致 |
| srcset / picture | 只出现 `srcset-large.png`（1280×960），没有 `srcset-small.png` |
| 懒加载 | `lazy-one.png`、`lazy-two.png` 都在（它们由 `data-src` 收集，占位图写在 `src` 里，尺寸按展示尺寸估算） |
| 背景图 | `bg-hero.png`、`bg-tile.png` 都在 |
| 重复 | `photo-dup.png` 只有 1 条；`photo-a_400x400.png` 不存在，合并进 `photo-a.png` |
| 过滤 | `photo-small.png`、`spacer-1x1.png`、`logo-site.png`、`banner-wide.png`、`photo-footer.png` 都不在 |
| 404 | `missing-on-purpose.png` 在列表里，缩略图位置显示「无法预览」 |
| 跨域 | 启动 `node test/no-cors-server.mjs` 后，第 14 张是它 |
| iframe / Shadow DOM | `frame-image.png`、`shadow-image.png` 都在 |
| 顶部提示条 | 显示「扫描到 N 个地址，保留 14 张，过滤掉 M 张」；展开「为什么图片比我预期的少？」能看到按原因分类的统计 |

## 2. 按钮注入范围

1. 淘宝 / 天猫 / 京东 / 拼多多的商品详情页各开一个，确认按钮出现且不遮挡平台自己的悬浮入口。
2. 各平台的首页、搜索页、购物车页 → 按钮**不出现**。
3. 详情页里点进另一个商品（SPA 路由切换）→ 按钮仍在，且再次点击提取会创建新会话。
4. 如果某个平台改版导致详情页识别失效：在地址后面加 `?imagegrab=1` 强制注入（临时排障用）。

## 3. 提取质量

1. 点「获取图片」→ 结果页自动打开。
2. 检查数量是否合理（不应出现 logo / 图标 / 1×1 占位图）。
3. 网格在窄窗（<620px）与宽窗下都自适应；卡片尺寸数字与真实像素一致。
4. 多张图片并列时确认没有同名重复条目。

## 4. 选择交互

全选 / 反选 / 取消选择 / 选中失败项 / 单张下载各点一次，确认按钮上的计数与卡片高亮同步。

## 5. 格式转换

在本地测试页里选 1 张 PNG、在真实平台上再选 1 张 JPG + 1 张 WebP，分别单张下载：

- 用图片查看器或 `file 商品图_001.png` 确认输出是**真正的 PNG**（不是改后缀）。
- 文件名严格是 `商品图_001.png`、`商品图_002.png`…（编号与面板/结果页顺序一致）。

## 6. 批量下载与进度

1. 全选 14 张（或真实页面 30 张），点「下载选中」。
2. 观察进度条、成功数、原格式数、失败数递增。
3. 打开 `chrome://downloads` 确认全部落地。
4. 中途点「取消任务」：未开始的条目变成「已取消」，**已经开始的不打断**（避免半截文件）。

## 7. 重名保护

同一批再下载一次 → 得到 `商品图_001 (1).png`，不覆盖已有文件。

## 8. 失败与降级反馈

1. 勾选 `missing-on-purpose.png` 单独下载 → 卡片变红，显示「失败：图片加载失败（404、防盗链或需要登录）…」，
   点「重试」可重试。
2. 勾选 `no-cors.png` 单独下载 → 若 `node test/no-cors-server.mjs` 没启动会直接失败；
   启动后转换路径全部受限，应降级为「原格式」并在卡片上给出提示，失败数不增加。
3. 批量结束时顶部出现汇总：「批量下载结束：成功 N 张，原格式 M 张（转换受限…），失败 K 张。失败原因：…」。

## 9. 临时数据与回收

1. 结果页下载中途直接关掉 → 30 秒后（`chrome://extensions` 点开 SW 的 Console）能看到 `回收会话 …`，
   且不再有残留 blob（`ImageGrabDebug.diagnostics()` 里 `blobs` 归零）。
2. 刷新源详情页后再点按钮 → 生成新会话，旧会话被淘汰（上限 10 个 / 有效期 2 小时）。
3. 重启浏览器 → `chrome://extensions` → SW Console 里 `chrome.runtime.sendMessage({type:'IG_DIAGNOSTICS'})`
   应看到 `sessions: []`（session 存储已清空）。

## 10. 断线与恢复

1. 下载大批图片时刷新结果页 → 关掉长连接后 30 秒内重连（状态栏短暂显示「正在重连后台」），数据不丢、进度继续。
2. 下载中途在 `chrome://extensions` 点扩展的「重新加载」→ 结果页提示「扩展已重新加载，请刷新本页」。
3. 若任务被 SW 回收中断，结果页状态栏提示「上次任务被中断…可以点继续下载」，「继续下载」只重跑未完成/失败的条目。

## 11. 静态检查

```bash
# 语法 + 模块 import/export 一致性 + manifest 与 HTML 引用
node tools/check-syntax.mjs

# 提取逻辑断言（地址补全、srcset、原图还原、去重、过滤、平台判定、文案完整性）
node test/unit-check.mjs
```

两个脚本都是零依赖的纯 Node 脚本，不需要浏览器。`check-syntax.mjs` 会把每个模块的导出名与别人 import 的名字对一遍——这类问题不会在语法检查阶段暴露，只会在运行时抛 `TypeError`。
