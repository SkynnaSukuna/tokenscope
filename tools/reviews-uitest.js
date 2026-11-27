'use strict';

// Real Chrome/Edge + production browser code; all offers/reviews are deterministic
// local fixtures. No dependencies or external FunPay traffic are required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildOffer, applyDescription } = require('../lib/parser');
const { parseFilters, applyFilters, sortOffers, computeStats, needCost } = require('../lib/filter');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Keep the existing eight offer fixtures intact; only their review summaries vary.
const rows = [
  ['910001', 'Claude unlimited for 1h', 120, 'claude'],
  ['910002', 'Claude безлимит на 3 часа', 150, 'claude'],
  ['910003', 'Claude unlimited for 24 hours', 480, 'claude'],
  ['910004', 'Claude безлимитный API 24/7', 300, 'claude'],
  ['910005', 'DeepSeek 10 млн токенов', 100, 'deepseek'],
  ['910006', 'ChatGPT Plus subscription на месяц', 900, 'gpt'],
  ['910007', 'Claude API доступ', 90, 'claude', 'Unlimited access for 1 hour. Выдача сразу после оплаты.'],
  ['910008', 'DeepSeek 5 млн токенов с бонусом — подробное длинное название предложения для проверки переноса текста на маленьком экране', 60, 'deepseek', 'Автоматическая выдача. Возврат не предусмотрен. Срок действия 30 дней. Бонус 10%.\\n<img src=x onerror="window.descriptionXss=true"> Точный исходный текст & условия.'],
];
const offers = rows.map(([id, titleHtml, price, model, description]) => {
  const offer = buildOffer({ id, titleHtml, price, fields: { model }, sellerId: 'seller-' + id, sellerName: 'Продавец ' + id, stars: 5, reviews: 150, age: 'на сайте 2 года', auto: true, online: true }, '4506');
  applyDescription(offer, { description: description || titleHtml, fields: {} });
  offer.modelLabel = { claude: 'Claude', deepseek: 'DeepSeek', gpt: 'ChatGPT' }[model];
  return offer;
});
// Extra rows are enabled only in the final pagination phase; the original
// eight-fixture scenarios above retain exactly their previous semantics.
const pagedOffers = [...offers, ...Array.from({ length: 77 }, (_, index) => ({ ...offers[7], id: String(920001 + index), title: 'Дополнительный лот 5 млн токенов ' + index, price: 61 + index, seller: { ...offers[3].seller } }))];
let catalogPaging = false;
const now = Date.now();
const known = (counts, extra = {}) => ({ counts, minimumCounts: { ...counts }, checkedRatings: [1, 2, 3, 4, 5], total: Object.values(counts).reduce((sum, value) => sum + value, 0), updatedAt: now, stale: false, ...extra });
const summaries = new Map([
  ['seller-910001', known({ 1: 2, 2: 1, 3: 1, 4: 1, 5: 1 })],
  ['seller-910002', known({ 1: 0, 2: 1, 3: 0, 4: 0, 5: 1 })],
  ['seller-910003', known({ 1: 0, 2: 0, 3: 1, 4: 0, 5: 1 })],
  ['seller-910004', known({ 1: 0, 2: 0, 3: 0, 4: 1, 5: 3 })],
  ['seller-910005', known({ 1: 0, 2: 1, 3: 0, 4: 0, 5: 1 })],
  ['seller-910006', { counts: { 1: null, 2: null, 3: null, 4: null, 5: null }, minimumCounts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, checkedRatings: [], total: null, updatedAt: null }],
  ['seller-910007', known({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 }, { checkedRatings: [] })],
  ['seller-910008', known({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })],
]);
const reviewText = 'Быстро, всё работает. Но не рекомендую: перестал работать.\r\n<img src=x onerror="window.reviewXss=true"> & <script>window.reviewXss=true</script> Точный текст 😀.';
const replyText = 'Помогли, вернули деньги. No refund не подтверждаем.\r\n<img src=x onerror="window.replyXss=true"> Ответ & детали.';
const primaryReviews = [
  { id: 'review-one-a', rating: 1, author: 'Покупатель <img src=x onerror="window.authorXss=true">', date: '2026-11-20', text: reviewText, reply: replyText, product: 'API <img src=x onerror="window.productXss=true">' },
  { id: 'review-one-b', rating: 1, author: 'Покупатель 2', date: '2026-11-21', text: 'Не работает. Продавец не отвечает.', reply: null, product: 'Claude API' },
  { id: 'review-two', rating: 2, author: 'Покупатель 3', date: '2026-11-22', text: 'Медленно, но помогли. Поисковый маркер: сапфир.', reply: 'Вернули деньги.', product: 'Claude API' },
  { id: 'review-three', rating: 3, author: 'Покупатель 4', date: '2026-11-23', text: 'Работает с перебоями, отзыв на три звезды.', reply: null, product: 'Claude API' },
  { id: 'review-four', rating: 4, author: 'Покупатель 5', date: '2026-11-24', text: 'Всё работает, быстро помогли.', reply: null, product: 'Claude API' },
  { id: 'review-five', rating: 5, author: 'Покупатель 6', date: '2026-11-25', text: 'Быстро! Рекомендую, всё работает.', reply: 'Спасибо за отзыв!', product: 'Claude API' },
];
const reviewRequests = [];
let offerRequests = 0;
const offerQueries = [];
let retryFailures = 1;
const desc = { totalInScope: offers.length, loadedInScope: offers.length, queued: 0, active: 0, errors: 0 };
const staticFiles = { '/': 'index.html', '/config.js': 'config.js', '/api.js': 'api.js', '/app.js': 'app.js', '/description.js': 'description.js', '/review-highlights.js': 'review-highlights.js', '/reviews.js': 'reviews.js', '/styles.css': 'styles.css' };
function cursorFor(seller, sort, rating, offset) {
  return Buffer.from(JSON.stringify({ seller, sort, rating, offset })).toString('base64url');
}
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
  if (url.pathname === '/api/meta') return json({ total: offers.length, updatedAt: now, categories: [{ id: '4506', name: 'Тестовая категория', color: '#ff7a59', count: offers.length }], models: ['claude', 'deepseek', 'gpt'].map((name) => ({ name, label: { claude: 'Claude', deepseek: 'DeepSeek', gpt: 'ChatGPT' }[name], count: offers.filter((offer) => offer.model === name).length })), desc });
  if (url.pathname === '/api/offers') {
    offerRequests++;
    const filters = parseFilters(url.searchParams);
    offerQueries.push(url.search);
    const source = catalogPaging ? pagedOffers : offers;
    const allItems = sortOffers(applyFilters(source, filters, { reviewSummaryFor: (sellerId) => summaries.get(String(sellerId)) }), filters).map((offer) => ({ ...offer, seller: { ...offer.seller, reviewSummary: summaries.get(String(offer.seller.id)) }, needCost: needCost(offer, filters.need) }));
    const pages = Math.max(1, Math.ceil(allItems.length / filters.pageSize));
    const currentPage = Math.min(filters.page, pages);
    const items = allItems.slice((currentPage - 1) * filters.pageSize, currentPage * filters.pageSize);
    return json({ total: allItems.length, page: currentPage, pages, pageSize: filters.pageSize, items, stats: computeStats(allItems, filters), desc, history: [], updatedAt: now, reviewCheck: { active: filters.noReviewStars?.length > 0, totalSellers: 8, checkedSellers: 6, pendingSellers: catalogPaging ? 1 : 0, failedSellers: 2, queued: catalogPaging ? 1 : 0, activeRequests: 0 } });
  }
  if (url.pathname === '/api/offer') { const offer = offers.find((item) => item.id === url.searchParams.get('id')); return json({ offer, description: offer?.description || '' }); }
  if (url.pathname === '/api/history') return json({ points: [] });
  if (url.pathname === '/api/reviews') {
    const sellerId = url.searchParams.get('seller');
    const sort = url.searchParams.get('sort') || 'worst';
    const rating = Number(url.searchParams.get('rating') || 0);
    const cursor = url.searchParams.get('cursor') || '';
    reviewRequests.push({ sellerId, sort, rating, cursor, refresh: url.searchParams.get('refresh') });
    if (!summaries.has(sellerId)) return json({ error: 'Неизвестный продавец' }, 404);
    if (sellerId === 'seller-910007' && retryFailures-- > 0) return json({ sellerId, items: [], hasMore: false, nextCursor: null, summary: { ...summaries.get(sellerId), error: 'Тестовая ошибка отзывов' }, error: 'Тестовая ошибка отзывов' }, 503);
    let offset = 0;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        assert.equal(decoded.seller, sellerId); assert.equal(decoded.sort, sort); assert.equal(decoded.rating, rating);
        assert.ok(Number.isInteger(decoded.offset) && decoded.offset > 0);
        offset = decoded.offset;
      } catch { return json({ error: 'Курсор относится к другому фильтру' }, 400); }
    }
    let source = sellerId === 'seller-910001' ? [...primaryReviews] : sellerId === 'seller-910008' ? [] : [{ id: sellerId + '-review', rating: 5, author: 'Тестовый покупатель', date: '2026-11-25', text: 'Всё работает. Быстро!', reply: null, product: 'API' }];
    if (rating) source = source.filter((item) => item.rating === rating);
    source.sort(sort === 'best' ? (a, b) => b.rating - a.rating || b.date.localeCompare(a.date) : sort === 'newest' ? (a, b) => b.date.localeCompare(a.date) : (a, b) => a.rating - b.rating || a.date.localeCompare(b.date));
    const nextOffset = Math.min(source.length, offset + 2);
    // FunPay pages may overlap: the browser must deduplicate by stable review id.
    const items = source.slice(Math.max(0, offset - (offset ? 1 : 0)), nextOffset);
    const hasMore = nextOffset < source.length;
    return json({ sellerId, items, summary: summaries.get(sellerId), hasMore, nextCursor: hasMore ? cursorFor(sellerId, sort, rating, nextOffset) : null });
  }
  const file = staticFiles[url.pathname];
  if (!file) { response.writeHead(404); return response.end(); }
  response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8');
  response.end(fs.readFileSync(path.join(__dirname, '../public', file)));
});

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url); this.seq = 0; this.pending = new Map(); this.events = [];
    this.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      } else if (message.method) this.events.push(message);
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
function check(name, condition, detail) { assert.ok(condition, name + ': ' + JSON.stringify(detail)); passed++; console.log('PASS ' + name + (detail ? ' → ' + JSON.stringify(detail) : '')); }

