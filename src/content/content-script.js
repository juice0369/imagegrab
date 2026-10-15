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
    let url;
    try {
      url = chrome.runtime.getURL(ENTRY);
    } catch (err) {
      // 扩展在「脚本注入」与「这里执行」之间被重载/卸载：chrome.* 已经不可用。
      // 浏览器抛的是英文原文（Extension context invalidated.），换成能照着做的中文提示。
      console.warn(
        '[ImageGrab] 扩展已被重新加载或停用，本页的面板无法注入。刷新页面即可恢复。',
        err?.message || err
      );
      return;
    }
    import(url)
      .then((mod) => mod.start())
      .catch((err) => {
        // 这里不能依赖 shared/logger（模块加载失败时就还没加载到）
        console.error('[ImageGrab] content 模块加载失败（检查 web_accessible_resources 是否覆盖该文件）：', err);
      });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
