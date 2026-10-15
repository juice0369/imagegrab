/*
 * 官网交互脚本。
 *
 * 只用渐进增强：所有内容在禁用 JavaScript 时依然可读、可下载，
 * 这里做的三件事都是「有则更好」：
 *   1. 用 HEAD 请求读出 ZIP 的真实大小，避免页面上写死一个会过期的数字；
 *   2. 高亮当前所在的导航项；
 *   3. 点击下载按钮后给出即时反馈（不拦截默认行为，下载照常进行）。
 */

(function () {
  'use strict';

  /* ── 1. 读取压缩包真实体积 ─────────────────────────────── */

  var zipLinks = document.querySelectorAll('[data-zip]');
  var zipUrl = zipLinks.length ? zipLinks[0].getAttribute('href') : null;

  function formatSize(bytes) {
    var kb = bytes / 1024;
    if (kb >= 1024) return (kb / 1024).toFixed(1) + ' MB';
    return Math.max(1, Math.round(kb)) + ' KB';
  }

  if (zipUrl && window.fetch) {
    // file:// 下 HEAD 请求会失败，此时静默保持「体积未知」的状态
    fetch(zipUrl, { method: 'HEAD', cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) return;
        var len = Number(res.headers.get('content-length'));
        if (!len) return;
        document.querySelectorAll('[data-zip-size]').forEach(function (el) {
          el.textContent = formatSize(len);
          el.hidden = false;
        });
      })
      .catch(function () {
        /* 忽略：不是关键信息 */
      });
  }

  /* ── 2. 高亮当前导航项 ─────────────────────────────────── */

  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.site-nav a[href^="#"]'));
  var sections = navLinks
    .map(function (link) {
      return document.getElementById(link.getAttribute('href').slice(1));
    })
    .filter(Boolean);

  function setActive(id) {
    navLinks.forEach(function (link) {
      var on = link.getAttribute('href') === '#' + id;
      if (on) {
        link.setAttribute('aria-current', 'true');
        link.style.color = 'var(--brand)';
        link.style.background = 'var(--amber-tint)';
      } else {
        link.removeAttribute('aria-current');
        link.style.color = '';
        link.style.background = '';
      }
    });
  }

  if ('IntersectionObserver' in window && sections.length) {
    var visible = Object.create(null);
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          visible[entry.target.id] = entry.isIntersecting;
        });
        for (var i = 0; i < sections.length; i += 1) {
          if (visible[sections[i].id]) {
            setActive(sections[i].id);
            return;
          }
        }
      },
      { rootMargin: '-30% 0px -60% 0px', threshold: 0 }
    );
    sections.forEach(function (section) {
      observer.observe(section);
    });
  }

  /* ── 3. 下载按钮的即时反馈 ─────────────────────────────── */

  var hint = document.getElementById('download-hint');
  var hintDefault = hint ? hint.textContent : '';

  zipLinks.forEach(function (link) {
    link.addEventListener('click', function () {
      var label = link.querySelector('[data-zip-label]');
      var original = label ? label.textContent : '';
      if (label) {
        label.textContent = '已开始下载…';
        window.setTimeout(function () {
          label.textContent = original;
        }, 2600);
      }
      if (hint) {
        hint.textContent = '浏览器应该已经开始下载。下载完成后请解压 ZIP，再在扩展程序页面选择解压出来的文件夹。';
        window.setTimeout(function () {
          hint.textContent = hintDefault;
        }, 6000);
      }
    });
  });

  /* ── 4. 页脚年份 ───────────────────────────────────────── */

  document.querySelectorAll('[data-year]').forEach(function (el) {
    el.textContent = String(new Date().getFullYear());
  });
})();
