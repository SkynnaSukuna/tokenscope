'use strict';

/* =========================================================
   TokenScope — client
   ========================================================= */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const HIDDEN_KEY = 'tokenradar_hidden_sellers';
const HIDDEN_OFFERS_KEY = 'tokenradar_hidden_offers';
const VIEW_KEY = 'tokenradar_view';
const SIDEBAR_KEY = 'tokenradar_sidebar_collapsed';
const CUSTOM_PRESET_KEY = 'tokenscope_custom_preset';
const PAGE_SIZE = 40;
// Resolve at request time so the live and snapshot adapters share every call site.
const apiFetch = (input, options) => window.TokenScopeAPI?.fetch
  ? window.TokenScopeAPI.fetch(input, options)
  : fetch(input, options);

const DEFAULTS = {
  cats: [],
  models: [],
  q: '',
  minStars: 0,
  minReviews: 0,
  noReviewStars: [],
  minAgeMonths: 0,
  auto: false,
  online: false,
  noRateLimited: false,
  noCredits: false,
  offerType: 'any',
  minDuration: null,
  maxDuration: null,
  bonus: 'any',
  oneToOne: 'any',
  inputOutput: 'any',
  refund: 'any',
  onlyDesc: false,
  minTokens: null,
  maxTokens: null,
  minPriceM: null,
  maxPriceM: null,
  minLotPrice: null,
  maxLotPrice: null,
  sellersExclude: [],
  unitMin: null,
  unitMax: null,
  unitKnown: false,
  exactTokens: false,
  qtyMode: 'any',
  qtyMin: null,
  qtyMax: null,
  need: 0,
  sort: 'priceM',
  pageSize: PAGE_SIZE,
};

const state = {
  view: 'grid',
  durationUnit: 60,
  volumeMode: 'any',
  filterUiReady: false,
  filters: cloneFilters(DEFAULTS),
  appliedFilters: null,
  hiddenSellers: [],
  hiddenOffers: [],
  expanded: new Set(),
  meta: null,
  items: [],
  stats: null,
  total: 0,
  pages: 0,
  page: 1,
  history: [],
  loading: false,
  reqId: 0,
  desc: null,
  descCache: new Map(),
  toastTimer: null,
  enrichTimer: null,
  reviewTimer: null,
  reviewCheck: null,
  deploymentMode: null,
  customPreset: null,
  cancelVolumeInputs: null,
};

/* ---------- helpers ---------- */

function normalizeReviewStars(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 3))].sort((a, b) => a - b);
}

function cloneFilters(filters = DEFAULTS) {
  return {
    ...filters,
    cats: [...filters.cats],
    models: [...filters.models],
    sellersExclude: [...filters.sellersExclude],
    noReviewStars: normalizeReviewStars(filters.noReviewStars),
  };
}

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtCount(n) {
  if (n == null || !isFinite(n)) return '—';
  return Math.round(n).toLocaleString('ru-RU');
}

function fmtMoney(n) {
  if (n == null || !isFinite(n)) return '—';
  if (n >= 1000) return Math.round(n).toLocaleString('ru-RU') + ' ₽';
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
}

function fmtPriceM(n) {
  if (n == null || !isFinite(n)) return '—';
  if (n >= 100) return Math.round(n).toLocaleString('ru-RU') + ' ₽';
  if (n >= 1) return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
  if (n >= 0.01) return n.toLocaleString('ru-RU', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) + ' ₽';
  return n.toPrecision(2).replace('.', ',') + ' ₽';
}

function fmtTokens(n) {
  if (n == null || !isFinite(n)) return '—';
  const units = [
    [1e12, 'трлн'],
    [1e9, 'млрд'],
    [1e6, 'млн'],
    [1e3, 'тыс'],
  ];
  for (const [v, u] of units) {
    if (n >= v) {
      const x = n / v;
      const s = Number.isInteger(x) ? String(x) : x.toFixed(x >= 10 ? 1 : 2).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');
      return s + ' ' + u;
    }
  }
  return fmtCount(n);
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function parseHuman(s) {
  if (s == null) return null;
  const raw = String(s).trim().toLowerCase().replace(/\s+/g, '');
  if (!raw) return null;
  const m = /^(\d+(?:[.,]\d+)?|[.,]\d+)(кк|к|м|тыс|млн|млрд|kk|k|m|b)?$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  const mult = { 'к': 1e3, 'k': 1e3, 'тыс': 1e3, 'кк': 1e6, 'kk': 1e6, 'м': 1e6, 'млн': 1e6, 'm': 1e6, 'млрд': 1e9, 'b': 1e9 }[m[2] || ''] || 1;
  return Number.isFinite(n * mult) ? n * mult : null;
}

function fmtDuration(minutes) {
  if (!(minutes > 0)) return 'срок не указан';
  const fmt = (n) => n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  if (minutes >= 1440 && minutes % 1440 === 0) return fmt(minutes / 1440) + ' дн.';
  if (minutes >= 60 && minutes % 60 === 0) return fmt(minutes / 60) + ' ч';
  return fmt(minutes) + ' мин';
}

const OFFER_TYPES = {
  any: 'Все предложения', tokens: 'Пакеты токенов', unlimited: 'Любой безлимит',
  timed: 'Безлимит на время', excludeTimed: 'Без безлимита на время', excludeUnlimited: 'Без безлимита (unlim / unlimited)', credits: 'Кредиты и подписки',
};

function priceMetric(o) {
  if (o.pricePerHour != null) return '<b>' + fmtMoney(o.pricePerHour) + '</b> за час';
  if (o.pricePerM != null) return '<b>' + fmtPriceM(o.pricePerM) + '</b> за 1М';
  return '<span class="price-unavailable">' + (o.flags.unlimited ? 'цена за весь срок' : 'цена за 1М не определена') + '</span>';
}

function volumeMetric(o) {
  if (o.flags.unlimited) return 'Безлимит · ' + fmtDuration(o.durationMinutes);
  if (o.tokens) return fmtTokens(o.tokens) + ' токенов';
  if (o.accessType === 'credits' || o.flags.credits) return 'Кредиты / подписка';
  return 'Объём не распознан';
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function starsHtml(n) {
  let out = '';
  for (let i = 1; i <= 5; i++) out += `<span class="${i <= n ? '' : 'off'}">★</span>`;
  return `<span class="stars" title="${n} из 5">${out}</span>`;
}

function avatarUrl(seller) {
  if (seller.avatar) return seller.avatar;
  const letter = esc((seller.name || '?').trim().charAt(0).toUpperCase() || '?');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><rect width="44" height="44" rx="22" fill="#171717"/><text x="22" y="29" font-family="Arial" font-size="18" fill="#b7f59a" text-anchor="middle">${letter}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

/* ---------- url state ---------- */

function loadHidden() {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
    if (Array.isArray(raw)) state.hiddenSellers = raw.filter((x) => x && x.id);
  } catch {
    state.hiddenSellers = [];
  }
}

function saveHidden() {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(state.hiddenSellers));
  } catch {
    /* ignore */
  }
}

function loadHiddenOffers() {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_OFFERS_KEY) || '[]');
    if (Array.isArray(raw)) {
      const unique = new Map();
      for (const offer of raw) {
        if (!offer || typeof offer.id !== 'string' || !offer.id) continue;
        unique.set(offer.id, { id: offer.id, title: typeof offer.title === 'string' ? offer.title : offer.id });
      }
      state.hiddenOffers = [...unique.values()];
    }
  } catch {
    state.hiddenOffers = [];
  }
}

function saveHiddenOffers() {
  try {
    localStorage.setItem(HIDDEN_OFFERS_KEY, JSON.stringify(state.hiddenOffers));
  } catch {
    /* ignore */
  }
}

function readUrl() {
  const sp = new URLSearchParams(location.search);
  const f = cloneFilters();
  const list = (k) => (sp.get(k) || '').split(',').filter(Boolean);
  const n = (k) => {
    const v = sp.get(k);
    if (v == null || v === '') return null;
    const x = parseFloat(String(v).replace(',', '.'));
    return isFinite(x) ? x : null;
  };
  f.cats = list('cat');
  f.models = list('model');
  f.q = sp.get('q') || '';
  f.minStars = n('minStars') || 0;
  f.minReviews = n('minReviews') || 0;
  f.noReviewStars = normalizeReviewStars(list('noReviewStars'));
  f.minAgeMonths = n('minAgeMonths') || 0;
  f.auto = sp.get('auto') === '1';
  f.online = sp.get('online') === '1';
  f.noRateLimited = sp.get('noRateLimited') === '1';
  f.noCredits = sp.get('noCredits') === '1';
  const type = sp.get('offerType') || (sp.get('unlimitedOnly') === '1' ? 'unlimited' : 'any');
  f.offerType = Object.hasOwn(OFFER_TYPES, type) ? type : 'any';
  f.minDuration = n('minDuration') > 0 ? n('minDuration') : null;
  f.maxDuration = n('maxDuration') > 0 ? n('maxDuration') : null;
  f.bonus = sp.get('bonus') || 'any';
  f.oneToOne = sp.get('oneToOne') || 'any';
  f.inputOutput = ['only', 'exclude'].includes(sp.get('inputOutput')) ? sp.get('inputOutput') : 'any';
  f.refund = sp.get('refund') || 'any';
  f.onlyDesc = sp.get('onlyDesc') === '1';
  f.minTokens = n('minTokens');
  f.maxTokens = n('maxTokens');
  f.minPriceM = n('minPriceM');
  f.maxPriceM = n('maxPriceM');
  f.minLotPrice = n('minLotPrice');
  f.maxLotPrice = n('maxLotPrice');
  f.unitMin = n('unitMin');
  f.unitMax = n('unitMax');
  f.unitKnown = sp.get('unitKnown') === '1';
  f.exactTokens = sp.get('exactTokens') === '1';
  const urlView = sp.get('view');
  if (urlView === 'list' || urlView === 'grid') state.view = urlView;
  const qtyMode = sp.get('qtyMode') || 'any';
  f.qtyMode = ['any', 'exclude1', 'known', 'range'].includes(qtyMode) ? qtyMode : 'any';
  f.qtyMin = n('qtyMin');
  f.qtyMax = n('qtyMax');
  f.need = n('need') || 0;
  f.sort = sp.get('sort') || 'priceM';
  const ex = list('sellersExclude');
  const merged = new Set((state.hiddenSellers || []).map((s) => String(s.id)));
  ex.forEach((id) => merged.add(String(id)));
  f.sellersExclude = [...merged];
  if (f.need > 0) { f.minTokens = null; f.maxTokens = null; }
  return f;
}

