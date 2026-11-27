'use strict';
// Проверка опубликованной статики в настоящем браузере, включая путь /tokenscope/.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { build } = require('./build-pages');
const { createPreview } = require('./preview-pages');
const { fixtures } = require('./pages-selftest');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url); this.seq = 0; this.pending = new Map(); this.events = [];
    this.ws.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(timer);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) this.events.push(msg);
    });
  }
  ready() { return new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }); }); }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout ' + method)); }, 15000);
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { for (const { timer } of this.pending.values()) clearTimeout(timer); this.ws.close(); }
}

(async () => {
  assert.ok(CHROME, 'Для браузерных проверок нужен Chrome или Edge');
  const work = path.resolve(__dirname, '../.probe/pages-ui-' + Date.now());
  const cacheDir = path.join(work, 'data'); fs.mkdirSync(cacheDir, { recursive: true });
  const offers = fixtures();
  fs.writeFileSync(path.join(cacheDir, 'cache.json'), JSON.stringify({ offers, updatedAt: Date.now() }));
  const output = build({ cacheDir, outDir: path.join(work, 'site') });
  const server = createPreview(output.outDir);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/tokenscope/';
  const debugPort = 9600 + Math.floor(Math.random() * 150);
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(work, 'browser'), 'about:blank'], { stdio: 'ignore' });
  let browser, page, passed = 0;
  try {
    let version;
    for (let i = 0; i < 60; i++) { try { version = await (await fetch('http://127.0.0.1:' + debugPort + '/json/version')).json(); break; } catch { await delay(150); } }
    assert.ok(version, 'Chrome не открыл DevTools');
    browser = new Cdp(version.webSocketDebuggerUrl); await browser.ready();
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json();
    page = new Cdp(targets.find((t) => t.id === targetId).webSocketDebuggerUrl); await page.ready();
    await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
    const evaluate = async (expression) => {
      const r = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const wait = async (condition) => { for (let i = 0; i < 120; i++) { if (await evaluate(condition)) return; await delay(70); } throw new Error('Не дождались: ' + condition); };
    const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const set = (selector, value, event = 'input') => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
    const check = (label, result) => { assert.ok(result, label); passed++; console.log('PASS ' + label); };
    const ready = () => wait('typeof state !== "undefined" && !state.loading && state.items.length > 0 && document.querySelectorAll("#list .offer").length > 0');
    const viewport = (width, height) => page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await viewport(1440, 1200);
    await page.send('Page.navigate', { url: base }); await ready();
    check('Сборка работает в подпапке репозитория без Node API', await evaluate('TokenScopeAPI.isStatic && state.total===4 && document.title.includes("TokenScope")'));
    check('В статике те же четыре основных раздела без дублирующих фильтров', await evaluate('[...document.querySelectorAll("#filters details.fgroup")].map(el=>el.dataset.group).join()==="offer,budget,seller,conditions" && !document.querySelector("#quickFilters,[data-quick],#clearAccess") && document.querySelector("#sourceOptions").contains(document.querySelector("#serviceFunpay"))'));
    check('Без ограничений объём и срок не показывают лишних полей', await evaluate('document.querySelector("#volumeMode").value==="any" && document.querySelector("#exactVolumeFields").hidden && document.querySelector("#rangeVolumeFields").hidden && document.querySelector("#durationOptions").hidden'));
    check('Фон статики чёрный, акцент светло-зелёный', await evaluate('(()=>{const rgb=getComputedStyle(document.querySelector("#filterApply")).backgroundColor.match(/[0-9.]+/g).map(Number);return getComputedStyle(document.body).backgroundColor==="rgb(0, 0, 0)" && rgb[0]>=80 && rgb[1]>=180 && rgb[1]>rgb[0]+20 && rgb[1]>rgb[2]+20;})()'));
    check('FunPay всегда включён, будущий сервис недоступен', await evaluate('document.querySelector("#serviceFunpay").checked && document.querySelector("#serviceFunpay").disabled && !document.querySelector("#serviceComingSoon").checked && document.querySelector("#serviceComingSoon").disabled'));
    check('Будущий сервис затемнён, подписан и перечёркнут', await evaluate('document.querySelector(".service-soon").textContent.toLowerCase().includes("coming soon") && getComputedStyle(document.querySelector(".service-soon"),"::after").backgroundImage.includes("linear-gradient")'));
    check('Старый слоган удалён и режим снимка подписан', await evaluate('!document.body.textContent.includes("Только чтение FunPay") && /снимок/i.test(document.querySelector("#modeLabel").textContent)'));
    await click('[data-preset="hour"]');
    await wait('!state.loading && state.filters.offerType === "timed" && state.total===1');
    check('Пресет на час применяет фильтры и активное состояние', await evaluate('state.filters.minDuration===60 && state.filters.maxDuration===60 && document.querySelector("[data-preset=hour]").getAttribute("aria-pressed")==="true" && !document.querySelector("#durationOptions").hidden && document.querySelector("#volumeMode").value==="any"'));
    await click('#savePresetBtn');
    await evaluate('document.querySelector("#presetName").value="Мой час";document.querySelector("#savePresetForm").requestSubmit()');
    await wait('document.querySelector("#savedPresetLabel").textContent.includes("Мой час")');
    await click('[data-preset="bulk"]');
    await wait('!state.loading && state.filters.offerType !== "timed"');
    check('Крупный объём включает диапазон и скрывает срок', await evaluate('state.filters.minTokens===10000000 && state.filters.maxTokens===null && state.filters.need===0 && document.querySelector("#volumeMode").value==="range" && !document.querySelector("#rangeVolumeFields").hidden && document.querySelector("#exactVolumeFields").hidden && document.querySelector("#durationOptions").hidden'));
    await click('#applySavedPreset');
    await wait('!state.loading && state.filters.offerType === "timed" && state.total===1');
    check('Свой пресет сохраняется и восстанавливает подборку', await evaluate('state.filters.minDuration===60 && document.querySelector("#savedPresetLabel").textContent.includes("Мой час")'));
    await page.send('Page.reload'); await ready();
    check('Свой пресет и фильтры переживают перезагрузку', await evaluate('state.filters.minDuration===60 && document.querySelector("#savedPresetLabel").textContent.includes("Мой час")'));
    await click('#resetBtn'); await wait('!state.loading && state.total===4');
    check('Сброс снимает активный пресет', await evaluate('!document.querySelector("#presetRow [aria-pressed=true]")'));
    await click('[data-preset="safe"]'); await wait('!state.loading && state.filters.minStars===5');
    check('Надёжный пресет не обещает непроведённые проверки на Pages', await evaluate('state.filters.minStars===5 && state.filters.noReviewStars.length===0'));
    await click('#resetBtn'); await wait('!state.loading && state.total===4');
    await set('#volumeMode', 'exact', 'change');
    await set('#needInput', '10М'); await wait('!state.loading && state.total===1 && state.filters.need===10000000');
    check('Точный объём фильтрует статический снимок без диапазона', await evaluate('state.items[0].id==="810001" && document.querySelector("#volumeMode").value==="exact" && !document.querySelector("#exactVolumeFields").hidden && document.querySelector("#rangeVolumeFields").hidden && state.filters.minTokens===null && state.filters.maxTokens===null'));
    await page.send('Page.reload'); await ready();
    check('Точный режим восстанавливается из ссылки в подпапке', await evaluate('state.filters.need===10000000 && document.querySelector("#volumeMode").value==="exact" && parseHuman(document.querySelector("#needInput").value)===10000000 && new URLSearchParams(location.search).get("need")==="10000000"'));
    await click('#savePresetBtn');
    await evaluate('document.querySelector("#presetName").value="Ровно 10М";document.querySelector("#savePresetForm").requestSubmit()');
    await wait('document.querySelector("#savedPresetLabel").textContent==="Ровно 10М"');
    await set('#volumeMode', 'range', 'change'); await wait('!state.loading && state.total===4');
    check('Диапазон очищает точный объём и ссылку статики', await evaluate('state.filters.need===0 && document.querySelector("#needInput").value==="" && !new URLSearchParams(location.search).has("need") && document.querySelector("#exactVolumeFields").hidden && !document.querySelector("#rangeVolumeFields").hidden'));
    await set('#minTokens', '5М'); await wait('!state.loading && state.total===3 && state.filters.minTokens===5000000');
    await set('#maxTokens', '10М'); await wait('!state.loading && state.total===2 && state.filters.maxTokens===10000000');
    await page.send('Page.reload'); await ready();
    check('Диапазон восстанавливается из ссылки и сохраняет границы', await evaluate('document.querySelector("#volumeMode").value==="range" && state.filters.need===0 && state.filters.minTokens===5000000 && state.filters.maxTokens===10000000 && document.querySelector("#minTokens").value==="5000000" && document.querySelector("#maxTokens").value==="10000000"'));
    await click('#applySavedPreset'); await wait('!state.loading && state.total===1 && state.filters.need===10000000');
    check('Свой пресет переключает диапазон на точный объём', await evaluate('document.querySelector("#volumeMode").value==="exact" && state.filters.minTokens===null && state.filters.maxTokens===null && document.querySelector("#minTokens").value==="" && document.querySelector("#maxTokens").value==="" && !new URLSearchParams(location.search).has("minTokens") && !new URLSearchParams(location.search).has("maxTokens") && !document.querySelector("#exactVolumeFields").hidden && document.querySelector("#rangeVolumeFields").hidden'));
    await set('#volumeMode', 'any', 'change'); await wait('!state.loading && state.total===4');
    check('Любой объём очищает значения и возвращает весь снимок', await evaluate('state.filters.need===0 && state.filters.minTokens===null && state.filters.maxTokens===null && document.querySelector("#needInput").value==="" && document.querySelector("#exactVolumeFields").hidden && document.querySelector("#rangeVolumeFields").hidden && ["need","minTokens","maxTokens"].every(k=>!new URLSearchParams(location.search).has(k))'));
    await evaluate('document.querySelector("#q").value="DeepSeek";document.querySelector("#q").dispatchEvent(new Event("input",{bubbles:true}))');
    await wait('!state.loading && state.total===2');
    check('Поиск фильтрует снимок в браузере', await evaluate('state.items.every(o=>o.cat==="4506")'));
    await click('#resetBtn'); await wait('!state.loading && state.total===4');
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    check('Уменьшенное движение учитывает системную настройку', await evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches && parseFloat(getComputedStyle(document.querySelector(".scope-sweep")).animationDuration)<0.1'));
    await page.send('Emulation.setEmulatedMedia', { features: [] });
    await evaluate('scrollTo(0,0)');
    await delay(500);
    let image = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.resolve(__dirname, '../.probe/tokenscope-desktop.png'), Buffer.from(image.data, 'base64'));
    for (const width of [320, 390, 768]) {
      await viewport(width, 1000); await delay(100);
      check('Нет горизонтального переполнения на ' + width + 'px', await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'));
    }
    await viewport(390, 1000);
    await click('#filtersToggle');
    await click('#sourceOptions > summary');
    check('Мобильные фильтры открываются и показывают дополнительные площадки', await evaluate('!document.querySelector("#filters").inert && document.querySelector("#sourceOptions").open && document.querySelector("#serviceFunpay").getClientRects().length>0'));
    await click('#filtersClose');
    check('Мобильная панель закрывается', await evaluate('document.querySelector("#filters").inert'));
    await evaluate('scrollTo(0,0)'); await delay(350);
    image = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.resolve(__dirname, '../.probe/tokenscope-mobile.png'), Buffer.from(image.data, 'base64'));
    const errors = page.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    check('Нет исключений JavaScript', errors.length === 0);
    const apiRequests = page.events.filter((e) => e.method === 'Network.requestWillBeSent' && new URL(e.params.request.url).pathname.startsWith('/api/'));
    check('Статика не обращается к несуществующему серверному API', apiRequests.length === 0);
    console.log(`\n${passed} браузерных проверок Pages пройдено. Снимки: .probe/tokenscope-desktop.png и .probe/tokenscope-mobile.png`);
  } finally {
    page?.close(); browser?.close(); chrome.kill(); await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
