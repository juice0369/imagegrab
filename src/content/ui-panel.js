/**
 * 页面侧悬浮面板：Shadow DOM 注入「获取图片」按钮 + 状态卡片，
 * 负责平台判定、SPA 路由跟进、扫描 → 过滤 → 上报 SW → 打开结果页，
 * 同时承担 SW 发来的「页内 canvas 回退转换」请求。
 */

import { MSG, DEFAULT_SETTINGS, STORAGE_KEYS, FILTER_REASONS, EXT } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { sendMessage, isExtensionAlive, toError } from '../shared/messaging.js';
import { getPageState } from './platform-rules.js';
import { scanPageImages } from './image-scanner.js';
import { filterRecords, describeFilterStats } from './image-filter.js';
import { handleConvertInPageRequest } from './inpage-converter.js';

const log = createLogger('panel');
const HOST_ID = 'imagegrab-panel-host';
const PANEL_CSS_PATH = 'src/content/panel.css';

const state = {
  mounted: false,
  host: null,
  shadow: null,
  refs: {},
  busy: false,
  sid: null,
  platform: null,
  settings: { ...DEFAULT_SETTINGS },
  lastStats: null,
  lastCount: 0,
  position: null,
  suppressClick: false
};

/* ────────────────────────────── 启动 ────────────────────────────── */

export function start() {
  if (!isExtensionAlive()) {
    log.warn('扩展上下文无效，面板不注入');
    return;
  }
  bindRuntimeListener();
  watchNavigation();
  watchDom();
  window.addEventListener('pagehide', onPageHide);

  loadSettings()
    .then(() => syncPanel('boot'))
    .catch((err) => log.error('初始化失败', err));
}

/* ────────────────────────── 消息与生命周期 ────────────────────────── */

/** SW 请求页面内 canvas 回退转换时，由这里应答。 */
function bindRuntimeListener() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== MSG.CONVERT_IN_PAGE) return undefined;
    handleConvertInPageRequest(message)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({
          ok: false,
          code: err?.code || 'PAGE_CONVERT_FAILED',
          message: err?.message || String(err)
        })
      );
    return true; // 异步应答
  });
}

function onPageHide(event) {
  if (event?.persisted) return; // 进 bfcache 不算卸载
  if (!state.sid || !isExtensionAlive()) return;
  const sid = state.sid;
  state.sid = null;
  try {
    chrome.runtime.sendMessage({ type: MSG.SOURCE_UNLOADED, payload: { sid } }).catch(() => {});
  } catch {
    /* 页面卸载中，忽略 */
  }
}

/** 监听 pushState / replaceState / popstate / hashchange，处理 SPA 路由切换。 */
function watchNavigation() {
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    if (typeof original !== 'function' || original.__imagegrabPatched) continue;
    const patched = function patchedHistory(...args) {
      const result = original.apply(this, args);
      window.dispatchEvent(new Event('imagegrab:locationchange'));
      return result;
    };
    patched.__imagegrabPatched = true;
    history[method] = patched;
  }
  window.addEventListener('popstate', onLocationChange);
  window.addEventListener('hashchange', onLocationChange);
  window.addEventListener('imagegrab:locationchange', onLocationChange);
}

let locationTimer = null;
function onLocationChange() {
  if (locationTimer) clearTimeout(locationTimer);
  locationTimer = setTimeout(() => {
    // 路由变了就当作新会话：旧的 sid 不再复用
    state.sid = null;
    syncPanel('locationchange');
  }, 400);
}

/** 页面框架可能整个重绘 body，把我们的宿主节点覆盖掉，这里守护一下。 */
function watchDom() {
  const observer = new MutationObserver(() => {
    if (!state.mounted) return;
    if (!state.host || !state.host.isConnected) {
      mount();
    }
  });
  const target = document.documentElement;
  if (target) observer.observe(target, { childList: true, subtree: false });
}

function syncPanel(reason) {
  if (!isExtensionAlive()) {
    teardown();
    return;
  }
  const page = getPageState();
  if (!page.supported || !page.isDetail) {
    if (state.mounted) log.info(`离开详情页（${reason}），移除面板`);
    teardown();
    return;
  }
  state.platform = page.platform;
  if (page.forced) log.info('通过 URL 参数强制注入（imagegrab=1）');
  mount();
}

