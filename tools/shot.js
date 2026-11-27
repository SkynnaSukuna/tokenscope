'use strict';

/**
 * Скриншот страницы через Chrome DevTools Protocol (без внешних зависимостей).
 * Запуск: node tools/shot.js <url> <width> <height> <out.png> [waitMs]
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const url = process.argv[2] || 'http://127.0.0.1:8787/';
const width = parseInt(process.argv[3] || '1440', 10);
const height = parseInt(process.argv[4] || '1600', 10);
const out = process.argv[5] || '.probe/shot.png';
const waitMs = parseInt(process.argv[6] || '5000', 10);
const PORT = 9333 + Math.floor(Math.random() * 200);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(method, urlStr) {
  return new Promise((resolve, reject) => {
    const req = http.request(urlStr, { method }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error(raw.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForBrowser() {
  for (let i = 0; i < 60; i++) {
    try {
      return await httpJson('GET', `http://127.0.0.1:${PORT}/json/version`);
    } catch {
      await sleep(250);
    }
  }
  throw new Error('Chrome не ответил на devtools-порт');
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('timeout ' + method));
        }
      }, 30000);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

(async () => {
  if (!CHROME) throw new Error('Chrome/Edge не найден');
  const profile = path.join(process.env.TEMP || '/tmp', 'tr-chrome-' + Date.now());
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=' + width + ',' + height,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  try {
    const version = await waitForBrowser();
    const browser = new Cdp(version.webSocketDebuggerUrl);
    await browser.ready();

    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const list = await httpJson('GET', `http://127.0.0.1:${PORT}/json/list`);
    const target = list.find((t) => t.id === targetId);
    const page = new Cdp(target.webSocketDebuggerUrl);
    await page.ready();

    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    await page.send('Page.navigate', { url });

    // ждём load и ещё немного, чтобы отработали fetch/рендер
    const started = Date.now();
    while (Date.now() - started < 15000) {
      if (page.events.some((e) => e.method === 'Page.loadEventFired')) break;
      await sleep(120);
    }
    await sleep(waitMs);

    const ex = page.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    if (ex.length) {
      console.error('Exceptions:');
      for (const e of ex.slice(0, 6)) {
        const d = e.params.exceptionDetails;
        console.error(' -', d.text, d.exception && d.exception.description ? d.exception.description.split('\n')[0] : '', d.url || '');
      }
    }
    const probe = await page.send('Runtime.evaluate', {
      expression: process.env.PROBE_EXPR || 'JSON.stringify({total:document.querySelector("#totalLots")?.textContent, list:document.querySelector("#list")?.children.length, app:typeof state})',
      returnByValue: true,
    });
    console.log('probe', probe.result.value);

    const errors = page.events.filter(
      (e) =>
        e.method === 'Log.entryAdded' && ['error'].includes(e.params.entry.level) &&
        !/favicon|net::ERR_BLOCKED/.test(e.params.entry.text)
    );
    if (errors.length) {
      console.error('JS/console errors:');
      for (const e of errors.slice(0, 8)) console.error(' -', e.params.entry.text);
    }

    const shot = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const buf = Buffer.from(shot.data, 'base64');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    console.log('saved', out, buf.length, 'bytes;', height, 'px viewport');

    page.close();
    browser.close();
  } finally {
    chrome.kill();
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