function syncUrl() {
  const f = state.appliedFilters || state.filters;
  const sp = new URLSearchParams();
  if (f.cats.length) sp.set('cat', f.cats.join(','));
  if (f.models.length) sp.set('model', f.models.join(','));
  if (f.q) sp.set('q', f.q);
  if (f.minStars) sp.set('minStars', f.minStars);
  if (f.minReviews) sp.set('minReviews', f.minReviews);
  if (f.noReviewStars.length) sp.set('noReviewStars', f.noReviewStars.join(','));
  if (f.minAgeMonths) sp.set('minAgeMonths', f.minAgeMonths);
  if (f.auto) sp.set('auto', '1');
  if (f.online) sp.set('online', '1');
  if (f.noRateLimited) sp.set('noRateLimited', '1');
  if (f.noCredits) sp.set('noCredits', '1');
  if (f.offerType !== 'any') sp.set('offerType', f.offerType);
  if (f.minDuration != null) sp.set('minDuration', f.minDuration);
  if (f.maxDuration != null) sp.set('maxDuration', f.maxDuration);
  if (f.bonus !== 'any') sp.set('bonus', f.bonus);
  if (f.oneToOne !== 'any') sp.set('oneToOne', f.oneToOne);
  if (f.inputOutput !== 'any') sp.set('inputOutput', f.inputOutput);
  if (f.refund !== 'any') sp.set('refund', f.refund);
  if (f.onlyDesc) sp.set('onlyDesc', '1');
  if (f.minTokens != null) sp.set('minTokens', f.minTokens);
  if (f.maxTokens != null) sp.set('maxTokens', f.maxTokens);
  if (f.minPriceM != null) sp.set('minPriceM', f.minPriceM);
  if (f.maxPriceM != null) sp.set('maxPriceM', f.maxPriceM);
  if (f.minLotPrice != null) sp.set('minLotPrice', f.minLotPrice);
  if (f.maxLotPrice != null) sp.set('maxLotPrice', f.maxLotPrice);
  if (f.unitMin != null) sp.set('unitMin', f.unitMin);
  if (f.unitMax != null) sp.set('unitMax', f.unitMax);
  if (f.unitKnown) sp.set('unitKnown', '1');
  if (f.exactTokens) sp.set('exactTokens', '1');
  if (f.qtyMode !== 'any') sp.set('qtyMode', f.qtyMode);
  if (f.qtyMin != null) sp.set('qtyMin', f.qtyMin);
  if (f.qtyMax != null) sp.set('qtyMax', f.qtyMax);
  if (f.need) sp.set('need', f.need);
  if (f.sort !== 'priceM') sp.set('sort', f.sort);
  if (f.sellersExclude.length) sp.set('sellersExclude', f.sellersExclude.join(','));
  if (state.view !== 'grid') sp.set('view', state.view);
  const qs = sp.toString();
  const url = location.pathname + (qs ? '?' + qs : '');
  history.replaceState(null, '', url);
}

function queryFor(page) {
  const f = state.appliedFilters || state.filters;
  const sp = new URLSearchParams();
  if (f.cats.length) sp.set('cat', f.cats.join(','));
  if (f.models.length) sp.set('model', f.models.join(','));
  if (f.q) sp.set('q', f.q);
  if (f.minStars) sp.set('minStars', f.minStars);
  if (f.minReviews) sp.set('minReviews', f.minReviews);
  if (f.noReviewStars.length) sp.set('noReviewStars', f.noReviewStars.join(','));
  if (f.minAgeMonths) sp.set('minAgeMonths', f.minAgeMonths);
  if (f.auto) sp.set('auto', '1');
  if (f.online) sp.set('online', '1');
  if (f.noRateLimited) sp.set('noRateLimited', '1');
  if (f.noCredits) sp.set('noCredits', '1');
  if (f.offerType !== 'any') sp.set('offerType', f.offerType);
  if (f.minDuration != null) sp.set('minDuration', f.minDuration);
  if (f.maxDuration != null) sp.set('maxDuration', f.maxDuration);
  if (f.bonus !== 'any') sp.set('bonus', f.bonus);
  if (f.oneToOne !== 'any') sp.set('oneToOne', f.oneToOne);
  if (f.inputOutput !== 'any') sp.set('inputOutput', f.inputOutput);
  if (f.refund !== 'any') sp.set('refund', f.refund);
  if (f.onlyDesc) sp.set('onlyDesc', '1');
  if (f.minTokens != null) sp.set('minTokens', f.minTokens);
  if (f.maxTokens != null) sp.set('maxTokens', f.maxTokens);
  if (f.minPriceM != null) sp.set('minPriceM', f.minPriceM);
  if (f.maxPriceM != null) sp.set('maxPriceM', f.maxPriceM);
  if (f.minLotPrice != null) sp.set('minLotPrice', f.minLotPrice);
  if (f.maxLotPrice != null) sp.set('maxLotPrice', f.maxLotPrice);
  if (f.sellersExclude.length) sp.set('sellersExclude', f.sellersExclude.join(','));
  if (f.unitMin != null) sp.set('unitMin', f.unitMin);
  if (f.unitMax != null) sp.set('unitMax', f.unitMax);
  if (f.unitKnown) sp.set('unitKnown', '1');
  if (f.exactTokens) sp.set('exactTokens', '1');
  if (f.qtyMode !== 'any') sp.set('qtyMode', f.qtyMode);
  if (f.qtyMin != null) sp.set('qtyMin', f.qtyMin);
  if (f.qtyMax != null) sp.set('qtyMax', f.qtyMax);
  if (f.need) sp.set('need', f.need);
  if (state.hiddenOffers.length) sp.set('offersExclude', state.hiddenOffers.map((o) => o.id).join(','));
  sp.set('sort', f.sort);
  sp.set('pageSize', f.pageSize);
  sp.set('page', page || 1);
  return sp.toString();
}

/* ---------- filters ui ---------- */

