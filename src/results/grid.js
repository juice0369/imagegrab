/**
 * 结果页的卡片渲染。
 *
 * 性能考虑：图片可能有几百张，所以卡片是「按 rAF 分片」挂载的，
 * 缩略图用 loading="lazy"，尺寸直接读 naturalWidth/naturalHeight——
 * 因为缩略图就是原图地址，浏览器缓存会复用，等于零额外请求。
 */

import { ITEM_STATUS, ITEM_STATUS_LABEL, describeError } from '../shared/constants.js';

const BATCH_SIZE = 60;

/**
 * 把 total 个条目切成互不重叠的区间 `[start, end)`，供分片挂载使用。
 *
 * 单独抽出来是为了能被自检脚本直接断言：分片一旦重叠，卡片就会被重复挂进容器
 * （曾经写成步长 1，59 张图在结果页里变成了上千张卡片）。这里保证每个下标恰好
 * 属于一个区间，所有区间合起来正好覆盖 [0, total)。
 */
export function batchRanges(total, size = BATCH_SIZE) {
  const count = Math.max(0, Math.floor(Number(total) || 0));
  const step = Math.max(1, Math.floor(Number(size) || 1));
  const ranges = [];
  for (let start = 0; start < count; start += step) {
    ranges.push([start, Math.min(start + step, count)]);
  }
  return ranges;
}

function sizeText(item, measured) {
  const width = measured?.width || item.naturalWidth || 0;
  const height = measured?.height || item.naturalHeight || 0;
  if (width && height) return `${width} × ${height}`;
  if (item.domWidth && item.domHeight) return `约 ${item.domWidth} × ${item.domHeight}（展示尺寸）`;
  return '尺寸未知';
}

function shortenUrl(url, max = 96) {
  const text = String(url || '');
  if (text.length <= max) return text;
  return `${text.slice(0, max / 2)}…${text.slice(-max / 2)}`;
}

