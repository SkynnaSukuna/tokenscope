'use strict';

// Standalone, dependency-free checks: node tools/review-highlights-selftest.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const api = require('../public/review-highlights.js');

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
  // One HTML entity decoding pass; entity-looking input remains literal text.
  return text.replace(/&(amp|lt|gt|quot|#39|#13);/g, (_, name) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#13': '\r'
  }[name]));
}
function inspect(value, renderer = api.render) {
  const text = value == null ? '' : String(value);
  const html = renderer(value);
  const marks = [];
  const unwrapped = html.replace(/<mark class="review-mark review-(positive|negative)" title="([^"<>]*)">([^<]*)<\/mark>/g,
    (_, kind, title, phrase) => {
      marks.push({ kind, text: decode(phrase), title: decode(title) });
      return phrase;
    });
  // This exact generated grammar allows no input tag, attribute or nested mark.
  ok(!/[<>]/.test(unwrapped), 'only the exact generated mark grammar may be emitted');
  ok(!/&(?!amp;|lt;|gt;|quot;|#39;|#13;)/.test(unwrapped), 'all input ampersands are escaped');
  same(decode(unwrapped), text, 'exact textContent roundtrip, including CRLF and entities');
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

check('CommonJS, browser and global standalone APIs agree', () => {
  same(Object.keys(api), ['render', 'analyze']);
  same(typeof api.render, 'function');
  same(typeof api.analyze, 'function');
  const source = fs.readFileSync(path.join(__dirname, '../public/review-highlights.js'), 'utf8');
  const browser = vm.createContext({ window: {} });
  vm.runInContext(source, browser);
  same(Object.keys(browser.window.TokenRadarReviewHighlights), ['render', 'analyze']);
  const global = vm.createContext({});
  vm.runInContext(source, global);
  same(typeof global.TokenRadarReviewHighlights.render, 'function');
  const sample = 'Быстро, всё работает. Не рекомендую: не вернул деньги. Fast, not a scam.';
  const expected = inspect(sample);
  same(inspect(sample, browser.window.TokenRadarReviewHighlights.render).html, expected.html);
  same(inspect(sample, global.TokenRadarReviewHighlights.render).html, expected.html);
  for (let i = 0; i < 8; i++) {
    same(api.render(sample), expected.html, 'global regex state must reset');
    same(JSON.stringify(browser.window.TokenRadarReviewHighlights.analyze(sample)), JSON.stringify(api.analyze(sample)));
  }
});

check('Russian praise and common grammatical forms', () => {
  only('positive', [
    'быстро', 'БЫСТРО', 'всё работает', 'Все работает', 'рекомендую', 'помог',
    'помогла', 'помогли', 'вернул деньги', 'вернула деньги', 'вернули средства', 'без обмана'
  ]);
  phrases('Всё работает — помог! Вернул деньги; рекомендую, без обмана.', [
    ['positive', 'Всё работает'], ['positive', 'помог'], ['positive', 'Вернул деньги'],
    ['positive', 'рекомендую'], ['positive', 'без обмана']
  ]);
});

check('Russian complaints include complete negative constructions', () => {
  only('negative', [
    'не работает', 'Не рекомендую', 'обман', 'обманул', 'мошенник', 'мошенники',
    'мошенница', 'заблокирован', 'заблокирована', 'заблокированы', 'не вернул деньги',
    'не вернула деньги', 'не вернули средства', 'не отвечает', 'не отвечают',
    'перестал работать', 'перестала работать', 'медленно', 'не советую'
  ]);
});

check('English praise and refund wording', () => {
  only('positive', [
    'fast', 'FAST', 'quickly', 'everything works', 'all works', 'everything is working',
    'works fine', 'worked well', 'works perfectly', 'recommend', 'recommended', 'helped',
    'returned money', 'returned the money', 'refunded', 'refunded my money',
    'money returned', 'my money was refunded', 'got my money back', 'received the money back',
    'without deception', 'no deception'
  ]);
});

check('English complaints, contractions and negative refunds', () => {
  only('negative', [
    'does not work', "doesn't work", 'doesn’t work', 'not working', 'is not working',
    "isn't working", 'do not recommend', "don't recommend", 'would not recommend',
    'cannot recommend', "can't recommend", 'not recommended', 'scam', 'scammer',
    'scammed', 'scammers', 'fraud', 'blocked', 'banned', 'did not return money',
    "didn't return my money", 'has not refunded the money', 'not refunded',
    'has not been refunded', "hasn't been refunded", 'will not be refunded',
    'money was not returned', 'my money has not been refunded', 'no refund',
    'does not respond', "doesn't reply", 'not responding', 'no response', 'no reply',
    'stopped working', 'slow', 'slowly'
  ]);
});

check('Mixed reviews preserve local praise and complaints in source order', () => {
  phrases('Сначала быстро, но перестал работать. Helped once, now does not respond. Не рекомендую.', [
    ['positive', 'быстро'], ['negative', 'перестал работать'], ['positive', 'Helped'],
    ['negative', 'does not respond'], ['negative', 'Не рекомендую']
  ]);
  phrases('Не вернул деньги, хотя помог. Всё работает, но медленно. Fast but blocked.', [
    ['negative', 'Не вернул деньги'], ['positive', 'помог'], ['positive', 'Всё работает'],
    ['negative', 'медленно'], ['positive', 'Fast'], ['negative', 'blocked']
  ]);
  phrases('без обмана. Не обманул, без проблем всё работает. Not a scam, no problems: fast.', [
    ['positive', 'без обмана'], ['positive', 'всё работает'], ['positive', 'fast']
  ]);
});

check('Negation suppresses positive fragments and denied complaints', () => {
  for (const text of [
    'не быстро', 'не помог', 'не помогла', 'не всё работает', 'не без обмана',
    'не очень быстро', 'не особо помог', 'не всегда быстро', 'не обманул', 'не обман', 'не мошенник',
    'не заблокирован', 'не был заблокирован', 'не было обмана', 'не медленно', 'не перестал работать', 'без проблем',
    'not fast', 'not really fast', 'not helped', 'never helped', "hasn't helped",
    'not everything works', 'not a scam', 'NOT A SCAM', 'not an actual scam', 'not a complete scam',
    'not a scammer', 'no scam', 'without fraud', 'not blocked', 'has not been scammed', 'not slow',
    "didn't actually recommend", 'not going to recommend',
    'no problems', 'not recommendedness'
  ]) phrases(text, []);
  phrases('не быстро; быстро. Не помог, но вернул деньги. Not fast! Quickly.', [
    ['positive', 'быстро'], ['positive', 'вернул деньги'], ['positive', 'Quickly']
  ]);
  phrases('не вернул деньги; не рекомендую; never refunded money; do not recommend.', [
    ['negative', 'не вернул деньги'], ['negative', 'не рекомендую'],
    ['negative', 'never refunded money'], ['negative', 'do not recommend']
  ]);
});

check('Unicode word boundaries, exact casing and whitespace', () => {
  for (const text of [
    'сверхбыстро', 'помогатор', 'обманчивый', 'антимошенник', 'заблокированность',
    'breakfast', 'fastest', 'scamper', 'recommendedness', 'helped42', 'scam_foo',
    'яfast', 'fastЯ', 'fast\u0301', '\u{10400}fast', 'all\nworks', 'всё\nработает'
  ]) phrases(text, []);
  phrases('😀БЫСТРО, «рекомендую». Всё\u00a0работает; НЕ\tВЕРНУЛ\u202fДЕНЬГИ.', [
    ['positive', 'БЫСТРО'], ['positive', 'рекомендую'], ['positive', 'Всё\u00a0работает'],
    ['negative', 'НЕ\tВЕРНУЛ\u202fДЕНЬГИ']
  ]);
  phrases('не\nбыстро. not\r\nfast.', [['positive', 'быстро'], ['positive', 'fast']]);
  phrases('не. быстро; not: fast.', [['positive', 'быстро'], ['positive', 'fast']]);
  phrases('не         быстро; not         fast', [['positive', 'быстро'], ['positive', 'fast']]);
});

check('Neutral titles describe the heuristic, never verified facts', () => {
  const { marks } = inspect('Быстро. Обман.');
  same(marks.length, 2);
  for (const mark of marks) {
    ok(/автора отзыва/u.test(mark.title), 'attribute the wording to the review author');
    ok(/Эвристическое выделение/u.test(mark.title), 'explain that the highlight is a heuristic');
    ok(/достоверность не проверена/u.test(mark.title), 'do not attest to the complaint or praise');
    ok(!/доказан|подтверждён|продавец мошенник/iu.test(mark.title));
  }
});

check('XSS, HTML, entities, quotes and CRLF stay literal text', () => {
  const attacks = [
    '<img src=x onerror=alert(1)> быстро',
    '</mark><script>alert("scam")</script>',
    '<svg/onload=alert(1)> не работает',
    '" onmouseover="alert(1)" & \' autofocus> helped',
    '<mark class="review-mark review-positive" title="unsafe">обман</mark>',
    '&lt;script&gt; &amp; &#13; &#x3c; &#0; &unknown; fast',
    '  \tБыстро\r\nне отвечает\n\n💬 <b>helped</b>\r ',
    '<!-- scam --><a href="javascript:alert(1)">рекомендую</a>'
  ];
  for (const text of attacks) {
    const { html } = inspect(text);
    ok(!/<(?:script|img|svg|b|a)\b/iu.test(html), 'input HTML remains escaped text');
    ok(!/<mark[^>]*(?:onload|onerror|onmouseover|autofocus|href)\s*=/iu.test(html), 'input cannot become attributes');
  }
  same(api.render('&<>"\'\r'), '&amp;&lt;&gt;&quot;&#39;&#13;');
  for (const value of ['', null, undefined, 123, false, { toString: () => 'быстро <ok>' }]) inspect(value);
  let seed = 0x12345678;
  const chunks = ['быстро', 'not ', '<', '>', '&', '"', "'", '\r', '\n', '\t', 'я', 'fast', ' scam ', '😀', '&lt;', 'не '];
  for (let caseIndex = 0; caseIndex < 100; caseIndex++) {
    let text = '';
    for (let j = 0; j < 70; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += chunks[seed % chunks.length];
    }
    inspect(text);
  }
});

check('Analyze returns fresh nonoverlapping exact UTF-16 source ranges', () => {
  const text = '😀 Быстро! Не вернул деньги, но helped. Без обмана.';
  const matches = api.analyze(text);
  same(matches.map(({ kind, text: phrase }) => [kind, phrase]), [
    ['positive', 'Быстро'], ['negative', 'Не вернул деньги'], ['positive', 'helped'], ['positive', 'Без обмана']
  ]);
  let cursor = 0;
  for (const match of matches) {
    same(Object.keys(match), ['start', 'end', 'kind', 'text', 'title']);
    ok(Number.isInteger(match.start) && Number.isInteger(match.end));
    ok(match.start >= cursor && match.end > match.start, 'ranges are ordered and cannot overlap');
    same(text.slice(match.start, match.end), match.text);
    ok(match.text.length <= 160 && !/[\r\n]/.test(match.text));
    cursor = match.end;
  }
  same(matches[0].start, 3, 'offsets use UTF-16, including surrogate pairs');
  same(inspect(text).marks, matches.map(({ kind, text: phrase, title }) => ({ kind, text: phrase, title })));
  matches[0].kind = 'changed';
  same(api.analyze(text)[0].kind, 'positive', 'callers cannot modify subsequent results');
  same(api.analyze(null), []);
  same(api.analyze(undefined), []);
});

check('Caps bound scanning, phrase width, candidates and emitted marks', () => {
  const many = inspect(('fast. ').repeat(700));
  same(many.marks.length, 512, 'generated mark cap');
  same(api.analyze(('fast. ').repeat(700)).length, 512, 'analysis and rendering share a cap');
  const long = 'x'.repeat(65536) + '\nбыстро <script> не работает';
  same(inspect(long).marks, [], 'unscanned suffix is still escaped and preserved');
  same(inspect('x'.repeat(65531) + ' fast').marks.map(({ text }) => text), ['fast'], 'phrase ending at scan cap is allowed');
  same(inspect('x'.repeat(65532) + ' fast').marks, [], 'phrase crossing scan cap stays plain');
  const paragraph = ('Обычный отзыв. ').repeat(20) + 'не отвечает. ' + ('Подробности покупки. ').repeat(20);
  same(inspect(paragraph).marks.map(({ text }) => text), ['не отвечает']);
  const start = performance.now();
  same(inspect(('fast ').repeat(12000)).marks, [], 'candidate cap falls back to escaped plain text');
  const hostile = 'н'.repeat(150000) + '<script>\r\n' + 'x'.repeat(1500000);
  same(inspect(hostile).marks, []);
  const spaces = 'не' + ' '.repeat(150000) + 'быстро <img>';
  same(inspect(spaces).marks, [], 'unbounded spacing cannot trigger regex backtracking');
  const elapsed = performance.now() - start;
  ok(elapsed < 5000, 'bounded checks should take under 5 seconds, took ' + elapsed.toFixed(1) + 'ms');
  console.log('      large-input checks: ' + elapsed.toFixed(1) + 'ms');
});

console.log('\n' + passed + ' groups passed; ' + assertions + ' assertions.');