function applyFiltersToInputs(force = false) {
  const f = state.filters;
  // One volume mode at a time, including old links and saved presets.
  if (f.need > 0) {
    f.minTokens = null;
    f.maxTokens = null;
    state.volumeMode = 'exact';
  } else if (f.minTokens != null || f.maxTokens != null) {
    state.volumeMode = 'range';
  } else if (force) {
    state.volumeMode = 'any';
  }
  const setVal = (id, v) => {
    const el = $(id);
    if (!el || (!force && document.activeElement === el)) return;
    el.value = v;
  };
  setVal('#q', f.q);
  setVal('#minStars', String(f.minStars || 0));
  setVal('#minReviews', f.minReviews || '');
  $$('[data-no-review-star]').forEach((input) => { input.checked = f.noReviewStars.includes(Number(input.dataset.noReviewStar)); });
  setVal('#minAgeMonths', String(f.minAgeMonths || 0));
  $('#autoOnly').checked = f.auto;
  $('#onlineOnly').checked = f.online;
  $('#noRateLimited').checked = f.noRateLimited;
  $('#noCredits').checked = f.noCredits;
  $('#onlyDesc').checked = f.onlyDesc;
  setVal('#offerType', f.offerType);
  setVal('#minDuration', f.minDuration != null ? Number((f.minDuration / state.durationUnit).toFixed(6)) : '');
  setVal('#maxDuration', f.maxDuration != null ? Number((f.maxDuration / state.durationUnit).toFixed(6)) : '');
  setVal('#durationUnit', state.durationUnit);
  $$('#durationPresets button').forEach((b) => {
    const m = Number(b.dataset.minutes);
    const on = m ? f.minDuration === m && f.maxDuration === m : f.minDuration == null && f.maxDuration == null;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $('#excludeOneToOne').checked = f.oneToOne === 'exclude';
  $('#unitKnown').checked = f.unitKnown;
  $('#exactTokens').checked = f.exactTokens;
  setVal('#minPriceM', f.minPriceM != null ? f.minPriceM : '');
  setVal('#maxPriceM', f.maxPriceM != null ? f.maxPriceM : '');
  setVal('#minLotPrice', f.minLotPrice != null ? f.minLotPrice : '');
  setVal('#maxLotPrice', f.maxLotPrice != null ? f.maxLotPrice : '');
  setVal('#minTokens', f.minTokens != null ? f.minTokens : '');
  setVal('#maxTokens', f.maxTokens != null ? f.maxTokens : '');
  setVal('#unitMin', f.unitMin != null ? f.unitMin : '');
  setVal('#unitMax', f.unitMax != null ? f.unitMax : '');
  setVal('#qtyMode', f.qtyMode || 'any');
  setVal('#qtyMin', f.qtyMin != null ? f.qtyMin : '');
  setVal('#qtyMax', f.qtyMax != null ? f.qtyMax : '');
  const qtyRange = $('#qtyRange');
  if (qtyRange) qtyRange.hidden = f.qtyMode !== 'range';
  setVal('#needInput', f.need ? fmtCount(f.need) : '');
  setVal('#sort', f.sort);
  setVal('#volumeMode', state.volumeMode);
  $('#exactVolumeFields').hidden = state.volumeMode !== 'exact';
  $('#rangeVolumeFields').hidden = state.volumeMode !== 'range';
  $('#durationOptions').hidden = !['timed', 'unlimited'].includes(f.offerType) && f.minDuration == null && f.maxDuration == null;
  // Show saved choices on arrival, without reopening sections the user closed.
  if (force || !state.filterUiReady) {
    if (f.cats.length || f.models.length || f.offerType !== 'any' || f.minDuration != null || f.maxDuration != null) $('.fgroup[data-group="offer"]').open = true;
    if (f.need || f.minTokens != null || f.maxTokens != null || f.minPriceM != null || f.maxPriceM != null || f.minLotPrice != null || f.maxLotPrice != null || f.unitMin != null || f.unitMax != null || f.unitKnown || f.exactTokens || f.qtyMode !== 'any') $('.fgroup[data-group="budget"]').open = true;
    if (f.sellersExclude.length || state.hiddenOffers.length) $('#sourceOptions').open = true;
    if (f.models.length) $('#modelOptions').open = true;
    if (f.noReviewStars.length) $('#reviewOptions').open = true;
    if (f.onlyDesc) $('#descriptionOptions').open = true;
    if (f.unitMin != null || f.unitMax != null || f.unitKnown || f.exactTokens || f.qtyMode !== 'any') $('#volumePrecision').open = true;
    if (f.minStars || f.minReviews || f.minAgeMonths || f.auto || f.online || f.noReviewStars.length) $('.fgroup[data-group="seller"]').open = true;
    if (f.oneToOne !== 'any' || f.inputOutput !== 'any' || f.bonus !== 'any' || f.refund !== 'any' || f.onlyDesc || f.noRateLimited || f.noCredits) $('.fgroup[data-group="conditions"]').open = true;
  }
  state.filterUiReady = true;

  setSeg($('#bonusSeg'), f.bonus);
  setSeg($('#inputOutputSeg'), f.inputOutput);
  setSeg($('#refundSeg'), f.refund);
  $$('#needPresets button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === f.need));

  $$('#catChips .chip').forEach((c) => c.classList.toggle('on', c.dataset.cat ? f.cats.includes(c.dataset.cat) : !f.cats.length));
  $$('#modelChips .chip').forEach((c) => c.classList.toggle('on', f.models.includes(c.dataset.model)));
  updatePresetChips();
  updateFilterBadges();
}

function setSeg(container, value) {
  container.querySelectorAll('button').forEach((b) => {
    const active = b.dataset.v === value;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
}

/** Stable preset keys are part of the existing UI contract. */
const PRESETS = {
  cheap: { label: 'Выгодные', description: 'Пакеты токенов от продавцов с рейтингом от 4★. Без «1 токен = 1 человек», сначала самая низкая цена за миллион.', apply: { offerType: 'tokens', sort: 'priceM', oneToOne: 'exclude', minStars: 4 } },
  safe: { label: 'Надёжные', description: 'Рейтинг 5★, от 100 отзывов, продавец онлайн и заявлен возврат. Исключены «1=1» и подтверждённые отзывы на 1–3★. Это фильтр, а не гарантия покупки.', apply: { sort: 'priceM', minStars: 5, minReviews: 100, noReviewStars: [1, 2, 3], refund: 'yes', online: true, oneToOne: 'exclude' } },
  bulk: { label: 'Крупный объём', description: 'Пакеты от 10 миллионов токенов. Сначала самые большие объёмы; стоимость за миллион видна на каждой карточке.', apply: { offerType: 'tokens', sort: 'tokens', minTokens: 10_000_000 } },
  hour: { label: 'Безлимит на 1 ч', description: 'Безлимит с указанным сроком ровно 60 минут. Сначала минимальная цена за час; срок определён по тексту предложения.', apply: { offerType: 'timed', minDuration: 60, maxDuration: 60, sort: 'priceHour' } },
  instant: { label: 'Без ожидания', description: 'Предложения с автовыдачей от продавцов онлайн. Статус относится к моменту обновления данных; проверьте условия выдачи перед покупкой.', apply: { auto: true, online: true, sort: 'priceM', oneToOne: 'exclude' } },
};

function isSnapshotMode() {
  return window.TokenScopeAPI?.isStatic === true || state.deploymentMode === 'snapshot' || state.meta?.deploymentMode === 'snapshot';
}

function presetForMode(key) {
  const preset = PRESETS[key];
  if (!preset || key !== 'safe' || !isSnapshotMode()) return preset;
  return { ...preset, description: 'В снимке: рейтинг 5★, от 100 отзывов, заявлен возврат и нет «1=1». Онлайн-статус — на момент сбора. Проверка оценок 1–3★ здесь недоступна; набор не гарантирует надёжность.', apply: { ...preset.apply, noReviewStars: [] } };
}

function sameFilterValues(actual, expected) {
  return Object.entries(expected).every(([key, value]) => Array.isArray(value)
    ? Array.isArray(actual[key]) && value.length === actual[key].length && value.every((item) => actual[key].includes(item))
    : (typeof value === 'boolean' ? !!actual[key] === value : actual[key] === value));
}

function updatePresetChips() {
  let active = null;
  $$('#presetRow .preset-btn').forEach((button) => {
    const preset = presetForMode(button.dataset.preset);
    if (!preset) return;
    const fit = sameFilterValues(state.filters, preset.apply);
    button.classList.toggle('on', fit);
    button.setAttribute('aria-pressed', String(fit));
    button.title = preset.description;
    if (fit && !active) active = preset;
  });
  const description = $('#presetDescription');
  if (description) description.textContent = active?.description || 'Набор настроит фильтры за вас. Категории, модели и поисковый запрос сохранятся.';
  updateSavedPreset();
}

function loadCustomPreset() {
  try {
    const saved = JSON.parse(localStorage.getItem(CUSTOM_PRESET_KEY) || 'null');
    if (!saved || typeof saved.name !== 'string' || !saved.filters || typeof saved.filters !== 'object') return;
    const filters = cloneFilters();
    // Copy known filter fields only; storage can be edited outside the app.
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      const value = saved.filters[key];
      if (Array.isArray(fallback)) filters[key] = Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 200) : [];
      else if (fallback === null) filters[key] = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
      else if (typeof value === typeof fallback) filters[key] = typeof value === 'number' && !Number.isFinite(value) ? fallback : value;
    }
    // Migrate presets saved before offerType replaced unlimitedOnly.
    if (saved.filters.unlimitedOnly === true) filters.offerType = 'unlimited';
    filters.noReviewStars = normalizeReviewStars(saved.filters.noReviewStars);
    state.customPreset = { name: saved.name.trim().slice(0, 40) || 'Мой набор', filters };
  } catch { /* A private or full browser storage must not break filters. */ }
}

function updateSavedPreset() {
  const saved = state.customPreset;
  const apply = $('#applySavedPreset');
  if (!apply) return;
  apply.hidden = !saved;
  $('#savedPresetEmpty').hidden = !!saved;
  $('#deleteSavedPreset').hidden = !saved;
  $('#savePresetBtn').textContent = saved ? 'Перезаписать' : 'Сохранить набор';
  if (!saved) return;
  $('#savedPresetLabel').textContent = saved.name;
  const parts = [];
  if (saved.filters.q) parts.push('«' + saved.filters.q + '»');
  if (saved.filters.cats.length) parts.push('категорий: ' + saved.filters.cats.length);
  if (saved.filters.models.length) parts.push('моделей: ' + saved.filters.models.length);
  if (saved.filters.minStars) parts.push(saved.filters.minStars + '★+');
  if (saved.filters.need) parts.push(fmtTokens(saved.filters.need) + ' токенов');
  $('#savedPresetDetails').textContent = parts.join(' · ') || 'Фильтры и сортировка · в этом браузере';
  const fit = sameFilterValues(state.filters, saved.filters);
  apply.classList.toggle('on', fit);
  apply.setAttribute('aria-pressed', String(fit));
}

function renderDeploymentInfo(data = {}) {
  if (data.deploymentMode) state.deploymentMode = data.deploymentMode;
  const snapshot = isSnapshotMode();
  document.body.classList.toggle('snapshot-mode', snapshot);
  $('#live').classList.toggle('is-snapshot', snapshot);
  const mode = $('#modeBadge');
  if (mode) mode.classList.toggle('is-snapshot', snapshot);
  if ($('#modeLabel')) $('#modeLabel').textContent = snapshot ? (state.meta?.partial ? 'Частичный снимок' : 'Опубликованный снимок') : 'Живой мониторинг';
  if ($('#updatePolicy')) $('#updatePolicy').textContent = snapshot ? 'Без фонового сбора' : 'Обновление каждые 3 мин';
  const refresh = $('#refreshBtn');
  refresh.querySelector('span').textContent = snapshot ? 'Перечитать снимок' : 'Обновить';
  refresh.setAttribute('aria-label', snapshot ? 'Перезагрузить опубликованный снимок' : 'Обновить данные');
  refresh.title = snapshot ? 'Перечитать опубликованные данные. Новый сбор предложений не запускается.' : 'Запросить обновление предложений';
  const updatedAt = data.updatedAt || state.meta?.updatedAt;
  if (updatedAt) {
    const date = new Date(updatedAt);
    const stamp = snapshot ? date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : fmtTime(updatedAt);
    $('#updated').textContent = (snapshot ? 'снимок · ' : 'обновлено ') + stamp;
    $('#updated').title = date.toLocaleString('ru-RU');
    $('#heroUpdated').textContent = stamp;
    $('#heroUpdated').title = date.toLocaleString('ru-RU');
  }
  if ($('#heroUpdatedLabel')) $('#heroUpdatedLabel').textContent = snapshot ? 'снимок от' : 'обновлено';
  if ($('#categoryTotal') && state.meta?.categories) $('#categoryTotal').textContent = state.meta.categories.length;
  if ($('#sourceNote')) $('#sourceNote').textContent = snapshot
    ? 'Снимок публичных предложений FunPay. Цены и наличие могли измениться; комиссия оплаты не включена.'
    : 'Источник: публичные предложения FunPay. Цены без комиссии способа оплаты.';
  $$('[data-no-review-star]').forEach((input) => {
    input.disabled = snapshot;
    input.setAttribute('aria-describedby', 'reviewFilterHint');
  });
  $('#reviewFilterHint').textContent = snapshot
    ? 'Проверка оценок по всему профилю недоступна в снимке. Фильтр из сохранённой ссылки покажет только подтверждённые данные; непроверенные продавцы не пройдут.'
    : 'Проверяем весь профиль FunPay, по всем покупкам. Можно выбрать несколько оценок. Непроверенные продавцы не проходят фильтр.';
  if ($('#safePresetDescription')) $('#safePresetDescription').textContent = snapshot ? '5★ · 100+ отзывов · по снимку' : '5★ · 100+ отзывов · с возвратом';
  $('#enrichBtn').disabled = snapshot;
  $('#enrichBtn').textContent = snapshot ? 'Описания из снимка' : 'Проверить ещё 120 лотов';
  $('#enrichBtn').title = snapshot ? 'Доступны сохранённые описания. Новая проверка в статичной версии не запускается.' : '';
  if (snapshot) $('#descQueue').textContent = 'без фоновой проверки';
  updatePresetChips();
}

/** Счётчик активных фильтров в шапке и в каждом блоке. */
function updateFilterBadges() {
  const f = state.filters;
  const hasRange = (min, max) => min != null || max != null ? 1 : 0;
  const counts = {
    offer: (f.cats.length ? 1 : 0) + (f.models.length ? 1 : 0) +
      (f.offerType !== 'any' ? 1 : 0) + hasRange(f.minDuration, f.maxDuration),
    budget: hasRange(f.minPriceM, f.maxPriceM) + hasRange(f.minLotPrice, f.maxLotPrice) +
      (f.need ? 1 : hasRange(f.minTokens, f.maxTokens)) + hasRange(f.unitMin, f.unitMax) +
      (f.unitKnown ? 1 : 0) + (f.exactTokens ? 1 : 0) + (f.qtyMode !== 'any' ? 1 : 0),
    seller: (f.minStars ? 1 : 0) + (f.minReviews ? 1 : 0) + (f.noReviewStars.length ? 1 : 0) +
      (f.minAgeMonths ? 1 : 0) + (f.auto ? 1 : 0) + (f.online ? 1 : 0),
    conditions: (f.oneToOne === 'exclude' ? 1 : 0) + (f.inputOutput !== 'any' ? 1 : 0) +
      (f.bonus !== 'any' ? 1 : 0) + (f.refund !== 'any' ? 1 : 0) + (f.onlyDesc ? 1 : 0) +
      (f.noRateLimited ? 1 : 0) + (f.noCredits ? 1 : 0),
    hidden: f.sellersExclude.length + state.hiddenOffers.length,
  };
  const total = Object.values(counts).reduce((s, n) => s + n, f.q ? 1 : 0);
  $$('[data-filter-count]').forEach((el) => {
    el.textContent = total;
    el.hidden = total === 0;
  });
  $$('.fgroup').forEach((g) => {
    const n = counts[g.dataset.group] || 0;
    const badge = g.querySelector('.fcount');
    if (badge) {
      badge.textContent = n;
      badge.hidden = !n;
    }
    g.classList.toggle('has-active', n > 0);
  });
  const openBtn = $('#filtersToggle');
  if (openBtn) openBtn.classList.toggle('has-active', total > 0);
  $('#filterSummary').textContent = total ? 'Активных условий: ' + total : 'Без ограничений';
  $('#sourceOptions').classList.toggle('has-active', counts.hidden > 0);
}

function buildCatChips(categories) {
  const wrap = $('#catChips');
  wrap.innerHTML = '';
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'chip';
  all.dataset.cat = '';
  all.innerHTML = `Все <span class="cnt">${fmtCount(categories.reduce((s, c) => s + c.count, 0))}</span>`;
  all.addEventListener('click', () => {
    state.filters.cats = [];
    commit();
  });
  wrap.appendChild(all);

  for (const c of categories) {
    if (!c.count) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.cat = c.id;
    b.innerHTML = `${esc(c.name)} <span class="cnt">${fmtCount(c.count)}</span>`;
    b.style.setProperty('--cat', c.color);
    b.addEventListener('click', () => {
      const set = new Set(state.filters.cats);
      if (set.has(c.id)) set.delete(c.id);
      else set.add(c.id);
      state.filters.cats = [...set];
      commit();
    });
    wrap.appendChild(b);
  }
  $$('#catChips .chip').forEach((c) => c.classList.toggle('on', c.dataset.cat ? state.filters.cats.includes(c.dataset.cat) : !state.filters.cats.length));
}

function buildModelChips(models) {
  const wrap = $('#modelChips');
  wrap.innerHTML = '';
  if (!models.length) {
    wrap.innerHTML = '<span class="hint" style="margin:0">модели появятся после обновления данных</span>';
    return;
  }
  for (const m of models) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.model = m.name;
    b.innerHTML = `${esc(m.label)} <span class="cnt">${fmtCount(m.count)}</span>`;
    b.addEventListener('click', () => {
      const set = new Set(state.filters.models);
      if (set.has(m.name)) set.delete(m.name);
      else set.add(m.name);
      state.filters.models = [...set];
      commit();
    });
    wrap.appendChild(b);
  }
  $$('#modelChips .chip').forEach((c) => c.classList.toggle('on', state.filters.models.includes(c.dataset.model)));
  filterModelChips();
}

function filterModelChips() {
  const q = $('#modelSearch').value.trim().toLowerCase();
  let visible = 0;
  $$('#modelChips .chip').forEach((b) => {
    b.hidden = !!q && !b.textContent.toLowerCase().includes(q);
    if (!b.hidden) visible++;
  });
  $('#modelSearchEmpty').hidden = !q || visible > 0;
}

/* ---------- rendering ---------- */

function renderHero(data) {
  const s = data.stats || {};
  const hist = data.history || [];
  $('#statMedianMain').textContent = s.medianPriceM ? fmtPriceM(s.medianPriceM) : '—';
  $('#statAvg').textContent = s.avgPriceM ? fmtPriceM(s.avgPriceM) : '—';
  $('#statWeighted').textContent = s.weightedPriceM ? `взвешенно: ${fmtPriceM(s.weightedPriceM)}` : '—';
  $('#statMin').textContent = s.minPriceM ? fmtPriceM(s.minPriceM) : '—';
  $('#statCount').textContent = fmtCount(s.count);
  $('#statCountFoot').textContent = `${fmtCount(s.withTokens)} с известным объёмом`;

  const delta = $('#statAvgDelta');
  if (hist.length > 1) {
    // Сравниваем с предыдущим замером, а не с самым первым: иначе после
    // смены методики расчёта график показывал ложные «+700%».
    const prev = hist[hist.length - 2].avg;
    const last = hist[hist.length - 1].avg;
    const d = prev ? ((last - prev) / prev) * 100 : 0;
    const arrow = d < 0 ? '↓' : d > 0 ? '↑' : '→';
    const pct = Math.abs(d) >= 100 ? Math.round(Math.abs(d)).toLocaleString('ru-RU') : Math.abs(d).toFixed(1).replace('.', ',');
    delta.innerHTML = `<span class="${d <= 0 ? 'down' : 'up'}">${arrow} ${pct}%</span> к прошлому замеру`;
    $('#chartDelta').textContent = `${arrow} ${pct}%`;
    $('#chartDelta').className = 'chart-delta ' + (d <= 0 ? 'down' : 'up');
  } else {
    delta.textContent = isSnapshotMode() ? 'История на момент публикации снимка' : 'Копится история — новый замер каждые 3 мин';
    $('#chartDelta').textContent = '—';
    $('#chartDelta').className = 'chart-delta';
  }

  renderBand(s);
  renderChart(hist);
}

function renderBand(s) {
  const lo = Math.max(0.0001, (s.p10PriceM || s.minPriceM || 0.1) * 0.8);
  const hi = Math.max(lo * 1.2, (s.p90PriceM || s.maxPriceM || 10) * 1.2);
  const logLo = Math.log(lo);
  const logHi = Math.log(hi);
  const pos = (v) => {
    if (!v || !isFinite(v) || v <= 0) return 0;
    const p = (Math.log(Math.min(hi, Math.max(lo, v))) - logLo) / (logHi - logLo);
    return Math.max(0, Math.min(1, p)) * 100;
  };
  $('#markMin').style.left = pos(s.minPriceM) + '%';
  $('#markAvg').style.left = pos(s.avgPriceM) + '%';
  $('#markMed').style.left = pos(s.medianPriceM) + '%';
  $('#markMax').style.left = pos(s.maxPriceM) + '%';
  $('#bandRange').textContent = s.minPriceM ? `${fmtPriceM(s.minPriceM)} — ${fmtPriceM(s.maxPriceM)}` : '—';
}

function renderChart(points) {
  const box = $('#chart');
  if (!points || points.length < 2) {
    box.innerHTML = '<div class="chart-empty">' + (isSnapshotMode() ? 'В этом снимке недостаточно замеров для графика' : 'История появится после нескольких обновлений') + '</div>';
    return;
  }
  const W = 320;
  const H = 96;
  const pad = 6;
  const vals = points.map((p) => p.avg).filter((v) => isFinite(v));
  if (vals.length < 2) {
    box.innerHTML = '<div class="chart-empty">мало данных</div>';
    return;
  }
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i) => pad + (i / (points.length - 1)) * (W - pad * 2);
  const y = (v) => H - pad - ((v - min) / span) * (H - pad * 2);
  const pts = points.map((p, i) => `${x(i).toFixed(1)},${y(p.avg).toFixed(1)}`);
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`;
  const falling = points[points.length - 1].avg <= points[0].avg;
  const color = falling ? '#b7f59a' : '#ff6b6b';
  const last = points[points.length - 1];
  box.innerHTML = `
    <div class="chart-last" style="color:${color}">${fmtPriceM(last.avg)}</div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="История средней цены">
      <path d="M${pad},${(H - pad) * 0.72} H${W - pad}" stroke="rgba(255,255,255,0.06)" stroke-width="1" vector-effect="non-scaling-stroke"/>
      <path d="M${pad},${(H - pad) * 0.34} H${W - pad}" stroke="rgba(255,255,255,0.06)" stroke-width="1" vector-effect="non-scaling-stroke"/>
      <path d="${area}" fill="${color}" fill-opacity="0.1"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      <circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.avg).toFixed(1)}" r="3.2" fill="${color}" stroke="#000000" stroke-width="1.5"/>
    </svg>`;
}

function renderNeedCard(data) {
  const card = $('#needCard');
  const need = state.filters.need;
  if (!need || !data.stats || !data.stats.needPlans || !data.stats.needPlans.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('#needTitle').textContent = fmtCount(need);
  const plans = data.stats.needPlans;
  $('#needPlans').innerHTML = plans
    .map((p, i) => {
      const units = p.units === 1 ? '1 шт' : `${p.units} шт`;
      return `<div class="plan ${i === 0 ? 'best' : ''}" data-plan-id="${esc(p.id)}" title="${esc(p.title)}">
        <div class="plan-top"><span>${units} · ${fmtTokens(p.got)}</span><span>${i === 0 ? 'лучший' : '#' + (i + 1)}</span></div>
        <div class="plan-cost">${fmtMoney(p.cost)}</div>
        <div class="plan-meta">${esc(p.seller)} · ${esc(p.cat)}</div>
      </div>`;
    })
    .join('');
}

function badgeHtml(o) {
  const out = [];
  if (o.promo) out.push('<span class="badge promo">топ</span>');
  if (o.auto) out.push('<span class="badge auto">авто</span>');
  if (o.flags.bonus) out.push('<span class="badge bonus">бонус</span>');
  if (o.flags.refund === true) out.push('<span class="badge refund">возврат</span>');
  else if (o.flags.refund === false) out.push('<span class="badge muted">без возврата</span>');
  if (o.flags.oneToOne) out.push('<span class="badge onetoone">1=1</span>');
  if (o.flags.inputOutput) out.push('<span class="badge muted" title="В тексте указано списание за вход + выход; множитель и условия — в описании">вход + выход</span>');
  if (o.flags.unlimited) out.push('<span class="badge unlim">' + (o.durationMinutes ? '∞ ' + fmtDuration(o.durationMinutes) : 'безлимит') + '</span>');
  if (o.flags.rateLimited) out.push('<span class="badge muted">лимит/день</span>');
  if (o.flags.credits) out.push('<span class="badge muted">кредиты</span>');
  if (o.qty != null) out.push(`<span class="badge qty">×${o.qty} шт</span>`);
  return out.join('');
}

/* ---------- вид: плитка / список ---------- */

function applyView() {
  const list = $('#list');
  if (!list) return;
  list.classList.toggle('grid', state.view === 'grid');
  $$('#viewToggle .vt-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
    b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
  });
}

function setView(v) {
  if (v !== 'grid' && v !== 'list') v = 'grid';
  if (state.view === v) return;
  state.view = v;
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {}
  applyView();
  renderList(state.items, false);
  syncUrl();
  toast(v === 'grid' ? 'Квадратные карточки' : 'Карточки строками');
}

function descriptionHtml(text) {
  return window.TokenRadarDescription?.render(text) ?? esc(text);
}

function expandedDescriptionHtml(text) {
  const html = descriptionHtml(text);
  const keys = [
    ['positive', '+ Преимущества'],
    ['negative', '− Ограничения и риски'],
    ['neutral', 'Условия'],
  ].filter(([kind]) => html.includes('class="desc-highlight desc-' + kind + '"')).map(([kind, label]) =>
    `<span class="desc-key desc-${kind}">${label}</span>`
  );
  const legend = keys.length ? `<div class="desc-legend" aria-label="Обозначения подсветки">${keys.join('')}<span>По тексту продавца</span></div>` : '';
  return `${legend}<div class="desc-content">${html}</div>`;
}

function sellerReviewButton(seller) {
  const total = seller.reviewSummary?.total ?? seller.reviews;
  return `<button class="seller-reviews" data-act="reviews" data-seller-id="${esc(seller.id || '')}" type="button" aria-haspopup="dialog" aria-controls="reviewsDialog" aria-label="Отзывы о продавце ${esc(seller.name || 'FunPay')}: ${fmtCount(total)}">Отзывы ${fmtCount(total)}</button>`;
}

function tileDescription(o) {
  return (o.descriptionPreview ?? o.description ?? '').replace(/\s+/g, ' ').trim() ||
    (o.descLoaded ? 'Описание пустое.' : (isSnapshotMode() ? 'Полное описание — на странице предложения.' : 'Описание загружается…'));
}

// Высота предпросмотра определяется свободным местом в квадратной плитке.
// Нативный line-clamp ставит многоточие только при обрезке текста.
const tilePreviewObserver = new ResizeObserver((entries) => {
  for (const { target, contentRect } of entries) {
    const text = target.firstElementChild;
    if (!text || !contentRect.height) continue;
    const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
    text.style.webkitLineClamp = String(Math.max(1, Math.floor(contentRect.height / lineHeight)));
  }
});

/** Квадратная карточка лота для режима плитки. */
function renderTile(o, absIndex) {
  const rank = absIndex + 1;
  const perM = o.pricePerM;
  const best = state.stats && perM != null && o.pricePerM === state.stats.minPriceM;
  const volume = `<span class="tile-volume ${!o.tokens ? 'warn' : ''}">${volumeMetric(o)}</span>`;
  const needLine = o.needCost
    ? `<div class="tile-need">×${o.needCost.units} шт → ${fmtMoney(o.needCost.cost)}</div>`
    : '';
  return `<article class="offer tile ${best ? 'best' : ''}" data-id="${esc(o.id)}" style="animation-delay:${Math.min((absIndex % 40) * 22, 300)}ms">
    <div class="tile-head">
      <span class="rank ${absIndex < 3 ? 'top' : ''}">${rank}</span>
      <div class="offer-badges">${badgeHtml(o)}</div>
    </div>
    <div class="tile-title" title="${esc(o.title)}">${esc(o.title)}</div>
    <div class="tile-preview"><div class="tile-description">${descriptionHtml(tileDescription(o))}</div></div>
    <div class="tile-pricebox">
      <div class="price">${fmtMoney(o.price)}</div>
      <div class="per-m">${priceMetric(o)}</div>
      ${needLine}
    </div>
    ${volume}
    <div class="tile-seller">
      <img class="avatar" src="${esc(avatarUrl(o.seller))}" alt="" loading="lazy" onerror="this.style.display='none'">
      <span class="seller-name">${esc(o.seller.name || 'продавец')}</span>
      ${o.seller.stars ? starsHtml(o.seller.stars) : ''}
      ${sellerReviewButton(o.seller)}
      ${o.seller.online ? '<span class="dot-online" title="онлайн"></span>' : ''}
    </div>
    <div class="tile-actions">
      <button class="icon-btn" data-act="desc" type="button" title="Показать описание"><svg class="ic"><use href="#i-desc"/></svg></button>
      <button class="icon-btn" data-act="copy" type="button" title="Скопировать ссылку на лот"><svg class="ic"><use href="#i-copy"/></svg></button>
      <button class="icon-btn danger" data-act="hide-offer" type="button" title="Скрыть это предложение" aria-label="Скрыть это предложение"><svg class="ic"><use href="#i-close"/></svg></button>
      <button class="icon-btn danger" data-act="hide" type="button" title="Скрыть продавца" aria-label="Скрыть все предложения продавца"><svg class="ic"><use href="#i-eyeoff"/></svg></button>
      <a class="icon-btn" data-act="open" href="https://funpay.com/lots/offer?id=${esc(o.id)}" target="_blank" rel="noopener" title="Открыть на FunPay"><svg class="ic"><use href="#i-external"/></svg></a>
    </div>
  </article>`;
}

function renderOffer(o, absIndex) {
  if (state.view === 'grid') return renderTile(o, absIndex);
  const rank = absIndex + 1;
  const perM = o.pricePerM;
  const best = state.stats && perM != null && o.pricePerM === state.stats.minPriceM;
  const meta = [];
  meta.push(`<span class="${!o.tokens ? 'warn' : ''}">${volumeMetric(o)}</span>`);
  if (o.perItemTokens) meta.push(`<span>1 шт = ${fmtTokens(o.perItemTokens)}</span>`);
  if (o.qty != null) meta.push(`<span><b>Наличие:</b> ${o.qty} шт</span>`);
  if (o.modelLabel) meta.push(`<span>${esc(o.modelLabel)}</span>`);

  const needLine = o.needCost
    ? `<div class="need-line">×${o.needCost.units} шт → ${fmtMoney(o.needCost.cost)}</div>`
    : '';

  return `<article class="offer ${best ? 'best' : ''}" data-id="${esc(o.id)}" style="animation-delay:${Math.min((absIndex % 40) * 22, 300)}ms">
    <div class="offer-main">
      <div class="offer-title-row">
        <span class="rank ${absIndex < 3 ? 'top' : ''}">${rank}</span>
        <div style="min-width:0">
          <div class="offer-title">${esc(o.title)}</div>
          <div class="offer-badges">${badgeHtml(o)}</div>
        </div>
      </div>
      <div class="seller">
        <img class="avatar" src="${esc(avatarUrl(o.seller))}" alt="" loading="lazy" onerror="this.style.display='none'">
        <span class="seller-name">${esc(o.seller.name || 'продавец')}</span>
        ${o.seller.stars ? starsHtml(o.seller.stars) : ''}
        ${sellerReviewButton(o.seller)}
        ${o.seller.online ? '<span class="dot-online" title="онлайн"></span>' : ''}
        ${o.seller.age ? `<span class="reviews">${esc(o.seller.age)}</span>` : ''}
      </div>
      <div class="offer-meta">${meta.join('')}</div>
    </div>
    <div class="offer-side">
      <div class="price-block">
        <div class="price">${fmtMoney(o.price)}</div>
        <div class="per-m">${priceMetric(o)}</div>
        ${needLine}
      </div>
      <div class="price-actions">
        <button class="icon-btn" data-act="desc" type="button" title="Показать описание"><svg class="ic"><use href="#i-desc"/></svg></button>
        <button class="icon-btn" data-act="copy" type="button" title="Скопировать ссылку на лот"><svg class="ic"><use href="#i-copy"/></svg></button>
        <button class="icon-btn danger" data-act="hide-offer" type="button" title="Скрыть это предложение" aria-label="Скрыть это предложение"><svg class="ic"><use href="#i-close"/></svg></button>
      <button class="icon-btn danger" data-act="hide" type="button" title="Скрыть продавца" aria-label="Скрыть все предложения продавца"><svg class="ic"><use href="#i-eyeoff"/></svg></button>
        <a class="icon-btn" data-act="open" href="https://funpay.com/lots/offer?id=${esc(o.id)}" target="_blank" rel="noopener" title="Открыть на FunPay"><svg class="ic"><use href="#i-external"/></svg></a>
      </div>
    </div>
  </article>`;
}

function renderList(items, append) {
  const list = $('#list');
  if (!append) {
    tilePreviewObserver.disconnect();
    list.innerHTML = '';
  }
  const start = append ? list.querySelectorAll('.offer').length : 0;
  list.insertAdjacentHTML('beforeend', items.map((o, i) => renderOffer(o, start + i)).join(''));
  list.querySelectorAll('.tile-preview').forEach((preview) => tilePreviewObserver.observe(preview));
  // Раскрытые описания не должны схлопываться при фоновом обновлении или
  // смене фильтра — возвращаем их из кэша.
  restoreExpandedDescriptions();
}

function restoreExpandedDescriptions() {
  if (!state.expanded.size) return;
  for (const id of state.expanded) {
    const card = $(`#list .offer[data-id="${CSS.escape(id)}"]`);
    const offer = state.items.find((o) => o.id === id);
    if (!card || !offer || card.querySelector('.offer-desc')) continue;
    expandDescription(card, offer);
  }
}