export function createGrid({ container: initialContainer = null, onAction }) {
  let container = initialContainer;
  const cards = new Map();
  const measured = new Map();
  /** 已渲染的条目数据，尺寸测量回来后需要用 */
  let itemsById = new Map();
  let token = 0;

  function setContainer(element) {
    container = element || null;
  }

  function statusInfo(itemId) {
    return onAction('status', itemId) || { status: ITEM_STATUS.PENDING };
  }

  function selectedInfo(itemId) {
    return Boolean(onAction('selected', itemId));
  }

  function buildCard(item) {
    const info = statusInfo(item.id);
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = item.id;
    card.dataset.status = info.status || ITEM_STATUS.PENDING;
    card.dataset.selected = selectedInfo(item.id) ? 'true' : 'false';

    card.innerHTML = `
      <div class="card-top">
        <input class="card-check" type="checkbox" aria-label="选择这张图片">
        <span class="pill"></span>
      </div>
      <div class="thumb">
        <img src="" alt="" loading="lazy" referrerpolicy="no-referrer">
        <div class="thumb-note" hidden></div>
      </div>
      <div class="card-body">
        <div class="meta"><span class="size"></span><span class="src"></span></div>
        <div class="fname" hidden></div>
        <p class="err" hidden></p>
        <div class="url"></div>
        <div class="card-actions">
          <button class="btn tiny" type="button" data-act="download">单张下载</button>
          <button class="btn tiny" type="button" data-act="retry" hidden>重试</button>
        </div>
      </div>
    `;

    const checkbox = card.querySelector('.card-check');
    const img = card.querySelector('img');
    const note = card.querySelector('.thumb-note');
    const sizeEl = card.querySelector('.size');
    const srcEl = card.querySelector('.src');
    const urlEl = card.querySelector('.url');

    checkbox.checked = selectedInfo(item.id);
    srcEl.textContent = item.source || 'img';
    srcEl.title = `来源：${item.source || 'img'}${item.alternates?.length ? `（另有 ${item.alternates.length} 个重复地址）` : ''}`;
    urlEl.textContent = shortenUrl(item.url);
    urlEl.title = item.url;

    if (item.kind === 'data') {
      img.src = item.url;
    } else {
      img.src = item.url;
      img.alt = item.alt || '';
    }

    measured.set(item.id, { width: item.naturalWidth || 0, height: item.naturalHeight || 0 });
    sizeEl.textContent = sizeText(item, measured.get(item.id));

    img.addEventListener('load', () => {
      measured.set(item.id, { width: img.naturalWidth, height: img.naturalHeight });
      sizeEl.textContent = sizeText(item, measured.get(item.id));
      card.dataset.preview = 'ok';
      onAction('resize');
    });

    img.addEventListener('error', () => {
      card.dataset.preview = 'failed';
      note.hidden = false;
      note.textContent = '无法预览（可能已失效或需要登录）';
      sizeEl.textContent = sizeText(item, null);
      onAction('thumb-error', item.id);
    });

    checkbox.addEventListener('change', (event) => {
      event.stopPropagation();
      onAction('toggle', item.id, checkbox.checked);
    });

    card.addEventListener('click', (event) => {
      if (event.target.closest('button, input, a')) return;
      onAction('toggle', item.id, !selectedInfo(item.id));
    });

    card.querySelector('[data-act="download"]').addEventListener('click', (event) => {
      event.stopPropagation();
      onAction('download-one', item.id);
    });
    card.querySelector('[data-act="retry"]').addEventListener('click', (event) => {
      event.stopPropagation();
      onAction('download-one', item.id);
    });

    cards.set(item.id, card);
    applyStatus(card, item.id);
    return card;
  }

  /** 更新单张卡片的状态区（不动缩略图，避免重新请求）。 */
  function applyStatus(card, itemId) {
    const info = statusInfo(itemId);
    const status = info.status || ITEM_STATUS.PENDING;
    const item = itemsById.get(itemId);
    card.dataset.status = status;
    card.dataset.selected = selectedInfo(itemId) ? 'true' : 'false';

    const pill = card.querySelector('.pill');
    pill.textContent = ITEM_STATUS_LABEL[status] || status;
    pill.dataset.status = status;

    const checkbox = card.querySelector('.card-check');
    if (checkbox.checked !== selectedInfo(itemId)) checkbox.checked = selectedInfo(itemId);

    const fname = card.querySelector('.fname');
    if (info.filename) {
      fname.hidden = false;
      fname.textContent = info.filename;
    } else {
      fname.hidden = true;
    }

    const errEl = card.querySelector('.err');
    const detail = info.message || (info.error ? describeError(info.error) : '');
    if (status === ITEM_STATUS.FAILED) {
      errEl.hidden = false;
      errEl.style.color = '';
      errEl.textContent = `失败：${detail}`;
    } else if (status === ITEM_STATUS.FALLBACK && detail) {
      errEl.hidden = false;
      errEl.style.color = '';
      errEl.textContent = `提示：${detail}`;
    } else if (status === ITEM_STATUS.CONVERTING || status === ITEM_STATUS.DOWNLOADING) {
      errEl.hidden = !detail;
      errEl.style.color = 'var(--text-dim)';
      errEl.textContent = detail;
    } else {
      errEl.hidden = true;
    }

    const retry = card.querySelector('[data-act="retry"]');
    retry.hidden = status !== ITEM_STATUS.FAILED;
    if (item && !detail) {
      card.querySelector('.size').textContent = sizeText(item, measured.get(itemId));
    }
  }

  return {
    setContainer,
    /** 全量渲染（会清空容器）。 */
    async render(items) {
      if (!container) return;
      token += 1;
      const current = token;
      cards.clear();
      container.textContent = '';
      itemsById = new Map(items.map((item) => [item.id, item]));

      // 每一轮只挂一批，区间由 batchRanges 保证不重叠——这是「卡片数 == 条目数」的关键。
      for (const [start, end] of batchRanges(items.length, BATCH_SIZE)) {
        if (current !== token) return; // 渲染被新的 render 取代
        const fragment = document.createDocumentFragment();
        for (let index = start; index < end; index += 1) fragment.appendChild(buildCard(items[index]));
        container.appendChild(fragment);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      }
    },

    /** 只更新某张卡片的状态。 */
    update(itemId) {
      const card = cards.get(itemId);
      if (!card) return;
      applyStatus(card, itemId);
    },

    /** 选中态变化。 */
    refreshSelection(itemId) {
      const card = cards.get(itemId);
      if (!card) return;
      const checkbox = card.querySelector('.card-check');
      checkbox.checked = selectedInfo(itemId);
      card.dataset.selected = selectedInfo(itemId) ? 'true' : 'false';
    },

    refreshAll(itemIds) {
      const ids = itemIds || [...cards.keys()];
      for (const itemId of ids) {
        const card = cards.get(itemId);
        if (card) applyStatus(card, itemId);
      }
    },

    count() {
      return cards.size;
    }
  };
}
