'use strict';

// Детерминированная проверка настоящего интерфейса и фильтров на локальных лотах.
// Данные FunPay не меняются, интернет для проверки не нужен.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildOffer, applyDescription } = require('../lib/parser');
const { parseFilters, applyFilters, sortOffers, computeStats, needCost } = require('../lib/filter');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const rows = [
  ['910001', 'Claude unlimited for 1h', 120, 'claude'],
  ['910002', 'Claude безлимит на 3 часа', 150, 'claude'],
  ['910003', 'Claude unlimited for 24 hours', 480, 'claude'],
  ['910004', 'Claude безлимитный API 24/7', 300, 'claude'],
  ['910005', 'DeepSeek 10 млн токенов', 100, 'deepseek', '(input + output) × 1,5. 43 модели. Кэшерование - 50 %. Остаток виден на странице ключа.'],
  ['910006', 'ChatGPT Plus subscription на месяц', 900, 'gpt'],
  ['910007', 'Claude API доступ', 90, 'claude', 'Unlimited access for 1 hour. Выдача сразу после оплаты.'],
  ['910008', 'DeepSeek 5 млн токенов с бонусом — подробное длинное название предложения для проверки переноса текста на маленьком экране', 60, 'deepseek', 'Автоматическая выдача. Возврат не предусмотрен. Срок действия 30 дней. Бонус 10%. Вход + выход, кэшированный вход — за половину. Остаток виден на странице ключа. 43 моделей.\n<img src=x onerror="window.descriptionXss=true"> Точный исходный текст & условия.'],
];
const offers = rows.map(([id, titleHtml, price, model, description]) => {
  const o = buildOffer({ id, titleHtml, price, fields: { model }, sellerId: 'seller-' + id, sellerName: 'Продавец ' + id, stars: 5, reviews: 150, age: 'на сайте 2 года', auto: true, online: true }, '4506');
  applyDescription(o, { description: description || titleHtml, fields: {} });
  o.modelLabel = { claude: 'Claude', deepseek: 'DeepSeek', gpt: 'ChatGPT' }[model];
  return o;
});
const timedIds = offers.filter((o) => o.flags.unlimited && o.durationMinutes).map((o) => o.id);
assert.equal(timedIds.length, 4, 'Фикстуры должны содержать четыре временных безлимита');
const now = Date.now();
const desc = { totalInScope: offers.length, loadedInScope: offers.length, queued: 0, active: 0, errors: 0 };
let offerRequests = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (value) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (url.pathname === '/api/meta') return json({ total: offers.length, updatedAt: now, categories: [{ id: '4506', name: 'Тестовая категория', color: '#ff7a59', count: offers.length }], models: ['claude', 'deepseek', 'gpt'].map((name) => ({ name, label: { claude: 'Claude', deepseek: 'DeepSeek', gpt: 'ChatGPT' }[name], count: offers.filter((o) => o.model === name).length })), desc });
  if (url.pathname === '/api/offers') {
    offerRequests++;
    const f = parseFilters(url.searchParams);
    const items = sortOffers(applyFilters(offers, f), f).map((o) => ({ ...o, needCost: needCost(o, f.need) }));
    return json({ total: items.length, page: 1, pages: 1, pageSize: 40, items, stats: computeStats(items, f), desc, history: [], updatedAt: now });
  }
  if (url.pathname === '/api/offer') { const offer = offers.find((o) => o.id === url.searchParams.get('id')); return json({ offer, description: offer?.description || '' }); }
  if (url.pathname === '/api/history') return json({ points: [] });
  const name = { '/': 'index.html', '/config.js': 'config.js', '/api.js': 'api.js', '/app.js': 'app.js', '/description.js': 'description.js', '/review-highlights.js': 'review-highlights.js', '/reviews.js': 'reviews.js', '/styles.css': 'styles.css' }[url.pathname];
  if (!name) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(fs.readFileSync(path.join(__dirname, '../public', name)));
});

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url); this.seq = 0; this.pending = new Map(); this.events = [];
    this.socket.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      } else if (msg.method) this.events.push(msg);
    });
  }
  ready() { return new Promise((resolve, reject) => { this.socket.addEventListener('open', resolve, { once: true }); this.socket.addEventListener('error', reject, { once: true }); }); }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { for (const { timer } of this.pending.values()) clearTimeout(timer); this.socket.close(); }
}
let passed = 0;
function check(name, ok, info) { assert.ok(ok, name + ': ' + JSON.stringify(info)); passed++; console.log('PASS ' + name + (info ? ' → ' + JSON.stringify(info) : '')); }

