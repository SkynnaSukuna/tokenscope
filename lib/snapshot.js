'use strict';

const { CATEGORIES, modelLabel, normalizeOfferAccess, parseSellerAgeMonths } = require('./parser');
const { computeStats } = require('./filter');

// Публичный снимок содержит только данные, необходимые интерфейсу: без кук,
// внутренних очередей, журнала запросов и произвольных полей из локального кэша.
function publicOffer(source, categoryStatus = {}) {
  const o = normalizeOfferAccess({ ...source, flags: { ...(source.flags || {}) }, seller: { ...(source.seller || {}) } });
  const seller = o.seller || {};
  return {
    id: String(o.id), source: 'funpay', url: `https://funpay.com/lots/offer?id=${encodeURIComponent(o.id)}`,
    cat: String(o.cat), catName: CATEGORIES.find((c) => c.id === String(o.cat))?.name || 'Другое',
    title: String(o.title || ''), model: o.model || '', modelLabel: modelLabel(o.model),
    price: o.price ?? null, tokens: o.tokens ?? null, pricePerM: o.pricePerM ?? null,
    accessType: o.accessType || 'other', durationMinutes: o.durationMinutes ?? null,
    pricePerHour: o.pricePerHour ?? null, perItemTokens: o.perItemTokens ?? null,
    qty: o.qty ?? null, confidence: o.tokensConfidence || o.confidence || 'unknown',
    tokensConfidence: o.tokensConfidence || o.confidence || 'unknown', parsedFrom: o.tokensParsedFrom || '',
    seller: {
      id: String(seller.id || ''), name: String(seller.name || 'Продавец'),
      stars: seller.stars ?? null, reviews: seller.reviews ?? 0, age: seller.age || '',
      ageMonths: seller.ageMonths ?? parseSellerAgeMonths(seller.age),
      online: !!(o.online || seller.online),
      avatar: /^https:\/\/(?:funpay\.com|s\.funpay\.com)\//i.test(seller.avatar || '') ? seller.avatar : '',
      reviewSummary: null,
    },
    auto: !!o.auto, online: !!(o.online || seller.online), promo: !!o.promo,
    descLoaded: !!o.descLoaded, description: String(o.description || ''),
    flags: {
      bonus: !!o.flags.bonus, oneToOne: !!o.flags.oneToOne, inputOutput: !!o.flags.inputOutput,
      refund: o.flags.refund ?? null, unlimited: !!o.flags.unlimited,
      rateLimited: !!o.flags.rateLimited, credits: !!o.flags.credits,
    },
    collectedAt: categoryStatus[o.cat]?.updatedAt || null,
    stale: categoryStatus[o.cat]?.ok === false,
  };
}

function historyPoint(offers, now = Date.now()) {
  const stats = computeStats(offers, { need: 0 });
  if (!stats.pricedCount) return null;
  return { t: now, avg: stats.avgPriceM, weighted: stats.weightedPriceM, median: stats.medianPriceM, min: stats.minPriceM, count: stats.pricedCount };
}

function makeSnapshot(cache = {}, history = {}) {
  const statuses = cache.categories || {};
  const offers = (Array.isArray(cache.offers) ? cache.offers : [])
    .filter((o) => o && o.id && o.seller && CATEGORIES.some((c) => c.id === String(o.cat)))
    .map((o) => publicOffer(o, statuses));
  const counts = {};
  const models = new Map();
  for (const o of offers) {
    counts[o.cat] = (counts[o.cat] || 0) + 1;
    if (o.model) models.set(o.model, (models.get(o.model) || 0) + 1);
  }
  const cleanPoints = (list) => (Array.isArray(list) ? list : [])
    .filter((p) => p && Number.isFinite(p.t) && p.count > 0 && Number.isFinite(p.avg)).slice(-120);
  return {
    schemaVersion: 1, deploymentMode: 'snapshot', builtAt: Date.now(),
    updatedAt: cache.updatedAt || null, lastAttemptAt: cache.lastAttemptAt || null,
    refreshError: cache.refreshError || (offers.length ? null : 'Каталог ещё не собран. Запустите сборку снимка в GitHub Actions.'),
    partial: Object.values(statuses).some((c) => c.ok === false),
    offers,
    categories: CATEGORIES.map((c) => ({ ...c, count: counts[c.id] || 0, ok: statuses[c.id]?.ok ?? null, updatedAt: statuses[c.id]?.updatedAt || cache.updatedAt || null })),
    models: [...models].map(([name, count]) => ({ name, count, label: modelLabel(name) })).sort((a, b) => b.count - a.count),
    history: { all: cleanPoints(history.all), byCat: Object.fromEntries(CATEGORIES.map((c) => [c.id, cleanPoints(history.byCat?.[c.id])])) },
  };
}

module.exports = { publicOffer, makeSnapshot, historyPoint };