function skeletons() {
  $('#list').innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join('');
}

function renderResultInfo(data, { keepList = false } = {}) {
  const info = $('#resultInfo');
  if (!keepList) {
    const shown = data.items.length;
    info.innerHTML = `Найдено <b>${fmtCount(data.total)}</b> · показано <b>${fmtCount(shown)}</b>`;
    $('#moreBtn').hidden = data.page >= data.pages;
    $('#empty').hidden = data.total !== 0;
  } else {
    info.innerHTML = `Найдено <b>${fmtCount(data.total)}</b> · показано <b>${fmtCount(state.items.length)}</b>`;
    $('#moreBtn').hidden = state.page >= state.pages;
    $('#empty').hidden = state.total !== 0;
  }
  $('#filterApplyText').textContent = data.total ? 'Показать ' + fmtCount(data.total) + ' объявлений' : 'Нет подходящих объявлений';
  const note = $('#descNote');
  if (data.desc && data.desc.totalInScope) {
    note.textContent = `описания: ${fmtCount(data.desc.loadedInScope)} из ${fmtCount(data.desc.totalInScope)}`;
  } else note.textContent = '';

  const dpText = $('#descProgressText');
  if (data.desc) {
    const pct = data.desc.totalInScope ? (data.desc.loadedInScope / data.desc.totalInScope) * 100 : 0;
    dpText.textContent = `${fmtCount(data.desc.loadedInScope)} / ${fmtCount(data.desc.totalInScope)}`;
    $('#descProgressBar').style.width = pct + '%';
    $('#descQueue').textContent = data.desc.queued || data.desc.active ? `в очереди ${data.desc.queued + data.desc.active}` : '';
  }
}