(async () => {
  assert.ok(CHROME, 'Chrome/Edge не найден');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const debugPort = 9800 + Math.floor(Math.random() * 150);
  const profile = path.join(process.env.TEMP || '/tmp', 'tr-access-' + Date.now());
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeLog = '';
  chrome.stderr.on('data', chunk => { chromeLog = (chromeLog + chunk).slice(-4000); });
  let browser, page;
  try {
    let version;
    for (let i = 0; i < 60; i++) { try { version = await (await fetch('http://127.0.0.1:' + debugPort + '/json/version')).json(); break; } catch { if (chrome.exitCode != null) break; await sleep(250); } }
    assert.ok(version, 'Chrome не ответил; exit=' + chrome.exitCode + '; ' + chromeLog);
    browser = new Cdp(version.webSocketDebuggerUrl); await browser.ready();
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json();
    page = new Cdp(targets.find((t) => t.id === targetId).webSocketDebuggerUrl); await page.ready();
    await page.send('Page.enable'); await page.send('Runtime.enable');
    const evaluate = async (expression) => {
      const r = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const run = (body) => evaluate('(async()=>{' + body + '})()');
    const wait = async (expression) => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(50); }
      throw new Error('Не дождались: ' + expression);
    };
    const click = (selector) => evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()');
    const set = (selector, value, event = 'input') => run('const el=document.querySelector(' + JSON.stringify(selector) + '); el.value=' + JSON.stringify(value) + ';el.dispatchEvent(new Event(' + JSON.stringify(event) + ',{bubbles:true}));');
    const readyCount = (n) => wait('typeof state!=="undefined" && !state.loading && document.querySelectorAll("#list .offer").length === ' + n + ' && !document.querySelector("#list .skeleton")');
    const metrics = () => run(`return [...document.querySelectorAll('#list .offer:not(.expanded)')].map(el=>{const r=el.getBoundingClientRect();const a=el.querySelector('.tile-actions')?.getBoundingClientRect();return {w:r.width,h:r.height,inside:!a||a.bottom<=r.bottom-2,scroll:el.scrollHeight<=el.clientHeight+1};});`);
    const viewport = (width, height = 1100) => page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await viewport(1440);
    await page.send('Page.navigate', { url: base }); await readyCount(offers.length);
    check('Плитка по умолчанию и все фикстуры', await evaluate('state.view === "grid" && getComputedStyle(document.querySelector("#list")).gridTemplateColumns.split(" ").length >= 2'));
    const filterStructure = await run(`const group=id=>document.getElementById(id)?.closest('details.fgroup')?.dataset.group;return {groups:[...document.querySelectorAll('#filters details.fgroup')].map(el=>el.dataset.group),offer:['catChips','modelChips','offerType'].every(id=>group(id)==='offer'),models:!!document.querySelector('#modelChips')?.closest('details.filter-subdetails'),budget:['minPriceM','maxPriceM','minLotPrice','maxLotPrice','volumeMode','needInput','minTokens','maxTokens','volumePrecision'].every(id=>group(id)==='budget'),seller:['minStars','minReviews','minAgeMonths','autoOnly','onlineOnly','reviewOptions'].every(id=>group(id)==='seller'),conditions:['bonusSeg','refundSeg','inputOutputSeg','noRateLimited','noCredits'].every(id=>group(id)==='conditions'),extras:['unitMin','unitMax','unitKnown','exactTokens','qtyMode'].every(id=>document.querySelector('#volumePrecision')?.contains(document.getElementById(id))),sources:['serviceFunpay','serviceComingSoon','hiddenOffers','hiddenSellers'].every(id=>document.querySelector('details#sourceOptions')?.contains(document.getElementById(id))),quick:document.querySelectorAll('#quickFilters,[data-quick],#clearAccess').length};`);
    check('Четыре основных раздела и дополнительные настройки на своих местах', filterStructure.groups.join() === 'offer,budget,seller,conditions' && filterStructure.offer && filterStructure.models && filterStructure.budget && filterStructure.seller && filterStructure.conditions && filterStructure.extras && filterStructure.sources, filterStructure);
    check('Повторяющиеся быстрые фильтры удалены', filterStructure.quick === 0, filterStructure.quick);
    check('Любой объём скрывает оба способа ограничения и срок', await evaluate('document.querySelector("#volumeMode").value==="any" && [...document.querySelector("#volumeMode").options].map(o=>o.value).join()==="any,exact,range" && document.querySelector("#exactVolumeFields").hidden && document.querySelector("#rangeVolumeFields").hidden && document.querySelector("#durationOptions").hidden'));
    const palette = await run(`const s=getComputedStyle(document.body);const accent=getComputedStyle(document.querySelector('#filterApply')).backgroundColor;return {background:s.backgroundColor,accent,rgb:accent.match(/[0-9.]+/g)?.map(Number)};`);
    check('Чёрный фон и светло-зелёный акцент вычислены браузером', palette.background === 'rgb(0, 0, 0)' && palette.rgb?.length >= 3 && palette.rgb[0] >= 80 && palette.rgb[1] >= 180 && palette.rgb[1] > palette.rgb[0] + 20 && palette.rgb[1] > palette.rgb[2] + 20, palette);
    let boxes = await metrics();
    check('Квадратные карточки: цена и действия помещаются', boxes.every((r) => Math.abs(r.w - r.h) <= 1 && r.inside && r.scroll), boxes[0]);
    check('Ввод объёма понимает пробелы, запятую и М', await evaluate('parseHuman("10 000 000")===10000000 && parseHuman("1,5М")===1500000 && parseHuman("2kk")===2000000 && parseHuman("12oops")===null'));

    check('Панель на компьютере открыта и имеет доступные кнопки', await evaluate('!document.querySelector("#filters").inert && document.querySelector("#filtersToggle").getAttribute("aria-expanded")==="true" && document.querySelector("#filtersToggle").getClientRects().length>0 && document.querySelector("#filtersClose").getClientRects().length>0'));
    const expandedWidth = await evaluate('document.querySelector(".results").getBoundingClientRect().width');
    const beforeCollapseRequests = offerRequests;
    await click('#filtersClose');
    check('Скрытие панели расширяет выдачу и сохраняет фильтры', await evaluate('getComputedStyle(document.querySelector("#filters")).display==="none" && document.querySelector("#filters").inert && document.querySelector("#filtersToggle").getAttribute("aria-expanded")==="false" && document.querySelector(".results").getBoundingClientRect().width>' + (expandedWidth + 300) + ' && state.items.length===8 && localStorage.getItem("tokenradar_sidebar_collapsed")==="true"') && offerRequests===beforeCollapseRequests);
    await page.send('Page.reload'); await readyCount(8);
    check('Состояние скрытой панели сохраняется после обновления', await evaluate('document.body.classList.contains("sidebar-collapsed") && document.querySelector("#filters").inert && document.querySelector("#filtersToggle").getAttribute("aria-expanded")==="false"'));
    await click('#filtersToggle');
    check('Кнопка Фильтры возвращает панель', await evaluate('!document.body.classList.contains("sidebar-collapsed") && !document.querySelector("#filters").inert && document.querySelector("#filtersToggle").getAttribute("aria-expanded")==="true" && localStorage.getItem("tokenradar_sidebar_collapsed")==="false"'));

    const previewHighlight = await run('const c=document.querySelector(".offer[data-id=\\"910008\\"]");const p=c.querySelector(".tile-description");return {positive:p.querySelectorAll(".desc-positive").length,negative:p.querySelectorAll(".desc-negative").length,neutral:p.querySelectorAll(".desc-neutral").length,safe:!p.querySelector("img")&&!window.descriptionXss,exact:p.textContent===tileDescription(state.items.find(o=>o.id==="910008")),title:c.querySelector(".tile-title").textContent};');
    check('В предпросмотре выделены преимущества, риски и условия', previewHighlight.positive>0 && previewHighlight.negative>0 && previewHighlight.neutral>0 && previewHighlight.safe && previewHighlight.exact && previewHighlight.title===rows[7][1], previewHighlight);
    await click('.offer[data-id="910008"] [data-act="desc"]');
    await wait('!!document.querySelector(".offer[data-id=\\"910008\\"] .desc-content")');
    const fullHighlight = await run('const c=document.querySelector(".offer[data-id=\\"910008\\"] .offer-desc");return {positive:c.querySelectorAll("mark.desc-positive").length,negative:c.querySelectorAll("mark.desc-negative").length,neutral:c.querySelectorAll("mark.desc-neutral").length,exact:c.querySelector(".desc-content").textContent===state.descCache.get("910008").description,safe:!c.querySelector("img")&&!window.descriptionXss,legend:c.querySelector(".desc-legend")?.textContent};');
    check('Полное описание: подсветка, легенда и исходный текст без исполнения HTML', fullHighlight.positive>0 && fullHighlight.negative>0 && fullHighlight.neutral>0 && fullHighlight.exact && fullHighlight.safe && /По тексту продавца/.test(fullHighlight.legend), fullHighlight);
    await click('[data-view="list"]'); await wait('!!document.querySelector(".offer[data-id=\\"910008\\"] .desc-content")');
    check('Подсветка сохраняется при переключении на список', await evaluate('document.querySelectorAll(".offer[data-id=\\"910008\\"] .offer-desc mark").length>2'));
    await click('[data-view="grid"]'); await wait('!!document.querySelector(".offer[data-id=\\"910008\\"] .desc-content")');
    await click('.offer[data-id="910008"] [data-act="desc"]');
    check('Фоновое обновление предпросмотра сохраняет подсветку', await run('const o=state.items.find(o=>o.id==="910008");patchCards([{...o,descriptionPreview:"Без возврата. Бонус 5%."}]);const p=document.querySelector(".offer[data-id=\\"910008\\"] .tile-description");const ok=!!p.querySelector(".desc-negative")&&!!p.querySelector(".desc-positive");patchCards([o]);return ok;'));

    await click('details[data-group="conditions"] summary');
    await click('#inputOutputSeg [data-v="only"]'); await readyCount(2);
    check('Формула на русском и английском фильтруется до статистики', await evaluate('state.items.map(o=>o.id).sort().join(",")==="910005,910008" && state.stats.count===2 && state.total===2 && state.items.every(o=>o.flags.inputOutput) && new URLSearchParams(queryFor(1)).get("inputOutput")==="only" && new URLSearchParams(location.search).get("inputOutput")==="only"'));
    check('Переключатель, счётчик и бейдж формулы синхронизированы', await evaluate('document.querySelector("#inputOutputSeg [data-v=only]").getAttribute("aria-pressed")==="true" && document.querySelector("details[data-group=conditions] .fcount").textContent==="1" && document.querySelectorAll(".offer .badge[title*=списание]").length===2'));
    await page.send('Page.reload'); await readyCount(2);
    check('Формула восстанавливается из ссылки', await evaluate('state.filters.inputOutput==="only" && document.querySelector("#inputOutputSeg [data-v=only]").classList.contains("active") && document.querySelector("#inputOutputSeg [data-v=only]").getAttribute("aria-pressed")==="true"'));
    const billingPreview = await run('const c=document.querySelector(".offer[data-id=\\"910005\\"] .tile-description");return {text:c.textContent,marks:[...c.querySelectorAll("mark")].map(m=>({text:m.textContent,kind:m.className})),exact:c.textContent===tileDescription(state.items.find(o=>o.id==="910005"))};');
    check('В предпросмотре выделены формула, модели, кэш и остаток', billingPreview.exact && ['input + output', '43 модели', 'Кэшерование - 50 %', 'Остаток виден на странице ключа'].every(part=>billingPreview.marks.some(m=>m.text.includes(part))), billingPreview);
    await click('.offer[data-id="910008"] [data-act="desc"]'); await wait('!!document.querySelector(".offer[data-id=\\"910008\\"] .desc-content")');
    check('Фраза про половину стоимости выделена без изменения текста', await run('const c=document.querySelector(".offer[data-id=\\"910008\\"] .desc-content");return c.textContent===state.descCache.get("910008").description && [...c.querySelectorAll("mark.desc-positive")].some(m=>m.textContent.includes("кэшированный вход — за половину")) && [...c.querySelectorAll("mark.desc-neutral")].some(m=>m.textContent.includes("43 моделей")) && !c.querySelector("img") && !window.descriptionXss;'));
    await run('const g=document.querySelector("details[data-group=conditions]");g.open=true;document.querySelector("#inputOutputLabel").scrollIntoView({block:"center"});');
    fs.mkdirSync(path.join(__dirname, '../.probe'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '../.probe/billing-filter-desktop.png'), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await click('[data-view="list"]'); await wait('!!document.querySelector(".offer:not(.tile) .desc-content")');
    check('Бейдж и новые выделения работают в режиме списка', await evaluate('document.querySelectorAll(".offer .badge[title*=списание]").length===2 && document.querySelectorAll(".desc-content mark").length>4'));
    await click('[data-view="grid"]');
    await run('const chip=[...document.querySelectorAll("#activeChips button")].find(b=>b.textContent.includes("с формулой"));chip.click();'); await readyCount(8);
    check('Снятие чипа формулы очищает ссылку и переключатель', await evaluate('state.filters.inputOutput==="any" && !new URLSearchParams(location.search).has("inputOutput") && document.querySelector("#inputOutputSeg [data-v=any]").getAttribute("aria-pressed")==="true"'));
    await click('#inputOutputSeg [data-v="exclude"]'); await readyCount(6);
    check('Без формулы исключает обе формулировки', await evaluate('state.items.every(o=>!o.flags.inputOutput) && state.stats.count===6 && new URLSearchParams(queryFor(1)).get("inputOutput")==="exclude"'));
    await page.send('Page.reload'); await readyCount(6);
    check('Режим без формулы сохраняется при обновлении', await evaluate('state.filters.inputOutput==="exclude" && document.querySelector("#inputOutputSeg [data-v=exclude]").getAttribute("aria-pressed")==="true"'));
    await click('#resetBtn'); await readyCount(8);
    await click('#inputOutputSeg [data-v="only"]'); await readyCount(2);
    await set('#volumeMode', 'exact', 'change');
    await set('#needInput', '10М'); await readyCount(1);
    check('Формула сочетается с точным объёмом', await evaluate('state.filters.inputOutput==="only" && state.filters.need===10000000 && state.items[0].id==="910005"'));
    await click('#resetBtn'); await readyCount(8);
    await page.send('Page.navigate', { url: base + '?inputOutput=wrong' }); await readyCount(8);
    check('Неизвестный режим формулы нормализуется в любой', await evaluate('state.filters.inputOutput==="any" && new URLSearchParams(queryFor(1)).get("inputOutput")===null && document.querySelector("#inputOutputSeg [data-v=any]").getAttribute("aria-pressed")==="true"'));

    await set('#offerType', 'timed', 'change'); await readyCount(4);
    check('Тип временного безлимита фильтрует и показывает срок', await evaluate('state.items.every(o=>o.flags.unlimited && o.durationMinutes>0) && state.filters.sort==="priceHour" && !document.querySelector("#durationOptions").hidden'));
    await click('#durationPresets [data-minutes="60"]'); await readyCount(2);
    const hour = await run('return {search:location.search, ids:state.items.map(o=>o.id), metric:document.querySelector(".per-m").textContent, volume:document.querySelector(".tile-volume").textContent};');
    check('1 час фильтрует заголовок и описание, показывает цену часа', /minDuration=60/.test(hour.search) && /maxDuration=60/.test(hour.search) && /за час/.test(hour.metric) && /1 ч/.test(hour.volume), hour);

    await page.send('Page.navigate', { url: base + hour.search }); await readyCount(2);
    check('Срок и тип восстанавливаются из ссылки', await evaluate('document.querySelector("#offerType").value === "timed" && document.querySelector("#minDuration").value === "1" && document.querySelector("#maxDuration").value === "1"'));
    await set('#durationUnit', '1', 'change');
    check('Смена часов на минуты сохраняет срок', await evaluate('state.filters.minDuration===60 && document.querySelector("#minDuration").value==="60" && document.querySelector("#maxDuration").value==="60"'));
    await set('#durationUnit', '60', 'change');
    await set('#maxDuration', '3'); await readyCount(3);
    check('Свой диапазон 1–3 часа включительно', await evaluate('state.filters.minDuration===60 && state.filters.maxDuration===180 && state.items.every(o=>o.durationMinutes>=60 && o.durationMinutes<=180)'));

    const requestCount = offerRequests;
    const validUrl = await evaluate('location.search');
    await set('#minDuration', '5'); await wait('!document.querySelector("#filterError").hidden');
    check('Перевёрнутый диапазон показывает ошибку и не отправляет запрос', offerRequests === requestCount && await evaluate('location.search===' + JSON.stringify(validUrl) + ' && document.querySelector("#minDuration").getAttribute("aria-invalid")==="true"'));
    await set('#minDuration', 'ошибка'); await sleep(500);
    check('Неверное число не превращается в скрытый фильтр', await evaluate('!document.querySelector("#filterError").hidden && location.search===' + JSON.stringify(validUrl)));
    check('Фоновые запросы используют последний корректный диапазон', await evaluate('new URLSearchParams(queryFor(1)).get("minDuration")==="60" && new URLSearchParams(queryFor(1)).get("maxDuration")==="180"'));
    await set('#minDuration', '1,5'); await readyCount(1);
    check('Дробный срок 1,5 часа фильтруется', await evaluate('state.filters.minDuration===90 && state.items[0].id==="910002" && document.querySelector("#filterError").hidden'));

    await click('#resetBtn'); await readyCount(8);
    await set('#volumeMode', 'exact', 'change');
    check('Точный режим показывает только поле и пресеты точного объёма', await evaluate('!document.querySelector("#exactVolumeFields").hidden && document.querySelector("#rangeVolumeFields").hidden && document.querySelector("#needPresets").closest("#exactVolumeFields")!==null'));
    await set('#needInput', '10 000 000'); await readyCount(1);
    check('Нужный объём оставляет только точный размер лота', await evaluate('state.filters.need===10000000 && state.items[0].id==="910005" && state.items.every(o=>o.tokens===10000000) && state.stats.count===1 && state.stats.needPlans.every(p=>p.units===1 && p.got===10000000) && document.querySelector("#activeChips").textContent.includes("ровно 10 млн токенов")'));
    await page.send('Page.reload'); await readyCount(1);
    check('Точный объём сохраняется в ссылке после обновления', await evaluate('new URLSearchParams(location.search).get("need")==="10000000" && parseHuman(document.querySelector("#needInput").value)===10000000 && state.items[0].tokens===10000000'));
    await click('#needPresets [data-v="5000000"]');
    await wait('state.items.length===1 && state.items[0].id==="910008"');
    check('Пресет меняет точный объём без подбора нескольких лотов', await evaluate('state.filters.need===5000000 && state.items.every(o=>o.tokens===5000000) && state.stats.needPlans.every(p=>p.units===1 && p.got===5000000)'));
    await set('#needInput', '1,5М'); await readyCount(0);
    check('Если точного объёма нет, выдача и планы пусты', await evaluate('state.filters.need===1500000 && state.total===0 && state.stats.count===0 && state.stats.needPlans.length===0 && !document.querySelector("#empty").hidden && document.querySelector("#needCard").hidden'));
    await set('#needInput', ''); await readyCount(8);
    check('Очистка нужного объёма возвращает все предложения', await evaluate('state.filters.need===0 && !new URLSearchParams(location.search).has("need")'));
    await click('#needPresets [data-v="10000000"]'); await readyCount(1);
    await run('const chip=[...document.querySelectorAll("#activeChips button")].find(b=>b.textContent.includes("ровно"));chip.click();'); await readyCount(8);
    check('Снятие чипа точного объёма возвращает все предложения', await evaluate('state.filters.need===0 && document.querySelector("#needInput").value===""'));
    await set('#volumeMode', 'range', 'change');
    check('Диапазон показывает только его границы', await evaluate('document.querySelector("#exactVolumeFields").hidden && !document.querySelector("#rangeVolumeFields").hidden'));
    await set('#minTokens', '5М'); await readyCount(2);
    await set('#maxTokens', '10М'); await wait('!state.loading && state.filters.maxTokens===10000000');
    check('Диапазон объёма включает обе границы до статистики', await evaluate('state.filters.need===0 && state.filters.minTokens===5000000 && state.filters.maxTokens===10000000 && state.items.map(o=>o.tokens).sort((a,b)=>a-b).join()==="5000000,10000000" && state.total===2 && state.stats.count===2 && !new URLSearchParams(queryFor(1)).has("need")'));
    await set('#volumeMode', 'exact', 'change'); await readyCount(8);
    check('Переход с диапазона к точному объёму очищает обе границы', await evaluate('state.filters.minTokens===null && state.filters.maxTokens===null && document.querySelector("#minTokens").value==="" && document.querySelector("#maxTokens").value==="" && !new URLSearchParams(location.search).has("minTokens") && !new URLSearchParams(location.search).has("maxTokens") && !new URLSearchParams(queryFor(1)).has("minTokens") && !new URLSearchParams(queryFor(1)).has("maxTokens") && !document.querySelector("#exactVolumeFields").hidden && document.querySelector("#rangeVolumeFields").hidden'));
    await set('#needInput', '10М'); await readyCount(1);
    await set('#volumeMode', 'range', 'change'); await readyCount(8);
    check('Переход к диапазону удаляет точный объём из поля, URL и API', await evaluate('state.filters.need===0 && document.querySelector("#needInput").value==="" && !new URLSearchParams(location.search).has("need") && !new URLSearchParams(queryFor(1)).has("need") && document.querySelector("#exactVolumeFields").hidden && !document.querySelector("#rangeVolumeFields").hidden'));
    await set('#minTokens', '5М'); await readyCount(2);
    await set('#maxTokens', '10М'); await wait('!state.loading && state.filters.maxTokens===10000000');
    await set('#volumeMode', 'any', 'change'); await readyCount(8);
    check('Любой объём очищает диапазон и скрывает оба набора полей', await evaluate('state.filters.need===0 && state.filters.minTokens===null && state.filters.maxTokens===null && document.querySelector("#minTokens").value==="" && document.querySelector("#maxTokens").value==="" && document.querySelector("#exactVolumeFields").hidden && document.querySelector("#rangeVolumeFields").hidden && ["need","minTokens","maxTokens"].every(k=>!new URLSearchParams(location.search).has(k)&&!new URLSearchParams(queryFor(1)).has(k))'));
    await set('#volumeMode', 'exact', 'change'); await set('#needInput', '5М'); await readyCount(1);
    await set('#volumeMode', 'any', 'change'); await readyCount(8);
    check('Любой объём очищает и точное значение', await evaluate('state.filters.need===0 && document.querySelector("#needInput").value==="" && !new URLSearchParams(location.search).has("need") && !new URLSearchParams(queryFor(1)).has("need")'));
    await set('#volumeMode', 'exact', 'change');
    await set('#needInput', '10М');
    await set('#volumeMode', 'range', 'change');
    await sleep(500); await readyCount(8);
    check('Ожидающий ввод точного объёма не возвращает прежний режим', await evaluate('document.querySelector("#volumeMode").value==="range" && state.filters.need===0 && state.filters.minTokens===null && state.filters.maxTokens===null && document.querySelector("#needInput").value==="" && document.querySelector("#exactVolumeFields").hidden && !document.querySelector("#rangeVolumeFields").hidden && !new URLSearchParams(location.search).has("need")'));
    await set('#minTokens', '5М');
    await set('#volumeMode', 'any', 'change');
    await sleep(550); await readyCount(8);
    check('Ожидающий ввод диапазона не возвращает ограничение после выбора любого объёма', await evaluate('document.querySelector("#volumeMode").value==="any" && state.filters.need===0 && state.filters.minTokens===null && state.filters.maxTokens===null && document.querySelector("#minTokens").value==="" && document.querySelector("#exactVolumeFields").hidden && document.querySelector("#rangeVolumeFields").hidden && ["need","minTokens","maxTokens"].every(k=>!new URLSearchParams(location.search).has(k)&&!new URLSearchParams(queryFor(1)).has(k))'));

    await set('#volumeMode', 'range', 'change');
    await set('#minTokens', '10М'); await readyCount(1);
    await set('#maxTokens', '5М'); await wait('!document.querySelector("#filterError").hidden');
    await set('#volumeMode', 'exact', 'change'); await readyCount(8);
    check('Смена режима очищает неверный скрытый диапазон и ошибку', await evaluate('document.querySelector("#filterError").hidden && !document.querySelector("#minTokens").hasAttribute("aria-invalid") && !document.querySelector("#maxTokens").hasAttribute("aria-invalid") && document.querySelector("#minTokens").value==="" && document.querySelector("#maxTokens").value==="" && state.filters.minTokens===null && state.filters.maxTokens===null && document.querySelector("#volumeMode").value==="exact"'));
    await set('#volumeMode', 'any', 'change'); await readyCount(8);
    for (const type of ['timed', 'unlimited', 'credits']) {
      await set('#offerType', type, 'change');
      await wait('!state.loading && state.filters.offerType===' + JSON.stringify(type));
      await set('#volumeMode', 'exact', 'change');
      await set('#needInput', '10М'); await readyCount(1);
      check('Точный объём после типа ' + type + ' очищает несовместимый доступ', await evaluate('state.filters.offerType==="tokens" && state.filters.minDuration===null && state.filters.maxDuration===null && state.filters.need===10000000 && state.items[0].id==="910005" && document.querySelector("#volumeMode").value==="exact" && document.querySelector("#durationOptions").hidden'));
    }
    await click('#resetBtn'); await readyCount(8);

    await page.send('Page.navigate', { url: base + '?need=10000000&minTokens=15000000&maxTokens=20000000' }); await readyCount(1);
    check('Историческая ссылка с точным объёмом нормализует конфликтующий диапазон', await evaluate('state.items[0].id==="910005" && state.filters.need===10000000 && state.filters.minTokens===null && state.filters.maxTokens===null && document.querySelector("#volumeMode").value==="exact" && !document.querySelector("#exactVolumeFields").hidden && document.querySelector("#rangeVolumeFields").hidden && !new URLSearchParams(queryFor(1)).has("minTokens") && !new URLSearchParams(queryFor(1)).has("maxTokens")'));
    await set('#minLotPrice', '1'); await wait('!state.loading && state.filters.minLotPrice===1');
    check('Следующее изменение переписывает старую ссылку без конфликтующих границ', await evaluate('new URLSearchParams(location.search).get("need")==="10000000" && !new URLSearchParams(location.search).has("minTokens") && !new URLSearchParams(location.search).has("maxTokens")'));
    await page.send('Page.navigate', { url: base + '?minTokens=5000000&maxTokens=10000000' }); await readyCount(2);
    check('Ссылка без точного объёма восстанавливает режим диапазона', await evaluate('state.filters.need===0 && document.querySelector("#volumeMode").value==="range" && document.querySelector("#minTokens").value==="5000000" && document.querySelector("#maxTokens").value==="10000000" && document.querySelector("#exactVolumeFields").hidden && !document.querySelector("#rangeVolumeFields").hidden'));
    await click('[data-preset="bulk"]'); await readyCount(1);
    check('Пресет крупного объёма синхронизирует режим диапазона', await evaluate('document.querySelector("#volumeMode").value==="range" && state.filters.need===0 && state.filters.minTokens===10000000 && state.filters.maxTokens===null && !document.querySelector("#rangeVolumeFields").hidden && document.querySelector("#exactVolumeFields").hidden && document.querySelector("details[data-group=budget]").open'));
    await click('#resetBtn'); await readyCount(8);
    check('Сброс возвращает любой объём и скрывает срок', await evaluate('document.querySelector("#volumeMode").value==="any" && document.querySelector("#exactVolumeFields").hidden && document.querySelector("#rangeVolumeFields").hidden && document.querySelector("#durationOptions").hidden'));
    await page.send('Page.navigate', { url: base + '?minDuration=60&maxDuration=60' }); await readyCount(2);
    check('Заданный в ссылке срок раскрывается и без выбора типа', await evaluate('state.filters.offerType==="any" && !document.querySelector("#durationOptions").hidden && document.querySelector("#minDuration").value==="1" && document.querySelector("#maxDuration").value==="1"'));
    await click('#durationPresets [data-minutes="0"]'); await readyCount(8);
    check('Очистка срока для всех типов скрывает дополнительные поля', await evaluate('document.querySelector("#durationOptions").hidden && state.filters.minDuration===null && state.filters.maxDuration===null'));
    await set('#offerType', 'unlimited', 'change'); await readyCount(5);
    check('Любой безлимит также показывает настройку срока', await evaluate('!document.querySelector("#durationOptions").hidden && state.items.every(o=>o.flags.unlimited)'));

    const extraQuery = 'need=5000000&model=deepseek&unitMin=1&unitMax=20000000&unitKnown=1&exactTokens=1&qtyMode=range&qtyMin=1&qtyMax=10&onlyDesc=1&sellersExclude=seller-910001';
    const extraCount = applyFilters(offers, parseFilters(new URLSearchParams(extraQuery))).length;
    await page.send('Page.navigate', { url: base + '?' + extraQuery }); await readyCount(extraCount);
    const extrasState = await run(`return {modelOptions:document.querySelector('#modelChips').closest('details.filter-subdetails').open,precision:document.querySelector('#volumePrecision').open,description:document.querySelector('#onlyDesc').closest('details.filter-subdetails').open,sources:document.querySelector('#sourceOptions').open,groups:Object.fromEntries(['offer','budget','conditions'].map(g=>[g,document.querySelector('details[data-group="'+g+'"]')?.open])),volumeMode:document.querySelector('#volumeMode').value,qtyMode:document.querySelector('#qtyMode').value,qtyRangeHidden:document.querySelector('#qtyRange').hidden,unitKnown:document.querySelector('#unitKnown').checked,exactTokens:document.querySelector('#exactTokens').checked,onlyDesc:document.querySelector('#onlyDesc').checked};`);
    const extrasReady = extrasState.modelOptions && extrasState.precision && extrasState.description && extrasState.sources && extrasState.groups.offer && extrasState.groups.budget && extrasState.groups.conditions && extrasState.volumeMode === 'exact' && extrasState.qtyMode === 'range' && !extrasState.qtyRangeHidden && extrasState.unitKnown && extrasState.exactTokens && extrasState.onlyDesc;
    check('Активные вложенные настройки раскрываются из URL', extrasReady, extrasState);
    await run('const el=document.querySelector("#onlyDesc");el.checked=false;el.dispatchEvent(new Event("change",{bubbles:true}));'); await readyCount(extraCount);
    check('Флажок описаний выключает фильтр и удаляет его из ссылки', await evaluate('state.filters.onlyDesc===false && !document.querySelector("#onlyDesc").checked && !new URLSearchParams(location.search).has("onlyDesc")'));
    await run('const el=document.querySelector("#onlyDesc");el.checked=true;el.dispatchEvent(new Event("change",{bubbles:true}));'); await readyCount(extraCount);
    check('Флажок описаний включает фильтр и сохраняет его в ссылке', await evaluate('state.filters.onlyDesc===true && document.querySelector("#onlyDesc").checked && new URLSearchParams(location.search).get("onlyDesc")==="1"'));
    await click('#savePresetBtn');
    await run('document.querySelector("#presetName").value="Точный объём с условиями";document.querySelector("#savePresetForm").requestSubmit();');
    await wait('document.querySelector("#savedPresetLabel").textContent==="Точный объём с условиями"');
    await click('#resetBtn'); await readyCount(8);
    await run('document.querySelectorAll("#filters details").forEach(el=>el.open=false);');
    await click('#applySavedPreset'); await readyCount(extraCount);
    check('Свой пресет восстанавливает точный режим и раскрывает его условия', await evaluate('document.querySelector("#modelChips").closest("details.filter-subdetails").open && document.querySelector("#volumePrecision").open && document.querySelector("#onlyDesc").closest("details.filter-subdetails").open && document.querySelector("#sourceOptions").open && ["offer","budget","conditions"].every(g=>document.querySelector("details[data-group="+g+"]").open) && document.querySelector("#volumeMode").value==="exact" && state.filters.need===5000000 && state.filters.minTokens===null && state.filters.maxTokens===null && !document.querySelector("#exactVolumeFields").hidden && document.querySelector("#rangeVolumeFields").hidden && document.querySelector("#qtyMode").value==="range" && !document.querySelector("#qtyRange").hidden && document.querySelector("#unitKnown").checked && document.querySelector("#exactTokens").checked && document.querySelector("#onlyDesc").checked'));
    await click('#resetBtn'); await readyCount(8);
    await run('localStorage.setItem("tokenscope_custom_preset",JSON.stringify({name:"Старый безлимит",filters:{unlimitedOnly:true}}));');
    await page.send('Page.reload'); await readyCount(8);
    check('Старый пресет безлимита мигрирует при загрузке', await evaluate('state.customPreset?.name==="Старый безлимит" && state.customPreset.filters.offerType==="unlimited" && !document.querySelector("#applySavedPreset").hidden'));
    await click('#applySavedPreset'); await readyCount(5);
    check('Старый пресет применяет только предложения безлимита', await evaluate('state.filters.offerType==="unlimited" && state.items.length===5 && state.items.every(o=>o.flags.unlimited)'));
    await click('#resetBtn'); await readyCount(8);

    await set('#volumeMode', 'range', 'change');
    await set('#minTokens', '5М'); await readyCount(2);
    await click('[data-preset="hour"]'); await wait('!state.loading && state.filters.offerType==="timed" && state.items.length===2');
    check('Пресет безлимита убирает несовместимый объём', await evaluate('state.filters.need===0 && state.filters.minTokens===null && state.filters.maxTokens===null && state.filters.minDuration===60 && state.filters.maxDuration===60 && document.querySelector("#volumeMode").value==="any" && !document.querySelector("#durationOptions").hidden'));
    await set('#offerType', 'excludeTimed', 'change'); await readyCount(4);
    check('Исключение почасовых оставляет пакеты и безлимит без срока', await evaluate('state.items.every(o=>!(o.flags.unlimited && o.durationMinutes)) && state.items.some(o=>o.flags.unlimited) && state.items.some(o=>o.tokens) && document.querySelector("#durationOptions").hidden'));
    await set('#offerType', 'excludeUnlimited', 'change'); await readyCount(3);
    check('Без безлимита исключает предложения со сроком и без срока', await evaluate('state.items.every(o=>!o.flags.unlimited) && state.items.some(o=>o.flags.credits) && state.filters.minDuration===null && state.filters.maxDuration===null'));
    await page.send('Page.reload'); await readyCount(3);
    check('Исключение безлимита восстанавливается после обновления', await evaluate('document.querySelector("#offerType").value==="excludeUnlimited" && state.filters.offerType==="excludeUnlimited" && document.querySelector("#durationOptions").hidden'));
    await set('#offerType', 'any', 'change'); await readyCount(8);
    check('Все типы возвращают полную выдачу без скрытого срока', await evaluate('state.filters.offerType==="any" && state.filters.minDuration===null && state.filters.maxDuration===null && !new URLSearchParams(location.search).has("offerType")'));
    await set('#offerType', 'credits', 'change');
    const creditsCount = offers.filter((o) => o.accessType === 'credits').length;
    await readyCount(creditsCount);
    check('Отдельный тип кредитов и подписок', await evaluate('state.items.length>0 && state.items.every(o=>o.accessType==="credits")'));

    await click('#resetBtn'); await readyCount(8);
    await run('const d=document.querySelector("#modelChips").closest("details.filter-subdetails");if(!d.open)d.querySelector("summary").click();');
    await click('#modelChips [data-model="claude"]'); await readyCount(5);
    await click('#modelChips [data-model="deepseek"]'); await readyCount(7);
    const chip = await run('const b=[...document.querySelectorAll("#activeChips button")].find(b=>b.textContent.includes("Claude"));b.click();return true;');
    await readyCount(2);
    check('Удаление модели из чипов сохраняет остальные', chip && await evaluate('state.filters.models.length===1 && state.filters.models[0]==="deepseek"'));
    await set('#modelSearch', 'claude');
    check('Поиск модели не меняет выбор и выдачу', await evaluate('document.querySelectorAll("#modelChips button:not([hidden])").length===1 && state.filters.models[0]==="deepseek" && state.items.length===2'));
    await set('#modelSearch', 'нет такой');
    check('У поиска модели есть пустое состояние', await evaluate('!document.querySelector("#modelSearchEmpty").hidden'));

    await click('#resetBtn'); await readyCount(8);
    await set('#offerType', 'timed', 'change'); await readyCount(4);
    check('Сортировка по цене часа', await evaluate('state.items.map(o=>o.id).join(",")==="910003,910002,910007,910001"'));
    const patched = await run('const o={...state.items[0],price:720,pricePerHour:30};patchCards([o]);return {price:document.querySelector(".price").textContent,metric:document.querySelector(".per-m").textContent};');
    check('Фоновое обновление цены работает в плитке', /720/.test(patched.price) && /30/.test(patched.metric), patched);
    await click('.offer [data-act="desc"]'); await wait('!!document.querySelector(".offer-desc") && !document.querySelector(".offer-desc").textContent.includes("Загружаем")');
    await click('[data-view="list"]'); await wait('!!document.querySelector(".offer:not(.tile) .offer-desc")');
    check('Список и плитка сохраняют открытое описание', await evaluate('state.expanded.size===1 && document.querySelectorAll(".offer-desc").length===1 && localStorage.getItem("tokenradar_view")==="list"'));
    await click('[data-view="grid"]');
    await click('.offer [data-act="desc"]');
    check('После сворачивания возвращается квадрат', (await metrics()).every((r)=>Math.abs(r.w-r.h)<=1 && r.inside));

    await click('#resetBtn'); await readyCount(8);
    const hiddenId = await evaluate('state.items[0].id');
    await click('.offer [data-act="hide-offer"]'); await readyCount(7);
    check('Крестик скрывает только одно предложение, не продавца', await evaluate('state.hiddenOffers.length===1 && state.filters.sellersExclude.length===0 && !state.items.some(o=>o.id===' + JSON.stringify(hiddenId) + ') && document.querySelectorAll("#hiddenOffers button").length===1'));
    check('Исключение ID передаётся в API до подсчёта и пагинации', await evaluate('new URLSearchParams(queryFor(1)).get("offersExclude")===' + JSON.stringify(hiddenId) + ' && state.total===7 && state.stats.count===7 && JSON.parse(localStorage.getItem("tokenradar_hidden_offers"))[0].id===' + JSON.stringify(hiddenId)));
    await page.send('Page.reload'); await readyCount(7);
    check('Скрытая карточка не возвращается после перезагрузки', await evaluate('state.hiddenOffers.length===1 && !state.items.some(o=>o.id===' + JSON.stringify(hiddenId) + ')'));
    await click('#resetBtn'); await readyCount(7);
    check('Сброс обычных фильтров сохраняет скрытые предложения', await evaluate('state.hiddenOffers.length===1 && state.total===7'));
    await click('#hiddenOffers button'); await readyCount(8);
    check('Скрытое предложение можно вернуть отдельно', await evaluate('state.hiddenOffers.length===0 && state.items.some(o=>o.id===' + JSON.stringify(hiddenId) + ') && JSON.parse(localStorage.getItem("tokenradar_hidden_offers")).length===0'));
    await click('[data-view="list"]');
    await click('.offer [data-act="hide-offer"]'); await readyCount(7);
    check('Скрытие работает в режиме списка', await evaluate('state.view==="list" && state.hiddenOffers.length===1 && document.querySelectorAll(".offer.tile").length===0'));
    await run('const b=[...document.querySelectorAll("#activeChips button")].find(b=>b.textContent.includes("скрыто предложений"));b.click();'); await readyCount(8);
    check('Чип скрытых предложений возвращает все карточки', await evaluate('state.hiddenOffers.length===0 && state.total===8'));
    await click('.offer [data-act="hide"]'); await readyCount(7);
    check('Отдельная кнопка продавца сохранила прежнее действие', await evaluate('state.hiddenSellers.length===1 && state.hiddenOffers.length===0 && state.filters.sellersExclude.length===1'));
    await click('#hiddenSellers button'); await readyCount(8);
    await click('[data-view="grid"]');
    await set('#volumeMode', 'exact', 'change');
    await set('#needInput', '5М'); await readyCount(1); await wait('!!document.querySelector(".tile-need")');
    for (const width of [320, 390, 600, 960, 961, 1440]) {
      await viewport(width); await sleep(100);
      boxes = await metrics();
      const layout = await evaluate('({width:innerWidth, doc:document.documentElement.scrollWidth, cols:getComputedStyle(document.querySelector("#list")).gridTemplateColumns.split(" ").length})');
      check('Адаптивная квадратная сетка ' + width + ' px', layout.doc <= width && boxes.every((r)=>Math.abs(r.w-r.h)<=1 && r.inside && r.scroll) && (width < 600 ? layout.cols===1 : layout.cols>=2), { ...layout, boxes });
    }
    for (const width of [320, 390]) {
      await viewport(width, 844); await wait('document.querySelector("#filters").inert');
      await click('#filtersToggle'); await wait('document.body.classList.contains("filters-open")'); await sleep(300);
      await run('document.querySelector("details[data-group=budget]").open=true;document.querySelector("#volumeMode").focus();');
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      check('Tab из режима объёма попадает в его видимое поле при ' + width + ' px', await evaluate('document.activeElement.id==="needInput" && document.querySelector("#rangeVolumeFields").hidden'));
      const volumeLayout = await run('return {doc:document.documentElement.scrollWidth,controls:[...document.querySelectorAll("#volumeMode,#exactVolumeFields input,#needPresets button")].map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};})};');
      check('Новые настройки объёма помещаются в шторке ' + width + ' px', volumeLayout.doc <= width && volumeLayout.controls.every(r=>r.width>0 && r.left>=0 && r.right<=width), volumeLayout);
      await click('#filterApply'); await wait('document.querySelector("#filters").inert');
    }
    await viewport(390, 844); await sleep(100);
    check('Закрытые мобильные фильтры исключены из Tab-навигации', await evaluate('document.querySelector("#filters").inert'));
    await click('#filtersToggle');
    await wait('document.body.classList.contains("filters-open")');
    await sleep(300);
    await evaluate('document.querySelector("#filterApply").focus()');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    check('Tab остаётся в открытой шторке', await evaluate('document.querySelector("#filters").contains(document.activeElement) && document.activeElement.id!=="filterApply"'));
    const drawer = await run('const f=document.querySelector("#filters");f.scrollTop=f.scrollHeight;await new Promise(r=>setTimeout(r,100));const h=document.querySelector(".filters-head").getBoundingClientRect();const a=document.querySelector("#filterApply").getBoundingClientRect();return {head:h.top,actionTop:a.top,actionBottom:a.bottom,height:innerHeight,text:document.querySelector("#filterApplyText").textContent,visible:getComputedStyle(document.querySelector("#filterApplyText")).display};');
    check('Мобильная шторка: шапка, результат и кнопка доступны при прокрутке', drawer.head >= 0 && drawer.actionTop >= 0 && drawer.actionBottom <= drawer.height && drawer.visible !== 'none' && /1/.test(drawer.text), drawer);
    await click('#filterApply'); await wait('!document.body.classList.contains("filters-open")');
    check('Показать объявления закрывает шторку', await evaluate('document.querySelector("#filtersToggle").getAttribute("aria-expanded")==="false"'));
    await viewport(1440); await wait('document.querySelector("#filtersToggle").getAttribute("aria-expanded")==="true"');
    await click('#filtersToggle');
    await viewport(390, 844); await sleep(100);
    await click('#filtersToggle'); await wait('document.body.classList.contains("filters-open")');
    check('Мобильные фильтры доступны и при скрытой панели на компьютере', await evaluate('!document.querySelector("#filters").inert && document.querySelector("#filtersToggle").getAttribute("aria-expanded")==="true" && document.querySelector("#filters").getClientRects().length>0'));
    await viewport(1440); await wait('!document.body.classList.contains("filters-open")');
    check('Смена ширины закрывает шторку и возвращает выбор компьютера', await evaluate('document.body.classList.contains("sidebar-collapsed") && getComputedStyle(document.querySelector("#filters")).display==="none" && document.querySelector("#filters").inert && document.querySelector("#filtersToggle").getAttribute("aria-expanded")==="false" && !document.querySelector("#filters").contains(document.activeElement) && getComputedStyle(document.body).overflow!=="hidden"'));
    await click('#filtersToggle');
    await click('#resetBtn'); await readyCount(8);
    await viewport(390, 844); await wait('document.querySelector("#filters").inert');
    await click('#filtersToggle');
    await wait('document.body.classList.contains("filters-open")'); await sleep(300);
    await run('const g=document.querySelector("details[data-group=conditions]");g.open=true;const b=document.querySelector("#inputOutputSeg [data-v=only]");b.scrollIntoView({block:"center"});b.focus();');
    await wait('document.activeElement === document.querySelector("#inputOutputSeg [data-v=only]")');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await readyCount(2);
    const mobileBilling = await run('const s=document.querySelector("#inputOutputSeg");return {width:innerWidth,doc:document.documentElement.scrollWidth,buttons:[...s.querySelectorAll("button")].map(b=>{const r=b.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height};}),selected:document.querySelector("#inputOutputSeg [data-v=only]").getAttribute("aria-pressed"),hint:document.querySelector("#inputOutputHint").textContent};');
    check('Новый фильтр доступен с клавиатуры и помещается на мобильном', mobileBilling.selected==='true' && mobileBilling.doc<=mobileBilling.width && mobileBilling.buttons.every(b=>b.left>=0 && b.right<=390 && b.top>=0 && b.bottom<=844 && b.height>=44), mobileBilling);
    fs.writeFileSync(path.join(__dirname, '../.probe/billing-filter-mobile.png'), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await click('#filterApply'); await wait('!document.body.classList.contains("filters-open")');
    check('Мобильное применение сохраняет новый фильтр и результат', await evaluate('state.filters.inputOutput==="only" && state.items.length===2 && new URLSearchParams(location.search).get("inputOutput")==="only"'));
    const exceptions = page.events.filter((e)=>e.method==='Runtime.exceptionThrown');
    check('Нет ошибок JavaScript в браузере', exceptions.length===0, exceptions.map((e)=>e.params.exceptionDetails.text));
    console.log('\nИтог: ' + passed + '/' + passed + ' проверок пройдено');
  } finally {
    page?.close(); browser?.close(); chrome.kill();
    await new Promise((resolve)=>server.close(resolve));
    server.closeAllConnections();
  }
})().catch((error)=>{ console.error(error.stack || error); process.exitCode=1; server.close(); server.closeAllConnections(); });
