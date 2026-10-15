# 本地夹具服务器

content script 只在 `localhost` / `127.0.0.1` 上注入（见 `manifest.json` 的 `content_scripts.matches`），
`file://` 打开测试页不会注入面板，所以要用本地 HTTP 服务器。

## 一、启动测试页服务器（端口 8000）

在**仓库根目录**执行（不是 test 目录，因为页面里用的是相对路径 `images/...`）：

```bash
# 方式 A：Python（推荐，Python 3 自带）
python -m http.server 8000

# 方式 B：Node（>= 18）
npx --yes serve -l 8000 .
```

然后访问：

```
http://localhost:8000/test/test-page.html
```

> 用 `http://127.0.0.1:8000/test/test-page.html` 也能打开（content script 同样会注入），
> 但 `127.0.0.1` 刻意不放进 `host_permissions`，所以图片会走「页内 canvas 回退」这条路，
> 正好可以顺便验证回退链路。

## 二、启动「无 CORS 头」图片服务器（端口 8001，可选）

测试页第 8 节里有一张 `http://127.0.0.1:8001/no-cors.png`，用来验证
「扩展直连失败 → 页内 canvas 回退被污染 → 原格式降级」这条完整链路：

```bash
node test/no-cors-server.mjs        # 默认 8001
node test/no-cors-server.mjs 9001   # 也可以换端口，记得同步改测试页里的地址
```

不启动它也可以：那张图会直接变成加载失败，结果页给出「无法预览」提示。

## 三、图片资源从哪来

`test/images/*.png` 与 `assets/icons/*.png` 都由脚本生成，可以随时重建：

```bash
node tools/make-assets.mjs
```

`test/images/missing-on-purpose.png` 是**故意不存在**的（404 场景），不要在生成脚本里补上它。
