'use strict';

/**
 * Быстрые проверки парсера и фильтров без запуска сервера.
 * Запуск: node tools/selftest.js
 */

const assert = require('assert');
const {
  detectOneToOne,
  detectBonus,
  detectRefund,
  parseQty,
  parsePerItemTokens,
  parseTokens,
  parseSellerAgeMonths,
  detectUnlimited,
  parseDurationMinutes,
  normalizeOfferAccess,
  buildOffer,
  applyDescription,
  parseLotsPage,
} = require('../lib/parser');
const { applyFilters, computeStats, needCost, parseFilters, sortOffers } = require('../lib/filter');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS  ' + name);
  } catch (err) {
    console.error('FAIL  ' + name + ' → ' + err.message);
    process.exitCode = 1;
  }
}

check('1=1: все основные формулировки', () => {
  const yes = [
    '1 токен = 1 человек',
    '1 ключ на 1 пользователя',
    'один аккаунт на одного человека',
    'токен = человек',
    'не более 1 пользователя',
    '1 человек = 1 ключ',
    'ключ на одного',
  ];
  for (const t of yes) assert.ok(detectOneToOne(t), 'не распознано: ' + t);
  assert.strictEqual(detectOneToOne('1 токен на 10 человек'), null);
});

check('бонусы: положительные и отрицательные формулировки', () => {
  const yes = [
    'Оставьте отзыв и получите +1 000 000 бонусных токенов!',
    'подарок за отзыв',
    'кэшбэк 5%',
    '+10% за отзыв',
    'промокод в подарок',
  ];
  for (const t of yes) assert.ok(detectBonus(t), 'не распознано: ' + t);
  for (const t of ['без бонусов', 'бонусов нет', 'бонусы не начисляются']) {
    assert.strictEqual(detectBonus(t), false, 'ложный бонус: ' + t);
  }
});

check('возврат: да / нет', () => {
  assert.strictEqual(detectRefund('возврат средств предусмотрен'), true);
  assert.strictEqual(detectRefund('refund available'), true);
  assert.strictEqual(detectRefund('без возврата'), false);
  assert.strictEqual(detectRefund('возврат не предусмотрен'), false);
  assert.strictEqual(detectRefund('деньги не возвращаем'), false);
});

check('наличие: только явные «N шт»', () => {
  assert.strictEqual(parseQty('в наличии 5 шт'), 5);
  assert.strictEqual(parseQty('осталось 3 штуки'), 3);
  assert.strictEqual(parseQty('доступно 12 шт.'), 12);
  assert.strictEqual(parseQty('доступно 24/7'), null);
  assert.strictEqual(parseQty('Количество: 10 000 000 токенов'), null);
});

check('стаж продавца: перевод в месяцы', () => {
  assert.strictEqual(parseSellerAgeMonths('на сайте 6 месяцев'), 6);
  assert.strictEqual(parseSellerAgeMonths('на сайте 2 года'), 24);
  assert.strictEqual(parseSellerAgeMonths('на сайте 3 года 2 месяца'), 38);
  assert.strictEqual(parseSellerAgeMonths('на сайте год'), 12);
  assert.strictEqual(parseSellerAgeMonths('на сайте месяц'), 1);
  assert.strictEqual(parseSellerAgeMonths(''), 0);
});

check('объём за 1 шт.', () => {
  assert.strictEqual(parsePerItemTokens('1 шт = 1 000 000 токенов'), 1e6);
  assert.strictEqual(parsePerItemTokens('1 товар = 7М токенов'), 7e6);
  assert.strictEqual(parseTokens('100 млн токенов').value, 100e6);
});

check('needCost: сколько лотов нужно под объём', () => {
  const o = { tokens: 1e6, price: 10 };
  const c = needCost(o, 5e6);
  assert.strictEqual(c.units, 5);
  assert.strictEqual(c.cost, 50);
  assert.strictEqual(c.got, 5e6);
});