async function loadSettings() {
  try {
    const data = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.panelPos]);
    state.settings = { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] || {}) };
    state.position = data[STORAGE_KEYS.panelPos] || null;
  } catch (err) {
    log.warn('读取设置失败，使用默认值', err);
  }
}

async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: state.settings });
  } catch (err) {
    log.warn('保存设置失败', err);
  }
}

/* ────────────────────────────── UI ────────────────────────────── */

const TEMPLATE = `
  <div class="ig-root" part="root">
    <button class="ig-fab" type="button" title="提取当前页面的商品图片">
      <span class="ig-spinner" hidden></span>
      <span class="ig-fab-label">获取图片</span>
      <span class="ig-badge" hidden></span>
    </button>
    <section class="ig-card" hidden role="dialog" aria-label="图提取状态">
      <header class="ig-card-head">
        <span class="ig-title">图提取 ImageGrab</span>
        <button class="ig-close" type="button" aria-label="收起面板">×</button>
      </header>
      <p class="ig-text"></p>
      <div class="ig-bar" hidden><i></i></div>
      <details class="ig-details" hidden>
        <summary>过滤详情</summary>
        <ul class="ig-details-list"></ul>
      </details>
      <label class="ig-switch">
        <input class="ig-autoscroll" type="checkbox">
        <span>扫描前自动滚动（触发懒加载）</span>
      </label>
      <div class="ig-actions">
        <button class="ig-btn ig-btn-primary" data-action="open" hidden type="button">打开结果页</button>
        <button class="ig-btn" data-action="retry" hidden type="button">重新提取</button>
      </div>
    </section>
  </div>
`;

function mount() {
  if (state.mounted && state.host?.isConnected) return;

  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-imagegrab', 'panel');
    (document.body || document.documentElement).appendChild(host);
  }
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483646; inset: auto;';

  const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  shadow.innerHTML = TEMPLATE;

  state.host = host;
  state.shadow = shadow;
  state.mounted = true;
  state.refs = {
    root: shadow.querySelector('.ig-root'),
    fab: shadow.querySelector('.ig-fab'),
    fabLabel: shadow.querySelector('.ig-fab-label'),
    spinner: shadow.querySelector('.ig-spinner'),
    badge: shadow.querySelector('.ig-badge'),
    card: shadow.querySelector('.ig-card'),
    title: shadow.querySelector('.ig-title'),
    text: shadow.querySelector('.ig-text'),
    bar: shadow.querySelector('.ig-bar'),
    barInner: shadow.querySelector('.ig-bar i'),
    details: shadow.querySelector('.ig-details'),
    detailsList: shadow.querySelector('.ig-details-list'),
    autoscroll: shadow.querySelector('.ig-autoscroll'),
    btnOpen: shadow.querySelector('[data-action="open"]'),
    btnRetry: shadow.querySelector('[data-action="retry"]'),
    btnClose: shadow.querySelector('.ig-close')
  };

  applyPosition();
  injectCss(shadow);

  state.refs.autoscroll.checked = state.settings.autoScroll !== false;
  state.refs.autoscroll.addEventListener('change', (event) => {
    saveSettings({ autoScroll: Boolean(event.target.checked) });
  });
  state.refs.fab.addEventListener('click', () => {
    if (state.suppressClick) {
      state.suppressClick = false;
      return;
    }
    runExtraction();
  });
  state.refs.btnOpen.addEventListener('click', openResultsPage);
  state.refs.btnRetry.addEventListener('click', () => runExtraction());
  state.refs.btnClose.addEventListener('click', () => hideCard());
  attachDrag();

  // 页面已经存在过一次会话时，把徽标恢复出来
  if (state.lastCount) renderBadge(state.lastCount);
}

async function injectCss(shadow) {
  try {
    const response = await fetch(chrome.runtime.getURL(PANEL_CSS_PATH));
    const css = await response.text();
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];
  } catch (err) {
    log.warn('样式注入失败', err);
  }
}

