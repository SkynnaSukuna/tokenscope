'use strict';

/**
 * Интерактивный тест UI через CDP: кликает по элементам и проверяет результат.
 * Запуск: node tools/uitest.js
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
const PORT = 9700 + Math.floor(Math.random() * 200);

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
          reject(new Error(raw.slice(0, 300)));
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
  throw new Error('Chrome не ответил');
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

async function evalJs(page, expr) {
  const r = await page.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text);
  }
  return r.result.value;
}

const results = [];
function check(name, ok, info) {
  results.push({ name, ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  → ' + info : ''}`);
}

(async () => {
  if (!CHROME) throw new Error('Chrome/Edge не найден');
  const profile = path.join(process.env.TEMP || '/tmp', 'tr-ui-' + Date.now());
  const chrome = spawn(
    CHROME,
    [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
      '--window-size=1440,1600', 'about:blank',
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

    await page.send('Page.navigate', { url });
    const started = Date.now();
    while (Date.now() - started < 20000) {
      if (page.events.some((e) => e.method === 'Page.loadEventFired')) break;
      await sleep(120);
    }
    await sleep(5000);

    // 1. список загрузился
    const cnt = await evalJs(page, 'document.querySelectorAll(".offer").length');
    check('список лотов отрисован', cnt >= 20, `${cnt} карточек`);

    // 1b. по умолчанию включена плитка: карточки стоят сеткой в несколько колонок
    const gridMode = await evalJs(
      page,
      '(()=>{const l=document.querySelector("#list");const cols=getComputedStyle(l).gridTemplateColumns.split(" ").filter(Boolean).length;return {grid:l.classList.contains("grid"),cols};})()'
    );
    check('плитка по умолчанию', gridMode.grid === true && gridMode.cols >= 2, JSON.stringify(gridMode));
    const filters = await evalJs(page, '(()=>{const rgb=getComputedStyle(document.querySelector("#filterApply")).backgroundColor.match(/[0-9.]+/g).map(Number);return {groups:[...document.querySelectorAll("#filters details.fgroup")].map(el=>el.dataset.group).join(),duplicates:document.querySelectorAll("#quickFilters,[data-quick],#clearAccess").length,volume:document.querySelector("#volumeMode").value,durationHidden:document.querySelector("#durationOptions").hidden,black:getComputedStyle(document.body).backgroundColor==="rgb(0, 0, 0)",green:rgb[0]>=80&&rgb[1]>=180&&rgb[1]>rgb[0]+20&&rgb[1]>rgb[2]+20};})()');
    check('четыре раздела фильтров без дублей', filters.groups === 'offer,budget,seller,conditions' && filters.duplicates === 0 && filters.volume === 'any' && filters.durationHidden, JSON.stringify(filters));
    check('чёрный фон со светло-зелёным акцентом', filters.black && filters.green, JSON.stringify(filters));

    // 2. карточка: аватар, цена за 1М
    const first = await evalJs(
      page,
      '(()=>{const o=document.querySelector(".offer");return {hasAvatar:!!o.querySelector("img.avatar"),perM:o.querySelector(".per-m")?.textContent,price:o.querySelector(".price")?.textContent,rank:o.querySelector(".rank")?.textContent};})()'
    );
    check('карточка: аватар + цена', !!first.hasAvatar && /1М/.test(first.perM || ''), JSON.stringify(first));

    // 3. кнопка «описание»
    const desc = await evalJs(
      page,
      `(async ()=>{
        const card=document.querySelector('.offer');
        card.querySelector('[data-act="desc"]').click();
        await new Promise(r=>setTimeout(r,2500));
        const d=card.querySelector('.offer-desc');
        return d? {len:d.textContent.length, head:d.textContent.slice(0,80)} : null;
      })()`
    );
    check('описание лота подгружается', !!desc && desc.len > 30, desc ? JSON.stringify(desc.head) : 'нет блока');

    // 4. повторный клик сворачивает
    const descClosed = await evalJs(
      page,
      `(async ()=>{
        const card=document.querySelector('.offer');
        card.querySelector('[data-act="desc"]').click();
        await new Promise(r=>setTimeout(r,300));
        return !card.querySelector('.offer-desc');
      })()`
    );
    check('описание сворачивается', descClosed === true);

    // 5. копирование ссылки лота (clipboard может быть недоступен в headless — проверяем вызов без ошибки)
    const copyOk = await evalJs(
      page,
      `(async ()=>{
        const card=document.querySelector('.offer');
        try { card.querySelector('[data-act="copy"]').click(); await new Promise(r=>setTimeout(r,400)); return true; }
        catch(e){ return e.message; }
      })()`
    );
    check('кнопка копирования не падает', copyOk === true, String(copyOk));

    // 6. фильтр «нужно токенов» 10М
    const need = await evalJs(
      page,
      `(async ()=>{
        const mode=document.querySelector('#volumeMode');
        mode.value='exact';
        mode.dispatchEvent(new Event('change',{bubbles:true}));
        const inp=document.querySelector('#needInput');
        inp.value='10000000';
        inp.dispatchEvent(new Event('input',{bubbles:true}));
        await new Promise(r=>setTimeout(r,1500));
        const card=document.querySelector('#needCard');
        return card && !card.hidden ? {plans:card.querySelectorAll('.plan').length,title:document.querySelector('#needTitle').textContent} : null;
      })()`
    );
    check('фильтр «нужно токенов»', !!need && need.plans >= 1, need ? JSON.stringify(need) : 'карточка не появилась');

    // 7. чипы активных фильтров
    const chips = await evalJs(page, 'document.querySelectorAll("#activeChips .chip").length');
    check('чипы активных фильтров', chips >= 1, `${chips} шт`);

    // 8. сегмент бонусов: «только с бонусами»
    const bonus = await evalJs(
      page,
      `(async ()=>{
        document.querySelector('#bonusSeg button[data-v="only"]').click();
        await new Promise(r=>setTimeout(r,1500));
        return {total:document.querySelector('#resultInfo').innerText,
                badges:[...document.querySelectorAll('.offer')].filter(o=>!o.textContent.includes('бонус')).length};
      })()`
    );
    check('фильтр «только с бонусами»', bonus && bonus.badges === 0, bonus ? bonus.total.replace(/\s+/g,' ') : '');

    // 9. чекбокс «убрать 1=1»
    const oneToOne = await evalJs(
      page,
      `(async ()=>{
        document.querySelector('#bonusSeg button[data-v="any"]').click();
        await new Promise(r=>setTimeout(r,800));
        const cb=document.querySelector('#excludeOneToOne');
        cb.click();
        await new Promise(r=>setTimeout(r,1500));
        return {info:document.querySelector('#resultInfo').innerText.replace(/\s+/g,' ')};
      })()`
    );
    check('фильтр «без 1=1» включается', !!oneToOne, oneToOne ? oneToOne.info : '');

    // 10. скрытие продавца
    const hide = await evalJs(
      page,
      `(async ()=>{
        document.querySelector('#excludeOneToOne').click();
        await new Promise(r=>setTimeout(r,800));
        const card=document.querySelector('.offer');
        const name=card.querySelector('.seller-name').textContent;
        card.querySelector('[data-act="hide"]').click();
        await new Promise(r=>setTimeout(r,1500));
        const hidden=[...document.querySelectorAll('#hiddenSellers .chip')].map(c=>c.textContent);
        const gone=![...document.querySelectorAll('.seller-name')].some(s=>s.textContent===name);
        return {name,hidden:hidden.join('|'),gone};
      })()`
    );
    check('скрытие продавца', hide && hide.gone && hide.hidden.includes(hide.name), JSON.stringify(hide));

    // 11. скрытые продавцы сохраняются в localStorage
    const stored = await evalJs(page, 'localStorage.getItem("tokenradar_hidden_sellers") || ""');
    check('скрытие сохраняется', stored.includes(hide ? hide.name : ''), stored.slice(0, 120));

    // 12. сброс фильтров
    const reset = await evalJs(
      page,
      `(async ()=>{
        document.querySelector('#resetBtn').click();
        await new Promise(r=>setTimeout(r,1500));
        const text=document.querySelector('#resultInfo').innerText.replace(/[\\u00a0\\u2007\\u2009\\u202f]/g,' ').replace(/\\s+/g,' ');
        const chips=[...document.querySelectorAll('#activeChips .chip')].filter(c=>!c.textContent.includes('скрыто продавцов')).length;
        return {text, total: document.querySelectorAll('.offer').length, chips};
      })()`
    );
    check('сброс фильтров', !!reset && /Найдено \d/.test(reset.text) && reset.chips === 0, reset ? reset.text + ' · чипов: ' + reset.chips : '');

    // 12б. фильтр наличия присутствует в UI
    const qtyFilter = await evalJs(
      page,
      '(()=>{const s=document.querySelector("#qtyMode"); return s ? [...s.options].map(o=>o.value) : null;})()'
    );
    check('фильтр наличия в UI', Array.isArray(qtyFilter) && qtyFilter.includes('exclude1') && qtyFilter.includes('range'), qtyFilter ? qtyFilter.join(',') : 'нет');

    // 13. скролл-подгрузка «показать ещё»
    const more = await evalJs(
      page,
      `(async ()=>{
        const btn=document.querySelector('#moreBtn');
        if(!btn||btn.hidden) return null;
        btn.click();
        await new Promise(r=>setTimeout(r,2000));
        return document.querySelectorAll('.offer').length;
      })()`
    );
    check('кнопка «показать ещё»', more == null || more > 40, more == null ? 'кнопка скрыта' : `${more} карточек`);

    // 13б. фоновое обновление не сбрасывает пагинацию, прокрутку и описание
    const preserved = await evalJs(
      page,
      `(async ()=>{
        const before=document.querySelectorAll('.offer').length;
        const card=document.querySelector('.offer');
        card.querySelector('[data-act="desc"]').click();
        await new Promise(r=>setTimeout(r,2200));
        const expandedBefore=!!card.querySelector('.offer-desc');
        document.documentElement.style.scrollBehavior='auto';
        window.scrollTo(0, document.body.scrollHeight);
        await new Promise(r=>setTimeout(r,400));
        const scrollBefore=window.scrollY;
        await load({silent:true});
        await new Promise(r=>setTimeout(r,1200));
        return {
          before,
          after:document.querySelectorAll('.offer').length,
          expandedBefore,
          expandedAfter:!!document.querySelector('.offer .offer-desc'),
          scrollBefore,
          scrollAfter:window.scrollY,
          page:state.page
        };
      })()`
    );
    check(
      'фон не сбрасывает страницу и описание',
      preserved &&
        preserved.after === preserved.before &&
        preserved.expandedBefore &&
        preserved.expandedAfter &&
        preserved.page > 1 &&
        Math.abs(preserved.scrollAfter - preserved.scrollBefore) < 2,
      JSON.stringify(preserved)
    );

    // 13в. история не содержит ложного скачка после смены методики
    const histOk = await evalJs(
      page,
      `(async ()=>{
        const d=await (await fetch('/api/history?cat=all')).json();
        const p=d.points.slice(-2);
        if (p.length<2) return {ok:true, len:0};
        const delta=Math.abs((p[1].avg-p[0].avg)/p[0].avg*100);
        return {ok:delta<100, delta:Math.round(delta*10)/10, last:p[1].avg};
      })()`
    );
    check('история без скачка +700%', histOk && histOk.ok, JSON.stringify(histOk));

    // 14. URL синхронизируется
    const needUrl = await evalJs(
      page,
      `(async ()=>{
        const mode=document.querySelector('#volumeMode');
        mode.value='exact';
        mode.dispatchEvent(new Event('change',{bubbles:true}));
        const inp=document.querySelector('#needInput');
        inp.value='5000000';
        inp.dispatchEvent(new Event('input',{bubbles:true}));
        await new Promise(r=>setTimeout(r,1500));
        return location.search;
      })()`
    );
    check('URL хранит состояние', /need=5000000/.test(needUrl || ''), needUrl);

    page.close();
    browser.close();

    const failed = results.filter((r) => !r.ok);
    console.log('\nИтог: ' + (results.length - failed.length) + '/' + results.length + ' проверок пройдено');
    if (failed.length) process.exitCode = 1;
  } finally {
    chrome.kill();
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
