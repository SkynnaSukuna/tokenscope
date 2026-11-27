'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { CATEGORIES, CAT_BY_ID, parseLotsPage, applyDescription, normalizeOfferAccess, modelLabel, parseSellerAgeMonths } = require('./lib/parser');
const { fetchText } = require('./lib/net');
const store = require('./lib/store');
const { Enricher } = require('./lib/enrich');
const { ReviewService } = require('./lib/reviews');
const { parseFilters, applyFilters, sortOffers, computeStats, percentile, needCost } = require('./lib/filter');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';
const REFRESH_MS = 3 * 60 * 1000;
const AHEAD_ENRICH_PER_CAT = 40;
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

const history = store.loadJson('history.json', { all: [], byCat: {} });
const reviews = new ReviewService({ store });
const reviewSummaryFor = (sellerId) => /^[1-9]\d{0,14}$/.test(String(sellerId)) ? reviews.summary(String(sellerId)) : null;
if (!history.all) history.all = [];
if (!history.byCat) history.byCat = {};

/** Чистим историю от старых/битых точек, чтобы график не показывал скачки. */
const HISTORY_TTL = 14 * 24 * 60 * 60 * 1000;
function trimHistory(list) {
  const cutoff = Date.now() - HISTORY_TTL;
  return (Array.isArray(list) ? list : [])
    .filter((p) => p && Number.isFinite(p.t) && p.t >= cutoff && p.count > 0 && Number.isFinite(p.avg))
    .slice(-1000);
}
history.all = trimHistory(history.all);
for (const [key, list] of Object.entries(history.byCat)) history.byCat[key] = trimHistory(list);

const state = {
  offers: [],
  byId: new Map(),
  updatedAt: null,
  categories: {},
  refreshing: null,
  refreshError: null,
  history,
};

function buildCache() {
  return { updatedAt: state.updatedAt, offers: state.offers };
}

const enricher = new Enricher({
  concurrency: 1,
  minInterval: 1200,
  store,
  onDone(offer, page) {
    const target = state.byId.get(offer.id) || offer;
    applyDescription(target, page);
    store.saveJsonDebounced('cache.json', buildCache(), 4000);
    store.saveJsonDebounced('history.json', state.history, 4000);
  },
});

enricher.hydrate(store.loadJsonl('descriptions.jsonl'));

(function hydrateCache() {
  const cached = store.loadJson('cache.json', null);
  if (!cached || !Array.isArray(cached.offers) || !cached.offers.length) return;
  state.offers = cached.offers;
  state.updatedAt = cached.updatedAt || null;
  for (const o of state.offers) {
    if (o.seller && o.seller.ageMonths == null) o.seller.ageMonths = parseSellerAgeMonths(o.seller.age);
    // Пересчитываем и уже загруженные описания: старый кэш может содержать
    // безлимит с ложным tokens/pricePerM и не иметь новых полей доступа.
    normalizeOfferAccess(o);
    const rec = enricher.get(o.id);
    if (o.descLoaded || o.description || rec) {
      try {
        applyDescription(o, { description: o.description || rec?.description || '', fields: {}, seller: {} });
      } catch {
        /* сохраняем хотя бы нормализованные поля из заголовка */
      }
    }
  }
  state.byId = new Map(state.offers.map((o) => [o.id, o]));
  console.log(`[cache] загружено ${state.offers.length} лотов, описаний: ${enricher.count}`);
})();

/* ------------------------------------------------------------------ */
/* refresh                                                             */
/* ------------------------------------------------------------------ */

function aheadTargets() {
  const targets = [];
  for (const cat of CATEGORIES) {
    const list = state.offers
      .filter((o) => o.cat === cat.id && !enricher.has(o.id))
      .sort((a, b) => (a.pricePerM ?? Infinity) - (b.pricePerM ?? Infinity))
      .slice(0, AHEAD_ENRICH_PER_CAT);
    targets.push(...list);
  }
  return targets;
}

function historyPoint(offers) {
  const priced = offers.filter((o) => o.pricePerM != null && o.price > 0 && o.tokens > 0);
  if (!priced.length) return null;
  const totalPrice = priced.reduce((s, o) => s + o.price, 0);
  const totalTokens = priced.reduce((s, o) => s + o.tokens, 0);
  const pms = priced.map((o) => o.pricePerM).sort((a, b) => a - b);
  return {
    t: Date.now(),
    // средняя по лотам: оптовые предложения не искажают метрику
    avg: (() => {
      const cut = percentile(pms, 0.99);
      const core = pms.filter((v) => v <= cut);
      const basis = core.length ? core : pms;
      return basis.reduce((s, v) => s + v, 0) / basis.length;
    })(),
    weighted: (totalPrice / totalTokens) * 1e6,
    median: percentile(pms, 0.5),
    min: pms[0],
    count: priced.length,
  };
}