function teardown() {
  state.mounted = false;
  state.refs = {};
  state.host?.remove();
  state.host = null;
  state.shadow = null;
}

function applyPosition() {
  const { root } = state.refs;
  if (!root) return;
  const pos = state.position;
  if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
    const maxLeft = Math.max(4, window.innerWidth - 72);
    const maxTop = Math.max(4, window.innerHeight - 48);
    root.style.left = `${Math.min(Math.max(4, pos.left), maxLeft)}px`;
    root.style.top = `${Math.min(Math.max(4, pos.top), maxTop)}px`;
    root.classList.add('ig-positioned');
  }
}

function attachDrag() {
  const { root, fab } = state.refs;
  if (!root || !fab) return;
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  fab.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rect = root.getBoundingClientRect();
    startX = event.clientX;
    startY = event.clientY;
    originLeft = rect.left;
    originTop = rect.top;
    moved = false;
    dragging = true;
    try {
      fab.setPointerCapture(event.pointerId);
    } catch {
      /* 忽略 */
    }
  });

  fab.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < 5) return;
    moved = true;
    const width = root.offsetWidth || 96;
    const height = root.offsetHeight || 36;
    const left = clamp(originLeft + dx, 4, Math.max(4, window.innerWidth - width - 4));
    const top = clamp(originTop + dy, 4, Math.max(4, window.innerHeight - height - 4));
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.classList.add('ig-positioned');
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    if (!moved) return;
    state.suppressClick = true;
    setTimeout(() => {
      state.suppressClick = false;
    }, 120);
    const rect = root.getBoundingClientRect();
    state.position = { left: Math.round(rect.left), top: Math.round(rect.top) };
    chrome.storage.local
      .set({ [STORAGE_KEYS.panelPos]: state.position })
      .catch(() => {});
  };

  fab.addEventListener('pointerup', endDrag);
  fab.addEventListener('pointercancel', endDrag);
}