function renderActiveChips() {
  const wrap = $('#activeChips');
  wrap.innerHTML = '';
  const f = state.filters;
  const meta = state.meta;
  const catName = (id) => (meta && meta.categories.find((c) => c.id === id)?.name) || id;

  const add = (label, action) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip removable';
    b.innerHTML = `${esc(label)} <svg class="ic" style="width:10px;height:10px"><use href="#i-close"/></svg>`;
    b.addEventListener('click', () => {
      action();
      commit();
    });
    wrap.appendChild(b);
  };

  f.cats.forEach((id) => add(catName(id), () => (state.filters.cats = state.filters.cats.filter((x) => x !== id))));
  f.models.forEach((m) =>
    add((meta?.models.find((x) => x.name === m)?.label || m), () => (state.filters.models = state.filters.models.filter((x) => x !== m)))
  );
  if (f.q) add(`«${f.q}»`, () => (state.filters.q = ''));
  if (f.need) add(`ровно ${fmtTokens(f.need)} токенов`, () => (state.filters.need = 0));
  if (f.minStars) add(`рейтинг ${f.minStars}★+`, () => (state.filters.minStars = 0));
  if (f.minReviews) add(`отзывов от ${f.minReviews}`, () => (state.filters.minReviews = 0));
  f.noReviewStars.forEach((rating) => add(`без отзывов на ${rating}★`, () => { state.filters.noReviewStars = state.filters.noReviewStars.filter((n) => n !== rating); }));
  if (f.minAgeMonths) add(`стаж от ${f.minAgeMonths} мес.`, () => (state.filters.minAgeMonths = 0));
  if (f.auto) add('автовыдача', () => (state.filters.auto = false));
  if (f.online) add('онлайн', () => (state.filters.online = false));
  if (f.noRateLimited) add('без суточного лимита', () => (state.filters.noRateLimited = false));
  if (f.noCredits) add('без кредитов', () => (state.filters.noCredits = false));
  if (f.offerType !== 'any') add(OFFER_TYPES[f.offerType], () => { state.filters.offerType = 'any'; });
  if (f.minDuration != null || f.maxDuration != null) {
    const label = f.minDuration === f.maxDuration ? fmtDuration(f.minDuration) : [f.minDuration != null ? 'от ' + fmtDuration(f.minDuration) : '', f.maxDuration != null ? 'до ' + fmtDuration(f.maxDuration) : ''].filter(Boolean).join(' ');
    add('срок: ' + label, () => { state.filters.minDuration = null; state.filters.maxDuration = null; });
  }
  if (f.bonus === 'only') add('только с бонусами', () => (state.filters.bonus = 'any'));
  if (f.bonus === 'exclude') add('без бонусов', () => (state.filters.bonus = 'any'));
  if (f.oneToOne === 'exclude') add('без «1=1»', () => (state.filters.oneToOne = 'any'));
  if (f.oneToOne === 'only') add('только «1=1»', () => (state.filters.oneToOne = 'any'));
  if (f.inputOutput === 'only') add('с формулой «вход + выход»', () => (state.filters.inputOutput = 'any'));
  if (f.inputOutput === 'exclude') add('без формулы «вход + выход»', () => (state.filters.inputOutput = 'any'));
  if (f.refund === 'yes') add('с возвратом', () => (state.filters.refund = 'any'));
  if (f.refund === 'no') add('без возврата', () => (state.filters.refund = 'any'));
  if (f.onlyDesc) add('только проверенные описания', () => (state.filters.onlyDesc = false));
  if (f.minTokens != null) add(`объём от ${fmtTokens(f.minTokens)}`, () => (state.filters.minTokens = null));
  if (f.maxTokens != null) add(`объём до ${fmtTokens(f.maxTokens)}`, () => (state.filters.maxTokens = null));
  if (f.minPriceM != null) add(`от ${fmtPriceM(f.minPriceM)}/1М`, () => (state.filters.minPriceM = null));
  if (f.maxPriceM != null) add(`до ${fmtPriceM(f.maxPriceM)}/1М`, () => (state.filters.maxPriceM = null));
  if (f.minLotPrice != null) add(`лот от ${fmtMoney(f.minLotPrice)}`, () => (state.filters.minLotPrice = null));
  if (f.maxLotPrice != null) add(`лот до ${fmtMoney(f.maxLotPrice)}`, () => (state.filters.maxLotPrice = null));
  if (f.unitKnown) add('с кратностью 1 шт', () => (state.filters.unitKnown = false));
  if (f.exactTokens) add('точный объём', () => (state.filters.exactTokens = false));
  if (f.unitMin != null) add(`1 шт от ${fmtTokens(f.unitMin)}`, () => (state.filters.unitMin = null));
  if (f.unitMax != null) add(`1 шт до ${fmtTokens(f.unitMax)}`, () => (state.filters.unitMax = null));
  if (f.qtyMode === 'exclude1') add('без лотов с 1 шт', () => (state.filters.qtyMode = 'any'));
  if (f.qtyMode === 'known') add('только с наличием', () => (state.filters.qtyMode = 'any'));
  if (f.qtyMode === 'range') {
    add(`наличие ${f.qtyMin != null ? 'от ' + f.qtyMin : ''}${f.qtyMin != null && f.qtyMax != null ? ' ' : ''}${f.qtyMax != null ? 'до ' + f.qtyMax : ''} шт`, () => {
      state.filters.qtyMode = 'any';
      state.filters.qtyMin = null;
      state.filters.qtyMax = null;
    });
  }
  if (state.hiddenOffers.length) add(`скрыто предложений: ${state.hiddenOffers.length}`, () => {
    state.hiddenOffers = [];
    saveHiddenOffers();
    renderHiddenOffers();
  });
  if (f.sellersExclude.length) add(`скрыто продавцов: ${f.sellersExclude.length}`, () => {
    state.filters.sellersExclude = [];
    state.hiddenSellers = [];
    saveHidden();
    renderHiddenSellers();
  });
  updateFilterBadges();
}

