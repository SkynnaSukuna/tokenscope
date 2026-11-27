'use strict';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, { timeout = 25000, tries = 3, retryDelay = 1800 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7',
          'Cache-Control': 'no-cache',
        },
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} для ${url}`);
        err.status = res.status;
        const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
        if (Number.isFinite(retryAfter)) err.retryAfter = retryAfter;
        throw err;
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < tries) {
        const extra = err.status === 429 ? 3000 : 0;
        await sleep(retryDelay * attempt + extra);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

module.exports = { fetchText, sleep, UA };