function renderBadge(count) {
  const { badge } = state.refs;
  if (!badge) return;
  if (!count) {
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  badge.textContent = count > 999 ? '999+' : String(count);
}

function setBusy(busy) {
  state.busy = busy;
  const { fab, spinner, fabLabel } = state.refs;
  if (!fab) return;
  fab.disabled = busy;
  spinner.hidden = !busy;
  fabLabel.textContent = busy ? '处理中…' : '获取图片';
}

/**
 * 更新状态卡片。
 * @param {{title?: string, text?: string, tone?: 'info'|'ok'|'warn'|'error',
 *   progress?: number|null, showOpen?: boolean, showRetry?: boolean,
 *   details?: Array<[string, string]>|null}} options
 */
function setCard(options = {}) {
  const { card, title, text, bar, barInner, btnOpen, btnRetry, details, detailsList } = state.refs;
  if (!card) return;
  if (options.hide) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  card.dataset.tone = options.tone || 'info';
  if (options.title !== undefined) title.textContent = options.title;
  if (options.text !== undefined) text.textContent = options.text;
  if (options.progress === null || options.progress === undefined) {
    bar.hidden = true;
  } else {
    bar.hidden = false;
    barInner.style.width = `${Math.round(Math.max(0, Math.min(1, options.progress)) * 100)}%`;
  }
  btnOpen.hidden = !options.showOpen;
  btnRetry.hidden = !options.showRetry;
  if (options.details && options.details.length) {
    details.hidden = false;
    detailsList.textContent = '';
    for (const [key, value] of options.details) {
      const li = document.createElement('li');
      const strong = document.createElement('strong');
      strong.textContent = `${value} 张`;
      li.append(strong, document.createTextNode(` ${key}`));
      detailsList.appendChild(li);
    }
  } else {
    details.hidden = true;
  }
}

function hideCard() {
  if (state.refs.card) state.refs.card.hidden = true;
}

/* ────────────────────────────── 提取流程 ────────────────────────────── */

async function runExtraction() {
  if (state.busy) return;
  setBusy(true);
  setCard({ title: '正在扫描图片…', text: '准备扫描页面…', tone: 'info', progress: 0.02, showRetry: false, showOpen: false });

  try {
    const settings = { ...state.settings };
    const records = await scanPageImages({
      settings,
      onProgress: (progress) => {
        if (progress.phase === 'scroll') {
          setCard({
            title: '正在触发懒加载…',
            text: `滚动预热 ${progress.step}/${progress.total}，让懒加载图片进入 DOM`,
            tone: 'info',
            progress: progress.total ? progress.step / progress.total : 0.5
          });
        } else {
          setCard({ title: '正在解析页面…', text: '收集 img / srcset / 背景图 / 同源 iframe', tone: 'info', progress: 0.85 });
        }
      }
    });

    const { items, stats } = filterRecords(records, { settings, platformId: state.platform?.id || 'default' });
    state.lastStats = stats;

    if (!items.length) {
      setCard({
        title: '没有找到可提取的图片',
        text: describeFilterStats(stats, FILTER_REASONS),
        tone: 'warn',
        showRetry: true,
        details: buildReasonDetails(stats)
      });
      return;
    }

    const sid = createSid();
    const payload = {
      sid,
      pageUrl: location.href,
      pageTitle: document.title || '',
      platformId: state.platform?.id || 'default',
      platformName: state.platform?.name || '未知站点',
      images: items,
      filterStats: stats,
      settings: {
        filenamePrefix: settings.filenamePrefix,
        filenamePad: settings.filenamePad,
        subfolder: settings.subfolder,
        concurrency: settings.concurrency,
        convertTimeoutMs: settings.convertTimeoutMs,
        downloadTimeoutMs: settings.downloadTimeoutMs,
        maxRetries: settings.maxRetries
      }
    };

    const response = await sendMessage({ type: MSG.EXTRACT_DONE, payload }, { timeoutMs: 20000 });
    if (!response?.ok) {
      throw toError(response?.error?.message || '后台没有接受这批图片', response?.error?.code || 'MESSAGE_FAILED');
    }

    state.sid = sid;
    state.lastCount = items.length;
    renderBadge(items.length);

    const notLoaded = items.filter((item) => !item.naturalWidth).length;
    const notes = [];
    if (stats.dropped) notes.push(`已过滤 ${stats.dropped} 张`);
    if (notLoaded) notes.push(`${notLoaded} 张是懒加载/背景图，尺寸会在结果页确认`);

    setCard({
      title: `已提取 ${items.length} 张图片`,
      text: notes.length ? `${notes.join('；')}。结果页已打开。` : '结果页已打开。',
      tone: 'ok',
      showOpen: true,
      showRetry: true,
      details: buildReasonDetails(stats)
    });
    log.info(`提取完成：${items.length} 张`, stats);
  } catch (err) {
    const error = toError(err);
    log.error('提取失败', error);
    setCard({
      title: '提取失败',
      text: `${error.message}${error.code === 'CONTEXT_INVALIDATED' ? '' : '（可点击「重新提取」重试）'}`,
      tone: 'error',
      showRetry: true
    });
  } finally {
    setBusy(false);
  }
}

function buildReasonDetails(stats) {
  if (!stats) return null;
  return Object.entries(stats.reasons)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => [FILTER_REASONS[key] || key, value]);
}

function createSid() {
  return `sid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function openResultsPage() {
  if (!state.sid) return;
  // content script 里没有 chrome.tabs，开标签页必须交给 service worker 代劳。
  // 后台还会在结果页已打开时复用那个标签，避免同一个会话堆出多个标签。
  sendMessage({ type: MSG.OPEN_RESULTS, payload: { sid: state.sid } }, { timeoutMs: 10000 })
    .then((response) => {
      if (!response?.ok) {
        throw toError(response?.error?.message || '后台没有响应', response?.error?.code || 'NO_RESPONSE');
      }
    })
    .catch((err) => {
      const error = toError(err);
      log.error('打开结果页失败', error);
      setCard({
        title: '打开结果页失败',
        text: `${error.message}（数据已保存在扩展里，可点扩展图标再试一次）`,
        tone: 'error',
        showRetry: true
      });
    });
}

// 让调试时能在控制台看到扩展名与版本
log.debug(`${EXT.displayName} v${EXT.version} 已就绪，平台：${getPageState().platform?.name || '未识别'}`);