check('фильтры: наличие и продавцы', () => {
  const offers = [
    { id: '1', cat: '4506', title: 'a', model: 'x', price: 10, tokens: 1e6, pricePerM: 10, seller: { id: 's1', stars: 5, reviews: 10 }, flags: {}, qty: 1 },
    { id: '2', cat: '4506', title: 'b', model: 'x', price: 20, tokens: 2e6, pricePerM: 10, seller: { id: 's2', stars: 5, reviews: 10 }, flags: {}, qty: 5 },
    { id: '3', cat: '4506', title: 'c', model: 'x', price: 30, tokens: 3e6, pricePerM: 10, seller: { id: 's3', stars: 3, reviews: 10 }, flags: {}, qty: null },
  ];
  const sp = new URLSearchParams('qtyMode=exclude1&sellersExclude=s3');
  const f = parseFilters(sp);
  const got = applyFilters(offers, f).map((o) => o.id);
  assert.deepStrictEqual(got, ['2']);
});

check('статистика: медиана и минимум', () => {
  const items = [
    { price: 10, tokens: 1e6, pricePerM: 10, descLoaded: true, seller: { stars: 5, reviews: 1 }, flags: {} },
    { price: 10, tokens: 2e6, pricePerM: 5, descLoaded: false, seller: { stars: 5, reviews: 1 }, flags: {} },
    { price: 10, tokens: 4e6, pricePerM: 2.5, descLoaded: true, seller: { stars: 5, reviews: 1 }, flags: {} },
  ];
  const s = computeStats(items, { need: 0 });
  assert.strictEqual(s.count, 3);
  assert.strictEqual(s.minPriceM, 2.5);
  assert.strictEqual(s.medianPriceM, 5);
  assert.strictEqual(s.withTokens, 3);
});

function fixtureOffer(title, price = 120, fields = {}) {
  return buildOffer({
    id: title, titleHtml: title, price, fields,
    sellerId: 'test', sellerName: 'Test', stars: 5, reviews: 10,
    age: 'на сайте 1 месяц', online: true,
  }, '4506');
}

check('нужный объём: только точный размер одного лота', () => {
  const base = fixtureOffer('DeepSeek 10 млн токенов', 100);
  const offers = [
    { ...base, id: 'smaller', tokens: 5e6, qty: 100 },
    { ...base, id: 'one-less', tokens: 10e6 - 1 },
    { ...base, id: 'exact', tokens: 10e6 },
    { ...base, id: 'exact-cheaper', tokens: 10e6, price: 80, pricePerM: 8 },
    { ...base, id: 'one-more', tokens: 10e6 + 1 },
    { ...base, id: 'larger', tokens: 20e6 },
    { ...base, id: 'unknown', tokens: null },
    { ...base, id: 'zero', tokens: 0 },
    { ...base, id: 'unlimited', flags: { ...base.flags, unlimited: true } },
    { ...base, id: 'credits', flags: { ...base.flags, credits: true } },
  ];
  const filters = (query) => parseFilters(new URLSearchParams(query));
  const f = filters('need=10000000&sort=need');
  const exact = sortOffers(applyFilters(offers, f), f);
  assert.deepStrictEqual(exact.map((o) => o.id), ['exact-cheaper', 'exact']);
  const stats = computeStats(exact, f);
  assert.strictEqual(stats.count, 2);
  assert.strictEqual(stats.withTokens, 2);
  assert.strictEqual(stats.needPlans.length, 2);
  assert.ok(stats.needPlans.every((p) => p.got === 10e6 && p.tokens === 10e6 && p.units === 1));
  assert.deepStrictEqual(applyFilters(offers, filters('need=15000000')), []);
  assert.deepStrictEqual(applyFilters(offers, filters('need=10000000&minTokens=10000001')), []);
  assert.deepStrictEqual(applyFilters(offers, filters('need=10000000&offersExclude=exact')), [offers[3]]);
  assert.deepStrictEqual(applyFilters(offers, filters('need=5000000')).map((o) => o.id), ['smaller']);
  for (const query of ['', 'need=0', 'need=-1', 'need=Infinity', 'need=wrong', 'need=10oops']) {
    assert.strictEqual(applyFilters(offers, filters(query)).length, offers.length, query);
  }
});

