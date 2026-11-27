'use strict';

const crypto = require('crypto');
const { UA, sleep } = require('./net');
const REVIEW_URL = 'https://funpay.com/users/reviews';
const STARS = [1, 2, 3, 4, 5];
const TTL = 30 * 60 * 1000;

function inputError(message) {
  const error = new Error(message);
  error.code = 'INVALID_CURSOR';
  error.status = 400;
  error.statusCode = 400;
  return error;
}
function sellerId(value) {
  const id = String(value == null ? '' : value);
  if (!/^[1-9]\d{0,14}$/.test(id)) throw inputError('Некорректный ID продавца');
  return id;
}
function decode(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', ndash: '–', mdash: '—' };
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] || all;
    const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}
function htmlTree(html) {
  if (typeof html !== 'string' || html.length > 4 * 1024 * 1024) throw new Error('Некорректный размер HTML отзывов');
  const root = { tag: '', attrs: {}, children: [] }, stack = [root];
  const tokens = html.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][^>]*>|[^<]+/gi) || [];
  for (const token of tokens) {
    if (/^<!/.test(token)) continue;
    if (token[0] !== '<') { stack[stack.length - 1].children.push(token); continue; }
    const tag = /^<\/?([a-z0-9]+)/i.exec(token)?.[1].toLowerCase();
    if (!tag) continue;
    if (token[1] === '/') {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    const attrs = {};
    for (const m of token.slice(tag.length + 1).matchAll(/([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
    const node = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tag) && !/\/\s*>$/.test(token)) stack.push(node);
  }
  return root;
}
function all(node, predicate) {
  const out = [], pending = [node];
  while (pending.length) {
    const next = pending.pop();
    if (typeof next === 'string') continue;
    if (predicate(next)) out.push(next);
    for (let i = next.children.length - 1; i >= 0; i--) pending.push(next.children[i]);
  }
  return out;
}
function hasClass(node, name) { return (node.attrs.class || '').split(/\s+/).includes(name); }
function byClass(node, name) { return all(node, n => hasClass(n, name)); }
function text(node) {
  function raw(n) {
    if (!n) return '';
    if (typeof n === 'string') return n;
    if (/^(script|style)$/.test(n.tag)) return '';
    if (n.tag === 'br') return '\n';
    return n.children.map(raw).join('') + (/^(div|p|li)$/.test(n.tag) ? '\n' : '');
  }
  return decode(raw(node)).replace(/\r/g, '').replace(/[\t \u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function continuation(value) {
  value = String(value || '');
  if (value === '0') return '';
  if (!/^[A-Za-z0-9+/=]{0,200}$/.test(value)) throw new Error('Некорректный курсор FunPay');
  return value;
}

// Exact counts are obtained only from an exhausted, server-filtered bucket.
// CSS histogram percentages and the current 25 rows never prove absence.
function parseReviews(html, { sellerId: id, rating = 0, cursor = '' } = {}) {
  const root = htmlTree(html);
  const filters = byClass(root, 'reviews-filter');
  const totalNode = all(root, n => hasClass(n, 'text-mini') && /\d[\d\s]*\s+отзыв/.test(text(n)))[0];
  const totalMatch = totalNode && text(totalNode).match(/([\d\s]+)\s+отзыв/);
  const total = totalMatch ? Number(totalMatch[1].replace(/\s/g, '')) : null;
  const empty = all(root, n => n.tag === 'p' && hasClass(n, 'pb20') && text(n) === 'Отсутствуют.').length > 0;
  const bodies = byClass(root, 'dyn-table-body');
  const containers = bodies.flatMap(n => byClass(n, 'review-container'));
  const forms = all(root, n => n.tag === 'form' && hasClass(n, 'dyn-table-form'));
  let next = '';
  if (!filters.length || !Number.isSafeInteger(total) || total < 0 || !byClass(root, 'rating-value').length) throw new Error('FunPay вернул нераспознанную страницу отзывов');
  if (containers.length) {
    if (forms.length !== 1) throw new Error('На странице отзывов отсутствует форма пагинации');
    const inputs = all(forms[0], n => n.tag === 'input');
    const remoteId = inputs.find(n => n.attrs.name === 'user_id')?.attrs.value;
    const nextInput = inputs.find(n => n.attrs.name === 'continue');
    if (remoteId !== String(id) || !nextInput || !/\/users\/reviews\/?$/.test(forms[0].attrs.action || '')) throw new Error('Несовпадение продавца или формы отзывов');
    next = continuation(nextInput.attrs.value);
    if (next && next === cursor) throw new Error('FunPay повторил курсор пагинации');
  } else if (!empty || forms.length || bodies.length) {
    throw new Error('Пустой ответ не подтверждает отсутствие отзывов');
  }
  const items = containers.map((container, index) => {
    const review = byClass(container, 'review-compiled-review')[0];
    if (!review) throw new Error('Не распознана структура отзыва');
    const ratingBlock = byClass(review, 'review-item-rating')[0];
    const r = ratingBlock && all(ratingBlock, n => /^rating[1-5]$/.test(n.attrs.class || ''))[0];
    const stars = r ? Number(r.attrs.class.slice(-1)) : null;
    const body = byClass(review, 'review-item-text')[0];
    if (!stars || !body || (rating && rating !== stars)) throw new Error('FunPay не применил фильтр оценки');
    const authorNode = byClass(review, 'review-item-name')[0] || byClass(review, 'review-item-username')[0];
    const result = { rating: stars, author: authorNode ? text(authorNode) : null, date: text(byClass(review, 'review-item-date')[0]) || null, text: text(body), reply: text(byClass(container, 'review-compiled-reply')[0] || byClass(container, 'review-item-answer')[0]) || null, product: text(byClass(review, 'review-item-detail')[0]) || null };
    // Public HTML has no review/order ID; this is an opaque synthetic page-item key.
    result.id = crypto.createHash('sha256').update(JSON.stringify([String(id), cursor, index, result])).digest('hex').slice(0, 24);
    return result;
  });
  return { items, next, hasMore: !!next, total, empty };
}

async function defaultPostText(url, { body, headers }) {
  const res = await fetch(url, { method: 'POST', body, headers, redirect: 'error', signal: AbortSignal.timeout(25000) });
  if (!res.ok) {
    const error = new Error(`FunPay: HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  if (!/text\/html/i.test(res.headers.get('content-type') || '')) throw new Error('FunPay вернул не HTML');
  return res.text();
}

class ReviewService {
  constructor(options = {}) {
    this.store = options.store || null;
    this.postText = options.postText || defaultPostText;
    this.ttlMs = options.ttlMs ?? TTL;
    this.requestIntervalMs = options.requestIntervalMs ?? 700;
    this.cooldownMs = options.cooldownMs ?? 60000;
    this.maxQueue = options.maxQueue ?? 4000;
    this.maxSellers = options.maxSellers ?? 2000;
    this.maxPages = options.maxPages ?? 200;
    this.now = options.now || Date.now;
    this.sleep = options.sleep || sleep;
    this.entries = new Map();
    this.pages = new Map();
    this.inflight = new Map();
    this.queue = [];
    this.pending = new Set();
    this.activeRequests = 0;
    this.secret = crypto.randomBytes(32);
    this.requestTail = Promise.resolve();
    this.lastRequestAt = -Infinity;
    this.worker = null;
    const saved = this.store?.loadJson?.('reviews.json', null);
    if (saved?.version === 1 && Array.isArray(saved.entries)) {
      for (const row of saved.entries.slice(-this.maxSellers)) {
        try {
          const id = sellerId(row?.sellerId);
          if (!row.ratings || typeof row.ratings !== 'object') continue;
          const entry = { sellerId: id, ratings: {}, errors: {}, total: Number.isSafeInteger(row.total) && row.total >= 0 ? row.total : null, totalUpdatedAt: Number(row.totalUpdatedAt) || 0 };
          for (const r of STARS) {
            const value = row.ratings[r];
            if (value && Number.isFinite(value.checkedAt) && (value.count === null || (Number.isSafeInteger(value.count) && value.count >= 0)) && Number.isSafeInteger(value.minimumCount) && value.minimumCount >= 0 && typeof value.present === 'boolean' && (value.count !== 0 || (value.complete === true && value.minimumCount === 0 && !value.present))) entry.ratings[r] = value;
          }
          for (const r of [0, ...STARS]) {
            const failure = row.errors?.[r];
            if (failure && Number.isFinite(failure.at) && typeof failure.message === 'string') entry.errors[r] = { at: failure.at, message: failure.message.slice(0, 500) };
          }
          this.entries.set(id, entry);
        } catch { /* Ignore malformed persisted cache, never turn it into zero. */ }
      }
    }
  }
  _entry(id) {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { sellerId: id, ratings: {}, errors: {}, total: null, totalUpdatedAt: 0 };
      this.entries.set(id, entry);
      while (this.entries.size > this.maxSellers) this.entries.delete(this.entries.keys().next().value);
    }
    return entry;
  }
  _save() { this.store?.saveJsonDebounced?.('reviews.json', { version: 1, entries: [...this.entries.values()] }); }
  summary(value) {
    const id = sellerId(value), entry = this.entries.get(id), now = this.now();
    const counts = Object.fromEntries(STARS.map(r => [r, null]));
    const minimumCounts = Object.fromEntries(STARS.map(r => [r, 0]));
    const checkedRatings = [], presentRatings = [], staleRatings = [];
    let updatedAt = null;
    for (const r of STARS) {
      const bucket = entry?.ratings[r];
      if (!bucket) continue;
      updatedAt = Math.max(updatedAt || 0, bucket.checkedAt);
      if (now - bucket.checkedAt > this.ttlMs) { staleRatings.push(r); continue; }
      checkedRatings.push(r);
      counts[r] = bucket.count;
      minimumCounts[r] = bucket.minimumCount;
      if (bucket.present) presentRatings.push(r);
    }
    const errors = Object.values(entry?.errors || {});
    const errorRatings = Object.keys(entry?.errors || {}).map(Number).sort((a, b) => a - b);
    const error = errors.length ? errors.sort((a, b) => b.at - a.at)[0].message : null;
    return { sellerId: id, counts, checkedRatings, presentRatings, minimumCounts, total: entry?.total ?? null, updatedAt, stale: staleRatings.length > 0, staleRatings, error, errorRatings, status: error ? 'error' : staleRatings.length ? 'stale' : checkedRatings.length ? 'ready' : 'unknown' };
  }
  stats(ids = [], ratings = [1, 2, 3]) {
    const selected = [...new Set(ratings.map(Number).filter(r => STARS.includes(r)))];
    let checkedSellers = 0, pendingSellers = 0, failedSellers = 0;
    const scope = new Set(ids.map(String));
    for (const id of scope) {
      const summary = this.summary(id);
      const failed = summary.errorRatings.some(r => selected.includes(r));
      if (selected.every(r => summary.checkedRatings.includes(r)) && !failed) checkedSellers++;
      else if (failed) failedSellers++;
      else pendingSellers++;
    }
    const queued = this.queue.filter(job => scope.has(job.id) && selected.includes(job.rating)).length;
    const pending = [...this.pending].filter(key => {
      const [id, rating] = key.split(':');
      return scope.has(id) && selected.includes(Number(rating));
    }).length;
    return { checkedSellers, pendingSellers, failedSellers, queued, activeRequests: Math.max(0, pending - queued) };
  }
  enqueue(ids, ratings = [1, 2, 3], { retryFailed = false } = {}) {
    const selected = [...new Set(ratings.map(Number).filter(r => STARS.includes(r)))];
    let invalidated = false;
    for (const value of ids) {
      let id; try { id = sellerId(value); } catch { continue; }
      for (const r of selected) {
        const key = `${id}:${r}`;
        let failure = this.entries.get(id)?.errors[r];
        if (this.queue.length >= this.maxQueue) break;
        if (retryFailed && failure) {
          const entry = this.entries.get(id);
          delete entry.errors[r];
          delete entry.ratings[r];
          for (const pageKey of this.pages.keys()) {
            const cached = JSON.parse(pageKey);
            if (cached[0] === id && cached[1] === r) this.pages.delete(pageKey);
          }
          failure = null;
          invalidated = true;
        }
        const summary = this.summary(id);
        if (this.pending.has(key) || (summary.checkedRatings.includes(r) && !failure) || (failure && this.now() - failure.at < this.cooldownMs)) continue;
        this.pending.add(key);
        this.queue.push({ id, rating: r, key });
      }
    }
    if (invalidated) this._save();
    if (!this.worker && this.queue.length) {
      this.worker = this._drain().finally(() => { this.worker = null; });
    }
    return { queued: this.queue.length, activeRequests: this.activeRequests };
  }
  async _drain() {
    while (this.queue.length) {
      const job = this.queue.shift();
      try { await this._page(job.id, job.rating, '', false, 0); } catch { /* Error state is exposed by summary. */ }
      finally { this.pending.delete(job.key); }
    }
  }
  async idle() { while (this.worker) await this.worker; await this.requestTail; }
  _limited(operation) {
    const execute = async () => {
      const pause = this.requestIntervalMs - (this.now() - this.lastRequestAt);
      if (pause > 0) await this.sleep(pause);
      this.lastRequestAt = this.now();
      this.activeRequests++;
      try { return await operation(); } finally { this.activeRequests--; }
    };
    const work = this.requestTail.then(execute, execute);
    this.requestTail = work.catch(() => {});
    return work;
  }
  async _page(id, rating, nativeCursor, refresh, seen) {
    // Bind continuation cache entries to the traversed prefix length as well.
    // A refreshed first page may reach the same native token with a new count.
    const key = JSON.stringify([id, rating, nativeCursor, seen]);
    const cached = this.pages.get(key);
    if (!refresh && cached && this.now() - cached.updatedAt <= this.ttlMs) return cached.page;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const failure = this.entries.get(id)?.errors[rating];
    if (!refresh && failure && this.now() - failure.at < this.cooldownMs) throw new Error(failure.message);
    const work = this._limited(async () => {
      try {
        const body = new URLSearchParams({ user_id: id, continue: nativeCursor, filter: rating ? String(rating) : '' }).toString();
        const html = await this.postText(REVIEW_URL, { body, headers: { 'User-Agent': UA, Accept: 'text/html, */*; q=0.01', 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', Origin: 'https://funpay.com', Referer: `https://funpay.com/users/${id}/` } });
        const page = parseReviews(html, { sellerId: id, rating, cursor: nativeCursor });
        if (nativeCursor && !page.items.length) throw new Error('История изменилась: обновите отзывы с первой страницы');
        const entry = this._entry(id), now = this.now();
        entry.total = page.total;
        entry.totalUpdatedAt = now;
        delete entry.errors[rating];
        if (rating) {
          const minimumCount = seen + page.items.length;
          entry.ratings[rating] = { count: page.hasMore ? null : minimumCount, minimumCount, present: minimumCount > 0, complete: !page.hasMore, checkedAt: now };
        }
        this.pages.set(key, { page, updatedAt: now });
        while (this.pages.size > this.maxPages) this.pages.delete(this.pages.keys().next().value);
        this._save();
        return page;
      } catch (error) {
        const entry = this._entry(id);
        entry.errors[rating] = { at: this.now(), message: error.message || 'Не удалось загрузить отзывы' };
        this._save();
        throw error;
      }
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }
  _encode(data) {
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    const signature = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }
  _decode(value, id, sort, rating) {
    if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw inputError('Некорректный курсор отзывов');
    const [payload, signature] = value.split('.');
    const expected = crypto.createHmac('sha256', this.secret).update(payload).digest('base64url');
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw inputError('Курсор отзывов устарел или повреждён');
    let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw inputError('Некорректные данные курсора'); }
    if (data.v !== 1 || data.id !== id || data.sort !== sort || data.rating !== rating || !STARS.concat(0).includes(data.bucket) || !Number.isSafeInteger(data.seen) || data.seen < 0 || data.seen > 10000000 || !Number.isFinite(data.at) || this.now() - data.at > this.ttlMs) throw inputError('Курсор не соответствует запросу или устарел');
    try { data.cont = continuation(data.cont); } catch { throw inputError('Некорректный внутренний курсор'); }
    return data;
  }
  async getPage(value, options = {}) {
    const id = sellerId(value), sort = options.sort ?? 'worst', rating = Number(options.rating ?? 0);
    if (!['worst', 'best', 'newest'].includes(sort) || !Number.isInteger(rating) || rating < 0 || rating > 5) throw inputError('Некорректный фильтр отзывов');
    const buckets = rating ? [rating] : sort === 'worst' ? STARS : sort === 'best' ? [...STARS].reverse() : [0];
    const state = options.cursor ? this._decode(options.cursor, id, sort, rating) : { v: 1, id, sort, rating, bucket: buckets[0], cont: '', seen: 0, at: this.now() };
    if (!buckets.includes(state.bucket)) throw inputError('Некорректная группа оценок в курсоре');
    let bucketIndex = buckets.indexOf(state.bucket);
    try {
      for (; bucketIndex < buckets.length; bucketIndex++) {
        const bucket = buckets[bucketIndex];
        const page = await this._page(id, bucket, state.cont, !!options.refresh, state.seen);
        const nextBucket = page.hasMore ? bucket : buckets[bucketIndex + 1];
        const hasMore = nextBucket !== undefined;
        const nextState = hasMore ? { v: 1, id, sort, rating, bucket: nextBucket, cont: page.hasMore ? page.next : '', seen: page.hasMore ? state.seen + page.items.length : 0, at: state.at } : null;
        if (page.items.length || !hasMore) return { sellerId: id, items: page.items, summary: this.summary(id), hasMore, nextCursor: nextState ? this._encode(nextState) : null };
        state.cont = '';
        state.seen = 0;
      }
    } catch (error) {
      return { sellerId: id, items: [], summary: this.summary(id), hasMore: false, nextCursor: null, error: error.message || 'Не удалось загрузить отзывы', warning: 'Отсутствие отзывов не подтверждено. Повторите запрос позже.' };
    }
  }
}

module.exports = { ReviewService, parseReviews };
