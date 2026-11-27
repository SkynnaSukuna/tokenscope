'use strict';

const assert = require('assert/strict');
const { ReviewService, parseReviews } = require('../lib/reviews');
const URL = 'https://funpay.com/users/reviews';
const id = '16756744';
const header = total => `<div class="param-item"><div class="rating-value"><span class="big">4.8</span></div><div class="text-mini text-light mb5">${total} отзывов за 1 год</div><div class="reviews-filter"><a data-value="1"><div class="rating1"></div></a><a data-value="5"><div class="rating5"></div></a></div></div>`;
function review(rating, label = 'Отзыв', reply = null, author = null) {
  return `<div class="review-container"><div class="review-item"><div class="review-item-row"><div class="review-compiled-review"><div class="review-item-user"><div class="review-item-photo"><img src="/avatar.png"></div>${author ? `<div class="review-item-name">${author}</div>` : ''}<div class="review-item-rating hidden-xs"><div class="rating"><div class="rating${rating}"></div></div></div><div class="review-item-date">В этом месяце</div><div class="review-item-detail">ChatGPT, 100 ₽</div><div class="review-item-rating visible-xs"><div class="rating"><div class="rating${rating}"></div></div></div></div><div class="review-item-text">${label}</div></div></div>${reply ? `<div class="review-item-row"><div>Ответ продавца</div><div class="review-item-answer review-compiled-reply"><div>${reply}</div></div></div>` : ''}</div></div>`;
}
function page(rows = [], next = '', total = 575, seller = id) {
  return header(total) + (rows.length ? `<div class="dyn-table"><div class="dyn-table-body">${rows.join('')}</div></div><form method="post" class="dyn-table-form" action="${URL}"><input name="user_id" value="${seller}"><input name="continue" value="${next}"><input name="filter" value=""></form><button class="dyn-table-continue ${next ? '' : 'hidden'}">Показать ещё отзывы</button>` : '<p class="pb20">Отсутствуют.</p>');
}
function setup(handler, extra = {}) {
  const calls = [], saved = [];
  const service = new ReviewService({ requestIntervalMs: 0, cooldownMs: 1000, store: { loadJson: () => null, saveJsonDebounced: (name, data) => saved.push({ name, data: JSON.parse(JSON.stringify(data)) }) }, postText: async (url, options) => { const params = new URLSearchParams(options.body); calls.push({ url, options, rating: Number(params.get('filter') || 0), cursor: params.get('continue'), id: params.get('user_id') }); return handler(calls[calls.length - 1]); }, ...extra });
  return { service, calls, saved };
}