function pushHistory(list, point) {
  if (!point) return;
  const last = list[list.length - 1];
  if (last && point.t - last.t < 60 * 1000) {
    list[list.length - 1] = point;
  } else {
    list.push(point);
  }
  if (list.length > 1000) list.splice(0, list.length - 1000);
}

function snapshotHistory() {
  pushHistory(history.all, historyPoint(state.offers));
  for (const cat of CATEGORIES) {
    const byCat = state.offers.filter((o) => o.cat === cat.id);
    if (!history.byCat[cat.id]) history.byCat[cat.id] = [];
    pushHistory(history.byCat[cat.id], historyPoint(byCat));
  }
  store.saveJsonDebounced('history.json', history, 1000);
}

async function refresh({ force = false } = {}) {
  if (state.refreshing) return state.refreshing;
  if (!force && state.updatedAt && Date.now() - state.updatedAt < REFRESH_MS) return null;

  state.refreshing = (async () => {
    const started = Date.now();
    const results = await Promise.allSettled(
      CATEGORIES.map(async (cat) => {
        const html = await fetchText(cat.url, { tries: 2 });
        return { cat, offers: parseLotsPage(html, cat.id) };
      })
    );

    const fresh = [];
    const seen = new Set();
    const categories = {};
    results.forEach((res, i) => {
      const cat = CATEGORIES[i];
      if (res.status === 'fulfilled' && res.value.offers.length) {
        categories[cat.id] = { ok: true, count: res.value.offers.length };
        for (const o of res.value.offers) {
          if (seen.has(o.id)) continue;
          seen.add(o.id);
          fresh.push(o);
        }
      } else {
        categories[cat.id] = {
          ok: false,
          error: String(res.reason && res.reason.message ? res.reason.message : res.reason).slice(0, 200),
        };
      }
    });

    if (fresh.length) {
      for (const o of fresh) {
        const rec = enricher.get(o.id);
        if (rec) {
          try {
            applyDescription(o, { description: rec.description, fields: {}, seller: {} });
          } catch {
            /* ignore */
          }
        }
      }
      state.offers = fresh;
      state.byId = new Map(fresh.map((o) => [o.id, o]));
      state.updatedAt = Date.now();
      state.categories = categories;
      state.refreshError = null;
      snapshotHistory();
      enricher.enqueue(aheadTargets());
      store.saveJsonDebounced('cache.json', buildCache(), 2000);
      console.log(
        `[refresh] ${fresh.length} лотов за ${Date.now() - started} мс, описаний в кеше: ${enricher.count}`
      );
    } else {
      state.refreshError = 'Не удалось загрузить категории FunPay';
      console.error('[refresh] не удалось загрузить ни одной категории');
    }

    return { ok: fresh.length > 0, count: fresh.length, ms: Date.now() - started, categories };
  })().finally(() => {
    state.refreshing = null;
  });

  return state.refreshing;
}

/* ------------------------------------------------------------------ */
/* serialization                                                       */
/* ------------------------------------------------------------------ */

