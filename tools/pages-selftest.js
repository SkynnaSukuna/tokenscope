'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildOffer, applyDescription, CATEGORIES } = require('../lib/parser');
const filter = require('../lib/filter');
const { makeSnapshot } = require('../lib/snapshot');
const { browserCore, build } = require('./build-pages');
const { collect } = require('./collect-snapshot');

function fixtures() {
  const rows = [
    ['810001', 'DeepSeek 10 млн токенов', 90, '4506', 'Вход + выход. Бонус 10%.'],
    ['810002', 'Claude unlimited for 1h', 120, '4234', 'Автовыдача.'],
    ['810003', 'DeepSeek 5 млн токенов', 70, '4506', 'Возврат не предусмотрен.'],
    ['810004', 'Claude 100 млн токенов', 600, '4234', '100 млн токенов.'],
  ];
  return rows.map(([id, titleHtml, price, cat, description], index) => {
    const o = buildOffer({ id, titleHtml, price, fields: { model: cat === '4506' ? 'deepseek' : 'claude' }, sellerId: String(7000 + index), sellerName: 'Продавец ' + (index + 1), stars: 5, reviews: 150, age: 'на сайте 2 года', auto: true, online: true }, cat);
    applyDescription(o, { description, fields: {} });
    o.secretToken = 'not-public';
    return o;
  });
}

