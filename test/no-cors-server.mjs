/**
 * 测试用「无 CORS 头」图片服务器。
 *
 * 目的：验证「扩展直连失败 → 页内 canvas 回退 → 被污染 → 原格式降级」这条完整链路。
 * 它故意不返回 Access-Control-Allow-Origin，而且 127.0.0.1 不在扩展的
 * host_permissions 里（只授权了 http://localhost/*），所以扩展侧抓不到。
 *
 * 用法：
 *   node test/no-cors-server.mjs          # 默认监听 8001
 *   node test/no-cors-server.mjs 9001     # 指定端口
 *
 * 然后从 http://localhost:8000/test/test-page.html 访问测试页。
 * 服务地址：http://127.0.0.1:8001/no-cors.png
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 8001;
const IMAGE = resolve(HERE, 'images', 'photo-b.png');

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  console.log(`${request.method} ${url.pathname}`);

  if (url.pathname !== '/no-cors.png') {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('只有 /no-cors.png 可用');
    return;
  }

  try {
    const bytes = await readFile(IMAGE);
    response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': bytes.length,
      'cache-control': 'no-store'
      // 故意不设置 access-control-allow-origin
    });
    response.end(bytes);
  } catch (err) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`读取图片失败：${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`无 CORS 头图片服务器已启动：http://127.0.0.1:${PORT}/no-cors.png`);
  console.log('按 Ctrl+C 退出。');
});