function publicOffer(o, f = null) {
  const item = {
    id: o.id,
    cat: o.cat,
    catName: o.catName,
    title: o.title,
    model: o.model,
    modelLabel: modelLabel(o.model),
    price: o.price,
    accessType: o.accessType || 'other',
    durationMinutes: o.durationMinutes ?? null,
    pricePerHour: o.pricePerHour ?? null,
    tokens: o.tokens,
    pricePerM: o.pricePerM,
    perItemTokens: o.perItemTokens,
    qty: o.qty,
    confidence: o.tokensConfidence,
    parsedFrom: o.tokensParsedFrom,
    seller: {
      id: o.seller.id,
      name: o.seller.name,
      stars: o.seller.stars,
      reviews: o.seller.reviews,
      age: o.seller.age,
      ageMonths: o.seller.ageMonths ?? parseSellerAgeMonths(o.seller.age),
      online: !!(o.online || o.seller.online),
      avatar: o.seller.avatar,
      reviewSummary: reviewSummaryFor(String(o.seller.id)),
    },
    auto: !!o.auto,
    promo: !!o.promo,
    descLoaded: !!o.descLoaded,
    descriptionPreview: (o.description || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
    flags: {
      bonus: !!o.flags.bonus,
      oneToOne: !!o.flags.oneToOne,
      // true — схема явно распознана по тексту; false включает неизвестные.
      inputOutput: !!o.flags.inputOutput,
      refund: o.flags.refund,
      unlimited: !!o.flags.unlimited,
      rateLimited: !!o.flags.rateLimited,
      credits: !!o.flags.credits,
    },
  };
  if (f && f.need) {
    const c = needCost(o, f.need);
    if (c) item.needCost = c;
  }
  return item;
}

function categoryCounts() {
  const map = {};
  for (const o of state.offers) map[o.cat] = (map[o.cat] || 0) + 1;
  return map;
}

function categoryMeta() {
  const counts = categoryCounts();
  return CATEGORIES.map((c) => ({
    id: c.id,
    name: c.name,
    full: c.full,
    color: c.color,
    url: c.url,
    count: counts[c.id] || 0,
    ok: state.categories[c.id] ? state.categories[c.id].ok : null,
  }));
}

function modelsMeta() {
  const map = new Map();
  for (const o of state.offers) {
    if (!o.model) continue;
    map.set(o.model, (map.get(o.model) || 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, label: modelLabel(name), count }))
    .sort((a, b) => b.count - a.count);
}

/* ------------------------------------------------------------------ */
/* http helpers                                                        */
/* ------------------------------------------------------------------ */

function sendJson(res, status, payload, { gzip = true } = {}) {
  let body = Buffer.from(JSON.stringify(payload));
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  };
  if (gzip && body.length > 1024) {
    body = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return sendText(res, 404, 'Not found');
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
    const accept = req.headers['accept-encoding'] || '';
    if (data.length > 1024 && /gzip/.test(accept) && /\.(html|css|js|svg)$/.test(file)) {
      const gz = zlib.gzipSync(data);
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = gz.length;
      res.writeHead(200, headers);
      res.end(gz);
      return;
    }
    headers['Content-Length'] = data.length;
    res.writeHead(200, headers);
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* api                                                                 */
/* ------------------------------------------------------------------ */

async function handleOffers(res, url) {
  const f = parseFilters(url.searchParams);
  const scope = f.cats.length ? state.offers.filter((o) => f.cats.includes(o.cat)) : state.offers;
  let reviewCheck = { active: false };
  if (f.noReviewStars.length) {
    // Сначала сужаем каталог обычными фильтрами: один продавец проверяется
    // один раз независимо от числа его лотов. Дальше допускаем только
    // подтверждённые нули; результаты появляются по мере проверки профилей.
    const candidates = applyFilters(state.offers, { ...f, noReviewStars: [] });
    const sellerIds = [...new Set(candidates.map((o) => String(o.seller.id)).filter((id) => /^[1-9]\d{0,14}$/.test(id)))];
    reviews.enqueue(sellerIds, f.noReviewStars, { retryFailed: url.searchParams.get('reviewRetry') === '1' });
    reviewCheck = { ...reviews.stats(sellerIds, f.noReviewStars), active: true, totalSellers: sellerIds.length };
  }
  let items = applyFilters(state.offers, f, { reviewSummaryFor });

  const stats = computeStats(items, f);
  const total = items.length;
  sortOffers(items, f);
  const pages = Math.max(1, Math.ceil(total / f.pageSize));
  const page = Math.min(f.page, pages);
  const start = (page - 1) * f.pageSize;
  const visibleItems = items.slice(start, start + f.pageSize);
  // Подгружаем недостающие описания для предпросмотра видимых карточек.
  enricher.enqueue(visibleItems.filter((o) => !o.descLoaded));
  const pageItems = visibleItems.map((o) => publicOffer(o, f));

  const histKey = f.cats.length === 1 ? f.cats[0] : 'all';
  const hist = (histKey === 'all' ? history.all : history.byCat[histKey] || []).slice(-90);

  sendJson(res, 200, {
    updatedAt: state.updatedAt,
    total,
    page,
    pageSize: f.pageSize,
    pages,
    items: pageItems,
    stats,
    desc: {
      ...enricher.stats(),
      loadedInScope: scope.filter((o) => o.descLoaded).length,
      totalInScope: scope.length,
    },
    history: hist,
    reviewCheck,
    refreshError: state.refreshError,
  });
}

async function handleMeta(res) {
  sendJson(res, 200, {
    updatedAt: state.updatedAt,
    total: state.offers.length,
    categories: categoryMeta(),
    models: modelsMeta(),
    desc: enricher.stats(),
    historyPoints: {
      all: history.all.length,
      ...Object.fromEntries(Object.entries(history.byCat).map(([k, v]) => [k, v.length])),
    },
  });
}

async function handleOffer(res, url) {
  const id = String(url.searchParams.get('id') || '');
  const offer = state.byId.get(id);
  if (!offer) return sendJson(res, 404, { error: 'Лот не найден' });
  let error = null;
  if (!offer.descLoaded) {
    try {
      await enricher.fetchNow(offer);
    } catch (err) {
      error = 'Не удалось загрузить описание: ' + err.message;
    }
  }
  sendJson(res, 200, {
    offer: publicOffer(offer),
    description: offer.description || '',
    flags: offer.flags,
    fields: offer.fields || {},
    error,
  });
}

async function handleReviews(res, url) {
  const sellerId = String(url.searchParams.get('seller') || '');
  if (!/^[1-9]\d{0,14}$/.test(sellerId)) return sendJson(res, 400, { error: 'Некорректный продавец' });
  if (!state.offers.some((offer) => String(offer.seller.id) === sellerId)) {
    return sendJson(res, 404, { error: 'Продавец не найден в каталоге' });
  }
  const sort = url.searchParams.get('sort') || 'worst';
  const rawRating = url.searchParams.get('rating') || '0';
  const cursor = url.searchParams.get('cursor') || null;
  if (!['worst', 'best', 'newest'].includes(sort) || !/^[0-5]$/.test(rawRating) || (cursor && cursor.length > 4096)) {
    return sendJson(res, 400, { error: 'Некорректные параметры отзывов' });
  }
  try {
    const data = await reviews.getPage(sellerId, { sort, rating: Number(rawRating), cursor, refresh: url.searchParams.get('refresh') === '1' });
    sendJson(res, data.error ? 502 : 200, data);
  } catch (err) {
    const invalid = err.status === 400 || err.statusCode === 400 || err.code === 'INVALID_CURSOR';
    sendJson(res, invalid ? 400 : 502, { error: invalid ? 'Некорректная страница отзывов' : 'Не удалось загрузить отзывы FunPay. Попробуйте ещё раз.', sellerId, summary: reviews.summary(sellerId) });
  }
}

async function handleEnrich(req, res) {
  const body = await readBody(req);
  let queued = 0;
  if (Array.isArray(body.ids) && body.ids.length) {
    const offers = body.ids.map((id) => state.byId.get(String(id))).filter(Boolean);
    queued += enricher.enqueue(offers);
  }
  if (body.cheap) {
    const cats = Array.isArray(body.cats) && body.cats.length ? body.cats : CATEGORIES.map((c) => c.id);
    const limit = Math.min(400, Math.max(10, parseInt(body.limit, 10) || 120));
    const candidates = state.offers
      .filter((o) => cats.includes(o.cat) && !enricher.has(o.id))
      .sort((a, b) => (a.pricePerM ?? Number.POSITIVE_INFINITY) - (b.pricePerM ?? Number.POSITIVE_INFINITY))
      .slice(0, limit);
    queued += enricher.enqueue(candidates);
  }
  sendJson(res, 200, { ok: true, queued, desc: enricher.stats() });
}

async function handleHistory(res, url) {
  const cat = url.searchParams.get('cat') || 'all';
  const list = cat === 'all' ? history.all : history.byCat[cat] || [];
  sendJson(res, 200, { cat, points: list.slice(-120) });
}

/* ------------------------------------------------------------------ */
/* server                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/offers') return await handleOffers(res, url);
    if (url.pathname === '/api/meta') return await handleMeta(res);
    if (url.pathname === '/api/offer') return await handleOffer(res, url);
    if (url.pathname === '/api/reviews') return await handleReviews(res, url);
    if (url.pathname === '/api/history') return await handleHistory(res, url);
    if (url.pathname === '/api/enrich' && req.method === 'POST') return await handleEnrich(req, res);
    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      const result = await refresh({ force: true });
      return sendJson(res, 200, { ok: true, result, updatedAt: state.updatedAt });
    }
    if (url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        offers: state.offers.length,
        updatedAt: state.updatedAt,
        refreshing: !!state.refreshing,
        desc: enricher.stats(),
        categories: state.categories,
      });
    }
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Неизвестный эндпоинт' });
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  TokenScope → http://${HOST}:${PORT}\n`);
  refresh({ force: true }).catch((e) => console.error('[refresh]', e));
  setInterval(() => {
    refresh({ force: false }).catch((e) => console.error('[interval]', e));
  }, REFRESH_MS).unref();
});

process.on('SIGINT', () => {
  try {
    store.saveJson('cache.json', buildCache());
    store.saveJson('history.json', state.history);
  } catch {
    /* ignore */
  }
  process.exit(0);
});
