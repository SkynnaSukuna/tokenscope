'use strict';

// node tools/billing-selftest.js — без сервера, браузера, сети и записи data/.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { detectInputOutput } = require('../lib/billing');
const { buildOffer, parseLotsPage, parseOfferPage, normalizeOfferAccess, applyDescription } = require('../lib/parser');
const { Enricher } = require('../lib/enrich');
const { parseFilters, applyFilters, computeStats } = require('../lib/filter');

let passed = 0;
let examples = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS  ' + name);
  } catch (err) {
    process.exitCode = 1;
    console.error('FAIL  ' + name + '\n' + err.stack);
  }
}

function fixture(id, title = '1M tokens', description = '') {
  const offer = buildOffer({
    id: String(id), titleHtml: title, fields: {}, price: Number(id) || 10,
    sellerId: String(id), sellerName: 'Seller ' + id, stars: 5, reviews: 10,
    age: '2 года', auto: false, online: false,
  }, '4506');
  if (description) applyDescription(offer, { description, fields: {}, seller: {} });
  return offer;
}

function page(description, fields = {}) {
  return { description, fields, seller: {} };
}

function filters(query) {
  return parseFilters(new URLSearchParams(query));
}

// Исполняем обработчики настоящего server.js с полностью заглушенными I/O.
// listen не вызывает callback, поэтому refresh и периодические задачи не идут.
function serverHarness(cachedOffers, descriptions = []) {
  let writes = 0;
  const reviewRequests = [];
  class FakeEnricher {
    constructor(options) { this.onDone = options.onDone; this.cache = new Map(); }
    hydrate(records) { for (const record of records) this.cache.set(record.id, record); }
    get(id) { return this.cache.get(id); }
    has(id) { return this.cache.has(id); }
    get count() { return this.cache.size; }
    enqueue(offers) { return offers.length; }
    stats() { return { cached: this.count }; }
    complete(offer, value) { this.onDone(offer, value); }
  }
  class FakeReviews {
    summary() { return { checkedRatings: [1], counts: { 1: 0 } }; }
    enqueue(ids, ratings) { reviewRequests.push({ ids, ratings }); }
    stats() { return {}; }
  }
  const fakeStore = {
    loadJson(name, fallback) { return name === 'cache.json' ? { offers: cachedOffers, updatedAt: 1 } : fallback; },
    loadJsonl() { return descriptions; },
    saveJson() { throw new Error('unexpected disk write'); },
    saveJsonDebounced() { writes++; },
  };
  const context = {
    require(id) {
      if (id === 'http') return { createServer() { return { listen() {} }; } };
      if (id === './lib/store') return fakeStore;
      if (id === './lib/enrich') return { Enricher: FakeEnricher };
      if (id === './lib/reviews') return { ReviewService: FakeReviews };
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
  const result = vm.runInNewContext(source + '\n;({ state, enricher, publicOffer, handleOffers, handleOffer });', context, { filename: 'server.js' });
  return { ...result, reviewRequests, get writes() { return writes; } };
}

async function request(handler, query) {
  let headers;
  let payload;
  await handler({
    writeHead(status, value) { assert.equal(status, 200); headers = value; },
    end(body) { payload = JSON.parse((headers['Content-Encoding'] === 'gzip' ? zlib.gunzipSync(body) : body).toString()); },
  }, new URL('http://localhost/api/offers?' + query));
  assert.ok(payload, 'handler did not return JSON');
  return payload;
}

async function main() {
  await check('детектор: формула, языки, знаки и необязательный множитель', () => {
    const yes = [
      'input+output', 'INPUT + OUTPUT', '(input + output) × множитель',
      '(input + output) x 2', '(input+output)*1.5', '(input+output) х 0,5',
      'input + output × factor', 'input+output x multiplier', 'input+outputx2',
      '2 * (input + output)', 'вход+выход', 'ВХОД + ВЫХОД х коэффициент',
      '(вход + выход) × два', 'вход+выходх2', 'вход плюс выход',
      'input tokens + output tokens', 'входящие токены + исходящие токены',
      'Входящие + исходящие токены', 'Входные токены + выходные токены',
      'Вход + выход, кэшированный вход — за половину. Остаток виден на странице ключа.',
      'Списание: вход + выход, кэшированный вход не учитывается',
      'Charges: input + output, cached input is not counted',
      'Не требует подписки. (input + output) × 2',
      'Списание: (input + output), без комиссии',
      'Поддерживается списание (input + output) × 2',
      'выход + вход', 'input　＋　output', 'input +\noutput', 'вход\n+\nвыход',
      '(input + output) × 1,5. 43 модели. Кэшерование - 50 %. Остаток виден на странице ключа.',
    ];
    for (const text of yes) {
      examples++;
      assert.equal(detectInputOutput(text), true, text);
    }
  });

  await check('детектор: суммирование словами только в контексте списания/учёта', () => {
    const yes = [
      'Списание: вход и выход', 'При списании учитываются вход и выход',
      'Вход и выход учитываются вместе', 'Сумма входа и выхода токенов',
      'УЧЁТ: входящих и исходящих токенов',
      'Тарификация за входные и выходные токены',
      'Входящие токены и исходящие токены списываются с баланса',
      'Bill calculated using input and output', 'Both input and output are counted',
      'Расход = вход & выход', 'Списание:\nвход и выход',
    ];
    for (const text of yes) {
      examples++;
      assert.equal(detectInputOutput(text), true, text);
    }
  });

  await check('детектор: неизвестное, перечни возможностей и отдельные тарифы', () => {
    const no = [
      '', null, undefined, 'API ключ с балансом', 'Остаток виден на странице ключа.',
      'Только выход, вход не учитывается', 'input and output', 'вход и выход',
      'Поддерживает input + output, streaming, tools',
      'Возможности: вход + выход, кэширование, reasoning',
      'Supports input+output, tools and streaming', 'Input + output features',
      'Возможности:\ninput+output, streaming, tools',
      'Возможности: входящие и исходящие токены',
      'Списание отдельно. Возможности: вход и выход',
      'Учёт включён\nВозможности: input and output',
      'Тарифы: input $1, output $2', 'input/output', 'вход / выход',
      'input-only + output-only models', 'myinput+output', 'input+outputting',
      'Вход в кабинет и выход из кабинета', 'Учитывается только output',
    ];
    for (const text of no) {
      examples++;
      assert.equal(detectInputOutput(text), false, String(text));
    }
  });

  await check('детектор: отрицания формулы и исключение одной стороны', () => {
    const no = [
      'Списание не по формуле (input + output) × множитель',
      'Не по формуле вход+выход', 'Не используем формулу (input + output)*2',
      'Не путайте с формулой input + output', 'Не (input + output)',
      'Без input + output', 'not (input + output)',
      '(input+output) x2 не применяется', 'input + output не используется',
      'Списание (вход + выход), вход не учитывается',
      'Списание (input + output), input is not counted',
      'input + output — only output is charged, input not billed',
      'Вход и выход не учитываются', 'Не учитываются вход и выход',
      'Спишем input + output, без учета входа',
      'Not billed as (input + output) * 2', 'В отличие от input+output, только выход',
      'Instead of input+output charge only output', 'Не по формуле:\ninput+output',
      'Списание не как input+output', 'No formula input+output',
      'input+output не является формулой', '(input + output) × 2 не поддерживается',
    ];
    for (const text of no) {
      examples++;
      assert.equal(detectInputOutput(text), false, text);
    }
    assert.equal(detectInputOutput('Не по формуле input+output. Списание по формуле вход+выход.'), true);
  });

  await check('parser: заголовок и поля проходят через buildOffer и parseLotsPage', () => {
    assert.equal(fixture('1', '1M tokens (input + output) × 2').flags.inputOutput, true);
    const field = fixture('2');
    field.fields.billing = 'Вход + выход, кэшированный вход — за половину';
    normalizeOfferAccess(field);
    assert.equal(field.flags.inputOutput, true);
    field.fields = { 'Списание': 'Вход и выход' };
    normalizeOfferAccess(field);
    assert.equal(field.flags.inputOutput, true, 'название поля сохраняет контекст учёта');
    const html = '<a class="tc-item" href="https://funpay.com/lots/offer?id=777" data-user="7">' +
      '<div class="tc-desc-text">1M tokens (input + output) x 2</div>' +
      '<div class="tc-price" data-s="10"></div><div class="media-user-name">Seller</div></a>';
    const [offer] = parseLotsPage(html, '4506');
    assert.equal(offer.flags.inputOutput, true);
    assert.equal(offer.tokens, 1e6);
    assert.equal(fixture('3').flags.inputOutput, false);
  });

  await check('parser: enrichment, повторный расчёт и сохранённые поля описания', () => {
    const offer = fixture('1');
    applyDescription(offer, parseOfferPage('<div class="offer-description">Вход + выход, кэшированный вход — за половину. Остаток виден на странице ключа.</div>'));
    assert.equal(offer.descLoaded, true);
    assert.equal(offer.flags.inputOutput, true);
    normalizeOfferAccess(offer);
    assert.equal(offer.flags.inputOutput, true);
    applyDescription(offer, page('Не по формуле (input+output), только выход, вход не учитывается'));
    assert.equal(offer.flags.inputOutput, false, 'старый true должен пересчитываться');
    const metadata = fixture('2');
    applyDescription(metadata, page('', { 'Списание': 'Вход и выход' }));
    assert.equal(metadata.flags.inputOutput, true);
    normalizeOfferAccess(metadata);
    assert.equal(metadata.flags.inputOutput, true, 'поле accessDetails сохраняет контекст после enrichment');
    const restored = JSON.parse(JSON.stringify(metadata));
    delete restored.flags.inputOutput;
    normalizeOfferAccess(restored);
    assert.equal(restored.flags.inputOutput, true);
  });

  await check('enrich: cached fetchNow вызывает тот же applyDescription без сети', async () => {
    const offer = fixture('1');
    const enricher = new Enricher({ onDone: applyDescription });
    enricher.hydrate([{ id: offer.id, description: 'Списание: вход и выход', fetchedAt: 1 }]);
    await enricher.fetchNow(offer);
    assert.equal(offer.flags.inputOutput, true);
    assert.equal(offer.descLoaded, true);
    assert.equal(enricher.loaded, 0, 'кэш не требует fetch');
  });

  await check('enrich: свежая страница и description record нормализуются без I/O', async () => {
    let fetches = 0;
    const records = [];
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'enrich.js'), 'utf8');
    const context = {
      module: { exports: {} }, process: { env: {} },
      require(id) {
        if (id === './parser') return require('../lib/parser');
        if (id === './net') return {
          async fetchText() { fetches++; return '<div class="offer-description">(input + output) × multiplier</div>'; },
          async sleep() { throw new Error('unexpected wait'); },
        };
        throw new Error('unexpected dependency ' + id);
      },
    };
    vm.runInNewContext(source, context, { filename: 'lib/enrich.js' });
    const offer = fixture('1');
    const enricher = new context.module.exports.Enricher({
      minInterval: 0, onDone: applyDescription,
      store: { appendJsonl(name, value) { assert.equal(name, 'descriptions.jsonl'); records.push(value); } },
    });
    await enricher.run(offer);
    assert.equal(fetches, 1);
    assert.equal(records.length, 1);
    assert.equal(offer.flags.inputOutput, true);
    const reload = fixture('1');
    applyDescription(reload, page(records[0].description));
    assert.equal(reload.flags.inputOutput, true);
  });

  await check('parseFilters: значения API и сериализация query/JSON', () => {
    for (const inputOutput of ['any', 'only', 'exclude']) {
      const query = new URLSearchParams({ inputOutput, cat: '4506', page: '2' }).toString();
      const parsed = filters(query);
      assert.equal(parsed.inputOutput, inputOutput);
      assert.equal(JSON.parse(JSON.stringify(parsed)).inputOutput, inputOutput);
      assert.deepEqual(parsed.cats, ['4506']);
    }
    for (const inputOutput of ['', 'invalid', 'ONLY', '1', 'true', 'yes', ' only ', 'exclude,only', 'null']) {
      assert.equal(filters(new URLSearchParams({ inputOutput })).inputOutput, 'any', inputOutput);
    }
    assert.equal(filters('').inputOutput, 'any');
  });

  await check('фильтры: only/exclude, неизвестные и совместимость с другими фильтрами', () => {
    const offers = [fixture('1', '1M tokens', 'input + output'), fixture('2'), fixture('3', '1M tokens', 'Только выход, вход не учитывается')];
    const legacyUnknown = fixture('4');
    delete legacyUnknown.flags.inputOutput;
    offers.push(legacyUnknown);
    assert.deepEqual(applyFilters(offers, filters('inputOutput=only')).map((o) => o.id), ['1']);
    assert.deepEqual(applyFilters(offers, filters('inputOutput=exclude')).map((o) => o.id), ['2', '3', '4']);
    assert.equal(applyFilters(offers, filters('inputOutput=any')).length, 4);
    assert.equal(applyFilters(offers, filters('inputOutput=bad')).length, 4);
    assert.equal(applyFilters(offers, filters('inputOutput=only&minLotPrice=2')).length, 0);
    const f = filters('inputOutput=only');
    const selected = applyFilters(offers, f);
    assert.equal(computeStats(selected, f).count, 1);
    assert.equal(computeStats(selected, f).totalTokens, 1e6);
  });

  await check('server: миграция старого cache/store и отдельного description cache', () => {
    const inOffer = fixture('1');
    Object.assign(inOffer, { descLoaded: true, description: 'Вход + выход, кэшированный вход — за половину.' });
    const separate = fixture('2');
    const title = fixture('3', '1M tokens (input+output)*2');
    const stale = fixture('4');
    stale.flags.inputOutput = true;
    const unknown = fixture('5');
    const storedFields = fixture('6');
    storedFields.accessDetails = 'Учёт: входящие и исходящие токены';
    const cached = [inOffer, separate, title, stale, unknown, storedFields];
    for (const offer of cached) if (offer !== stale) delete offer.flags.inputOutput;
    delete unknown.flags;
    const harness = serverHarness(cached, [{ id: '2', description: '(input + output) x multiplier' }]);
    assert.deepEqual(Array.from(harness.state.offers, (o) => o.flags.inputOutput), [true, true, true, false, false, true]);
    assert.equal(harness.writes, 0, 'гидратация не пишет data/');
    const target = harness.state.byId.get('5');
    harness.enricher.complete({ ...target }, page('При списании учитываются вход и выход'));
    assert.equal(target.flags.inputOutput, true, 'onDone обновляет актуальный offer в state');
    assert.equal(harness.writes, 2, 'сохранения только заглушены');
  });

  await check('API: flags boolean, фильтр до stats/пагинации, детали и review candidates', async () => {
    const offers = Array.from({ length: 25 }, (_, i) => fixture(String(i + 1), '1M tokens', i < 13 ? '(input + output) × множитель' : 'Схема списания не указана'));
    const harness = serverHarness(offers);
    const only = await request(harness.handleOffers, 'inputOutput=only&page=2&pageSize=10&sort=price');
    assert.equal(only.total, 13);
    assert.equal(only.pages, 2);
    assert.equal(only.items.length, 3);
    assert.equal(only.stats.count, 13);
    assert.equal(only.stats.totalTokens, 13e6);
    assert.ok(only.items.every((o) => o.flags.inputOutput === true));
    const exclude = await request(harness.handleOffers, 'inputOutput=exclude&page=2&pageSize=10');
    assert.equal(exclude.total, 12);
    assert.equal(exclude.items.length, 2);
    assert.equal(exclude.stats.count, 12);
    assert.ok(exclude.items.every((o) => o.flags.inputOutput === false));
    const invalid = await request(harness.handleOffers, 'inputOutput=wat');
    assert.equal(invalid.total, 25);
    assert.ok(invalid.items.every((o) => typeof o.flags.inputOutput === 'boolean'));
    const detail = await request(harness.handleOffer, 'id=1');
    assert.equal(detail.offer.flags.inputOutput, true);
    assert.equal(detail.flags.inputOutput, true);
    await request(harness.handleOffers, 'inputOutput=only&noReviewStars=1');
    assert.deepEqual(Array.from(harness.reviewRequests[0].ids), offers.slice(0, 13).map((o) => o.seller.id));
    assert.equal(harness.writes, 0);
  });

  console.log('\nИтог: ' + passed + ' проверок, ' + examples + ' примеров детектора; ' + (process.exitCode ? 'есть ошибки' : 'все пройдены'));
}

main().catch((err) => { console.error(err.stack); process.exitCode = 1; });