check('безлимит: положительные упоминания и явные отрицания', () => {
  for (const text of ['unlimited for 1h', 'unlim 7d', 'UNLIM', 'Безлимитный доступ', 'неограниченные токены', '∞ на час', 'unmetered access']) {
    assert.strictEqual(detectUnlimited(text), true, text);
  }
  for (const text of ['не безлимит', 'no unlimited', 'no unlim', 'not unlim', 'unlim is not available', 'not unlimited', 'без безлимита', 'безлимита нет', 'не является безлимитом', 'unlimited is not available', 'не неограниченный доступ']) {
    assert.strictEqual(detectUnlimited(text), false, text);
  }
  assert.strictEqual(detectUnlimited('no unlimited on basic; unlimited on Pro'), true);
});

check('срок доступа: английские и русские часы, сутки, недели, месяцы', () => {
  const cases = [
    ['unlimited for 1h', 60], ['unlimited for 1 hour', 60],
    ['безлимит на 1 час', 60], ['Безлимит 60 min', 60],
    ['unlimited 24h', 1440], ['unlimited for 1 day', 1440], ['unlim 7d', 10080],
    ['безлимит на сутки', 1440], ['безлимит на неделю', 10080],
    ['безлимит на месяц', 43200], ['доступ на 2 недели', 20160],
    ['access for an hour', 60], ['access for a month', 43200],
    ['Доступ на полтора часа: 1,5 часа', 90], ['API key 30 minutes', 30],
    ['access 0.5h', 30], ['безлимит на 2 дня', 2880],
  ];
  for (const [text, expected] of cases) assert.strictEqual(parseDurationMinutes(text), expected, text);
  assert.strictEqual(parseDurationMinutes('Срок действия: 60 min', { description: true }), 60);
  assert.strictEqual(parseDurationMinutes('24h', { description: true }), null);
  assert.strictEqual(parseDurationMinutes('0h'), null);
  assert.strictEqual(parseDurationMinutes('-1h'), null);
});

check('срок доступа: квоты, доставка, ответ, гарантия и стаж не сроки', () => {
  const cases = [
    'Unlimited 24/7', 'Безлимит, поддержка 24/7',
    'Безлимит, время ответа 1 час', 'Unlimited 1 hour response',
    'Безлимит, автовыдача за 60 min', 'Безлимит, выдача доступа в течение 1 часа',
    'Unlimited 24h warranty', 'Безлимит, гарантия доступа на 1 месяц',
    'Безлимит, на сайте 1 месяц', 'Безлимит, стаж 1 месяц', 'Безлимит, продаю уже 1 месяц',
    'Unlimited 100 requests per hour', 'Unlimited 100 requests per 1 hour',
    'Unlimited 100M tokens per 24h', '100 млн токенов в день',
    'Безлимит, 1000000 токенов на 1 день', 'Безлимит, лимит 100 кредитов каждые 24h',
    'Безлимит, квота обновляется каждые сутки', 'Unlimited 1 hour daily',
    'Безлимит 1 час в день', 'Безлимит 100 рублей в час',
    '100M tokens 1 day', '100 requests 1 hour',
  ];
  for (const text of cases) {
    assert.strictEqual(parseDurationMinutes(text), null, text);
    assert.strictEqual(parseDurationMinutes(text, { description: true }), null, 'description: ' + text);
  }
  assert.strictEqual(parseDurationMinutes('Безлимит на 1 час, гарантия 1 месяц'), 60);
  assert.strictEqual(parseDurationMinutes('Гарантия 1 месяц. Доступ на 1 день', { description: true }), 1440);
});

