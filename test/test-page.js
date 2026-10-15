/**
 * 测试页自己的小脚本（属于页面世界，与扩展无关）：
 *  1. 用 IntersectionObserver 模拟真实商品的懒加载（把 data-src 写进 src）；
 *  2. 在 shadow root 里放一张图，验证扩展会递归下钻 Shadow DOM；
 *  3. 提示用户当前访问方式是否正确（file:// / 扩展是否已注入面板）。
 */

(() => {
  /* 1. 懒加载：滚动进入视口后再赋值 src */
  const lazyImages = Array.from(document.querySelectorAll('img.lazy'));
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const img = entry.target;
          const source = img.getAttribute('data-src');
          if (source) img.src = source;
          observer.unobserve(img);
        }
      },
      { rootMargin: '200px 0px' }
    );
    for (const img of lazyImages) observer.observe(img);
  } else {
    for (const img of lazyImages) {
      const source = img.getAttribute('data-src');
      if (source) img.src = source;
    }
  }

  /* 2. Shadow DOM 里的图片 */
  const shadowHost = document.getElementById('shadow-host');
  if (shadowHost) {
    const root = shadowHost.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .wrap { display: inline-block; background: #fff; border: 1px solid #e4e7ef; border-radius: 10px; padding: 8px; }
        img { display: block; width: 280px; height: auto; border-radius: 6px; }
        p { margin: 6px 0 0; color: #6b7280; font-size: 12px; font-family: -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif; }
      </style>
      <div class="wrap">
        <img src="images/shadow-image.png" alt="Shadow DOM 内的图片 560×420" />
        <p>Shadow DOM 内的图片（shadow-image.png · 560×420）应出现在结果页。</p>
      </div>
    `;
  }

  /* 3. 环境自检 */
  const protocolWarning = document.getElementById('protocol-warning');
  if (location.protocol === 'file:' && protocolWarning) protocolWarning.hidden = false;

  const extensionWarning = document.getElementById('extension-warning');
  const extensionOk = document.getElementById('extension-ok');
  window.setTimeout(() => {
    if (location.protocol === 'file:') return;
    const hasPanel = Boolean(document.getElementById('imagegrab-panel-host'));
    if (extensionWarning) extensionWarning.hidden = hasPanel;
    if (extensionOk) extensionOk.hidden = !hasPanel;
  }, 2000);
})();