function renderHiddenSellers() {
  const wrap = $('#hiddenSellers');
  wrap.innerHTML = '';
  if (!state.hiddenSellers.length) {
    wrap.innerHTML = '<span class="hint" style="margin:0">пока никого не скрывали</span>';
    return;
  }
  for (const s of state.hiddenSellers) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip removable';
    b.innerHTML = `${esc(s.name || s.id)} <svg class="ic" style="width:10px;height:10px"><use href="#i-close"/></svg>`;
    b.addEventListener('click', () => {
      state.hiddenSellers = state.hiddenSellers.filter((x) => String(x.id) !== String(s.id));
      state.filters.sellersExclude = state.filters.sellersExclude.filter((id) => id !== String(s.id));
      saveHidden();
      renderHiddenSellers();
      commit();
    });
    wrap.appendChild(b);
  }
}

function renderHiddenOffers() {
  const wrap = $('#hiddenOffers');
  wrap.innerHTML = '';
  if (!state.hiddenOffers.length) {
    wrap.innerHTML = '<span class="hint" style="margin:0">пока нет скрытых предложений</span>';
    return;
  }
  for (const offer of state.hiddenOffers) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip removable hidden-offer-chip';
    b.title = 'Вернуть: ' + offer.title;
    b.setAttribute('aria-label', 'Вернуть предложение: ' + offer.title);
    b.innerHTML = `<span>${esc(offer.title)}</span><svg class="ic" style="width:10px;height:10px"><use href="#i-close"/></svg>`;
    b.addEventListener('click', () => {
      state.hiddenOffers = state.hiddenOffers.filter((o) => o.id !== offer.id);
      saveHiddenOffers();
      renderHiddenOffers();
      commit();
      toast('Предложение возвращено');
    });
    wrap.appendChild(b);
  }
}

/* ---------- data ---------- */

async function load({ append = false, silent = false, retryReviews = false } = {}) {
  const reqId = ++state.reqId;
  clearTimeout(state.reviewTimer);
  state.reviewTimer = null;
  const reviewFiltering = (state.appliedFilters || state.filters).noReviewStars.length > 0;
  // Фоновое обновление не должно сбрасывать прокрутку, пагинацию и
  // раскрытые описания. Если пользователь уже взаимодействовал со списком,
  // обновляем карточки точечно, не перерисовывая DOM.
  const keepList =
    silent &&
    !append &&
    !reviewFiltering &&
    state.items.length > 0 &&
    (state.page > 1 || state.expanded.size > 0 || window.scrollY > 140);
  if (!append && !silent) skeletons();
  const page = append ? state.page + 1 : 1;
  const preservedPage = reviewFiltering && silent && !append ? state.page : 1;
  const qs = queryFor(page) + (retryReviews ? '&reviewRetry=1' : '');
  try {
    const res = await apiFetch('/api/offers?' + qs);
    const data = await res.json();
    if (reqId !== state.reqId) return;
    if (!res.ok || data.error) throw new Error(data.error || `Ошибка загрузки (${res.status})`);

    // При проверке отзывов перечитываем весь уже открытый диапазон страниц:
    // ни старые неподходящие продавцы, ни сброс до первой страницы недопустимы.
    if (preservedPage > 1) {
      const freshItems = new Map(data.items.map((offer) => [String(offer.id), offer]));
      let lastPage = 1;
      for (let nextPage = 2; nextPage <= Math.min(preservedPage, data.pages); nextPage++) {
        const params = new URLSearchParams(qs);
        params.set('page', String(nextPage));
        params.delete('reviewRetry');
        const response = await apiFetch('/api/offers?' + params.toString());
        const extra = await response.json();
        if (reqId !== state.reqId) return;
        if (!response.ok || extra.error) throw new Error(extra.error || `Ошибка загрузки (${response.status})`);
        for (const offer of extra.items) freshItems.set(String(offer.id), offer);
        data.total = extra.total;
        data.pages = extra.pages;
        for (const key of ['stats', 'history', 'desc', 'updatedAt', 'reviewCheck', 'refreshError']) {
          if (Object.hasOwn(extra, key)) data[key] = extra[key];
        }
        lastPage = Math.min(nextPage, Math.max(1, data.pages));
      }
      data.items = [...freshItems.values()].slice(0, Math.max(1, data.pages) * (state.appliedFilters || state.filters).pageSize);
      data.page = lastPage;
    }

    state.total = data.total;
    state.stats = data.stats;
    state.history = data.history || [];
    state.desc = data.desc;
    state.reviewCheck = data.reviewCheck || null;
    renderReviewCheck();
    if (keepList) {
      // Список в DOM остаётся как есть; подтягиваем цены и бейджи.
      state.pages = Math.max(state.pages, data.pages);
      const fresh = new Map(data.items.map((o) => [o.id, o]));
      state.items = state.items.map((o) => fresh.get(o.id) || o);
      patchCards(data.items);
    } else {
      state.page = data.page;
      state.pages = data.pages;
      if (append) {
        state.items = state.items.concat(data.items);
        renderList(data.items, true);
      } else {
        state.items = data.items;
        renderList(data.items, false);
      }
    }

    if (!append) {
      renderHero(data);
      renderNeedCard(data);
    }
    renderResultInfo(data, { keepList });
    renderActiveChips();
    renderDeploymentInfo(data);
    if (state.meta) $('#totalLots').textContent = fmtCount(state.meta.total);
    if (data.refreshError) toast(data.refreshError);
    if (data.desc && data.desc.queued + data.desc.active > 0) pollEnrich();
    if (reviewFiltering && reviewCheckBusy()) pollReviewChecks();
  } catch (err) {
    if (reqId !== state.reqId) return;
    $('#moreBtn').hidden = true;
    $('#empty').hidden = true;
    if (reviewFiltering) renderReviewCheck('Не удалось обновить результаты проверки. Повторите запрос.');
    $('#list').innerHTML = `<div class="empty"><div class="empty-mark">◌</div><h3>Не удалось загрузить</h3><p>${esc(err.message)}</p><button class="btn btn-accent" onclick="location.reload()">Повторить</button></div>`;
  }
}

function reviewCheckBusy() {
  const check = state.reviewCheck;
  return !!check && (Number(check.pendingSellers) > 0 || Number(check.queued) > 0 || Number(check.activeRequests) > 0);
}

function renderReviewCheck(error = '') {
  const box = $('#reviewCheckProgress');
  const active = (state.appliedFilters || state.filters).noReviewStars.length > 0;
  box.hidden = !active;
  if (!active) return;
  const check = state.reviewCheck;
  if (isSnapshotMode() || check?.unavailable) {
    $('#reviewCheckText').textContent = 'Проверка всех отзывов недоступна в опубликованном снимке. Показаны только продавцы с подтверждёнными данными; непроверенные исключены. Уберите фильтр «без отзывов на …★», чтобы увидеть остальные предложения.';
    box.classList.remove('is-pending');
    box.classList.add('is-error');
    $('#reviewCheckRetry').hidden = true;
    return;
  }
  const busy = reviewCheckBusy();
  const failed = Number(check?.failedSellers) || 0;
  $('#reviewCheckText').textContent = error || (check
    ? `Проверка отзывов по всему профилю: ${fmtCount(check.checkedSellers)} из ${fmtCount(check.totalSellers)} продавцов${busy ? ` · осталось ${fmtCount(check.pendingSellers)}` : ' · завершена'}${failed ? ` · не удалось проверить: ${fmtCount(failed)}` : ''}. Непроверенные не показаны.`
    : 'Проверка отзывов по всему профилю. В результатах только проверенные продавцы.');
  box.classList.toggle('is-pending', !error && busy);
  box.classList.toggle('is-error', !!error || failed > 0);
  $('#reviewCheckRetry').hidden = !error && !failed;
}

function pollReviewChecks() {
  if (isSnapshotMode() || state.reviewCheck?.unavailable || state.reviewTimer) return;
  state.reviewTimer = setTimeout(() => {
    state.reviewTimer = null;
    if ((state.appliedFilters || state.filters).noReviewStars.length) load({ silent: true });
  }, 2500);
}

/** Точечное обновление уже отрисованных карточек (бейджи, цена) без перерисовки. */
function patchCards(items) {
  for (const o of items) {
    const card = $(`#list .offer[data-id="${CSS.escape(o.id)}"]`);
    if (!card) continue;
    const badges = card.querySelector('.offer-badges');
    if (badges) badges.innerHTML = badgeHtml(o);
    const perM = card.querySelector('.per-m');
    if (perM) perM.innerHTML = priceMetric(o);
    const price = card.querySelector('.price');
    if (price) price.textContent = fmtMoney(o.price);
    const reviewsButton = card.querySelector('[data-act="reviews"]');
    if (reviewsButton) {
      const count = fmtCount(o.seller.reviewSummary?.total ?? o.seller.reviews);
      reviewsButton.textContent = 'Отзывы ' + count;
      reviewsButton.setAttribute('aria-label', `Отзывы о продавце ${o.seller.name || 'FunPay'}: ${count}`);
    }
    const volume = card.querySelector('.tile-volume');
    if (volume) volume.textContent = volumeMetric(o);
    const preview = card.querySelector('.tile-description');
    if (preview) preview.innerHTML = descriptionHtml(tileDescription(o));
    const priceBlock = card.querySelector('.price-block, .tile-pricebox');
    const oldNeed = priceBlock && priceBlock.querySelector('.need-line, .tile-need');
    if (priceBlock) {
      if (oldNeed) oldNeed.remove();
      if (o.needCost) priceBlock.insertAdjacentHTML('beforeend', `<div class="${state.view === 'grid' ? 'tile-need' : 'need-line'}">×${o.needCost.units} шт → ${fmtMoney(o.needCost.cost)}</div>`);
    }
    const meta = card.querySelector('.offer-meta');
    if (meta && o.descLoaded) {
      const parts = [];
      parts.push(`<span>${volumeMetric(o)}</span>`);
      if (o.perItemTokens) parts.push(`<span>1 шт = ${fmtTokens(o.perItemTokens)}</span>`);
      if (o.modelLabel) parts.push(`<span>${esc(o.modelLabel)}</span>`);
      if (parts.length) meta.innerHTML = parts.join('');
    }
  }
}

async function loadMeta() {
  try {
    const res = await apiFetch('/api/meta');
    const meta = await res.json();
    if (!res.ok || meta.error) throw new Error(meta.error || 'Не удалось получить каталог');
    state.meta = meta;
    renderDeploymentInfo(meta);
    $('#totalLots').textContent = fmtCount(meta.total);
    buildCatChips(meta.categories || []);
    buildModelChips(meta.models || []);
    renderHiddenSellers();
    applyFiltersToInputs();
    renderActiveChips();
    if (!meta.updatedAt && !isSnapshotMode()) setTimeout(loadMeta, 2500);
    return meta;
  } catch {
    if (!isSnapshotMode()) setTimeout(loadMeta, 2500);
    return null;
  }
}

/* ---------- interactions ---------- */

function commit() {
  if (!validateFilterInputs()) return;
  state.appliedFilters = cloneFilters(state.filters);
  state.reviewCheck = null;
  renderReviewCheck();
  syncUrl();
  applyFiltersToInputs();
  renderActiveChips();
  load();
}

const debounced = (fn, ms) => {
  let t;
  const schedule = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...a);
    }, ms);
  };
  schedule.cancel = () => {
    clearTimeout(t);
    t = null;
  };
  return schedule;
};