check('buildOffer: тип доступа и отсутствие фиктивного пакета у безлимита', () => {
  const unlimited = fixtureOffer('Unlimited for 1h — 100M tokens per day', 90, { quantity: '1кк токенов' });
  assert.strictEqual(unlimited.accessType, 'unlimited');
  assert.strictEqual(unlimited.durationMinutes, 60);
  assert.strictEqual(unlimited.pricePerHour, 90);
  for (const key of ['tokens', 'pricePerM', 'perItemTokens', 'tokensConfidence', 'tokensParsedFrom']) assert.strictEqual(unlimited[key], null, key);
  const tokens = fixtureOffer('100 млн токенов, не безлимит');
  assert.strictEqual(tokens.accessType, 'tokens');
  assert.strictEqual(tokens.flags.unlimited, false);
  assert.strictEqual(tokens.tokens, 100e6);
  assert.strictEqual(tokens.pricePerHour, null);
  const credits = fixtureOffer('100 credits, 1M tokens equivalent');
  assert.strictEqual(credits.accessType, 'credits');
  assert.strictEqual(credits.tokens, null);
  assert.strictEqual(credits.pricePerM, null);
  assert.strictEqual(fixtureOffer('API ключ').accessType, 'other');
  const subscription = fixtureOffer('ChatGPT Plus subscription на месяц', 900);
  assert.strictEqual(subscription.accessType, 'credits');
  assert.strictEqual(subscription.durationMinutes, 43200);
  assert.strictEqual(subscription.pricePerHour, null);
  assert.strictEqual(fixtureOffer('Подписка ChatGPT на 1 месяц').accessType, 'credits');
  assert.strictEqual(fixtureOffer('100M tokens без подписки, no credit card').accessType, 'tokens');
  assert.strictEqual(fixtureOffer('100M tokens, подписка не нужна, оплата кредитной картой').accessType, 'tokens');
  const free = fixtureOffer('Безлимит на 1 час', 0);
  assert.strictEqual(free.pricePerHour, 0);
});

check('страница лотов: новые поля проходят через настоящий HTML парсер', () => {
  const html = '<a href="https://funpay.com/lots/offer?id=101" class="tc-item" data-user="seller">'
    + '<div class="tc-desc-text">Unlimited for 1h</div>'
    + '<div class="tc-price" data-s="75"></div></a>';
  const offers = parseLotsPage(html, '4506');
  assert.strictEqual(offers.length, 1);
  assert.strictEqual(offers[0].accessType, 'unlimited');
  assert.strictEqual(offers[0].durationMinutes, 60);
  assert.strictEqual(offers[0].pricePerHour, 75);
});

check('applyDescription: сначала безлимит, затем токены; заголовок приоритетнее', () => {
  const offer = fixtureOffer('API ключ', 180);
  applyDescription(offer, {
    description: 'Безлимитный доступ на 1 час. Лимит 100 млн токенов в день. 1 товар = 7М токенов.', fields: {}, seller: {},
  });
  assert.strictEqual(offer.accessType, 'unlimited');
  assert.strictEqual(offer.durationMinutes, 60);
  assert.strictEqual(offer.pricePerHour, 180);
  assert.strictEqual(offer.tokens, null);
  assert.strictEqual(offer.pricePerM, null);
  const titled = fixtureOffer('Безлимит на 1 час', 180);
  applyDescription(titled, { description: 'Доступ на 1 месяц. Гарантия 24h.', fields: {}, seller: {} });
  assert.strictEqual(titled.durationMinutes, 60);
  assert.strictEqual(titled.pricePerHour, 180);
  const stale = fixtureOffer('1М токенов', 100);
  applyDescription(stale, { description: 'Unlimited access for 1 day. 100M tokens per day.', fields: {}, seller: {} });
  assert.strictEqual(stale.tokens, null);
  assert.strictEqual(stale.pricePerM, null);
  assert.strictEqual(stale.pricePerHour, 100 / 24);
});

