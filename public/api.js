'use strict';

// Один интерфейс запросов для Node-сервера и статического GitHub Pages.
(() => {
  const config = window.TOKENSCOPE_CONFIG || { mode: 'live' };
  const isStatic = config.mode === 'snapshot';
  const nativeFetch = window.fetch.bind(window);
  let snapshotPromise = null;
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
  async function snapshot(reload = false) {
    if (reload) snapshotPromise = null;
    if (!snapshotPromise) {
      const compressed = !!config.compressedSnapshotUrl && typeof DecompressionStream !== 'undefined';
      const snapshotUrl = compressed ? config.compressedSnapshotUrl : config.snapshotUrl || './snapshot.json';
      const pending = nativeFetch(new URL(snapshotUrl, document.baseURI), { cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) throw new Error('Снимок каталога недоступен. Повторите загрузку позже.');
          let body = response;
          if (compressed) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            const packed = bytes[0] === 0x1f && bytes[1] === 0x8b;
            body = new Response(bytes);
            if (packed) body = new Response(body.body.pipeThrough(new DecompressionStream('gzip')));
          }
          const data = await body.json();
          if (data.schemaVersion !== 1 || !Array.isArray(data.offers)) throw new Error('Формат снимка не поддерживается. Обновите страницу.');
          return data;
        });
      snapshotPromise = pending;
      pending.catch(() => { if (snapshotPromise === pending) snapshotPromise = null; });
    }
    return snapshotPromise;
  }
  function descStats(offers) {
    const loaded = offers.filter((o) => o.descLoaded).length;
    return { total: offers.length, loaded, totalInScope: offers.length, loadedInScope: loaded, queued: 0, active: 0, errors: 0, snapshot: true };
  }
  function freshness(data) {
    if (data.refreshError) return data.refreshError;
    if (data.updatedAt && Date.now() - data.updatedAt > 2 * 60 * 60 * 1000) return 'Снимок старше двух часов. Актуальную цену и наличие проверьте на площадке.';
    return null;
  }
  async function request(input, options = {}) {
    if (!isStatic) return nativeFetch(input, options);
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return nativeFetch(input, options);
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (url.pathname === '/api/reviews') return json({ error: 'Живые отзывы доступны в локальной версии TokenScope. На GitHub Pages откройте профиль продавца на FunPay.', unavailable: true }, 503);
    if (url.pathname === '/api/refresh') {
      const data = await snapshot(true);
      return json({ ok: true, snapshot: true, updatedAt: data.updatedAt });
    }
    const data = await snapshot();
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const core = window.TokenScopeCore;
    if (!core) throw new Error('Не загрузился модуль фильтров. Обновите страницу.');
    switch (url.pathname) {
      case '/api/meta': return json({
        deploymentMode: 'snapshot', total: data.offers.length, updatedAt: data.updatedAt,
        builtAt: data.builtAt, partial: data.partial, refreshError: freshness(data),
        categories: data.categories, models: data.models, desc: descStats(data.offers),
        historyPoints: { all: data.history.all.length, ...Object.fromEntries(Object.entries(data.history.byCat).map(([k, v]) => [k, v.length])) },
      });
      case '/api/offers': {
        const f = core.parseFilters(url.searchParams);
        // Проверки звёзд из старых ссылок не подменяются рейтингом или отсутствием данных.
        const items = core.applyFilters(data.offers, f);
        const stats = core.computeStats(items, f);
        core.sortOffers(items, f);
        const pages = Math.max(1, Math.ceil(items.length / f.pageSize));
        const page = Math.min(f.page, pages);
        const visible = items.slice((page - 1) * f.pageSize, page * f.pageSize).map((o) => {
          const { description, ...offer } = o;
          offer.descriptionPreview = (description || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
          return f.need ? { ...offer, needCost: core.needCost(o, f.need) } : offer;
        });
        const scope = f.cats.length ? data.offers.filter((o) => f.cats.includes(o.cat)) : data.offers;
        return json({
          deploymentMode: 'snapshot', updatedAt: data.updatedAt, total: items.length, page, pageSize: f.pageSize, pages,
          items: visible, stats, desc: descStats(scope),
          history: (f.cats.length === 1 ? data.history.byCat[f.cats[0]] || [] : data.history.all).slice(-90),
          reviewCheck: { active: false, unavailable: true },
          refreshError: f.noReviewStars.length ? 'Проверка отсутствия оценок 1–3★ доступна в локальной версии. Снимите это условие, чтобы увидеть каталог.' : freshness(data),
        });
      }
      case '/api/offer': {
        const offer = data.offers.find((o) => o.id === url.searchParams.get('id'));
        if (!offer) return json({ error: 'Лот не найден в снимке' }, 404);
        return json({ offer, description: offer.description || '', flags: offer.flags, fields: {},
          error: offer.descLoaded ? null : 'Описание ещё не вошло в снимок. Откройте лот на площадке.' });
      }
      case '/api/history': {
        const cat = url.searchParams.get('cat') || 'all';
        return json({ cat, points: (cat === 'all' ? data.history.all : data.history.byCat[cat] || []).slice(-120) });
      }
      case '/api/enrich': return json({ ok: false, snapshot: true, queued: 0, desc: descStats(data.offers), message: 'Описания дополняются при следующей сборке сайта.' });
      case '/api/health': return json({ ok: true, snapshot: true, offers: data.offers.length, updatedAt: data.updatedAt });
      default: return json({ error: 'Неизвестный эндпоинт' }, 404);
    }
  }
  window.TokenScopeAPI = Object.freeze({ isStatic, fetch: request });
})();
