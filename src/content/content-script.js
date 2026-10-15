/**
 * content script 的唯一入口。
 *
 * 重要：MV3 的「声明式 content script」不支持 ES Module，所以这里是一个 classic script，
 * 用动态 import 加载真正的模块代码（模块文件通过 web_accessible_resources 暴露）。
 * 这样 content 侧依然全部是标准 ESM，和 background / results 共用同一套 shared 模块。
 */

(() => {
  const ENTRY = 'src/content/ui-panel.js';
  const boot = () => {
    const url = chrome.runtime.getURL(ENTRY);
    import(url)
      .then((mod) => mod.start())
      .catch((err) => {
        // 这里不能依赖 shared/logger（模块加载失败时就还没加载到）
        console.error('[ImageGrab] content 模块加载失败：', err);
      });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