check('applyDescription: отрицание безлимита и описания с чужими сроками', () => {
  const offer = fixtureOffer('API ключ', 10);
  applyDescription(offer, { description: 'No unlimited. 1 товар = 7М токенов. Доставка 1 hour. Гарантия 1 месяц.', fields: {}, seller: {} });
  assert.strictEqual(offer.accessType, 'tokens');
  assert.strictEqual(offer.tokens, 7e6);
  assert.strictEqual(offer.flags.unlimited, false);
  assert.strictEqual(offer.durationMinutes, null);
  assert.strictEqual(offer.pricePerHour, null);
  const quota = fixtureOffer('Unlimited API');
  applyDescription(quota, { description: '100 requests per hour. Гарантия доступа 1 месяц.', fields: {}, seller: {} });
  assert.strictEqual(quota.durationMinutes, null);
  assert.strictEqual(quota.pricePerHour, null);
  const metadata = fixtureOffer('API ключ', 45);
  applyDescription(metadata, { description: '', fields: { 'Тип доступа': 'Безлимит', 'Срок доступа': '1 час' }, seller: {} });
  assert.strictEqual(metadata.durationMinutes, 60);
  normalizeOfferAccess(metadata);
  assert.strictEqual(metadata.accessType, 'unlimited');
  assert.strictEqual(metadata.durationMinutes, 60);
});

const accessOffers = [
  fixtureOffer('Безлимит на 1 час', 60), fixtureOffer('Unlimited 24h', 240),
  fixtureOffer('Unlimited API', 80), fixtureOffer('100M tokens', 20),
  fixtureOffer('100 credits', 30), fixtureOffer('API ключ на 1 час', 40),
];
accessOffers.forEach((o, i) => { o.id = String(i + 1); });
function filteredIds(query, offers = accessOffers) {
  return applyFilters(offers, parseFilters(new URLSearchParams(query))).map((o) => o.id);
}

check('offerType: каждый тип, timed и точное дополнение excludeTimed', () => {
  assert.deepStrictEqual(filteredIds('offerType=any'), ['1', '2', '3', '4', '5', '6']);
  assert.deepStrictEqual(filteredIds('offerType=tokens'), ['4']);
  assert.deepStrictEqual(filteredIds('offerType=unlimited'), ['1', '2', '3']);
  assert.deepStrictEqual(filteredIds('offerType=excludeUnlimited'), ['4', '5', '6']);
  assert.deepStrictEqual(filteredIds('offersExclude=1,4,6'), ['2', '3', '5']);
  assert.deepStrictEqual(filteredIds('offerType=excludeUnlimited&offersExclude=4'), ['5', '6']);
  assert.deepStrictEqual(filteredIds('offerType=timed'), ['1', '2']);
  assert.deepStrictEqual(filteredIds('offerType=excludeTimed'), ['3', '4', '5', '6']);
  assert.deepStrictEqual(filteredIds('offerType=credits'), ['5']);
  assert.deepStrictEqual(filteredIds('unlimitedOnly=1'), ['1', '2', '3']);
  assert.deepStrictEqual(filteredIds('unlimitedOnly=1&offerType=excludeTimed'), ['3']);
  assert.deepStrictEqual(filteredIds('offerType=unknown'), ['1', '2', '3', '4', '5', '6']);
  const fakeTokens = [{ ...accessOffers[3], flags: { credits: true } }, { ...accessOffers[3], flags: { unlimited: true } }];
  assert.deepStrictEqual(filteredIds('offerType=tokens', fakeTokens), []);
});

check('границы срока: положительные минуты, включительность, неизвестный срок', () => {
  assert.deepStrictEqual(filteredIds('minDuration=60&maxDuration=60'), ['1', '6']);
  assert.deepStrictEqual(filteredIds('offerType=timed&minDuration=61'), ['2']);
  assert.deepStrictEqual(filteredIds('maxDuration=1440'), ['1', '2', '6']);
  assert.deepStrictEqual(filteredIds('minDuration=1441&maxDuration=60'), []);
  assert.deepStrictEqual(filteredIds('minDuration=0&maxDuration=-1'), ['1', '2', '3', '4', '5', '6']);
  for (const value of ['-1', '0', 'NaN', 'Infinity', '60min', '']) {
    assert.strictEqual(parseFilters(new URLSearchParams({ minDuration: value })).minDuration, null, value);
  }
  assert.strictEqual(parseFilters(new URLSearchParams('minDuration=0,5')).minDuration, 0.5);
});