async function main() {
  let checks = 0;
  const actual = parseReviews(page([review(2, 'Не &lt;быстро&gt;<br>Совсем', 'Проверили &amp; ответили')]), { sellerId: id, rating: 2 });
  assert.equal(actual.items.length, 1);
  assert.equal(actual.items[0].rating, 2);
  assert.equal(actual.items[0].author, null);
  assert.equal(actual.items[0].date, 'В этом месяце');
  assert.equal(actual.items[0].product, 'ChatGPT, 100 ₽');
  assert.equal(actual.items[0].text, 'Не <быстро>\nСовсем');
  assert.equal(actual.items[0].reply, 'Проверили & ответили');
  assert.equal(actual.total, 575);
  assert.equal(actual.hasMore, false);
  assert.equal(actual.items[0].id.length, 24);
  assert.equal(parseReviews(page([review(1, 'x', null, 'Buyer')]), { sellerId: id, rating: 1 }).items[0].author, 'Buyer');
  checks++;

  for (const html of ['', '<html>captcha</html>', header(575), header(575) + '<div class="dyn-table-body"></div>', page([review(5)]), page([review(1)], '', 575, '999')]) {
    assert.throws(() => parseReviews(html, { sellerId: id, rating: 1 }));
  }
  assert.throws(() => parseReviews(page([review(1)], 'abc='), { sellerId: id, rating: 1, cursor: 'abc=' }));
  assert.equal(parseReviews(page([], '', 115), { sellerId: '4233111', rating: 1 }).empty, true);
  checks++;

  const counts = { 1: 2, 2: 1, 3: 1, 4: 0, 5: 25 };
  const mock = setup(({ rating, cursor }) => {
    if (rating === 5 && cursor) return page([review(5, 'old5')]);
    return page(Array.from({ length: counts[rating] || 0 }, (_, n) => review(rating, `${rating}:${n}`)), rating === 5 ? 'next5=' : '');
  });
  assert.deepEqual(mock.service.summary(id).counts, { 1: null, 2: null, 3: null, 4: null, 5: null });
  mock.service.enqueue([id, id], [1, 2, 3]);
  mock.service.enqueue([id], [1, 2, 3]);
  await mock.service.idle();
  assert.equal(mock.calls.length, 3);
  assert.deepEqual(mock.service.summary(id).checkedRatings, [1, 2, 3]);
  assert.deepEqual(mock.service.summary(id).counts, { 1: 2, 2: 1, 3: 1, 4: null, 5: null });
  assert.equal(mock.service.stats([id]).checkedSellers, 1);
  assert.equal(mock.service.stats([id]).activeRequests, 0);
  assert.equal(mock.saved.at(-1).name, 'reviews.json');
  checks++;

  let result = await mock.service.getPage(id, { sort: 'worst' });
  assert.deepEqual(result.items.map(x => x.rating), [1, 1]);
  assert.equal(result.hasMore, true);
  result = await mock.service.getPage(id, { sort: 'worst', cursor: result.nextCursor });
  assert.deepEqual(result.items.map(x => x.rating), [2]);
  result = await mock.service.getPage(id, { sort: 'worst', cursor: result.nextCursor });
  assert.deepEqual(result.items.map(x => x.rating), [3]);
  result = await mock.service.getPage(id, { sort: 'worst', cursor: result.nextCursor });
  assert.equal(result.items.length, 25);
  assert.ok(result.items.every(x => x.rating === 5));
  assert.equal(result.summary.counts[4], 0);
  assert.equal(result.summary.counts[5], null);
  assert.equal(result.summary.minimumCounts[5], 25);
  assert.equal(result.hasMore, true);
  const continuation = result.nextCursor;
  const beforeBadCursor = mock.calls.length;
  await assert.rejects(() => mock.service.getPage(id, { sort: 'best', cursor: continuation }));
  await assert.rejects(() => mock.service.getPage('999', { sort: 'worst', cursor: continuation }));
  await assert.rejects(() => mock.service.getPage(id, { cursor: continuation.slice(0, -2) + 'xx' }));
  await assert.rejects(() => mock.service.getPage('https://127.0.0.1/', {}));
  assert.equal(mock.calls.length, beforeBadCursor);
  result = await mock.service.getPage(id, { sort: 'worst', cursor: continuation });
  assert.equal(result.hasMore, false);
  assert.equal(result.nextCursor, null);
  assert.equal(result.summary.counts[5], 26);
  assert.equal(mock.calls.at(-1).cursor, 'next5=');
  checks++;

  const clean = setup(() => page([], '', 115));
  clean.service.enqueue(['4233111'], [1, 2, 3]);
  await clean.service.idle();
  assert.deepEqual(clean.service.summary('4233111').counts, { 1: 0, 2: 0, 3: 0, 4: null, 5: null });
  assert.equal(clean.service.stats(['4233111']).checkedSellers, 1);
  checks++;

  const errors = setup(() => { throw new Error('HTTP 429'); });
  errors.service.enqueue([id], [1]);
  await errors.service.idle();
  assert.equal(errors.service.summary(id).counts[1], null);
  assert.equal(errors.service.summary(id).status, 'error');
  assert.equal(errors.service.stats([id], [1]).failedSellers, 1);
  errors.service.enqueue([id], [1]);
  await errors.service.idle();
  assert.equal(errors.calls.length, 1);
  const failedPage = await errors.service.getPage(id, { rating: 1 });
  assert.ok(failedPage.error);
  assert.ok(failedPage.warning);
  assert.equal(failedPage.summary.counts[1], null);
  checks++;

  let now = 10000;
  const expires = setup(() => page([], '', 0), { now: () => now, ttlMs: 100 });
  await expires.service.getPage(id, { rating: 1 });
  assert.equal(expires.service.summary(id).counts[1], 0);
  now += 101;
  assert.equal(expires.service.summary(id).counts[1], null);
  assert.equal(expires.service.summary(id).stale, true);
  assert.equal(expires.service.stats([id], [1]).pendingSellers, 1);
  expires.service.enqueue([id], [1]);
  await expires.service.idle();
  assert.equal(expires.service.summary(id).counts[1], 0);
  assert.equal(expires.service.summary(id).stale, false);
  checks++;

  const newest = setup(({ rating, cursor }) => page([review(5, cursor || 'newest')], cursor ? '' : 'old=', 100));
  const first = await newest.service.getPage(id, { sort: 'newest' });
  assert.equal(first.hasMore, true);
  assert.equal(first.summary.counts[1], null);
  assert.deepEqual(first.summary.checkedRatings, []);
  const cached = await newest.service.getPage(id, { sort: 'newest' });
  assert.equal(cached.items[0].id, first.items[0].id);
  assert.equal(newest.calls.length, 1);
  const second = await newest.service.getPage(id, { sort: 'newest', cursor: first.nextCursor });
  assert.equal(second.hasMore, false);
  assert.notEqual(second.items[0].id, first.items[0].id);
  await newest.service.getPage(id, { sort: 'newest', refresh: true });
  assert.equal(newest.calls.length, 3);
  checks++;

  const mismatch = setup(() => page([review(5)]));
  const bad = await mismatch.service.getPage(id, { rating: 1 });
  assert.ok(bad.error);
  assert.equal(bad.summary.counts[1], null);
  const htmlError = setup(() => '<html><title>Access denied</title></html>');
  htmlError.service.enqueue([id], [1]);
  await htmlError.service.idle();
  assert.equal(htmlError.service.summary(id).counts[1], null);
  assert.equal(htmlError.service.summary(id).status, 'error');
  checks++;

  const restored = new ReviewService({ store: { loadJson: () => clean.saved.at(-1).data }, requestIntervalMs: 0 });
  assert.equal(restored.summary('4233111').counts[1], 0);
  const badCache = new ReviewService({ store: { loadJson: () => ({ version: 1, entries: [{ sellerId: id, ratings: { 1: { count: 0, minimumCount: 0, present: false, checkedAt: Date.now() } } }] }) } });
  assert.equal(badCache.summary(id).counts[1], null);
  checks++;

  const bounded = setup(() => page([], '', 0), { maxQueue: 2 });
  bounded.service.enqueue(['1', '2', '3'], [1, 2, 3]);
  assert.ok(bounded.service.queue.length <= 2);
  await bounded.service.idle();
  assert.ok(bounded.calls.length <= 3);
  checks++;

  let rejectOnce = true;
  const retry = setup(() => { if (rejectOnce) { rejectOnce = false; throw new Error('Temporary upstream error'); } return page([], '', 0); });
  const initialFailure = await retry.service.getPage(id, { rating: 1 });
  assert.ok(initialFailure.error);
  const recovered = await retry.service.getPage(id, { rating: 1, refresh: true });
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.summary.counts[1], 0);
  assert.deepEqual(recovered.summary.errorRatings, []);
  checks++;

  const unrelated = setup(({ rating }) => { if (rating === 5) throw new Error('Only five-star endpoint failed'); return page([], '', 115); });
  await unrelated.service.getPage(id, { rating: 5 });
  unrelated.service.enqueue([id], [1, 2, 3]);
  await unrelated.service.idle();
  assert.deepEqual(unrelated.service.summary(id).errorRatings, [5]);
  assert.equal(unrelated.service.stats([id], [1, 2, 3]).checkedSellers, 1);
  assert.equal(unrelated.service.stats([id], [1, 2, 3]).failedSellers, 0);
  assert.equal(unrelated.service.stats([id], [5]).failedSellers, 1);
  const restoredError = new ReviewService({ store: { loadJson: () => unrelated.saved.at(-1).data } });
  assert.deepEqual(restoredError.summary(id).errorRatings, [5]);
  checks++;

  const recount = setup(() => page([review(5)], '', 100));
  await recount.service._page(id, 5, 'last=', false, 25);
  assert.equal(recount.service.summary(id).counts[5], 26);
  await recount.service._page(id, 5, 'last=', false, 26);
  assert.equal(recount.service.summary(id).counts[5], 27);
  assert.equal(recount.calls.length, 2);
  checks++;

  let tick = 10000;
  const starts = [];
  const polite = setup(() => { starts.push(tick); return page([], '', 0); }, { now: () => tick, requestIntervalMs: 700, sleep: async ms => { tick += ms; } });
  await Promise.all([polite.service.getPage(id, { rating: 1 }), polite.service.getPage(id, { rating: 1 }), polite.service.getPage(id, { rating: 2 })]);
  assert.equal(polite.calls.length, 2);
  assert.equal(starts[1] - starts[0], 700);
  assert.equal(polite.service.activeRequests, 0);
  await assert.rejects(() => polite.service.getPage(id, { cursor: 'garbage' }), error => error.status === 400 && error.code === 'INVALID_CURSOR');
  checks++;

  let attempt = 0;
  const queuedRetry = setup(() => { if (++attempt === 2) throw new Error('Refresh failed'); return page([], '', 0); });
  await queuedRetry.service.getPage(id, { rating: 1 });
  const staleFailure = await queuedRetry.service.getPage(id, { rating: 1, refresh: true });
  assert.ok(staleFailure.error);
  queuedRetry.service.enqueue([id], [1], { retryFailed: true });
  assert.equal(queuedRetry.service.summary(id).counts[1], null);
  await queuedRetry.service.idle();
  assert.equal(queuedRetry.calls.length, 3);
  assert.equal(queuedRetry.service.summary(id).counts[1], 0);
  assert.deepEqual(queuedRetry.service.summary(id).errorRatings, []);
  checks++;

  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const scoped = setup(async () => { await blocked; return page([], '', 0); });
  scoped.service.enqueue(['999'], [1, 2, 3]);
  assert.equal(scoped.service.stats([id], [1, 2, 3]).queued, 0);
  assert.equal(scoped.service.stats([id], [1, 2, 3]).activeRequests, 0);
  assert.equal(scoped.service.stats(['999'], [1, 2, 3]).queued, 2);
  assert.equal(scoped.service.stats(['999'], [1, 2, 3]).activeRequests, 1);
  release();
  await scoped.service.idle();
  assert.equal(scoped.service.stats(['999'], [1, 2, 3]).checkedSellers, 1);
  checks++;

  console.log(`reviews-selftest: ${checks} groups passed (HTML, absence, global sorting, queue, cache, expiry, errors, signed cursors)`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