async function run() {
  let count = 0;
  const check = (label, condition) => { assert.ok(condition, label); count++; console.log('PASS ' + label); };
  const offers = fixtures();
  const now = Date.now();
  const data = makeSnapshot({ offers, updatedAt: now, cookies: 'secret', categories: { '4506': { ok: true, updatedAt: now } } }, { all: [{ t: now, avg: 10, count: 3 }], byCat: {} });
  check('Публичный снимок не содержит произвольные поля кэша', !JSON.stringify(data).includes('not-public') && !JSON.stringify(data).includes('secret'));
  check('Все шесть категорий сохранены, безлимит отделён от пакетов', data.categories.length === 6 && data.offers[1].pricePerM === null && data.offers[1].pricePerHour === 120);
  check('Точность объёма сохранена для общего фильтра', data.offers.every((o, i) => o.tokensConfidence === (offers[i].tokensConfidence || 'unknown')));
  let downloads = 0;
  let fail = false;
  let requestedUrl = '';
  const window = {
    TOKENSCOPE_CONFIG: { mode: 'snapshot' },
    fetch: async (url) => {
      requestedUrl = String(url); downloads++;
      if (fail) throw new Error('Network test error');
      return new Response(String(url).endsWith('.gz') ? require('node:zlib').gzipSync(JSON.stringify(data)) : JSON.stringify(data));
    },
  };
  const context = vm.createContext({ window, URL, Response, DOMException, location: { href: 'https://example.github.io/tokenscope/' }, document: { baseURI: 'https://example.github.io/tokenscope/' } });
  vm.runInContext(browserCore(), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/api.js'), 'utf8'), context);
  const api = window.TokenScopeAPI;
  const request = async (query) => (await api.fetch('/api/offers?' + query)).json();
  const initial = await request('');
  check('Статический адаптер выдаёт все лоты', initial.total === offers.length && initial.items.length === offers.length && initial.deploymentMode === 'snapshot');
  check('Снимок загружается по пути репозитория', requestedUrl === 'https://example.github.io/tokenscope/snapshot.json');
  for (const query of ['need=10000000', 'offerType=timed&minDuration=60&maxDuration=60', 'cat=4506&sort=price', 'inputOutput=only', 'minPriceM=10&maxPriceM=20', 'exactTokens=1', 'q=claude&sort=priceHour', 'offersExclude=810001&sellersExclude=7002']) {
    const f = filter.parseFilters(new URLSearchParams(query));
    const expected = filter.sortOffers(filter.applyFilters(data.offers, f), f);
    const actual = await request(query);
    check('Общие фильтры Node/Pages: ' + query, actual.total === expected.length && JSON.stringify(actual.items.map((o) => o.id)) === JSON.stringify(expected.map((o) => o.id)));
    assert.deepEqual(actual.stats, filter.computeStats(expected, f));
  }
  check('Повторные фильтры используют один загруженный снимок', downloads === 1);
  const noReviews = await request('noReviewStars=1,2,3');
  check('Отсутствие проверок отзывов не считается отсутствием жалоб', noReviews.total === 0 && noReviews.refreshError.includes('локальной версии') && noReviews.reviewCheck.unavailable);
  check('Неизвестный лот возвращает 404', (await api.fetch('/api/offer?id=missing')).status === 404);
  const description = await (await api.fetch('/api/offer?id=810001')).json();
  check('Описание лота доступно из снимка', description.description === offers[0].description);
  check('Живые отзывы явно недоступны на статике', (await api.fetch('/api/reviews?seller=7000')).status === 503);
  const ctrl = new AbortController(); ctrl.abort();
  await assert.rejects(api.fetch('/api/meta', { signal: ctrl.signal }), { name: 'AbortError' }); count++;
  await api.fetch('/api/refresh', { method: 'POST' });
  check('Кнопка обновления перезагружает опубликованный снимок', downloads === 2);
  fail = true;
  await assert.rejects(api.fetch('/api/refresh', { method: 'POST' }));
  fail = false;
  await api.fetch('/api/meta');
  check('После сетевой ошибки доступен повтор', downloads === 4);
  window.TOKENSCOPE_CONFIG.compressedSnapshotUrl = './snapshot.json.gz';
  context.DecompressionStream = DecompressionStream;
  await api.fetch('/api/refresh', { method: 'POST' });
  const unpacked = await request('need=10000000');
  check('Gzip-снимок распаковывается браузером без сервера', requestedUrl.endsWith('/tokenscope/snapshot.json.gz') && unpacked.total === 1 && unpacked.items[0].descriptionPreview === offers[0].description);
  const empty = makeSnapshot({}, {});
  check('Пустая сборка честно сообщает об отсутствии каталога', empty.offers.length === 0 && empty.refreshError.includes('ещё не собран'));
  const writes = {};
  const cachedOffers = CATEGORIES.map((cat, index) => ({ ...offers[index % offers.length], id: String(820000 + index), cat: cat.id }));
  const oldHistory = { all: [{ t: now - 7200000, avg: 10, count: 6 }], byCat: {} };
  const saved = await collect({
    previous: { offers: cachedOffers, updatedAt: now - 3600000 }, history: oldHistory,
    fetchPage: async () => { throw new Error('offline fixture'); }, delay: async () => {}, descriptionLimit: 0,
    save: (name, value) => { writes[name] = value; return true; },
  });
  check('Неудачный скан сохраняет прежние лоты и время данных', saved.offers.length === cachedOffers.length && saved.updatedAt === now - 3600000 && saved.lastAttemptAt >= now);
  check('Ошибки категорий не маскируются успешным сканом', CATEGORIES.every((c) => saved.categories[c.id].ok === false && saved.categories[c.id].updatedAt === now - 3600000) && saved.refreshError.includes('Не удалось'));
  check('Неудачный скан сохраняет историю без ложных новых точек', JSON.stringify(writes['history.json'].all) === JSON.stringify(oldHistory.all));
  const htmlFor = (index) => '<a class="tc-item" href="https://funpay.com/lots/offer?id=' + (830000 + index) + '" data-user="7000"><div class="tc-desc-text">DeepSeek 10 млн токенов</div><div class="tc-price" data-s="90"></div><div class="media-user-name">Seller</div></a>';
  const freshPage = async (url) => htmlFor(CATEGORIES.findIndex((cat) => cat.url === url));
  const onlyFirstPage = async (url) => { if (url === CATEGORIES[0].url) return htmlFor(0); throw new Error('offline fixture'); };
  const collectOptions = { previous: {}, history: {}, delay: async () => {}, descriptionLimit: 0 };
  let failedWrites = 0;
  const forbiddenSave = () => { failedWrites++; return true; };
  await assert.rejects(collect({ ...collectOptions, fetchPage: async () => { throw new Error('offline fixture'); }, save: forbiddenSave }), /Нет доступного каталога/);
  check('Без сети и кэша сбор завершается ошибкой до записи', failedWrites === 0);
  await assert.rejects(collect({ ...collectOptions, fetchPage: onlyFirstPage, save: forbiddenSave }), /Неполный каталог/);
  check('Частичный первый сбор не заменяет опубликованный сайт', failedWrites === 0);
  await assert.rejects(collect({ ...collectOptions, previous: { offers, updatedAt: now }, fetchPage: onlyFirstPage, save: forbiddenSave }), /Неполный каталог/);
  check('В кэше должен быть fallback для каждой недоступной категории', failedWrites === 0);
  const broken = cachedOffers.map((offer) => ({ ...offer, price: null }));
  await assert.rejects(collect({ ...collectOptions, previous: { offers: broken, updatedAt: now }, fetchPage: onlyFirstPage, save: forbiddenSave }), /Неполный каталог/);
  check('Повреждённые лоты не считаются пригодным кэшем', failedWrites === 0);
  const freshWrites = {};
  const fresh = await collect({ ...collectOptions, fetchPage: freshPage, save: (name, value) => { freshWrites[name] = value; return true; } });
  check('Полный первый сбор сохраняет все категории и историю', fresh.offers.length === CATEGORIES.length && !fresh.refreshError && freshWrites['history.json'].all.length === 1 && CATEGORIES.every((cat) => freshWrites['history.json'].byCat[cat.id].length === 1));
  const partial = await collect({ ...collectOptions, previous: { offers: cachedOffers, updatedAt: now - 3600000 }, fetchPage: onlyFirstPage, save: () => true });
  check('Частичное обновление сохраняет все категории и даты fallback', partial.offers.length === CATEGORIES.length && partial.categories[CATEGORIES[0].id].ok && CATEGORIES.slice(1).every((cat) => !partial.categories[cat.id].ok && partial.categories[cat.id].updatedAt === now - 3600000));
  for (const failedFile of ['cache.json', 'history.json']) {
    await assert.rejects(collect({ ...collectOptions, fetchPage: freshPage, save: (name) => name !== failedFile }), /Не удалось сохранить/);
    check('Ошибка записи ' + failedFile + ' останавливает сбор', true);
  }
  const work = path.resolve(__dirname, '../.probe/pages-build-' + Date.now());
  const cacheDir = path.join(work, 'data');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'cache.json'), JSON.stringify({ offers, updatedAt: now }));
  const output = build({ cacheDir, outDir: path.join(work, 'site') });
  check('Сборка сайта включает полный неизменённый текст MIT', fs.readFileSync(path.join(output.outDir, 'LICENSE'), 'utf8') === fs.readFileSync(path.resolve(__dirname, '../LICENSE'), 'utf8'));
  const compressedSnapshot = require('node:zlib').gunzipSync(fs.readFileSync(path.join(output.outDir, 'snapshot.json.gz'))).toString('utf8');
  check('Сжатый снимок совпадает с опубликованным JSON', compressedSnapshot === fs.readFileSync(path.join(output.outDir, 'snapshot.json'), 'utf8'));
  console.log(`\n${count} проверок Pages выполнено.`);
}
if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { fixtures };
