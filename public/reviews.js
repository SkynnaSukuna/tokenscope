'use strict';

/* Read-only FunPay review viewer. Ordering and pagination are provided by the API. */
(function () {
  const dialog = document.getElementById('reviewsDialog');
  if (!dialog) return;
  const el = (id) => document.getElementById(id);
  const apiFetch = (input, options) => window.TokenScopeAPI?.fetch
    ? window.TokenScopeAPI.fetch(input, options)
    : fetch(input, options);
  const isSnapshot = () => window.TokenScopeAPI?.isStatic === true;
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const textValue = (value) => {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (value && typeof value === 'object') return String(value.text ?? value.name ?? value.title ?? '');
    return '';
  };
  const countLabel = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value).toLocaleString('ru-RU') : '—';
  const highlighted = (text) => window.TokenRadarReviewHighlights?.render(text) ?? escapeHtml(text);
  const viewer = {
    seller: null,
    trigger: null,
    offerId: '',
    sort: 'worst',
    rating: 0,
    search: '',
    items: [],
    ids: new Set(),
    summary: null,
    cursor: null,
    hasMore: false,
    loading: false,
    error: '',
    warning: '',
    controller: null,
    seq: 0,
  };

  function renderSummary() {
    const summary = viewer.summary || {};
    const checked = new Set((summary.checkedRatings || []).map(Number));
    const errorRatings = Array.isArray(summary.errorRatings) ? summary.errorRatings.map(Number) : [];
    const staleRatings = Array.isArray(summary.staleRatings) ? summary.staleRatings.map(Number) : [];
    const uncertainRatings = new Set([...errorRatings, ...staleRatings]);
    const allUnknown = (!!summary.error && !errorRatings.length) || (!!summary.stale && !staleRatings.length);
    const focusedRating = el('reviewsSummary').contains(document.activeElement) ? document.activeElement.dataset.reviewRating : null;
    el('reviewsSummaryTotal').textContent = 'Всего: ' + countLabel(summary.total);
    el('reviewsSummary').innerHTML = [1, 2, 3, 4, 5].map((rating) => {
      const count = summary.counts?.[rating];
      const minimum = summary.minimumCounts?.[rating];
      const exact = typeof count === 'number' && Number.isFinite(count) && count >= 0 && (count > 0 || checked.has(rating) || summary.total === 0);
      const usable = !allUnknown && !uncertainRatings.has(rating);
      const label = !usable ? '—' : (exact ? countLabel(count) : (typeof minimum === 'number' && minimum > 0 ? '≥' + countLabel(minimum) : '—'));
      const pressed = viewer.rating === rating;
      return `<button class="feedback-summary-star${pressed ? ' on' : ''}" type="button" data-review-rating="${rating}"${isSnapshot() ? ' disabled' : ''} aria-pressed="${pressed}" aria-label="Показать отзывы на ${rating} из 5: ${label}"><span>${rating}★</span><b>${label}</b></button>`;
    }).join('');
    if (focusedRating) el('reviewsSummary').querySelector(`[data-review-rating="${focusedRating}"]`)?.focus({ preventScroll: true });
    const updated = typeof summary.updatedAt === 'number' && Number.isFinite(summary.updatedAt)
      ? ' Обновлено ' + new Date(summary.updatedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '.' : '';
    el('reviewsSummaryNote').textContent = 'Прочерк — число пока неизвестно; ≥ — не меньше указанного; 0 — отсутствие подтверждено.' + updated;
  }

  function itemHtml(item) {
    const rating = Number(item.rating);
    const knownRating = Number.isInteger(rating) && rating >= 1 && rating <= 5;
    const reply = textValue(item.reply);
    const text = textValue(item.text);
    const author = textValue(item.author) || 'Покупатель';
    const product = textValue(item.product);
    const date = textValue(item.date);
    return `<article class="feedback-card${knownRating && rating <= 3 ? ' feedback-low' : ''}" data-review-id="${escapeHtml(item.id)}">
      <div class="feedback-card-head">
        <span class="feedback-rating${knownRating && rating <= 3 ? ' feedback-rating-low' : ''}" aria-label="${knownRating ? rating + ' из 5' : 'Оценка не указана'}">${knownRating ? rating + '★' : '—★'}</span>
        <span class="feedback-author">${escapeHtml(author)}</span>
        ${date ? `<span class="feedback-date">${escapeHtml(date)}</span>` : ''}
      </div>
      ${product ? `<p class="feedback-product">${escapeHtml(product)}</p>` : ''}
      <div class="feedback-text">${text ? highlighted(text) : '<span class="feedback-no-text">Покупатель не оставил текст.</span>'}</div>
      ${reply ? `<div class="feedback-reply"><div class="feedback-reply-label">Ответ продавца</div><div class="feedback-reply-text">${highlighted(reply)}</div></div>` : ''}
    </article>`;
  }

  function render() {
    renderSummary();
    const needle = viewer.search.trim().toLocaleLowerCase('ru-RU');
    const visible = needle ? viewer.items.filter((item) => [item.text, item.reply, item.author, item.product].some((value) => textValue(value).toLocaleLowerCase('ru-RU').includes(needle))) : viewer.items;
    el('reviewsList').innerHTML = visible.map(itemHtml).join('');
    el('reviewsList').setAttribute('aria-busy', String(viewer.loading));
    el('reviewsError').hidden = !viewer.error;
    el('reviewsErrorText').textContent = viewer.error;
    el('reviewsRetry').disabled = viewer.loading;
    el('reviewsRetry').hidden = isSnapshot();
    el('reviewsWarning').hidden = !viewer.warning;
    el('reviewsWarning').textContent = viewer.warning;
    el('reviewsMore').hidden = !viewer.hasMore || !!viewer.error;
    el('reviewsMore').disabled = viewer.loading;
    el('reviewsMore').textContent = viewer.loading ? 'Загружаем…' : 'Показать ещё отзывы';
    let status = '';
    if (viewer.loading) {
      status = viewer.items.length ? 'Загружаем ещё отзывы…' : 'Загружаем отзывы…';
    } else if (viewer.error) {
      status = viewer.items.length ? 'Ранее загруженные отзывы доступны ниже.' : '';
    } else if (needle) {
      status = `Найдено среди загруженных: ${countLabel(visible.length)} из ${countLabel(viewer.items.length)}.${viewer.hasMore ? ' Другие отзывы можно загрузить кнопкой ниже.' : ''}`;
    } else if (!viewer.items.length) {
      if (viewer.hasMore) status = 'На этой странице нет отзывов. Попробуйте загрузить ещё.';
      else if (viewer.rating) status = `Отзывы на ${viewer.rating}★ не найдены.`;
      else status = viewer.summary?.total === 0 ? 'У продавца пока нет отзывов.' : 'Отзывы не найдены.';
    } else {
      status = `Загружено отзывов: ${countLabel(viewer.items.length)}${viewer.hasMore ? ' · доступны ещё' : ''}.`;
    }
    el('reviewsStatus').textContent = status;
  }

  function cancelRequest() {
    viewer.seq++;
    viewer.controller?.abort();
    viewer.controller = null;
    viewer.loading = false;
  }

  async function requestReviews({ append = false, refresh = false } = {}) {
    if (!viewer.seller || !dialog.open) return;
    if (append && (viewer.loading || !viewer.hasMore)) return;
    cancelRequest();
    const sequence = viewer.seq;
    const sellerId = String(viewer.seller.id ?? '');
    if (!append) {
      viewer.items = [];
      viewer.ids = new Set();
      viewer.cursor = null;
      viewer.hasMore = false;
    }
    viewer.error = '';
    viewer.warning = '';
    if (!sellerId) {
      viewer.error = 'У этого предложения не указан профиль продавца. Откройте лот на FunPay.';
      render();
      return;
    }
    const controller = new AbortController();
    viewer.controller = controller;
    viewer.loading = true;
    render();
    const params = new URLSearchParams({ seller: sellerId, sort: viewer.sort, rating: String(viewer.rating) });
    if (append && viewer.cursor) params.set('cursor', viewer.cursor);
    if (refresh) params.set('refresh', '1');
    try {
      const response = await apiFetch('/api/reviews?' + params.toString(), { signal: controller.signal });
      let data;
      try { data = await response.json(); } catch { throw new Error(`Сервер вернул некорректный ответ (${response.status}).`); }
      if (sequence !== viewer.seq || !dialog.open) return;
      if (!response.ok || data.error) throw new Error(textValue(data.error) || `Не удалось получить отзывы (${response.status}).`);
      if (!Array.isArray(data.items)) throw new Error('Сервер не вернул список отзывов. Повторите запрос.');
      if (data.sellerId != null && String(data.sellerId) !== sellerId) throw new Error('Получен ответ для другого продавца. Повторите запрос.');
      for (const raw of data.items) {
        if (!raw || typeof raw !== 'object') continue;
        const id = raw.id == null || raw.id === ''
          ? 'anonymous:' + [raw.rating, raw.author, raw.date, raw.text, raw.reply].map(textValue).join('|')
          : String(raw.id);
        if (viewer.ids.has(id)) continue;
        viewer.ids.add(id);
        viewer.items.push({ ...raw, id });
      }
      if (data.summary && typeof data.summary === 'object') viewer.summary = data.summary;
      const nextCursor = typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null;
      const repeatedCursor = append && nextCursor != null && nextCursor === viewer.cursor;
      viewer.hasMore = !!data.hasMore && !!nextCursor && !repeatedCursor;
      viewer.cursor = nextCursor;
      viewer.warning = textValue(data.warning);
      if (data.hasMore && !viewer.hasMore) viewer.warning ||= 'FunPay не передал следующую страницу. Повторите загрузку позднее.';
      if (data.summary && typeof data.summary === 'object') {
        document.dispatchEvent(new CustomEvent('tokenradar:reviews-summary', { detail: { sellerId, summary: data.summary } }));
      }
    } catch (error) {
      if (sequence !== viewer.seq || controller.signal.aborted || !dialog.open) return;
      viewer.error = (isSnapshot() ? '' : 'Не удалось загрузить отзывы. ') + (error?.message || 'Проверьте соединение и повторите запрос.');
    } finally {
      if (sequence === viewer.seq && dialog.open) {
        viewer.loading = false;
        viewer.controller = null;
        render();
      }
    }
  }

  function open(seller, trigger = document.activeElement) {
    if (!seller || typeof seller !== 'object') return;
    cancelRequest();
    viewer.seller = { ...seller };
    viewer.trigger = trigger instanceof HTMLElement ? trigger : null;
    viewer.offerId = viewer.trigger?.closest('.offer')?.dataset.id || '';
    // Always start each seller at the lowest rating, even after a previous manual choice.
    viewer.sort = 'worst';
    viewer.rating = 0;
    viewer.search = '';
    viewer.items = [];
    viewer.ids = new Set();
    viewer.cursor = null;
    viewer.hasMore = false;
    viewer.error = '';
    viewer.warning = '';
    viewer.summary = seller.reviewSummary || { counts: {}, checkedRatings: [], total: typeof seller.reviews === 'number' ? seller.reviews : null };
    el('reviewsSellerName').textContent = textValue(seller.name) || 'продавец';
    const profile = el('reviewsProfile');
    if (seller.id != null && String(seller.id)) {
      profile.href = 'https://funpay.com/users/' + encodeURIComponent(String(seller.id)) + '/';
      profile.hidden = false;
    } else {
      profile.removeAttribute('href');
      profile.hidden = true;
    }
    el('reviewsAbout').textContent = isSnapshot()
      ? 'В опубликованном снимке доступны общие сведения о продавце. Отзывы не загружаются в реальном времени — откройте профиль площадки для проверки.'
      : 'Отзывы покупателей по всему профилю FunPay · только чтение. Каждый раз сначала показываем низкие оценки.';
    ['reviewsSort', 'reviewsRating', 'reviewsSearch'].forEach((id) => { el(id).disabled = isSnapshot(); });
    el('reviewsSort').value = 'worst';
    el('reviewsRating').value = '0';
    el('reviewsSearch').value = '';
    el('reviewsBody').scrollTop = 0;
    document.body.classList.add('reviews-open');
    if (!dialog.open) dialog.showModal();
    el('reviewsClose').focus({ preventScroll: true });
    requestReviews();
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  dialog.addEventListener('close', () => {
    cancelRequest();
    document.body.classList.remove('reviews-open');
    const sellerId = String(viewer.seller?.id ?? '');
    const restored = viewer.trigger?.isConnected ? viewer.trigger
      : (viewer.offerId ? document.querySelector(`#list .offer[data-id="${CSS.escape(viewer.offerId)}"] [data-act="reviews"]`) : null)
        || document.querySelector(`#list [data-act="reviews"][data-seller-id="${CSS.escape(sellerId)}"]`)
        || document.getElementById('filtersToggle');
    restored?.focus({ preventScroll: true });
    viewer.trigger = null;
  });
  el('reviewsClose').addEventListener('click', close);
  el('reviewsSort').addEventListener('change', (event) => {
    viewer.sort = ['worst', 'best', 'newest'].includes(event.target.value) ? event.target.value : 'worst';
    requestReviews();
  });
  el('reviewsRating').addEventListener('change', (event) => {
    viewer.rating = Math.max(0, Math.min(5, Number(event.target.value) || 0));
    requestReviews();
  });
  el('reviewsSummary').addEventListener('click', (event) => {
    const button = event.target.closest('[data-review-rating]');
    if (!button) return;
    const rating = Number(button.dataset.reviewRating);
    viewer.rating = viewer.rating === rating ? 0 : rating;
    el('reviewsRating').value = String(viewer.rating);
    requestReviews();
  });
  el('reviewsSearch').addEventListener('input', (event) => {
    viewer.search = event.target.value;
    render();
  });
  el('reviewsMore').addEventListener('click', () => requestReviews({ append: true }));
  el('reviewsRetry').addEventListener('click', () => requestReviews({ refresh: true }));

  window.TokenRadarReviews = Object.freeze({ open, close, refresh: () => requestReviews({ refresh: true }) });
})();
