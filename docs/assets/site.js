/*
 * 官网交互脚本。
 *
 * 全部是渐进增强：禁用 JavaScript 时内容依然完整可读、可下载，
 * 这里做的事情都是「有则更好」——
 *   1. 滚动时内容轻微淡入；
 *   2. 窄屏下把导航折叠成菜单；
 *   3. 用 HEAD 请求读出 ZIP 的真实大小，避免页面写死一个会过期的数字；
 *   4. 高亮当前所在分区的导航项；
 *   5. 点击下载按钮后给出即时反馈（不拦截默认行为，下载照常进行）。
 */

(function () {
  'use strict';

  var root = document.documentElement;
  var reduceMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* 通知 index.html 里的内联脚本：脚本跑起来了，不要回退成无动效状态 */
  root.classList.add('js-ready');

  /* ── 1. 滚动淡入 ───────────────────────────────────────── */

  var revealTargets = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));

  function revealAll() {
    revealTargets.forEach(function (el) {
      el.classList.add('is-visible');
    });
  }

  if (reduceMotion || !('IntersectionObserver' in window)) {
    // 用户要求减少动态效果，或浏览器不支持观察器：直接呈现最终状态
    revealAll();
  } else {
    var revealObserver = new IntersectionObserver(
      function (entries, observer) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0 }
    );

    revealTargets.forEach(function (el) {
      revealObserver.observe(el);
    });
  }

  /* ── 2. 窄屏导航折叠 ───────────────────────────────────── */

  var navToggle = document.querySelector('[data-nav-toggle]');
  var nav = document.getElementById('site-nav');

  function setNavOpen(open) {
    if (!navToggle || !nav) return;
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    nav.classList.toggle('site-nav--open', open);
  }

  if (navToggle && nav) {
    navToggle.addEventListener('click', function () {
      setNavOpen(navToggle.getAttribute('aria-expanded') !== 'true');
    });

    // 点导航链接后收起面板，避免滚动到目标位置时菜单还盖在上面
    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) setNavOpen(false);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && navToggle.getAttribute('aria-expanded') === 'true') {
        setNavOpen(false);
        navToggle.focus();
      }
    });
  }

  /* ── 3. 读取压缩包真实体积 ─────────────────────────────── */

  var zipLinks = Array.prototype.slice.call(document.querySelectorAll('[data-zip]'));
  var zipUrl = zipLinks.length ? zipLinks[0].getAttribute('href') : null;

  function formatSize(bytes) {
    var kb = bytes / 1024;
    if (kb >= 1024) return (kb / 1024).toFixed(1) + ' MB';
    return Math.max(1, Math.round(kb)) + ' KB';
  }

  if (zipUrl && window.fetch) {
    fetch(zipUrl, { method: 'HEAD', cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var len = Number(res.headers.get('content-length'));
        if (!len) throw new Error('缺少 content-length');
        document.querySelectorAll('[data-zip-size]').forEach(function (el) {
          el.textContent = formatSize(len);
        });
      })
      .catch(function () {
        // 读不到体积不是关键信息（file:// 下 HEAD 一定会失败），
        // 把这一项整条撤掉，而不是留一个没有意义的占位符
        document.querySelectorAll('[data-zip-size]').forEach(function (el) {
          var item = el.closest('.facts__item');
          if (item) item.hidden = true;
        });
      });
  }

  /* ── 4. 高亮当前分区的导航项 ───────────────────────────── */

  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.site-nav a[href^="#"]'));
  var sections = navLinks
    .map(function (link) {
      return document.getElementById(link.getAttribute('href').slice(1));
    })
    .filter(Boolean);

  function setActive(id) {
    navLinks.forEach(function (link) {
      if (link.getAttribute('href') === '#' + id) {
        link.setAttribute('aria-current', 'true');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  }

  if ('IntersectionObserver' in window && sections.length) {
    var visible = Object.create(null);
    var sectionObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          visible[entry.target.id] = entry.isIntersecting;
        });
        // 同时可见多个分区时，取文档顺序里最靠前的那个
        for (var i = 0; i < sections.length; i += 1) {
          if (visible[sections[i].id]) {
            setActive(sections[i].id);
            return;
          }
        }
      },
      { rootMargin: '-40% 0px -55% 0px', threshold: 0 }
    );

    sections.forEach(function (section) {
      sectionObserver.observe(section);
    });
  }

  /* ── 5. 下载按钮的即时反馈 ─────────────────────────────── */

  var hint = document.getElementById('download-hint');
  var hintHTML = hint ? hint.innerHTML : '';

  zipLinks.forEach(function (link) {
    link.addEventListener('click', function () {
      var label = link.querySelector('[data-zip-label]');
      if (label) {
        var original = label.textContent;
        label.textContent = '正在下载…';
        window.setTimeout(function () {
          label.textContent = original;
        }, 2600);
      }

      if (hint) {
        hint.textContent = '浏览器应该已经开始下载。下载完成后请先完整解压 ZIP，再在扩展程序页面选择解压出来的文件夹。';
        window.setTimeout(function () {
          hint.innerHTML = hintHTML;
        }, 6000);
      }
    });
  });

  /* ── 6. 页脚年份 ───────────────────────────────────────── */

  document.querySelectorAll('[data-year]').forEach(function (el) {
    el.textContent = String(new Date().getFullYear());
  });
})();