function bind() {
  $('#presetRow').addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    const preset = presetForMode(b.dataset.preset);
    if (!preset) return;
    state.cancelVolumeInputs?.();
    const { cats, models, q, sellersExclude, noReviewStars } = state.filters;
    state.filters = cloneFilters({ ...DEFAULTS, cats, models, q, sellersExclude, noReviewStars, ...preset.apply });
    applyFiltersToInputs(true);
    toast(`Набор «${preset.label}» применён`);
    commit();
  });

  $('#presetReset')?.addEventListener('click', resetFilters);
  const closePresetForm = () => {
    $('#savePresetForm').hidden = true;
    $('#savePresetBtn').setAttribute('aria-expanded', 'false');
  };
  $('#savePresetBtn')?.addEventListener('click', () => {
    const open = $('#savePresetForm').hidden;
    $('#savePresetForm').hidden = !open;
    $('#savePresetBtn').setAttribute('aria-expanded', String(open));
    if (open) {
      $('#presetName').value = state.customPreset?.name || '';
      $('#presetName').focus({ preventScroll: true });
    }
  });
  $('#cancelSavePreset')?.addEventListener('click', () => {
    closePresetForm();
    $('#savePresetBtn').focus({ preventScroll: true });
  });
  $('#savePresetForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!validateFilterInputs()) { toast('Сначала исправьте значения фильтров'); return; }
    const preset = { name: $('#presetName').value.trim().slice(0, 40) || 'Мой набор', filters: cloneFilters(state.appliedFilters || state.filters) };
    try {
      localStorage.setItem(CUSTOM_PRESET_KEY, JSON.stringify(preset));
      state.customPreset = preset;
      updateSavedPreset();
      closePresetForm();
      $('#applySavedPreset').focus({ preventScroll: true });
      toast('Набор сохранён в этом браузере');
    } catch { toast('Браузер не разрешил сохранить набор. Проверьте доступ к хранилищу.'); }
  });
  $('#applySavedPreset')?.addEventListener('click', () => {
    if (!state.customPreset) return;
    state.cancelVolumeInputs?.();
    state.filters = cloneFilters(state.customPreset.filters);
    state.filters.sellersExclude = [...new Set([...state.filters.sellersExclude, ...state.hiddenSellers.map((seller) => String(seller.id))])];
    applyFiltersToInputs(true);
    commit();
    toast(`Набор «${state.customPreset.name}» применён`);
  });
  $('#deleteSavedPreset')?.addEventListener('click', () => {
    try {
      localStorage.removeItem(CUSTOM_PRESET_KEY);
      state.customPreset = null;
      updateSavedPreset();
      closePresetForm();
      $('#savePresetBtn').focus({ preventScroll: true });
      toast('Сохранённый набор удалён');
    } catch { toast('Не удалось изменить хранилище браузера'); }
  });

  $('#volumeMode').addEventListener('change', (event) => chooseVolumeMode(event.target.value));

  const onNeed = debounced(() => {
    const v = parseHuman($('#needInput').value);
    state.filters.need = v && v > 0 ? Math.round(v) : 0;
    state.filters.minTokens = null;
    state.filters.maxTokens = null;
    state.volumeMode = 'exact';
    commit();
  }, 400);
  $('#needInput').addEventListener('input', onNeed);

  $('#needPresets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.cancelVolumeInputs?.();
    const v = Number(b.dataset.v);
    state.filters.need = state.filters.need === v ? 0 : v;
    state.filters.minTokens = null;
    state.filters.maxTokens = null;
    state.volumeMode = 'exact';
    commit();
  });

  const onSearch = debounced(() => {
    state.filters.q = $('#q').value.trim();
    commit();
  }, 350);
  $('#q').addEventListener('input', onSearch);

  $('#sort').addEventListener('change', (e) => {
    state.filters.sort = e.target.value;
    commit();
  });

  $('#minStars').addEventListener('change', (e) => {
    state.filters.minStars = Number(e.target.value) || 0;
    commit();
  });

  const onMinReviews = debounced(() => {
    state.filters.minReviews = parseHuman($('#minReviews').value) || 0;
    commit();
  }, 400);
  $('#minReviews').addEventListener('input', onMinReviews);

  $$('[data-no-review-star]').forEach((input) => input.addEventListener('change', () => {
    state.filters.noReviewStars = normalizeReviewStars($$('[data-no-review-star]:checked').map((el) => el.dataset.noReviewStar));
    commit();
  }));
  $('#reviewCheckRetry').addEventListener('click', () => load({ silent: true, retryReviews: true }));
  document.addEventListener('tokenradar:reviews-summary', (event) => {
    const { sellerId, summary } = event.detail || {};
    if (!summary || sellerId == null) return;
    for (const offer of state.items) {
      if (String(offer.seller.id) === String(sellerId)) offer.seller.reviewSummary = summary;
    }
    patchCards(state.items.filter((offer) => String(offer.seller.id) === String(sellerId)));
    if ((state.appliedFilters || state.filters).noReviewStars.length) pollReviewChecks();
  });

  $('#minAgeMonths').addEventListener('change', (e) => {
    state.filters.minAgeMonths = Number(e.target.value) || 0;
    commit();
  });

  $('#autoOnly').addEventListener('change', (e) => {
    state.filters.auto = e.target.checked;
    commit();
  });
  $('#onlineOnly').addEventListener('change', (e) => {
    state.filters.online = e.target.checked;
    commit();
  });
  $('#noRateLimited').addEventListener('change', (e) => {
    state.filters.noRateLimited = e.target.checked;
    commit();
  });
  $('#noCredits').addEventListener('change', (e) => {
    state.filters.noCredits = e.target.checked;
    if (e.target.checked && state.filters.offerType === 'credits') state.filters.offerType = 'any';
    commit();
  });
  $('#onlyDesc').addEventListener('change', (e) => {
    state.filters.onlyDesc = e.target.checked;
    commit();
  });
  $('#excludeOneToOne').addEventListener('change', (e) => {
    state.filters.oneToOne = e.target.checked ? 'exclude' : 'any';
    commit();
  });
  $('#exactTokens').addEventListener('change', (e) => {
    state.filters.exactTokens = e.target.checked;
    commit();
  });

  $('#viewToggle').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    setView(b.dataset.view);
  });

  $('#unitKnown').addEventListener('change', (e) => {
    state.filters.unitKnown = e.target.checked;
    commit();
  });

  $('#qtyMode').addEventListener('change', (e) => {
    state.filters.qtyMode = e.target.value;
    if (state.filters.qtyMode !== 'range') {
      state.filters.qtyMin = null;
      state.filters.qtyMax = null;
    }
    $('#qtyRange').hidden = state.filters.qtyMode !== 'range';
    commit();
  });
  const onQtyRange = debounced(() => {
    const f = state.filters;
    f.qtyMin = parseHuman($('#qtyMin').value);
    f.qtyMax = parseHuman($('#qtyMax').value);
    commit();
  }, 450);
  ['#qtyMin', '#qtyMax'].forEach((s) => $(s).addEventListener('input', onQtyRange));

  $('#bonusSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.filters.bonus = b.dataset.v;
    commit();
  });
  $('#inputOutputSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    state.filters.inputOutput = b.dataset.v;
    commit();
  });
  $('#refundSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.filters.refund = b.dataset.v;
    commit();
  });

  const onRange = debounced((event) => {
    const f = state.filters;
    if (['minTokens', 'maxTokens'].includes(event.target.id)) {
      f.need = 0;
      state.volumeMode = 'range';
    }
    f.minPriceM = parseHuman($('#minPriceM').value);
    f.maxPriceM = parseHuman($('#maxPriceM').value);
    f.minLotPrice = parseHuman($('#minLotPrice').value);
    f.maxLotPrice = parseHuman($('#maxLotPrice').value);
    f.minTokens = parseHuman($('#minTokens').value);
    f.maxTokens = parseHuman($('#maxTokens').value);
    f.unitMin = parseHuman($('#unitMin').value);
    f.unitMax = parseHuman($('#unitMax').value);
    commit();
  }, 450);
  ['#minPriceM', '#maxPriceM', '#minLotPrice', '#maxLotPrice', '#minTokens', '#maxTokens', '#unitMin', '#unitMax'].forEach((s) =>
    $(s).addEventListener('input', onRange)
  );
  state.cancelVolumeInputs = () => { onNeed.cancel(); onRange.cancel(); };

  const drawerMedia = window.matchMedia('(max-width: 960px)');
  let sidebarCollapsed = false;
  try { sidebarCollapsed = localStorage.getItem(SIDEBAR_KEY) === 'true'; } catch {}
  const filtersVisible = () => drawerMedia.matches
    ? document.body.classList.contains('filters-open')
    : !sidebarCollapsed;
  const syncDrawer = () => {
    const open = filtersVisible();
    document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed);
    $('#filters').inert = !open;
    $('#filtersToggle').setAttribute('aria-expanded', String(open));
    const label = open ? 'Скрыть панель фильтров' : 'Показать панель фильтров';
    $('#filtersToggle').setAttribute('aria-label', label);
    $('#filtersToggle').title = label;
    $('#filtersClose').textContent = drawerMedia.matches ? 'Готово' : 'Скрыть';
    $('#filtersClose').setAttribute('aria-label', 'Скрыть панель фильтров');
  };
  const saveSidebar = () => {
    try { localStorage.setItem(SIDEBAR_KEY, String(sidebarCollapsed)); } catch {}
  };
  const closeFilters = () => {
    const wasOpen = filtersVisible();
    document.body.classList.remove('filters-open');
    if (!drawerMedia.matches) { sidebarCollapsed = true; saveSidebar(); }
    syncDrawer();
    if (wasOpen) $('#filtersToggle').focus({ preventScroll: true });
  };
  drawerMedia.addEventListener('change', () => {
    document.body.classList.remove('filters-open');
    const focusInPanel = $('#filters').contains(document.activeElement);
    syncDrawer();
    if (!filtersVisible() && focusInPanel) $('#filtersToggle').focus({ preventScroll: true });
  });
  $('#filtersToggle').setAttribute('aria-controls', 'filters');
  syncDrawer();
  $('#filtersToggle').addEventListener('click', () => {
    if (drawerMedia.matches) document.body.classList.toggle('filters-open');
    else { sidebarCollapsed = !sidebarCollapsed; saveSidebar(); }
    syncDrawer();
    if (drawerMedia.matches && filtersVisible()) $('#filtersClose').focus({ preventScroll: true });
  });
  $('#filtersBackdrop').addEventListener('click', closeFilters);
  $('#filtersClose').addEventListener('click', closeFilters);
  $('#filterApply').addEventListener('click', () => {
    if (!validateFilterInputs()) {
      const invalid = $('#filters [aria-invalid="true"]');
      if (invalid) { invalid.closest('details').open = true; invalid.focus(); }
      return;
    }
    closeFilters();
    $('#resultInfo').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  });
  $('#modelSearch').addEventListener('input', filterModelChips);
  bindAccessFilters();
  document.addEventListener('keydown', (e) => {
    if ($('#reviewsDialog')?.open) return;
    const editing = e.target instanceof Element && !!e.target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
    if (e.key === '/' && !editing && !e.ctrlKey && !e.metaKey && !e.altKey && !document.body.classList.contains('filters-open')) {
      e.preventDefault();
      $('#q').focus();
      return;
    }
    if (e.key === 'Escape' && (document.body.classList.contains('filters-open') || $('#filters').contains(document.activeElement))) closeFilters();
    if (e.key !== 'Tab' || !drawerMedia.matches || !document.body.classList.contains('filters-open')) return;
    const controls = [...$('#filters').querySelectorAll('button, input, select, summary, a[href]')].filter((el) => !el.disabled && el.getClientRects().length > 0);
    const first = controls[0], last = controls[controls.length - 1];
    if (e.shiftKey && (document.activeElement === first || !$('#filters').contains(document.activeElement))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !$('#filters').contains(document.activeElement))) {
      e.preventDefault(); first.focus();
    }
  });

  $('#resetBtn').addEventListener('click', resetFilters);
  $('#emptyReset').addEventListener('click', resetFilters);

  $('#moreBtn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    await load({ append: true, silent: true });
    e.target.disabled = false;
  });

  const shareSelection = async (event) => {
    const button = event.currentTarget;
    syncUrl();
    await copyText(location.href);
    button.classList.add('is-copied');
    setTimeout(() => button.classList.remove('is-copied'), 1600);
    toast('Ссылка на подборку скопирована');
  };
  $('#shareBtn').addEventListener('click', shareSelection);
  $('#copyBtn').addEventListener('click', shareSelection);

  $('#refreshBtn').addEventListener('click', async () => {
    const btn = $('#refreshBtn');
    btn.disabled = true;
    $('#live').classList.add('busy');
    try {
      const response = await apiFetch('/api/refresh', { method: 'POST' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Не удалось обновить данные');
      }
      const meta = await loadMeta();
      if (!meta) throw new Error('Не удалось перечитать каталог');
      await load({ silent: true });
      toast(isSnapshotMode() ? 'Опубликованный снимок перечитан. Новый сбор не запускался.' : 'Данные обновлены');
    } catch (error) {
      toast(error.message || 'Не удалось обновить');
    } finally {
      btn.disabled = false;
      $('#live').classList.remove('busy');
    }
  });

  $('#enrichBtn').addEventListener('click', async () => {
    try {
      const res = await apiFetch('/api/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cheap: true, cats: state.filters.cats, limit: 120 }),
      });
      const data = await res.json();
      toast(data.queued ? `В очередь добавлено ${data.queued} лотов` : 'Все доступные описания уже загружены');
      pollEnrich(true);
    } catch {
      toast('Не удалось запустить анализ');
    }
  });

  $('#list').addEventListener('click', onListClick);
}

