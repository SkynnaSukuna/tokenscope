'use strict';

// Одноразовый сборщик для GitHub Actions. Не поднимает сервер и не зацикливает скан.
const { CATEGORIES, parseLotsPage, parseOfferPage, applyDescription, normalizeOfferAccess } = require('../lib/parser');
const { fetchText, sleep } = require('../lib/net');
const { historyPoint } = require('../lib/snapshot');
const store = require('../lib/store');

async function collect({ fetchPage = fetchText, delay = sleep, descriptionLimit = 18, save = store.saveJson, previous = store.loadJson('cache.json', {}), history = store.loadJson('history.json', { all: [], byCat: {} }) } = {}) {
  const started = Date.now();
  // Повреждённый или неполный кэш не должен считаться запасным каталогом.
  const categoryIds = new Set(CATEGORIES.map((cat) => cat.id));
  const prior = (Array.isArray(previous.offers) ? previous.offers : []).filter((offer) => {
    if (!offer || !categoryIds.has(String(offer.cat))) return false;
    const updatedAt = previous.categories?.[offer.cat]?.updatedAt || previous.updatedAt;
    return /^\d+$/.test(String(offer.id)) && typeof offer.title === 'string' && offer.title.trim()
      && Number.isFinite(offer.price) && offer.price >= 0 && offer.seller && typeof offer.seller === 'object'
      && Number.isFinite(updatedAt) && updatedAt > 0;
  });
  const oldById = new Map(prior.map((o) => [String(o.id), o]));
  const offers = [];
  const categories = {};
  let succeeded = 0;
  // Последовательная загрузка с паузой: всего шесть страниц категорий за запуск.
  for (const cat of CATEGORIES) {
    try {
      const html = await fetchPage(cat.url, { tries: 2, timeout: 20000 });
      const parsed = parseLotsPage(html, cat.id);
      if (!parsed.length) throw new Error('Страница не содержит распознанных лотов');
      const now = Date.now();
      for (const o of parsed) {
        const old = oldById.get(String(o.id));
        if (old?.descLoaded && old.description) {
          applyDescription(o, { description: old.description, fields: old.fields || {} });
        }
        offers.push(o);
      }
      categories[cat.id] = { ok: true, count: parsed.length, updatedAt: now };
      succeeded++;
      console.log(`[snapshot] ${cat.name}: ${parsed.length}`);
    } catch (error) {
      const fallback = prior.filter((o) => String(o.cat) === cat.id);
      offers.push(...fallback);
      categories[cat.id] = { ok: false, count: fallback.length, updatedAt: previous.categories?.[cat.id]?.updatedAt || previous.updatedAt || null };
      console.warn(`[snapshot] ${cat.name}: ${error.message}; сохранено старых лотов ${fallback.length}`);
    }
    await delay(600);
  }
  const unique = [...new Map(offers.map((o) => [String(o.id), o])).values()];
  // Проверяем до описаний и записи: не заменяем опубликованный сайт урезанным
  // каталогом, если Actions потерял кэш или в нём нет нужной категории.
  if (!unique.length) throw new Error('Нет доступного каталога: сеть недоступна и предыдущего снимка нет. Повторите запуск позже.');
  const missing = CATEGORIES.filter((cat) => categories[cat.id].count === 0);
  if (missing.length) throw new Error('Неполный каталог: нет свежих или сохранённых данных для ' + missing.map((cat) => cat.name).join(', ') + '. Публикация остановлена; повторите сбор позже.');
  // Небольшое число описаний за один запуск; остальные накопятся в следующих снимках.
  const targets = unique.filter((o) => !o.descLoaded)
    .sort((a, b) => (a.pricePerM ?? Infinity) - (b.pricePerM ?? Infinity)).slice(0, descriptionLimit);
  for (const o of targets) {
    try {
      const html = await fetchPage(`https://funpay.com/lots/offer?id=${encodeURIComponent(o.id)}`, { tries: 1, timeout: 12000 });
      const page = parseOfferPage(html);
      if (page.description) applyDescription(o, page);
    } catch (error) { console.warn(`[snapshot] описание ${o.id}: ${error.message}`); }
    await delay(700);
  }
  unique.forEach((o) => normalizeOfferAccess(o));
  const next = {
    updatedAt: succeeded ? Date.now() : previous.updatedAt || Math.max(...Object.values(categories).map((cat) => cat.updatedAt || 0)) || null,
    lastAttemptAt: Date.now(), offers: unique, categories,
    refreshError: succeeded === CATEGORIES.length ? null : succeeded ? 'Часть категорий не обновилась. Для них сохранён предыдущий снимок.' : 'Не удалось обновить каталог. Показан последний доступный снимок.',
  };
  const appendPoint = (list, point) => {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const kept = (Array.isArray(list) ? list : []).filter((p) => p && p.t >= cutoff);
    if (point) kept.push(point);
    return kept.slice(-1000);
  };
  const nextHistory = {
    all: appendPoint(history.all, succeeded === CATEGORIES.length ? historyPoint(unique) : null),
    byCat: Object.fromEntries(CATEGORIES.map((c) => [c.id, appendPoint(history.byCat?.[c.id], categories[c.id].ok ? historyPoint(unique.filter((o) => String(o.cat) === c.id)) : null)])),
  };
  if (!save('cache.json', next) || !save('history.json', nextHistory)) throw new Error('Не удалось сохранить снимок на диск');
  console.log(`[snapshot] ${unique.length} лотов, ${succeeded}/${CATEGORIES.length} категорий, ${Math.round((Date.now() - started) / 1000)} с`);
  return next;
}

if (require.main === module) collect().catch((error) => { console.error('[snapshot] ' + error.message); process.exitCode = 1; });
module.exports = { collect };