check('сортировки: часовая цена и срок возрастают, неизвестное в конце', () => {
  const items = [accessOffers[2], accessOffers[0], accessOffers[1], accessOffers[3]];
  assert.deepStrictEqual(sortOffers(items.slice(), { sort: 'priceHour' }).map((o) => o.id), ['2', '1', '3', '4']);
  assert.deepStrictEqual(sortOffers(items.slice(), { sort: 'duration' }).map((o) => o.id), ['1', '2', '3', '4']);
  const nonfinite = [{ id: 'a', durationMinutes: NaN }, { id: 'b', durationMinutes: 10 }, { id: 'c', durationMinutes: Infinity }];
  assert.deepStrictEqual(sortOffers(nonfinite, { sort: 'duration' }).map((o) => o.id), ['b', 'a', 'c']);
});

// Исполняем настоящий server.js в изолированной VM. Сеть/listen, таймеры и
// запись хранилища заглушены: проверка гидратации/API не меняет data/.
function serverHarness(cachedOffers, descriptions = []) {
  let writes = 0;
  class FakeEnricher {
    constructor() { this.cache = new Map(); }
    hydrate(records) { for (const record of records) this.cache.set(record.id, record); }
    get(id) { return this.cache.get(id); }
    get count() { return this.cache.size; }
    enqueue(offers) { return offers.length; }
    stats() { return { cached: this.count }; }
  }
  const fakeStore = {
    loadJson(name, fallback) { return name === 'cache.json' ? { offers: cachedOffers, updatedAt: 1 } : fallback; },
    loadJsonl() { return descriptions; },
    saveJson() { writes++; throw new Error('unexpected data write'); },
    saveJsonDebounced() { writes++; throw new Error('unexpected data write'); },
  };
  const context = {
    require(id) {
      if (id === 'http') return { createServer() { return { listen() {} }; } };
      if (id === './lib/store') return fakeStore;
      if (id === './lib/enrich') return { Enricher: FakeEnricher };
      if (id === './lib/net') return { fetchText() { throw new Error('unexpected network'); } };
      if (id.startsWith('./lib/')) return require('../' + id.slice(2));
      return require(id);
    },
    __dirname: path.join(__dirname, '..'), Buffer, URL,
    console: { log() {}, error() {} },
    process: { env: {}, on() {}, exit() { throw new Error('unexpected process exit'); } },
    setInterval() { throw new Error('unexpected timer'); },
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const server = vm.runInNewContext(source + '\n;({ state, publicOffer, handleOffers });', context, { filename: 'server.js' });
  return { ...server, get writes() { return writes; } };
}

check('старый кэш: миграция загруженных и сохранённых отдельно описаний', () => {
  const loaded = fixtureOffer('API ключ', 120);
  Object.assign(loaded, { id: 'old', descLoaded: true, description: 'Unlimited access for 1 hour. 100M tokens per day.', tokens: 100e6, pricePerM: 1.2 });
  loaded.flags.unlimited = true;
  const titleOnly = fixtureOffer('Безлимит на 24h', 240);
  titleOnly.id = 'title';
  const separate = fixtureOffer('API ключ', 70);
  separate.id = 'separate';
  const negative = fixtureOffer('100M tokens — no unlimited', 10);
  Object.assign(negative, { id: 'negative', descLoaded: true, tokens: null });
  negative.flags.unlimited = true;
  for (const o of [loaded, titleOnly, separate, negative]) {
    delete o.accessType; delete o.durationMinutes; delete o.pricePerHour;
  }
  const flagsOnly = fixtureOffer('API ключ', 50);
  flagsOnly.id = 'flagsOnly';
  flagsOnly.flags.unlimited = true;
  flagsOnly.tokens = 1e6;
  flagsOnly.pricePerM = 50;
  const negativeUnloaded = fixtureOffer('100M tokens — не безлимит', 10);
  negativeUnloaded.tokens = null;
  negativeUnloaded.flags.unlimited = true;
  delete negativeUnloaded.fields;
  const harness = serverHarness([loaded, titleOnly, separate, negative, flagsOnly, negativeUnloaded], [{ id: 'separate', description: 'Безлимитный доступ на неделю' }]);
  const [a, b, c, d, e, g] = harness.state.offers;
  assert.strictEqual(a.accessType, 'unlimited');
  assert.strictEqual(a.durationMinutes, 60);
  assert.strictEqual(a.pricePerHour, 120);
  assert.strictEqual(a.tokens, null);
  assert.strictEqual(a.pricePerM, null);
  assert.strictEqual(b.durationMinutes, 1440);
  assert.strictEqual(b.pricePerHour, 10);
  assert.strictEqual(c.durationMinutes, 10080);
  assert.strictEqual(c.accessType, 'unlimited');
  assert.strictEqual(d.flags.unlimited, false);
  assert.strictEqual(d.accessType, 'tokens');
  assert.strictEqual(d.tokens, 100e6);
  assert.strictEqual(e.accessType, 'unlimited');
  assert.strictEqual(e.durationMinutes, null);
  assert.strictEqual(e.tokens, null);
  assert.strictEqual(e.pricePerM, null);
  assert.strictEqual(g.accessType, 'tokens');
  assert.strictEqual(g.tokens, 100e6);
  assert.strictEqual(harness.writes, 0);
  normalizeOfferAccess(a);
  assert.strictEqual(a.pricePerM, null);
});

check('GET /api/offers: новые поля, фильтры, сортировка без сети и data/', () => {
  const harness = serverHarness(accessOffers.map((o) => JSON.parse(JSON.stringify(o))));
  function request(query) {
    let headers;
    let payload;
    harness.handleOffers({
      writeHead(status, value) { assert.strictEqual(status, 200); headers = value; },
      end(body) { payload = JSON.parse((headers['Content-Encoding'] === 'gzip' ? zlib.gunzipSync(body) : body).toString()); },
    }, new URL('http://localhost/api/offers?' + query));
    assert.ok(payload);
    return payload;
  }
  const timed = request('offerType=timed&minDuration=60&maxDuration=1440&sort=priceHour');
  assert.deepStrictEqual(timed.items.map((o) => o.id), ['2', '1']);
  assert.strictEqual(timed.items[0].accessType, 'unlimited');
  assert.strictEqual(timed.items[0].durationMinutes, 1440);
  assert.strictEqual(timed.items[0].pricePerHour, 10);
  const excluded = request('offerType=excludeTimed&sort=duration');
  assert.deepStrictEqual(excluded.items.map((o) => o.id), ['6', '3', '4', '5']);
  for (const offer of excluded.items) {
    assert.ok(Object.hasOwn(offer, 'accessType'));
    assert.ok(Object.hasOwn(offer, 'durationMinutes'));
    assert.ok(Object.hasOwn(offer, 'pricePerHour'));
    assert.strictEqual(typeof offer.descriptionPreview, 'string');
    assert.ok(offer.descriptionPreview.length <= 2000);
    assert.strictEqual(offer.pricePerHour, null);
  }
  assert.deepStrictEqual(request('unlimitedOnly=1').items.map((o) => o.id).sort(), ['1', '2', '3']);
  const withoutUnlimited = request('offerType=excludeUnlimited&offersExclude=4');
  assert.deepStrictEqual(withoutUnlimited.items.map((o) => o.id).sort(), ['5', '6']);
  assert.strictEqual(withoutUnlimited.total, 2);
  assert.strictEqual(withoutUnlimited.stats.count, 2);
  const sharedSeller = request('offersExclude=1');
  assert.strictEqual(sharedSeller.total, accessOffers.length - 1);
  assert.ok(sharedSeller.items.every((o) => o.id !== '1'));
  assert.ok(sharedSeller.items.some((o) => o.id === '2'));
  assert.strictEqual(harness.writes, 0);
});

console.log('\nИтог: ' + passed + ' проверок пройдено');