(async () => {
  assert.ok(CHROME, 'Chrome/Edge не найден');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const debugPort = 10000 + Math.floor(Math.random() * 150);
  const profile = path.join(process.env.TEMP || '/tmp', 'tr-reviews-' + Date.now());
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let browser, page;
  try {
    let version;
    for (let attempt = 0; attempt < 60; attempt++) { try { version = await (await fetch('http://127.0.0.1:' + debugPort + '/json/version')).json(); break; } catch { await sleep(100); } }
    assert.ok(version, 'Chrome не ответил');
    browser = new Cdp(version.webSocketDebuggerUrl); await browser.ready();
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json();
    page = new Cdp(targets.find((target) => target.id === targetId).webSocketDebuggerUrl); await page.ready();
    await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
    const evaluate = async (expression) => {
      const result = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const run = (body) => evaluate('(async()=>{' + body + '})()');
    const wait = async (expression) => { for (let attempt = 0; attempt < 120; attempt++) { if (await evaluate(expression)) return; await sleep(50); } throw new Error('Не дождались: ' + expression); };
    const click = (selector) => evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()');
    const set = (selector, value, event = 'input') => run('const el=document.querySelector(' + JSON.stringify(selector) + ');el.value=' + JSON.stringify(value) + ';el.dispatchEvent(new Event(' + JSON.stringify(event) + ',{bubbles:true}));');
    const viewport = (width, height = 1100) => page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    const ids = () => evaluate('state.items.map(offer=>offer.id).sort()');
    const ready = async (expected) => wait('typeof state!=="undefined" && !state.loading && !document.querySelector("#list .skeleton") && JSON.stringify(state.items.map(offer=>offer.id).sort())===' + JSON.stringify(JSON.stringify([...expected].sort())));
    const allIds = offers.map((offer) => offer.id);
    const reset = async () => { await click('#resetBtn'); await ready(allIds); };
    const expectedFor = (ratings) => offers.filter((offer) => {
      const summary = summaries.get(offer.seller.id);
      return ratings.every((rating) => summary.checkedRatings.includes(rating) && summary.counts[rating] === 0 && !summary.stale && !summary.error);
    }).map((offer) => offer.id);
    const checkedRatings = () => evaluate('[...document.querySelectorAll("[data-no-review-star]:checked")].map(input=>Number(input.dataset.noReviewStar))');
    const reviewIds = () => evaluate('[...document.querySelectorAll("#reviewsList > .feedback-card")].map(card=>card.dataset.reviewId)');
    const reviewReady = (expected) => wait('document.querySelector("#reviewsDialog").open && document.querySelector("#reviewsList").getAttribute("aria-busy")==="false" && JSON.stringify([...document.querySelectorAll("#reviewsList > .feedback-card")].map(card=>card.dataset.reviewId))===' + JSON.stringify(JSON.stringify(expected)));
    const openReviews = async (offerId, expected) => { await click('.offer[data-id="' + offerId + '"] [data-act="reviews"]'); await reviewReady(expected); };
    const escape = async () => {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await wait('!document.querySelector("#reviewsDialog").open && !document.body.classList.contains("reviews-open")');
    };
    await viewport(1440);
    await page.send('Page.navigate', { url: base }); await ready(allIds);
    check('Все восемь предложений и кнопки отзывов доступны', await evaluate('document.querySelectorAll("#list .offer").length===8 && document.querySelectorAll("#list [data-act=reviews]").length===8'));
    check('Скрипты отзывов загружены без 404', await evaluate('typeof TokenRadarReviewHighlights?.render==="function" && !!document.querySelector("#reviewsDialog")'));
    check('Проверка отзывов находится в дополнительных настройках продавца', await evaluate('!!document.querySelector("details[data-group=seller] details#reviewOptions") && document.querySelectorAll("#reviewOptions [data-no-review-star]").length===3 && !document.querySelector("#quickFilters,[data-quick]")'));
    await click('details[data-group="seller"] > summary');
    await click('#reviewOptions > summary');

    for (const rating of [1, 2, 3]) {
      await reset(); await click('#noReviewStar' + rating); await ready(expectedFor([rating]));
      const actual = await ids();
      check('Чекбокс исключения ' + rating + '★ проверяет весь summary', JSON.stringify(actual) === JSON.stringify(expectedFor([rating]).sort()) && (await checkedRatings()).join() === String(rating), actual);
      check('Неизвестные отзывы не считаются нулём для ' + rating + '★', !actual.includes('910006') && !actual.includes('910007'));
    }
    for (const ratings of [[1, 2], [1, 3], [2, 3], [1, 2, 3]]) {
      await reset();
      for (const rating of ratings) await click('#noReviewStar' + rating);
      await ready(expectedFor(ratings));
      check('Комбинация исключений ' + ratings.join('+') + '★ применяется одновременно', JSON.stringify(await ids()) === JSON.stringify(expectedFor(ratings).sort()), await ids());
    }
    check('Комбинация звёзд записана в URL', await evaluate('new URLSearchParams(location.search).get("noReviewStars")==="1,2,3"'));
    await page.send('Page.reload'); await ready(expectedFor([1, 2, 3]));
    check('URL reload восстанавливает все чекбоксы и раскрывает настройки отзывов', (await checkedRatings()).join() === '1,2,3' && await evaluate('document.querySelector("#reviewOptions").open && document.querySelector("details[data-group=seller]").open'));
    await run('const chip=[...document.querySelectorAll("#activeChips button")].find(button=>button.textContent.includes("2★"));if(!chip)throw new Error("Нет чипа 2★");chip.click();');
    await ready(expectedFor([1, 3]));
    check('Удаление чипа 2★ сохраняет остальные исключения', (await checkedRatings()).join() === '1,3' && await evaluate('new URLSearchParams(location.search).get("noReviewStars")==="1,3"'));
    await click('#savePresetBtn');
    await run('document.querySelector("#presetName").value="Без оценок 1 и 3";document.querySelector("#savePresetForm").requestSubmit();');
    await wait('document.querySelector("#savedPresetLabel").textContent==="Без оценок 1 и 3"');
    await reset();
    await run('document.querySelector("#reviewOptions").open=false;document.querySelector("details[data-group=seller]").open=false;');
    await click('#applySavedPreset'); await ready(expectedFor([1, 3]));
    check('Свой пресет восстанавливает независимые оценки и раскрывает их настройки', (await checkedRatings()).join() === '1,3' && await evaluate('document.querySelector("#reviewOptions").open && document.querySelector("details[data-group=seller]").open && new URLSearchParams(location.search).get("noReviewStars")==="1,3"'));
    await reset();
    check('Reset снимает все исключения отзывов и очищает URL', (await checkedRatings()).length === 0 && await evaluate('!new URLSearchParams(location.search).has("noReviewStars")'));
    for (const rating of [1, 2, 3]) await click('#noReviewStar' + rating);
    await ready(expectedFor([1, 2, 3]));
    check('Три независимых чекбокса исключают все низкие оценки', (await checkedRatings()).join() === '1,2,3');
    for (const rating of [1, 2, 3]) await click('#noReviewStar' + rating);
    await ready(allIds);
    check('Снятие трёх чекбоксов возвращает продавцов без скрытого исключения', (await checkedRatings()).length === 0 && await evaluate('state.filters.noReviewStars.length===0 && !new URLSearchParams(location.search).has("noReviewStars")'));
    await set('#volumeMode', 'exact', 'change');
    await set('#needInput', '10М'); await ready(['910005']);
    await click('#noReviewStar1'); await ready(['910005']);
    check('Исключение отзывов совместимо с точным need', await evaluate('state.filters.need===10000000 && state.items.length===1 && state.items[0].tokens===10000000 && state.filters.noReviewStars.join() === "1"'));
    await click('#noReviewStar2'); await ready([]);
    check('Точный need не обходит исключение плохих отзывов', await evaluate('state.total===0 && !document.querySelector("#empty").hidden'));
    await reset();
    const freshSummary = summaries.get('seller-910004');
    summaries.set('seller-910004', { ...freshSummary, stale: true });
    for (const rating of [1, 2, 3]) await click('#noReviewStar' + rating);
    await ready(expectedFor([1, 2, 3]));
    check('Устаревшее подтверждение нулей не проходит фильтр', !(await ids()).includes('910004'));
    await reset();
    summaries.set('seller-910004', { ...freshSummary, error: 'Не удалось обновить отзывы' });
    for (const rating of [1, 2, 3]) await click('#noReviewStar' + rating);
    await ready(expectedFor([1, 2, 3]));
    check('Summary с ошибкой не подтверждает отсутствие плохих отзывов', !(await ids()).includes('910004'));
    summaries.set('seller-910004', freshSummary);
    await reset();

    const beforeOpen = reviewRequests.length;
    await openReviews('910001', ['review-one-a', 'review-one-b']);
    check('Viewer открывается с худшими отзывами по умолчанию', reviewRequests[beforeOpen]?.sort === 'worst' && reviewRequests[beforeOpen]?.rating === 0 && await evaluate('document.querySelector("#reviewsSort").value==="worst" && document.querySelector("#reviewsRating").value==="0"'));
    check('Native dialog получает фокус и блокирует фон', await evaluate('document.querySelector("#reviewsDialog").contains(document.activeElement) && document.body.classList.contains("reviews-open")'));
    check('В summary показан общий объём отзывов', await evaluate('document.querySelector("#reviewsSummaryTotal").textContent.includes("6")'));
    const exact = await run('const card=document.querySelector("[data-review-id=review-one-a]");const body=card.querySelector(".feedback-text");const reply=card.querySelector(".feedback-reply .feedback-text,.feedback-reply-text")||card.querySelector(".feedback-reply");return {text:body.textContent,reply:reply.textContent,positive:body.querySelectorAll("mark.review-positive").length,negative:body.querySelectorAll("mark.review-negative").length,replyMarks:reply.querySelectorAll("mark").length,safe:!document.querySelector("#reviewsDialog img,#reviewsDialog script")&&!window.reviewXss&&!window.replyXss&&!window.authorXss&&!window.productXss};');
    check('Текст и CRLF отзыва сохранены точно после подсветки', exact.text === reviewText, exact);
    check('Ответ продавца сохранён и отдельно выделен', exact.reply === replyText && exact.replyMarks > 0, exact);
    check('Положительные и отрицательные фразы подсвечены безопасно', exact.positive > 0 && exact.negative > 0 && exact.safe, exact);
    await click('#reviewsMore'); await reviewReady(['review-one-a', 'review-one-b', 'review-two', 'review-three']);
    check('More передаёт непрозрачный cursor и удаляет повтор страницы', !!reviewRequests.at(-1).cursor && new Set(await reviewIds()).size === 4, reviewRequests.at(-1));
    await click('#reviewsMore'); await reviewReady(primaryReviews.map((review) => review.id));
    check('Все страницы объединены без дубликатов, More скрыт в конце', new Set(await reviewIds()).size === 6 && await evaluate('document.querySelector("#reviewsMore").hidden'));
    const beforeSearch = reviewRequests.length;
    await set('#reviewsSearch', 'сапфир'); await reviewReady(['review-two']);
    check('Поиск фильтрует загруженные отзывы по тексту', reviewRequests.length === beforeSearch);
    await set('#reviewsSearch', ''); await reviewReady(primaryReviews.map((review) => review.id));
    await set('#reviewsSort', 'best', 'change'); await reviewReady(['review-five', 'review-four']);
    check('Сортировка best запрашивается с начала, без старого cursor', reviewRequests.at(-1).sort === 'best' && !reviewRequests.at(-1).cursor);
    await set('#reviewsSort', 'newest', 'change'); await reviewReady(['review-five', 'review-four']);
    check('Сортировка newest передаётся API', reviewRequests.at(-1).sort === 'newest' && !reviewRequests.at(-1).cursor);
    await set('#reviewsRating', '1', 'change'); await reviewReady(['review-one-b', 'review-one-a']);
    check('Фильтр оценки 1★ сохраняет сортировку и начинает новую страницу', reviewRequests.at(-1).rating === 1 && reviewRequests.at(-1).sort === 'newest' && !reviewRequests.at(-1).cursor);
    await set('#reviewsRating', '2', 'change'); await reviewReady(['review-two']);
    check('Фильтр оценки 2★ показывает только выбранные отзывы', reviewRequests.at(-1).rating === 2 && await evaluate('document.querySelectorAll("#reviewsList > .feedback-card").length===1'));
    await set('#reviewsRating', '0', 'change'); await reviewReady(['review-five', 'review-four']);
    await escape();
    check('Escape закрывает viewer, возвращает фокус и разблокирует фон', await evaluate('!document.body.classList.contains("reviews-open") && document.activeElement.dataset.act==="reviews" && document.activeElement.closest(".offer")?.dataset.id==="910001"'));
    await openReviews('910001', ['review-one-a', 'review-one-b']);
    check('Повторное открытие возвращает default worst и все оценки', await evaluate('document.querySelector("#reviewsSort").value==="worst" && document.querySelector("#reviewsRating").value==="0" && document.querySelector("#reviewsSearch").value===""'));
    await click('#reviewsClose'); await wait('!document.querySelector("#reviewsDialog").open && !document.body.classList.contains("reviews-open")');
    await openReviews('910008', []);
    check('Продавец без отзывов показывает подтверждённый ноль', await evaluate('document.querySelector("#reviewsSummary").textContent.includes("0") && document.querySelector("#reviewsMore").hidden && document.querySelector("#reviewsError").hidden && document.querySelector("#reviewsStatus").textContent.length>0'));
    await escape();
    await openReviews('910006', ['seller-910006-review']);
    check('Неизвестные счётчики показаны прочерком, а не нулём', await evaluate('document.querySelector("#reviewsSummaryTotal").textContent.includes("—") && [...document.querySelectorAll("#reviewsSummary b")].every(el=>el.textContent==="—")'));
    await escape();
    await click('.offer[data-id="910007"] [data-act="reviews"]');
    await wait('document.querySelector("#reviewsDialog").open && !document.querySelector("#reviewsError").hidden');
    check('Ошибка API показана с доступным Retry, без ложного нуля', await evaluate('document.querySelector("#reviewsErrorText").textContent.includes("Тестовая ошибка") && !document.querySelector("#reviewsRetry").hidden'));
    await click('#reviewsRetry'); await reviewReady(['seller-910007-review']);
    check('Retry восстанавливает загрузку отзывов после ошибки', reviewRequests.at(-1).refresh === '1' && await evaluate('document.querySelector("#reviewsError").hidden && document.querySelectorAll("#reviewsList > .feedback-card").length===1'));
    check('Неподтверждённые нули в summary остаются неизвестными', await evaluate('[...document.querySelectorAll("#reviewsSummary [data-review-rating]")].filter(el=>Number(el.dataset.reviewRating)<=3).every(el=>el.querySelector("b").textContent==="—")'));
    await escape();

    for (const width of [320, 390, 1440]) {
      await viewport(width, width < 600 ? 844 : 1100);
      const tiles = await run('return [...document.querySelectorAll("#list .offer")].map(card=>{const r=card.getBoundingClientRect();const actions=card.querySelector(".tile-actions").getBoundingClientRect();return {width:r.width,height:r.height,actionsInside:actions.bottom<=r.bottom-1 && actions.left>=r.left && actions.right<=r.right,scroll:card.scrollHeight<=card.clientHeight+1};});');
      check('Квадратные плитки с кнопкой отзывов помещаются в ' + width + ' px', tiles.length===8 && tiles.every(tile=>Math.abs(tile.width-tile.height)<=1 && tile.actionsInside && tile.scroll), tiles[0]);
      await openReviews('910001', ['review-one-a', 'review-one-b']);
      const geometry = await run('const dialog=document.querySelector("#reviewsDialog");const rect=dialog.getBoundingClientRect();const controls=["reviewsClose","reviewsSort","reviewsRating","reviewsSearch"].map(id=>{const el=document.getElementById(id);const r=el.getBoundingClientRect();return {id,left:r.left,right:r.right,top:r.top,bottom:r.bottom};});return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,clientWidth:dialog.clientWidth,scrollWidth:dialog.scrollWidth,controls};');
      check('Viewer помещается в ' + width + ' px без горизонтального скролла', geometry.left >= -1 && geometry.right <= width + 1 && geometry.top >= -1 && geometry.bottom <= geometry.height + 1 && geometry.scrollWidth <= geometry.clientWidth + 1 && geometry.documentWidth <= width && geometry.controls.every((item) => item.left >= geometry.left && item.right <= geometry.right + 1), geometry);
      await evaluate('document.querySelector("#reviewsClose").focus()');
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
      check('Фокус Tab остаётся в диалоге при ' + width + ' px', await evaluate('document.querySelector("#reviewsDialog").contains(document.activeElement)'));
      await escape();
    }
    const exceptions = page.events.filter((event) => event.method === 'Runtime.exceptionThrown');
    check('Нет необработанных ошибок JavaScript', exceptions.length === 0, exceptions.map((event) => event.params.exceptionDetails.text));
    const missingScripts = page.events.filter((event) => event.method === 'Network.responseReceived' && /\/(?:reviews|review-highlights)\.js(?:\?|$)/.test(event.params.response.url) && event.params.response.status !== 200);
    check('Новые static JS routes не возвращают 404', missingScripts.length === 0, missingScripts);
    console.log('\nИтог: ' + passed + '/' + passed + ' проверок пройдено; API offers requests=' + offerRequests + ', reviews requests=' + reviewRequests.length);
  } catch (error) {
    console.error('Review request trace:', JSON.stringify(reviewRequests));
    if (page) {
      const diagnostic = await page.send('Runtime.evaluate', { expression: '({open:document.querySelector("#reviewsDialog")?.open,errorHidden:document.querySelector("#reviewsError")?.hidden,error:document.querySelector("#reviewsErrorText")?.textContent,status:document.querySelector("#reviewsStatus")?.textContent,busy:document.querySelector("#reviewsList")?.getAttribute("aria-busy"),ids:[...document.querySelectorAll("#reviewsList > .feedback-card")].map(el=>el.dataset.reviewId)})', returnByValue: true });
      console.error('Viewer state:', JSON.stringify(diagnostic.result?.value));
    }
    throw error;
  } finally {
    page?.close(); browser?.close(); chrome.kill();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; server.closeAllConnections(); server.close(); });
