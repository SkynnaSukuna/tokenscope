'use strict';
const assert = require('node:assert/strict');
const { buildOffer } = require('../lib/parser');
const { parseFilters, applyFilters, sortOffers, computeStats } = require('../lib/filter');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS ' + name); }
const offers = [
  ['known-zero', 5, 900, 100], ['known-one', 5, 1200, 80], ['known-two', 5, 800, 70],
  ['unknown', 5, 0, 60], ['stale', 5, 1400, 50], ['error', 5, 1500, 40],
  ['unproven', 5, 0, 30], ['all-zero', 0, 0, 20], ['known-three', 3, 50, 10],
].map(([id, stars, reviews, price]) => buildOffer({ id, titleHtml: '10 млн токенов DeepSeek', price, sellerId: id, sellerName: id, stars, reviews, fields: { model: 'deepseek' } }, '4506'));
const summaries = {
  'known-zero': { counts: {1: 0, 2: 0, 3: 1}, checkedRatings: [1, 2, 3] },
  'known-one': { counts: {1: null, 2: 0, 3: 0}, minimumCounts: {1:25}, presentRatings: [1], checkedRatings: [1,2,3] },
  'known-two': { counts: {1: 0, 2: 2, 3: 0}, checkedRatings: [1,2,3] },
  stale: { counts: {1:0,2:0,3:0}, checkedRatings:[1,2,3], stale:true },
  error: { counts: {1:0,2:0,3:0}, checkedRatings:[1,2,3], error:'HTTP 429' },
  unproven: { counts: {1:0,2:0,3:0}, checkedRatings:[] },
  'all-zero': { counts: {1:0,2:0,3:0}, checkedRatings:[1,2,3] },
  'known-three': { counts: {1:1,2:1,3:0}, checkedRatings:[1,2,3] },
};
const options = {reviewSummaryFor: id => summaries[id] || null};
const f = query => parseFilters(new URLSearchParams(query));
const ids = (query, opts=options) => applyFilters(offers, f(query), opts).map(o=>o.id).sort();
check('noReviewStars: только разрешённые оценки, без дубликатов и частичных чисел', () => {
  assert.deepEqual(f('noReviewStars=3,1,1,2,0,4,5,2oops,-1,NaN').noReviewStars, [1,2,3]);
  assert.deepEqual(f('').noReviewStars, []);
});
check('без фильтра проверка не скрывает предложения', () => assert.equal(ids('').length, offers.length));
check('без 1★ допускает только доказанный ноль, даже при рейтинге 5★', () => assert.deepEqual(ids('noReviewStars=1'), ['all-zero','known-two','known-zero']));
check('без 2★ работает независимо от 1★', () => assert.deepEqual(ids('noReviewStars=2'), ['all-zero','known-one','known-zero']));
check('без 3★ работает независимо от 1★ и 2★', () => assert.deepEqual(ids('noReviewStars=3'), ['all-zero','known-one','known-three','known-two']));
check('несколько флажков пересекаются', () => assert.deepEqual(ids('noReviewStars=1,2'), ['all-zero','known-zero']));
check('без 1–3★: неизвестные/ошибки/просрочка/непроверенные нули исключены', () => assert.deepEqual(ids('noReviewStars=1,2,3'), ['all-zero']));
check('нет поставщика проверок — никто не проходит строгий фильтр', () => assert.deepEqual(ids('noReviewStars=1', {}), []));
check('совместимость с точным объёмом и минимумом отзывов', () => {
  assert.deepEqual(ids('noReviewStars=1,2&need=10000000&minReviews=100'), ['known-zero']);
  assert.deepEqual(ids('noReviewStars=1&need=5000000'), []);
});
check('статистика и планы рассчитаны после проверки отзывов', () => {
  const filters = f('noReviewStars=1,2&need=10000000');
  const stats = computeStats(applyFilters(offers, filters, options), filters);
  assert.equal(stats.count, 2);
  assert.equal(stats.needPlans.length, 2);
  assert.ok(stats.needPlans.every(p=>['all-zero','known-zero'].includes(p.id) && p.units===1));
});
check('скрытые предложения и продавцы сохраняются', () => {
  assert.deepEqual(ids('noReviewStars=1,2&offersExclude=known-zero'), ['all-zero']);
  assert.deepEqual(ids('noReviewStars=1,2&sellersExclude=all-zero'), ['known-zero']);
});
check('добавлена сортировка по числу отзывов по возрастанию', () => {
  const sorted = sortOffers([...offers], f('sort=reviewsAsc'));
  assert.equal(sorted[0].seller.reviews, 0);
  assert.ok(sorted.every((o,i)=>!i || sorted[i-1].seller.reviews<=o.seller.reviews));
});
check('рейтинг по возрастанию: неизвестные оценки идут после известных', () => {
  const sorted = sortOffers([...offers], f('sort=starsAsc'));
  assert.equal(sorted[0].seller.stars, 3);
  assert.equal(sorted.at(-1).seller.stars, 0);
});
check('просрочка или ошибка другой оценки не отменяют свежий нужный ноль', () => {
  const other = {reviewSummaryFor:()=>({counts:{1:0,2:null},checkedRatings:[1],stale:true,staleRatings:[2],error:'ошибка 3★',errorRatings:[3]})};
  assert.equal(ids('noReviewStars=1',other).length,offers.length);
  assert.equal(ids('noReviewStars=2',other).length,0);
  assert.equal(ids('noReviewStars=3',other).length,0);
});
console.log('\n' + passed + '/' + passed + ' проверок фильтров отзывов пройдено');
