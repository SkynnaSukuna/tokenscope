'use strict';

const { parseSellerAgeMonths } = require('./parser');

function list(sp, key) {
  return (sp.get(key) || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(sp, key, def = null) {
  const raw = sp.get(key);
  if (raw == null || raw === '') return def;
  const v = parseFloat(String(raw).replace(',', '.'));
  return Number.isFinite(v) ? v : def;
}

function bool(sp, key) {
  return sp.get(key) === '1';
}

function positiveNum(sp, key) {
  const raw = sp.get(key);
  if (raw == null || !raw.trim()) return null;
  const value = Number(raw.replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : null;
}

const OFFER_TYPES = new Set(['any', 'tokens', 'unlimited', 'timed', 'excludeTimed', 'excludeUnlimited', 'credits']);
const INPUT_OUTPUT_MODES = new Set(['any', 'only', 'exclude']);

function parseFilters(sp) {
  const offerType = sp.get('offerType') || 'any';
  const inputOutput = sp.get('inputOutput') || 'any';
  return {
    cats: list(sp, 'cat'),
    q: (sp.get('q') || '').trim().toLowerCase(),
    models: list(sp, 'model'),
    minStars: num(sp, 'minStars', 0),
    minReviews: num(sp, 'minReviews', 0),
    noReviewStars: [...new Set(list(sp, 'noReviewStars').filter((v) => /^[123]$/.test(v)).map(Number))].sort(),
    minAgeMonths: num(sp, 'minAgeMonths', 0),
    auto: bool(sp, 'auto'),
    online: bool(sp, 'online'),
    noRateLimited: bool(sp, 'noRateLimited'),
    noCredits: bool(sp, 'noCredits'),
    unlimitedOnly: bool(sp, 'unlimitedOnly'),
    offerType: OFFER_TYPES.has(offerType) ? offerType : 'any',
    minDuration: positiveNum(sp, 'minDuration'),
    maxDuration: positiveNum(sp, 'maxDuration'),
    bonus: sp.get('bonus') || 'any',
    oneToOne: sp.get('oneToOne') || 'any',
    inputOutput: INPUT_OUTPUT_MODES.has(inputOutput) ? inputOutput : 'any',
    refund: sp.get('refund') || 'any',
    onlyDesc: bool(sp, 'onlyDesc'),
    minTokens: num(sp, 'minTokens', null),
    maxTokens: num(sp, 'maxTokens', null),
    minPriceM: num(sp, 'minPriceM', null),
    maxPriceM: num(sp, 'maxPriceM', null),
    minLotPrice: num(sp, 'minLotPrice', null),
    maxLotPrice: num(sp, 'maxLotPrice', null),
    offersExclude: list(sp, 'offersExclude'),
    sellersExclude: list(sp, 'sellersExclude'),
    sellersInclude: list(sp, 'sellersInclude'),
    qtyMode: sp.get('qtyMode') || 'any',
    qtyMin: num(sp, 'qtyMin', null),
    qtyMax: num(sp, 'qtyMax', null),
    unitMin: num(sp, 'unitMin', null),
    unitMax: num(sp, 'unitMax', null),
    unitKnown: bool(sp, 'unitKnown'),
    exactTokens: bool(sp, 'exactTokens'),
    need: positiveNum(sp, 'need') || 0,
    sort: sp.get('sort') || 'priceM',
    page: Math.max(1, parseInt(sp.get('page') || '1', 10) || 1),
    pageSize: Math.min(200, Math.max(10, parseInt(sp.get('pageSize') || '40', 10) || 40)),
  };
}

function textOf(o) {
  return (o.title + ' ' + (o.model || '') + ' ' + (o.seller ? o.seller.name : '') + ' ' + (o.description || '')).toLowerCase();
}

function sellerAgeMonths(o) {
  if (!o.seller) return 0;
  if (o.seller.ageMonths != null) return o.seller.ageMonths;
  return parseSellerAgeMonths(o.seller.age);
}

function applyFilters(offers, f, { reviewSummaryFor = null } = {}) {
  const exOffers = new Set(f.offersExclude);
  const exSellers = new Set(f.sellersExclude);
  const incSellers = new Set(f.sellersInclude);
  const out = [];
  for (const o of offers) {
    if (exOffers.has(String(o.id))) continue;
    if (f.cats.length && !f.cats.includes(o.cat)) continue;
    if (f.models.length && !f.models.includes(o.model)) continue;
    if (f.q && !textOf(o).includes(f.q)) continue;
    if (f.auto && !o.auto) continue;
    if (f.online && !(o.online || (o.seller && o.seller.online))) continue;
    if (f.minStars && (o.seller.stars || 0) < f.minStars) continue;
    if (f.minReviews && (o.seller.reviews || 0) < f.minReviews) continue;
    if (f.minAgeMonths && sellerAgeMonths(o) < f.minAgeMonths) continue;
    if (f.noRateLimited && o.flags.rateLimited) continue;
    if (f.noCredits && o.flags.credits) continue;
    if (f.unlimitedOnly && !o.flags.unlimited) continue;
    const timed = !!o.flags.unlimited && o.durationMinutes != null;
    if (f.offerType === 'tokens' && (!Number.isFinite(o.tokens) || o.tokens <= 0 || o.flags.unlimited || o.flags.credits)) continue;
    if (f.offerType === 'unlimited' && !o.flags.unlimited) continue;
    if (f.offerType === 'excludeUnlimited' && o.flags.unlimited) continue;
    if (f.offerType === 'credits' && !o.flags.credits) continue;
    if (f.offerType === 'timed' && !timed) continue;
    if (f.offerType === 'excludeTimed' && timed) continue;
    if (f.minDuration != null && (o.durationMinutes == null || o.durationMinutes < f.minDuration)) continue;
    if (f.maxDuration != null && (o.durationMinutes == null || o.durationMinutes > f.maxDuration)) continue;
    if (f.bonus === 'only' && !o.flags.bonus) continue;
    if (f.bonus === 'exclude' && o.flags.bonus) continue;
    if (f.oneToOne === 'only' && !o.flags.oneToOne) continue;
    if (f.oneToOne === 'exclude' && o.flags.oneToOne) continue;
    // exclude убирает распознанное заявление; неизвестные остаются.
    if (f.inputOutput === 'only' && o.flags.inputOutput !== true) continue;
    if (f.inputOutput === 'exclude' && o.flags.inputOutput === true) continue;
    if (f.refund === 'yes' && o.flags.refund !== true) continue;
    if (f.refund === 'no' && o.flags.refund !== false) continue;
    if (f.onlyDesc && !o.descLoaded) continue;
    // Нужный объём — точный размер одного лота, без подбора кратности.
    if (f.need > 0 && (o.tokens !== f.need || o.flags.unlimited || o.flags.credits)) continue;
    if (f.minTokens != null && (!o.tokens || o.tokens < f.minTokens)) continue;
    if (f.maxTokens != null && (!o.tokens || o.tokens > f.maxTokens)) continue;
    if (f.minPriceM != null && (o.pricePerM == null || o.pricePerM < f.minPriceM)) continue;
    if (f.maxPriceM != null && (o.pricePerM == null || o.pricePerM > f.maxPriceM)) continue;
    if (f.minLotPrice != null && (o.price == null || o.price < f.minLotPrice)) continue;
    if (f.maxLotPrice != null && (o.price == null || o.price > f.maxLotPrice)) continue;
    if (exSellers.size && exSellers.has(String(o.seller.id))) continue;
    if (incSellers.size && !incSellers.has(String(o.seller.id))) continue;
    if (f.unitKnown && o.perItemTokens == null) continue;
    if (f.exactTokens && o.tokensConfidence !== 'high') continue;
    if (f.unitMin != null && (o.perItemTokens == null || o.perItemTokens < f.unitMin)) continue;
    if (f.unitMax != null && (o.perItemTokens == null || o.perItemTokens > f.unitMax)) continue;
    if (f.qtyMode === 'exclude1' && o.qty === 1) continue;
    if (f.qtyMode === 'known' && o.qty == null) continue;
    if (f.qtyMode === 'range') {
      if (o.qty == null) continue;
      if (f.qtyMin != null && o.qty < f.qtyMin) continue;
      if (f.qtyMax != null && o.qty > f.qtyMax) continue;
    }
    // Отсутствие низких оценок подтверждается по всему профилю FunPay.
    // Неизвестные, просроченные и ошибочные проверки не равны нулю отзывов.
    if (f.noReviewStars?.length) {
      const summary = reviewSummaryFor ? reviewSummaryFor(String(o.seller.id)) : null;
      const stale = summary?.stale && (!Array.isArray(summary.staleRatings) || f.noReviewStars.some((r) => summary.staleRatings.includes(r)));
      const failed = summary?.error && (!Array.isArray(summary.errorRatings) || f.noReviewStars.some((r) => summary.errorRatings.includes(r)));
      if (!summary || stale || failed || !f.noReviewStars.every((rating) =>
        summary.checkedRatings?.includes(rating) && summary.counts?.[rating] === 0
      )) continue;
    }
    out.push(o);
  }
  return out;
}

function needCost(o, need) {
  if (!need || !o.tokens || !o.price) return null;
  const units = Math.max(1, Math.ceil(need / o.tokens));
  const cost = units * o.price;
  const got = units * o.tokens;
  return { units, cost, got, effectivePriceM: (cost / got) * 1e6 };
}

function knownFirstAscending(key) {
  return (a, b) => {
    const av = Number.isFinite(a[key]) ? a[key] : null;
    const bv = Number.isFinite(b[key]) ? b[key] : null;
    if (av == null) return bv == null ? 0 : 1;
    if (bv == null) return -1;
    return av - bv;
  };
}

const SORTERS = {
  priceM: (a, b) => (a.pricePerM ?? Infinity) - (b.pricePerM ?? Infinity),
  priceHour: knownFirstAscending('pricePerHour'),
  duration: knownFirstAscending('durationMinutes'),
  price: (a, b) => a.price - b.price,
  tokens: (a, b) => (b.tokens ?? -1) - (a.tokens ?? -1),
  stars: (a, b) => (b.seller.stars || 0) - (a.seller.stars || 0) || (b.seller.reviews || 0) - (a.seller.reviews || 0),
  reviews: (a, b) => (b.seller.reviews || 0) - (a.seller.reviews || 0),
  reviewsAsc: (a, b) => (a.seller.reviews || 0) - (b.seller.reviews || 0),
  starsAsc: (a, b) => (a.seller.stars > 0 ? a.seller.stars : Infinity) - (b.seller.stars > 0 ? b.seller.stars : Infinity) || (b.seller.reviews || 0) - (a.seller.reviews || 0),
  age: (a, b) => sellerAgeMonths(b) - sellerAgeMonths(a),
};

function sortOffers(items, f) {
  if (f.sort === 'need' && f.need) {
    const withCost = new Map();
    for (const o of items) withCost.set(o.id, needCost(o, f.need));
    return items.sort((a, b) => {
      const ca = withCost.get(a.id);
      const cb = withCost.get(b.id);
      if (!ca && !cb) return 0;
      if (!ca) return 1;
      if (!cb) return -1;
      return ca.cost - cb.cost;
    });
  }
  const sorter = SORTERS[f.sort] || SORTERS.priceM;
  return items.sort(sorter);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeStats(items, f) {
  const priced = items.filter((o) => o.pricePerM != null && o.price > 0 && o.tokens > 0);
  const pms = priced.map((o) => o.pricePerM).sort((a, b) => a - b);
  const totalPrice = priced.reduce((s, o) => s + o.price, 0);
  const totalTokens = priced.reduce((s, o) => s + o.tokens, 0);

  // Средняя по лотам: каждый лот весит одинаково (оптовые «за 1 токен» не топят цену).
  // Выбросы (ошибочные лоты с абсурдной ценой) отсекаются по 99-му процентилю.
  let avgPriceM = 0;
  if (pms.length) {
    const cut = percentile(pms, 0.99);
    const core = pms.filter((v) => v <= cut);
    const basis = core.length ? core : pms;
    avgPriceM = basis.reduce((s, v) => s + v, 0) / basis.length;
  }
  // Взвешенная суммарная цена (сколько денег уходит на весь рынок)
  const weightedPriceM = totalTokens ? (totalPrice / totalTokens) * 1e6 : 0;
  const medianPriceM = pms.length ? percentile(pms, 0.5) : 0;
  const p10 = pms.length ? percentile(pms, 0.1) : 0;
  const p90 = pms.length ? percentile(pms, 0.9) : 0;

  const needPlans = f.need
    ? items
        .map((o) => {
          const c = needCost(o, f.need);
          return c ? { ...c, id: o.id, title: o.title, cat: o.cat, seller: o.seller.name, tokens: o.tokens, price: o.price } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.cost - b.cost)
        .slice(0, 3)
    : [];

  return {
    count: items.length,
    pricedCount: priced.length,
    avgPriceM,
    weightedPriceM,
    medianPriceM,
    minPriceM: pms.length ? pms[0] : 0,
    maxPriceM: pms.length ? pms[pms.length - 1] : 0,
    p10PriceM: p10,
    p90PriceM: p90,
    totalTokens,
    needPlans,
    descLoaded: items.filter((o) => o.descLoaded).length,
    withTokens: items.filter((o) => o.tokens).length,
  };
}

module.exports = { parseFilters, applyFilters, sortOffers, computeStats, needCost, percentile };
