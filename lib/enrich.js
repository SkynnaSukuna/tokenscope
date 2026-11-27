'use strict';

const { fetchText, sleep } = require('./net');
const { parseOfferPage, applyDescription } = require('./parser');

const DESC_FILE = 'descriptions.jsonl';

class Enricher {
  constructor({ concurrency = 1, minInterval = 1200, onDone = null, store = null } = {}) {
    this.cache = new Map(); // id -> {id, description, fetchedAt}
    this.queue = [];
    this.queued = new Set();
    this.active = 0;
    this.concurrency = concurrency;
    this.minInterval = minInterval;
    this.nextAt = 0;
    this.onDone = onDone || (() => {});
    this.store = store;
    this.errors = 0;
    this.last429 = 0;
    this.loaded = 0;
  }

  hydrate(records) {
    for (const r of records) {
      if (r && r.id && !this.cache.has(r.id)) this.cache.set(r.id, r);
    }
  }

  has(id) {
    return this.cache.has(id);
  }

  get(id) {
    return this.cache.get(id);
  }

  get count() {
    return this.cache.size;
  }

  async gate() {
    const wait = Math.max(0, this.nextAt - Date.now());
    if (wait > 0) await sleep(wait);
    this.nextAt = Date.now() + this.minInterval;
  }

  enqueue(offers) {
    const list = [];
    for (const o of offers) {
      if (!o || this.cache.has(o.id) || this.queued.has(o.id)) continue;
      this.queued.add(o.id);
      list.push(o);
    }
    list.sort((a, b) => (a.pricePerM ?? Number.POSITIVE_INFINITY) - (b.pricePerM ?? Number.POSITIVE_INFINITY));
    this.queue.push(...list);
    this.pump();
    return list.length;
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const offer = this.queue.shift();
      this.active++;
      this.run(offer)
        .catch((err) => {
          this.errors++;
          this.queued.delete(offer.id);
          offer.descError = true;
          if (process.env.DEBUG) console.error('[enrich]', offer.id, err.message);
        })
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  async run(offer) {
    if (this.cache.has(offer.id)) {
      const rec = this.cache.get(offer.id);
      this.onDone(offer, { description: rec.description, fields: {}, seller: {} });
      this.queued.delete(offer.id);
      return rec;
    }
    const url = offer.offerUrl || `https://funpay.com/lots/offer?id=${offer.id}`;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.gate();
      try {
        const html = await fetchText(url, { tries: 1, timeout: 20000 });
        const page = parseOfferPage(html);
        const rec = { id: offer.id, description: page.description || '', fetchedAt: Date.now() };
        this.cache.set(offer.id, rec);
        this.queued.delete(offer.id);
        this.loaded++;
        if (this.store) this.store.appendJsonl(DESC_FILE, rec);
        this.onDone(offer, page);
        return rec;
      } catch (err) {
        lastErr = err;
        if (err.status === 429) {
          this.last429 = Date.now();
          await sleep(6000 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error('Не удалось загрузить описание');
  }

  async fetchNow(offer) {
    const cached = this.cache.get(offer.id);
    if (cached) {
      this.onDone(offer, { description: cached.description, fields: {}, seller: {} });
      return cached;
    }
    return this.run(offer);
  }

  stats() {
    return {
      cached: this.cache.size,
      queued: this.queue.length,
      active: this.active,
      errors: this.errors,
      last429: this.last429 || null,
    };
  }
}

module.exports = { Enricher };