async function onListClick(e) {
  const btn = e.target.closest('[data-act]');
  const card = e.target.closest('.offer');
  if (!card) return;
  const id = card.dataset.id;
  const offer = state.items.find((o) => o.id === id);

  if (btn && btn.dataset.act === 'reviews' && offer) {
    window.TokenRadarReviews?.open(offer.seller, btn);
    return;
  }

  if (btn && btn.dataset.act === 'copy') {
    await copyText(`https://funpay.com/lots/offer?id=${id}`);
    toast('Ссылка на лот скопирована');
    btn.classList.add('on');
    setTimeout(() => btn.classList.remove('on'), 900);
    return;
  }

  if (btn && btn.dataset.act === 'hide-offer' && offer) {
    if (!state.hiddenOffers.some((o) => o.id === id)) {
      state.hiddenOffers.push({ id, title: offer.title });
      saveHiddenOffers();
    }
    state.expanded.delete(id);
    renderHiddenOffers();
    commit();
    toast('Предложение скрыто. Вернуть можно в фильтрах → Скрытые');
    return;
  }

  if (btn && btn.dataset.act === 'hide' && offer) {
    const seller = offer.seller;
    if (!seller.id) return;
    if (!state.hiddenSellers.some((s) => String(s.id) === String(seller.id))) {
      state.hiddenSellers.push({ id: String(seller.id), name: seller.name });
      saveHidden();
    }
    if (!state.filters.sellersExclude.includes(String(seller.id))) {
      state.filters.sellersExclude.push(String(seller.id));
    }
    toast(`Продавец «${seller.name}» скрыт`);
    renderHiddenSellers();
    commit();
    return;
  }

  if (btn && btn.dataset.act === 'desc' && offer) {
    toggleDescription(card, offer);
  }
}

function toggleDescription(card, offer) {
  let existing;
  if (state.view === 'grid') {
    existing = $(`#list .offer-desc[data-for="${CSS.escape(offer.id)}"]`);
  } else {
    existing = card.querySelector('.offer-desc');
  }
  if (existing) {
    existing.remove();
    card.classList.remove('expanded');
    state.expanded.delete(offer.id);
    return;
  }
  expandDescription(card, offer);
}

async function expandDescription(card, offer) {
  const gridMode = state.view === 'grid';
  if (card.querySelector('.offer-desc')) return;
  state.expanded.add(offer.id);
  const box = document.createElement('div');
  box.className = 'offer-desc';
  box.dataset.for = offer.id;
  box.textContent = 'Загружаем описание…';
  if (gridMode) card.classList.add('expanded');
  card.appendChild(box);

  try {
    let data = state.descCache.get(offer.id);
    if (!data) {
      const res = await apiFetch('/api/offer?id=' + encodeURIComponent(offer.id));
      data = await res.json();
      state.descCache.set(offer.id, data);
    }
    if (!box.isConnected) return;
    if (data.error) {
      box.innerHTML = `<span class="desc-empty">${esc(data.error)}</span>`;
      return;
    }
    box.innerHTML = expandedDescriptionHtml(data.description || 'Описание пустое.');
    if (data.offer) {
      Object.assign(offer, data.offer);
      const badges = card.querySelector('.offer-badges');
      if (badges) badges.innerHTML = badgeHtml(offer);
      patchCards([offer]);
    }
  } catch (err) {
    if (box.isConnected) box.innerHTML = `<span class="desc-empty">Не удалось загрузить: ${esc(err.message)}</span>`;
  }
}

function pollEnrich(force = false) {
  if (isSnapshotMode()) return;
  if (state.enrichTimer && !force) return;
  if (state.enrichTimer) clearInterval(state.enrichTimer);
  let ticks = 0;
  state.enrichTimer = setInterval(async () => {
    ticks++;
    await load({ silent: true });
    if (!state.desc || (!state.desc.queued && !state.desc.active) || ticks > 20) {
      clearInterval(state.enrichTimer);
      state.enrichTimer = null;
    }
  }, 6000);
}

function resetFilters() {
  state.cancelVolumeInputs?.();
  state.filters = cloneFilters({ ...DEFAULTS, sellersExclude: state.hiddenSellers.map((s) => String(s.id)) });
  $('#modelSearch').value = '';
  filterModelChips();
  applyFiltersToInputs(true);
  commit();
}


const NUMERIC_FIELDS = {
  needInput: 'Нужный объём', minReviews: 'Отзывы',
  minPriceM: 'Цена за 1М от', maxPriceM: 'Цена за 1М до',
  minLotPrice: 'Цена лота от', maxLotPrice: 'Цена лота до',
  minTokens: 'Объём от', maxTokens: 'Объём до',
  unitMin: 'Объём за штуку от', unitMax: 'Объём за штуку до',
  qtyMin: 'Наличие от', qtyMax: 'Наличие до',
  minDuration: 'Срок от', maxDuration: 'Срок до',
};

function validateFilterInputs() {
  let error = '';
  const values = {};
  for (const [id, label] of Object.entries(NUMERIC_FIELDS)) {
    const el = $('#' + id);
    el.removeAttribute('aria-invalid');
    const raw = el.value.trim();
    const value = parseHuman(raw);
    values[id] = value;
    if (raw && (value == null || ((id === 'minDuration' || id === 'maxDuration') && value <= 0))) {
      el.setAttribute('aria-invalid', 'true');
      error ||= label + ': введите ' + (id.includes('Duration') ? 'число больше нуля.' : 'неотрицательное число, например 10 или 1,5.');
    }
  }
  for (const [min, max, label] of [
    ['minPriceM', 'maxPriceM', 'Цена за 1М'], ['minLotPrice', 'maxLotPrice', 'Цена лота'],
    ['minTokens', 'maxTokens', 'Объём'], ['unitMin', 'unitMax', 'Объём за штуку'],
    ['qtyMin', 'qtyMax', 'Наличие'], ['minDuration', 'maxDuration', 'Срок'],
  ]) {
    if (values[min] != null && values[max] != null && values[min] > values[max]) {
      $('#' + min).setAttribute('aria-invalid', 'true');
      $('#' + max).setAttribute('aria-invalid', 'true');
      error ||= label + ': значение «от» должно быть не больше «до».';
    }
  }
  $('#filterError').textContent = error;
  $('#filterError').hidden = !error;
  return !error;
}

function chooseVolumeMode(value) {
  if (!['any', 'exact', 'range'].includes(value)) return;
  state.cancelVolumeInputs?.();
  if (value !== 'any' && ['unlimited', 'timed', 'credits'].includes(state.filters.offerType)) chooseOfferType('tokens');
  state.filters.need = 0;
  state.filters.minTokens = null;
  state.filters.maxTokens = null;
  state.volumeMode = value;
  // Clear drafts too: an invalid hidden value must not block another mode.
  for (const id of ['needInput', 'minTokens', 'maxTokens']) $('#' + id).value = '';
  applyFiltersToInputs();
  commit();
}

function chooseOfferType(value) {
  const f = state.filters;
  f.offerType = value;
  f.minDuration = null;
  f.maxDuration = null;
  if (['unlimited', 'timed', 'credits'].includes(value)) {
    state.cancelVolumeInputs?.();
    for (const key of ['minPriceM', 'maxPriceM', 'minTokens', 'maxTokens', 'unitMin', 'unitMax']) f[key] = null;
    f.unitKnown = false;
    f.exactTokens = false;
    f.need = 0;
    if (['priceM', 'tokens', 'need'].includes(f.sort)) f.sort = value === 'timed' ? 'priceHour' : 'price';
  } else if (['priceHour', 'duration'].includes(f.sort)) {
    f.sort = value === 'tokens' ? 'priceM' : 'price';
  }
  if (value === 'credits') f.noCredits = false;
  applyFiltersToInputs(true);
}

function bindAccessFilters() {
  $('#offerType').addEventListener('change', (e) => { chooseOfferType(e.target.value); commit(); });
  $('#durationPresets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-minutes]');
    if (!b) return;
    const minutes = Number(b.dataset.minutes);
    const f = state.filters;
    if (minutes) {
      chooseOfferType('timed');
      f.minDuration = minutes;
      f.maxDuration = minutes;
      state.durationUnit = minutes >= 1440 ? 1440 : 60;
    } else { f.minDuration = null; f.maxDuration = null; }
    applyFiltersToInputs(true);
    commit();
  });
  const readDuration = () => {
    const min = parseHuman($('#minDuration').value);
    const max = parseHuman($('#maxDuration').value);
    if (min != null || max != null) {
      const saved = [$('#minDuration').value, $('#maxDuration').value];
      if (state.filters.offerType !== 'timed') chooseOfferType('timed');
      $('#minDuration').value = saved[0];
      $('#maxDuration').value = saved[1];
    }
    state.filters.minDuration = min != null ? min * state.durationUnit : null;
    state.filters.maxDuration = max != null ? max * state.durationUnit : null;
  };
  const onDuration = debounced(() => { readDuration(); commit(); }, 400);
  ['#minDuration', '#maxDuration'].forEach((s) => $(s).addEventListener('input', onDuration));
  $('#durationUnit').addEventListener('change', (e) => {
    // Смена единиц сохраняет сам срок: 1 час превращается в 60 минут.
    const nextUnit = Number(e.target.value);
    readDuration();
    if (!validateFilterInputs()) { e.target.value = state.durationUnit; return; }
    state.durationUnit = nextUnit;
    applyFiltersToInputs(true);
    commit();
  });
}

/* Subtle pointer motion is optional; no input is delayed by animation. */
function bindMotion() {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const pointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  $$('.magnetic').forEach((button) => {
    button.addEventListener('pointermove', (event) => {
      if (reduced.matches || !pointer.matches || button.disabled) return;
      const rect = button.getBoundingClientRect();
      button.style.setProperty('--magnet-x', Math.max(-3, Math.min(3, (event.clientX - rect.left - rect.width / 2) * .045)) + 'px');
      button.style.setProperty('--magnet-y', Math.max(-3, Math.min(3, (event.clientY - rect.top - rect.height / 2) * .06)) + 'px');
    });
    button.addEventListener('pointerleave', () => {
      button.style.removeProperty('--magnet-x');
      button.style.removeProperty('--magnet-y');
    });
  });
}

/* ---------- boot ---------- */

(function boot() {
  loadHidden();
  loadCustomPreset();
  loadHiddenOffers();
  renderHiddenOffers();
  buildCatChips([]);
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === 'list' || saved === 'grid') state.view = saved;
  } catch {}
  state.filters = readUrl();
  state.appliedFilters = cloneFilters(state.filters);
  applyView();
  bind();
  bindMotion();
  renderDeploymentInfo();
  for (const [id, label] of Object.entries(NUMERIC_FIELDS)) $('#' + id).setAttribute('aria-label', label);
  applyFiltersToInputs();
  renderHiddenSellers();
  renderActiveChips();
  loadMeta();
  load();
  if (!isSnapshotMode()) setInterval(() => { if (!isSnapshotMode()) load({ silent: true }); }, 180000);
})();
