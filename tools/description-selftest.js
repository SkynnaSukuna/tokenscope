'use strict';

// Standalone, dependency-free checks: node tools/description-selftest.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const api = require('../public/description.js');

let passed = 0;
let assertions = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}
function same(actual, expected, message) {
  assertions++;
  assert.deepEqual(actual, expected, message);
}
function ok(value, message) {
  assertions++;
  assert.ok(value, message);
}

function decode(text) {
  // One decoding pass, just as HTML parsing does. &amp;lt; remains literal &lt;.
  return text.replace(/&(amp|lt|gt|quot|#39|#13);/g, (_, name) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#13': '\r'
  }[name]));
}
function inspect(text, renderer = api.render) {
  const html = renderer(text);
  const marks = [];
  const unwrapped = html.replace(/<mark class="desc-highlight desc-(positive|negative|neutral)" title="([^"<>]*)">([^<]*)<\/mark>/g,
    (_, kind, title, phrase) => {
      marks.push({ kind, text: decode(phrase), title: decode(title) });
      return phrase;
    });
  // For this strictly limited generated HTML grammar these checks plus one entity
  // decoding pass are equivalent to the parsed element's textContent. In particular,
  // no untrusted opening/closing tag or attribute can survive as actual markup.
  ok(!/[<>]/.test(unwrapped), 'only the exact, non-nested mark markup may be emitted');
  ok(!/&(?!amp;|lt;|gt;|quot;|#39;|#13;)/.test(unwrapped), 'all ampersands must be escaped');
  same(decode(unwrapped), text == null ? '' : String(text), 'exact textContent roundtrip');
  return { html, marks };
}
function phrases(text, expected) {
  const result = inspect(text);
  same(result.marks.map(({ kind, text: phrase }) => [kind, phrase]), expected, text);
  return result;
}
function only(kind, list) {
  for (const text of list) phrases(text, [[kind, text]]);
}

check('CommonJS and browser classic-script APIs agree', () => {
  same(Object.keys(api), ['render']);
  same(typeof api.render, 'function');
  const context = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/description.js'), 'utf8'), context);
  same(Object.keys(context.window.TokenRadarDescription), ['render']);
  const sample = 'Автоматическая выдача. Возврат не предусмотрен. Срок действия 30 дней. Бонус 10%.';
  const common = inspect(sample);
  const browser = inspect(sample, context.window.TokenRadarDescription.render);
  same(browser.html, common.html);
  same(common.marks.map(({ kind, text }) => [kind, text]), [
    ['positive', 'Автоматическая выдача'],
    ['negative', 'Возврат не предусмотрен'],
    ['neutral', 'Срок действия 30 дней'],
    ['positive', 'Бонус 10%']
  ]);
  for (let i = 0; i < 5; i++) same(api.render(sample), common.html, 'regex state must reset between renders');
});

check('explicit positive seller statements in Russian and English', () => {
  only('positive', [
    'Гарантия возврата средств', 'Гарантируем замену', 'Гарантированная замена',
    'Возврат гарантирован', 'Возврат гарантируем', 'Замена предусмотрена',
    'Refunds guaranteed', 'replacement is guaranteed', 'guaranteed refund',
    'Гарантия', 'guarantee', 'БОНУС 10%', 'bonus', 'bonuses',
    'Автовыдача', 'Авто выдача', 'Мгновенная доставка', 'instant delivery', 'auto delivery',
    'Без ограничений', 'без суточных лимитов', 'без лимита', 'no limits',
    'Личный аккаунт', 'Персональный ключ', 'Личная учётная запись', 'private API key', 'personal account',
    'Без срока действия', 'Бессрочный', 'без комиссии', 'no expiry', 'no commission', 'does not expire'
  ]);
  const warranty = inspect('Гарантия').marks[0];
  ok(/заявление продавца/iu.test(warranty.title), 'a standalone guarantee must explicitly say seller statement');
  ok(/не провер|не подтвержд|а не подтвержд/iu.test(warranty.title), 'do not present claims as verified');
});

check('full negative constructions beat positive fragments', () => {
  only('negative', [
    'Без возврата', 'без гарантии возврата', 'Возврат не предусмотрен', 'Возврат денег не осуществляется',
    'Гарантии нет', 'Гарантий не даём', 'не гарантируем возврат', 'Деньги не возвращаются',
    'Никаких гарантий', 'Гарантия не распространяется', 'отсутствие гарантии',
    'No refunds', 'no guarantee', 'no refunds or support', 'refunds are not guaranteed',
    'guarantee not available', "don't provide refunds", 'support is not included', 'Без поддержки',
    'Поддержка не предоставляется', 'Безлимит не предоставляется', 'не безлимит',
    'безлимитный доступ не предусмотрен', 'not unlimited', 'unlimited access is not available',
    'без ограничений нет', 'не без ограничений', 'без лимитов нет'
  ]);
  phrases('No refunds. Replacement guaranteed. Гарантии нет. Бонус 10%.', [
    ['negative', 'No refunds'], ['positive', 'Replacement guaranteed'],
    ['negative', 'Гарантии нет'], ['positive', 'Бонус 10%']
  ]);
  phrases('Без возврата и гарантии. Гарантия возврата.', [
    ['negative', 'Без возврата и гарантии'], ['positive', 'Гарантия возврата']
  ]);
});

check('negated bonuses and other negated fragments stay uncolored', () => {
  for (const text of [
    'бонусов нет', 'Без бонусов', 'Бонусы не начисляются', 'Бонус не гарантирован',
    'no bonus', 'bonus not included', 'not a personal account', 'не личный аккаунт',
    'no instant delivery', 'instant delivery is not available', 'не гарантия',
    'не требуется VPN', 'VPN не требуется', 'not a shared account', 'no risk of bans',
    'без суточных ограничений нет', 'нет никаких гарантий'
  ]) phrases(text, []);
});

check('quantified and time restrictions, shared accounts, VPN, wait and risks', () => {
  only('negative', [
    'Лимит: 100 токенов', 'Суточный лимит 100 токенов', 'daily limit: 100 tokens',
    '100 запросов в день', '50K tokens/day', '20 requests per 24 hours',
    'не более 500 токенов', 'up to 50 requests per day', '100 tokens maximum',
    'Дневной лимит', 'request limits', 'лимит времени', 'лимит 30 дней', 'limited to 2 days',
    'Общий аккаунт', 'Общая учётная запись', 'shared accounts', 'Требуется VPN',
    'VPN обязателен', 'mandatory VPN', 'VPN is required', 'Ручная активация', 'manual activation',
    'Активация вручную', 'Ожидание до 24 часов', 'wait up to 2 hours',
    'Риск блокировки', 'риск бана', 'Ключ может быть отозван', 'Отзыв ключа',
    'key revocation', 'risk of bans', 'key may be revoked',
    '1 токен = 1 человек', '1 token = 1 person'
  ]);
});

check('unlimited is neutral; definite periods and quantities need explicit context', () => {
  only('neutral', [
    'Безлимит', 'безлимитный доступ', 'неограниченный доступ', 'Unlimited access', 'unmetered',
    'Срок действия 30 дней', 'Доступ на 7 дней', 'Подписка на 1 месяц',
    'valid for 30 days', 'subscription for 1 month', 'valid until 2027-01-31',
    'действителен до 31.01.2027', '1 000 000 токенов', '1.5M tokens',
    '1 кредит = 1000 токенов', '10 credits → 1M tokens', '250 credits'
  ]);
  for (const text of ['30 дней', 'Ответ в течение 2 часов', 'Стаж 10 лет', 'лучший выгодный надёжный premium']) {
    phrases(text, []);
  }
  phrases('Гарантия 30 дней. Доступ на 7 дней. Лимит: 100 токенов.', [
    ['positive', 'Гарантия'], ['neutral', 'Доступ на 7 дней'], ['negative', 'Лимит: 100 токенов']
  ]);
});

check('model counts, cache conditions, accounting formulas and balance locations are neutral', () => {
  only('neutral', [
    '43 модели', '43 моделей', 'более 40 моделей', 'моделей: 43', 'models: 43',
    '43 models', 'more than 40 models', 'up to 100 models', 'не более 43 моделей', 'не менее 40 моделей',
    'кэш', 'кеш', 'кэширование', 'кеширование', 'кэшерование', 'кешерование',
    'Кэшированный вход', 'кешированный вход', 'cached input', 'cache hit', 'cache hits', 'caching',
    'кэшированный вход — 50 % стоимости', 'cache hit: 50%',
    'Вход + выход', 'вход+выход', 'input + output', 'input and output',
    '(input + output) × множитель', '(input + output) * multiplier', '(input + output) × multiplier 2',
    '(вход + выход) × 1,5', 'input + output x 2', 'input + output × multiplier',
    'Учёт: вход + выход с множителем 2', 'списывается вход + выход',
    'input tokens + output tokens', 'входящие токены + исходящие токены',
    'Остаток виден на странице ключа', 'Баланс в кабинете',
    'Проверьте баланс в личном кабинете', 'Остаток можно посмотреть на странице API ключа',
    'Balance is shown on the API key page', 'Check the balance in the dashboard',
    'remaining credits on the key page', 'В кабинете отображается баланс',
    'Остаток средств виден на странице ключа', 'Баланс смотрите в вашем личном кабинете',
    'Balance can be checked in your dashboard', 'На странице ключа можно посмотреть остаток'
  ]);
  phrases('43 моделей. Вход + выход, кэшированный вход — за половину. Остаток виден на странице ключа.', [
    ['neutral', '43 моделей'], ['neutral', 'Вход + выход'],
    ['positive', 'кэшированный вход — за половину'], ['neutral', 'Остаток виден на странице ключа']
  ]);
});

check('only explicit savings turn green; contextual cache rates keep their meaning', () => {
  only('positive', [
    'кэшерование - 50 %', 'кеширование -50%', 'кэш: −50%', 'cached input: -50%',
    'cache hit - 50 %', 'кэшированный вход — за половину', 'кешированный вход вдвое дешевле',
    'cached input at half price', 'cache hit: 50% off', 'cached input is half price',
    'Кэшированный вход — половина стоимости',
    'Скидка 50 %', 'скидка -50%', 'скидка на 50%', 'discount: 50 %',
    '50% скидки', '50 % discount', '50% off', 'на 50 % дешевле',
    'вдвое дешевле', 'за половину стоимости', 'половина цены', 'half price', '50% cheaper'
  ]);
  for (const text of [
    '43', '50 %', '-50%', 'половина', 'за половину', 'вдвое', 'half',
    'Половина страницы готова, осталось 43 пункта и 50 % текста.',
    'input', 'output', 'множитель 2', '43modelsExtra', '43 модельных года',
    'баланс', 'Остаток виден', 'на странице ключа', 'в личном кабинете'
  ]) phrases(text, []);
});

check('cache and discount absence plus extra charges are explicitly red', () => {
  only('negative', [
    'Без кеша', 'без кэширования', 'Кэшерования нет', 'Кеширование отсутствует',
    'Кэширование не поддерживается', 'Кэшированный вход не учитывается',
    'Кеширование -50% не поддерживается', 'Не применяется скидка 50%',
    'нет скидки 50 %', 'скидка -50% отсутствует', 'Скидки нет', 'Без скидки',
    'no caching', 'without cached input', 'cached input is not supported',
    'cache hit unavailable', 'cached input -50% is not supported',
    'no discount 50%', 'discount 50% is not available', 'no cache hit discount 50%',
    'input is not cached', 'Вход не кэшируется', 'не кешируется',
    'Дополнительные списания', 'дополнительное списание 10%', 'дополнительно списывается 50 %',
    'Повторное списание', 'additional charges', 'extra fees: 10%', 'charged extra',
    'Дополнительная комиссия', 'Кэширование отключено', 'Скидка 50% не действует',
    'Скидки за кэш нет', 'нет скидки 50% на cached input', 'discount for cached input unavailable',
    'Без 50% скидки', 'no 50 % discount', '50% off is not available',
    'Кэшированный вход — за половину не поддерживается'
  ]);
});

check('negations and conflicts cannot leak green discounts or false red charges', () => {
  for (const text of [
    'Не без кэша', 'not without caching', 'no additional charges', 'without extra fees',
    'Без дополнительных списаний', 'Никаких дополнительных списаний', 'дополнительных списаний нет',
    'Дополнительные списания не производятся', 'Не взимается дополнительная комиссия',
    'Дополнительная комиссия не взимается', 'additional charges do not apply',
    'extra fees are not applied', 'Отсутствие дополнительных списаний',
    'скидка 50% не гарантирована', 'not a 50% discount', 'не вдвое дешевле',
    'не за половину стоимости', 'Не скидки за кэш нет',
    'Кэширование не гарантируется', 'Скидка 50% не обещается',
    'Баланс не виден на странице ключа', 'Остаток виден не на странице ключа',
    'не input + output', '43 models are not available'
  ]) phrases(text, []);
  phrases('нет скидки на 50% дешевле', [['negative', 'нет скидки на 50%']]);
  phrases('Без кэширования. Скидка 50%. Учёт: (input + output) × 2. Баланс в кабинете.', [
    ['negative', 'Без кэширования'], ['positive', 'Скидка 50%'],
    ['neutral', 'Учёт: (input + output) × 2'], ['neutral', 'Баланс в кабинете']
  ]);
  phrases('Кэширование -50% не поддерживается; кэшированный вход — за половину. Дополнительных списаний нет.', [
    ['negative', 'Кэширование -50% не поддерживается'], ['positive', 'кэшированный вход — за половину']
  ]);
  phrases('No cache hit discount 50%. Cached input -50%. No extra fees. 43 models.', [
    ['negative', 'No cache hit discount 50%'], ['positive', 'Cached input -50%'], ['neutral', '43 models']
  ]);
});

check('Unicode boundaries, exact casing and original whitespace', () => {
  for (const text of [
    'супергарантия', 'ультрабонус', 'антиguarantee', 'guaranteeship', 'бонусник',
    'bonusЯ', 'яbonus', 'bonus_foo', 'bonus42', 'bonus\u0301', '\u{10400}bonus',
    'неограниченныйдоступ', 'instant\ndelivery'
  ]) phrases(text, []);
  phrases('🎁Бонус\u00a010% — INSTANT\tdelivery! Неограниченный доступ.', [
    ['positive', 'Бонус\u00a010%'], ['positive', 'INSTANT\tdelivery'], ['neutral', 'Неограниченный доступ']
  ]);
  phrases('«гарантия» и (bonus).', [['positive', 'гарантия'], ['positive', 'bonus']]);
  phrases('21 токен = 1 человек', [['neutral', '21 токен']]);
  phrases('1 token = 1000 tokens', [['neutral', '1 token'], ['neutral', '1000 tokens']]);
});

check('XSS payloads, entity-looking strings and CRLF roundtrip exactly', () => {
  const attacks = [
    '<img src=x onerror=alert(1)> Бонус 10%',
    '</mark><script>alert("guarantee")</script>',
    '<svg/onload=alert(1)> no refunds',
    '</mark><img src=x onerror="alert(1)">43 моделей & кэшерование - 50 %',
    '<svg onload="alert(1)">(input + output) × множитель</svg> Баланс в кабинете',
    '&lt;mark&gt; cached input -50% &amp; discount 50% is not available',
    '" title="<script>" Кэшированный вход — за половину. Остаток виден на странице ключа.',
    '" onmouseover="alert(1)" & \' autofocus> private account',
    '&lt;script&gt; &amp; &#13; &#x3c; &#0; &unknown;',
    '  \tБонус 10%\r\nВозврат не предусмотрен\n\n💬 <b>100 tokens</b>\r ',
    '<mark class="desc-negative" title="unsafe">guarantee</mark>'
  ];
  for (const input of attacks) {
    const { html } = inspect(input);
    ok(!/<(?:script|img|svg|b)\b/iu.test(html), 'input HTML must remain escaped text');
    ok(!/<mark[^>]*(?:onload|onerror|onmouseover|autofocus)\s*=/iu.test(html), 'no input becomes an attribute');
  }
  inspect('');
  inspect(null);
  inspect(undefined);
  inspect(123);
  let seed = 0x12345678;
  const chunks = ['Бонус', 'not ', '<', '>', '&', '"', "'", '\r', '\n', '\t', 'я', 'bonus', ' guarantee ', '😀', '&lt;'];
  chunks.push('43 моделей', ' кэшерование - 50 % ', ' (input + output) × множитель ', ' no caching ', ' баланс в кабинете ', '50 %', ' половина ');
  for (let caseIndex = 0; caseIndex < 80; caseIndex++) {
    let input = '';
    for (let j = 0; j < 60; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      input += chunks[seed % chunks.length];
    }
    inspect(input);
  }
});

check('phrases stay local, do not nest, and work is bounded on large descriptions', () => {
  const paragraph = ('Обычное описание товара. ').repeat(20) + 'Возврат не предусмотрен. ' + ('Подробности покупки. ').repeat(20);
  const local = inspect(paragraph);
  same(local.marks.map(({ text }) => text), ['Возврат не предусмотрен']);
  for (const mark of local.marks) ok(mark.text.length <= 160 && !/[\r\n]/.test(mark.text));
  const many = inspect(('guarantee. ').repeat(700));
  same(many.marks.length, 512, 'mark count cap');
  const pastScanCap = inspect('x'.repeat(65536) + '\nБонус 10% <script>');
  same(pastScanCap.marks.length, 0, 'the unscanned suffix must still be escaped and preserved');
  const start = performance.now();
  const dense = inspect(('bonus ').repeat(12000));
  same(dense.marks.length, 0, 'candidate cap safely falls back to escaped text');
  const hostile = inspect('9'.repeat(150000) + '<script>\r\n' + 'x'.repeat(1500000));
  same(hostile.marks.length, 0);
  const cacheDense = inspect(('кэширование ').repeat(12000));
  same(cacheDense.marks.length, 0, 'new cache rules share the bounded candidate storage');
  const longNearMiss = inspect(('кэшир' + 'я'.repeat(40) + ' input + скидка        --999999999999999999% ').repeat(1800));
  same(longNearMiss.marks.length, 0, 'long near-matches must not invent claims');
  const crossingCap = inspect(' '.repeat(65528) + '(input + output) × multiplier');
  same(crossingCap.marks.length, 0, 'a new formula cannot cross the scan boundary');
  const boundedClaims = inspect(('43 моделей. Кэшерование - 50 %. Учёт: (input + output) × 2. Баланс в кабинете. ').repeat(400));
  same(boundedClaims.marks.length, 512, 'new rules share the mark cap');
  for (const mark of boundedClaims.marks) ok(mark.text.length <= 160 && !/[\r\n]/.test(mark.text));
  const elapsed = performance.now() - start;
  ok(elapsed < 5000, 'bounded scans and escaping should take under 5 seconds, took ' + elapsed.toFixed(1) + 'ms');
  console.log('      large-input checks: ' + elapsed.toFixed(1) + 'ms');
});

console.log('\n' + passed + ' groups passed; ' + assertions + ' assertions.');
