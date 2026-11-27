'use strict';

/**
 * Парсер страниц FunPay: списки лотов и карточки офферов.
 * Работает на регулярных выражениях по стабильной разметке FunPay.
 */

const { detectInputOutput } = require('./billing');

const CATEGORIES = [
  { id: '4506', name: 'DeepSeek', full: 'API-ключ DeepSeek', url: 'https://funpay.com/lots/4506/', color: '#4d6bfe' },
  { id: '4752', name: 'OpenCode', full: 'Токены Opencode AI', url: 'https://funpay.com/lots/4752/', color: '#00c2a8' },
  { id: '4448', name: 'ChatGPT', full: 'Токены ChatGPT', url: 'https://funpay.com/lots/4448/', color: '#10a37f' },
  { id: '4615', name: 'Gemini', full: 'Токены Gemini', url: 'https://funpay.com/lots/4615/', color: '#4285f4' },
  { id: '4234', name: 'Claude', full: 'Токены Claude', url: 'https://funpay.com/lots/4234/', color: '#d97757' },
  { id: '4614', name: 'Kimi', full: 'Токены Kimi', url: 'https://funpay.com/lots/4614/', color: '#8b5cf6' },
];

const CAT_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

const MODEL_LABELS = {
  'deepseek v4 pro': 'DeepSeek V4 Pro',
  'deepseek v4 flash': 'DeepSeek V4 Flash',
  'deepseek v4': 'DeepSeek V4',
  'v3': 'DeepSeek V3',
  'r1': 'DeepSeek R1',
  'прочее': 'Прочее',
  'токены chatgpt': 'ChatGPT',
  'токены claude': 'Claude',
  'токены gemini': 'Gemini',
  'токены kimi': 'Kimi',
  'токены opencode ai': 'OpenCode',
};

function modelLabel(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const low = s.toLowerCase();
  if (MODEL_LABELS[low]) return MODEL_LABELS[low];
  if (/^токены\s+/i.test(s)) return s.replace(/^токены\s+/i, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'", '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&laquo;': '«', '&raquo;': '»',
};

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|#039|apos|nbsp|mdash|ndash|laquo|raquo);/g, (m) => ENTITIES[m] || m);
}

function htmlToText(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normText(s) {
  return String(s || '')
    .replace(/\u00a0|\u2007|\u2009|\u202f/g, ' ')
    .replace(/[ᴍᴋᴛʙ]/g, (c) => ({ 'ᴍ': 'M', 'ᴋ': 'K', 'ᴛ': 'T', 'ʙ': 'B' }[c]))
    .replace(/[ёЁ]/g, (c) => (c === 'ё' ? 'е' : 'Е'))
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* token amount parsing                                                */
/* ------------------------------------------------------------------ */

// Число: "10.000.000", "1 000 000", "1.5", "700", "1,125"
const NUM = String.raw`(?<![\d.,])(?:\d{1,4}(?:[ \u00a0.]\d{3}){1,}(?:[.,]\d+)?|\d{1,3}(?:,\d{3}){1,}|\d+(?:[.,]\d+)?)`;
const UNIT = String.raw`(?:миллиардов|миллиарда|миллиард|миллионов|миллиона|миллион|млрд|млн|тыс|ккк|kkk|кк|kk|k|m|b|g|к|м)(?![а-яa-z])`;

const UNIT_MULT = {
  'к': 1e3, 'k': 1e3, 'тыс': 1e3,
  'кк': 1e6, 'kk': 1e6, 'млн': 1e6, 'm': 1e6, 'м': 1e6,
  'миллион': 1e6, 'миллиона': 1e6, 'миллионов': 1e6,
  'ккк': 1e9, 'kkk': 1e9,
  'млрд': 1e9, 'b': 1e9, 'g': 1e9,
  'миллиард': 1e9, 'миллиарда': 1e9, 'миллиардов': 1e9,
};

/**
 * @param {string} raw
 * @param {boolean} hasUnit — если рядом стоит множитель, точка/запятая
 *   в "1.765B" или "1,125 млрд" — десятичный разделитель, а не тысячи.
 */
function parseNum(raw, hasUnit = false) {
  let s = String(raw).replace(/[\s\u00a0]/g, '').replace(/[.,]$/, '');
  if (!s) return NaN;
  const dotGroups = /^(\d+)((?:\.\d{3})+)$/.exec(s);
  const commaGroups = /^(\d+)((?:,\d{3})+)$/.exec(s);
  if (dotGroups) {
    const groups = dotGroups[2].split('.').length - 1;
    if (hasUnit && groups === 1) return parseFloat(s);
    return parseFloat(s.replace(/\./g, ''));
  }
  if (commaGroups) {
    const groups = commaGroups[2].split(',').length - 1;
    if (hasUnit && groups === 1) return parseFloat(s.replace(',', '.'));
    return parseFloat(s.replace(/,/g, ''));
  }
  return parseFloat(s.replace(',', '.'));
}

function unitMult(unit) {
  if (!unit) return 1;
  return UNIT_MULT[String(unit).toLowerCase()] || 1;
}

const TOKEN_WORD = String.raw`(?:токен[а-я]*|tokens?\b)`;

// Число рядом со словом "токен", но по смыслу — не токены.
const BAD_AFTER = /(?:запрос|сообщен|слов|символ|отзыв|в\s*день|дней|дн\b|час|мес|минут|секунд|\bшт|человек|юзер|польз)/i;

function ctxBad(before, after) {
  if (/[₽$€]\s*$/.test(before)) return true;
  if (/^\s*(?:₽|\$|€|руб|usd|eur)/i.test(after)) return true;
  if (BAD_AFTER.test(after.slice(0, 16))) return true;
  return false;
}

/**
 * Извлекает объём токенов из текста (название лота).
 * @returns {{value:number, confidence:'high'|'medium'|'low'}|null}
 */
function parseTokens(text) {
  if (!text) return null;
  const t = normText(text).toLowerCase();

  // Диапазон "от 1 до 1000кк токенов" — цена указана за минимальную порцию.
  const rangeM = new RegExp(
    `от\\s*(${NUM})\\s*(?:шт\\.?\\s*)?(${UNIT})?\\s*до\\s*(${NUM})\\s*(${UNIT})?`,
    'i'
  ).exec(t);
  if (rangeM && /токен|tokens?\b/.test(t)) {
    const unit = rangeM[2] || rangeM[4] || '';
    const a = parseNum(rangeM[1], !!unit) * unitMult(unit);
    const b = parseNum(rangeM[3], !!rangeM[4]) * unitMult(rangeM[4]);
    if (a >= 1000 && a <= b && b <= 1e14) return { value: Math.round(a), confidence: 'medium' };
  }

  const hasTokenWord = /токен|tokens?\b/.test(t);

  const found = []; // {value, kind}
  const add = (numRaw, unit, kind) => {
    const n = parseNum(numRaw, !!unit);
    if (!isFinite(n) || n <= 0) return;
    const value = n * unitMult(unit);
    if (value < 1000 || value > 1e14) return;
    found.push({ value, kind });
  };

  if (hasTokenWord) {
    // 1) "1000M токенов", "100 000 000 токенов", "10 М ТОКЕНОВ"
    {
      const re = new RegExp(`(${NUM})\\s*(?:шт\\.?\\s*)?(${UNIT})?\\s*(?:шт\\.?\\s*)?${TOKEN_WORD}`, 'gi');
      let m;
      while ((m = re.exec(t))) add(m[1], m[2] || '', m[2] ? 'unit' : 'exact');
    }
    // 2) "токенов: 5 000 000"
    {
      const re = new RegExp(`${TOKEN_WORD}\\s*[:=—–-]?\\s*(${NUM})\\s*(${UNIT})?`, 'gi');
      let m;
      while ((m = re.exec(t))) add(m[1], m[2] || '', m[2] ? 'unit' : 'exact');
    }
    // 3) число с множителем рядом со словом "токен" (в пределах 26 символов)
    {
      const re = new RegExp(`(${NUM})\\s*(${UNIT})`, 'gi');
      let m;
      while ((m = re.exec(t))) {
        const start = Math.max(0, m.index - 26);
        const ctx = t.slice(start, m.index + m[0].length + 26);
        if (/токен|tokens?\b/.test(ctx)) add(m[1], m[2], 'unit');
      }
      // 4) просто большое число рядом со словом "токен"
      const re2 = new RegExp(`(${NUM})`, 'g');
      while ((m = re2.exec(t))) {
        const start = Math.max(0, m.index - 24);
        const ctx = t.slice(start, m.index + m[0].length + 24);
        if (!/токен|tokens?\b/.test(ctx)) continue;
        if (m[0].replace(/\D/g, '').length < 4) continue;
        const before = t.slice(Math.max(0, m.index - 8), m.index);
        const after = t.slice(m.index + m[0].length, m.index + m[0].length + 18);
        if (ctxBad(before, after)) continue;
        add(m[0], '', 'loose');
      }
    }
  }

  if (!found.length) return parseVolumeFallback(t);
  const rank = { exact: 3, unit: 2, loose: 1 };
  const bestRank = Math.max(...found.map((f) => rank[f.kind]));
  const pool = found.filter((f) => rank[f.kind] === bestRank);
  const max = Math.max(...pool.map((f) => f.value));
  const confidence = bestRank === 3 ? 'high' : bestRank === 2 ? 'medium' : 'low';
  return { value: Math.round(max), confidence };
}

/**
 * Запасной вариант: в названиях вида "TokenLavka | API 250 000 000 000 →"
 * слово "токены" отсутствует, но объём очевиден по контексту.
 */
function parseVolumeFallback(lowerText) {
  const t = lowerText || '';
  if (!/(?:api|ключ|key|токен|balance|баланс)/.test(t)) return null;
  const re = new RegExp(`(${NUM})\\s*(${UNIT})?`, 'g');
  let m;
  let best = 0;
  while ((m = re.exec(t))) {
    const hasUnit = !!m[2];
    const n = parseNum(m[1], hasUnit);
    if (!isFinite(n)) continue;
    const value = n * unitMult(m[2]);
    if (value < 1e5 || value > 1e14) continue;
    const before = t.slice(Math.max(0, m.index - 14), m.index);
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 18);
    if (ctxBad(before, after)) continue;
    if (/[₽$€]|руб|usd|eur|%|дн|дней|отзыв|лет|года|мес|\bшт/.test(before + after)) continue;
    if (value > best) best = value;
  }
  return best ? { value: Math.round(best), confidence: 'low' } : null;
}

/**
 * Объём из лот-полей FunPay ("1кк токенов" / "Другое количество" + 3000000).
 * Значения у продавцов противоречивые, поэтому проверяем на правдоподобие
 * цены за 1М токенов.
 */
function tokensFromFields(fields, price) {
  if (!fields) return null;
  const candidates = [];
  if (fields.quantity && !/^\d+$/.test(fields.quantity)) {
    const t = parseTokens(fields.quantity);
    if (t) candidates.push(t.value);
  }
  if (fields.quantity2 && /^\d+$/.test(fields.quantity2)) {
    const q = parseInt(fields.quantity2, 10);
    if (q > 0) {
      candidates.push(q);
      candidates.push(q * 1e6);
    }
  }
  const plausible = candidates.filter((v) => {
    if (!v || v < 1000) return false;
    if (!price) return true;
    const perM = (price / v) * 1e6;
    return perM >= 0.02 && perM <= 5000;
  });
  if (!plausible.length) return null;
  // "1кк токенов" из поля quantity — самый надёжный источник
  const fromQuantity = fields.quantity ? parseTokens(fields.quantity) : null;
  if (fromQuantity && plausible.includes(fromQuantity.value)) return fromQuantity.value;
  return Math.min(...plausible);
}

/** Кол-во токенов за 1 шт. ("1 товар = 7М токенов", "1 шт = 500 000 токенов"). */
function parsePerItemTokens(text) {
  if (!text) return null;
  const t = normText(text).toLowerCase();
  const re = new RegExp(
    `(?:^|[^а-яa-z0-9])(?:1|один|одна|одну|одного)\\s*(?:товар[а-я]*|шт\\.?|штук[а-я]*|ключ[а-я]*|акк[а-я]*|аккаунт[а-я]*|покупк[а-я]*|лот[а-я]*)?\\s*(?:=|:|—|–|-|→|->|за)\\s*(${NUM})\\s*(${UNIT})?\\s*${TOKEN_WORD}`,
    'i'
  );
  const m = re.exec(t);
  if (!m) return null;
  const value = Math.round(parseNum(m[1], !!m[2]) * unitMult(m[2]));
  if (!isFinite(value) || value < 1000 || value > 1e14) return null;
  return value;
}

/**
 * Количество штук в лоте. FunPay почти не публикует остатки, поэтому берём
 * только явные формулировки ("в наличии 5 шт", "осталось 3 шт") и требуем
 * слово «шт»: иначе «доступно 24/7» или «Количество: 10 000 000 токенов»
 * превращаются в ложное наличие 24 шт.
 */
function parseQty(text) {
  if (!text) return null;
  const t = normText(text).toLowerCase();
  const re =
    /(?:в\s*наличии|наличие|осталось|остаток|доступно|кол-во|количество)\s*[:—–-]?\s*(\d{1,6})\s*(?:шт\.?|штук[а-я]*)(?![а-яa-z0-9])/i;
  const m = re.exec(t);
  if (!m) return null;
  const q = parseInt(m[1], 10);
  if (q > 0 && q <= 1000000) return q;
  return null;
}

/* ------------------------------------------------------------------ */
/* flags                                                               */
/* ------------------------------------------------------------------ */

const ONE_TO_ONE_RES = [
  /(?:^|[^а-яa-z0-9])(?:1|один|одна|одно|одного|одну|одной)\s*(?:шт\.?|штук[а-я]*|токен[а-я]*|ключ[а-я]*|акк[а-я]*|аккаунт[а-я]*|подписк[а-я]*|доступ[а-я]*)?\s*(?:=|:|—|–|-|на|для|→|->)?\s*(?:1|одного|одному|один|одну|одной)\s*(?:человек[а-я]*|пользовател[а-я]*|юзер[а-я]*|покупател[а-я]*|клиент[а-я]*|аккаунт[а-я]*|ключ[а-я]*)/gi,
  /(?:^|[^а-яa-z0-9])(?:1|один|одна|одного)\s*(?:человек[а-я]*|пользовател[а-я]*|юзер[а-я]*|покупател[а-я]*)\s*(?:=|:|на|—|–|-)\s*(?:1|один|одну|одного)\s*(?:токен[а-я]*|ключ[а-я]*|акк[а-я]*|аккаунт[а-я]*)/gi,
  /токен[а-я]*\s*(?:=|:|—|–|-)\s*(?:1\s*)?человек/gi,
  /(?:не\s+более|только)\s+(?:1|одного)\s+(?:пользовател[а-я]*|человек[а-я]*)/gi,
  /(?:ключ|аккаунт|токен)\s*(?:на|для)\s*одного/gi,
  /один\s*(?:ключ|аккаунт)\s*на\s*одного/gi,
];

function detectOneToOne(text) {
  if (!text) return null;
  const t = normText(text);
  for (const re of ONE_TO_ONE_RES) {
    re.lastIndex = 0;
    const m = re.exec(t);
    if (m) return m[0].replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  return null;
}

const NO_REFUND_RE =
  /без\s*возврат|возврат[а-я]*\s*не\s*(?:подлеж|предусмотр|возмож|осуществл)|не\s*(?:подлежит|подлежат|предусмотрен|возможен|принимается)\s*возврат|no\s*refund|невозвратн|без\s*гарантии\s*возврат|деньги\s*не\s*возвращ/i;
const YES_REFUND_RE =
  /возврат[а-я]*|верн[её]м|верн[её]т|верну\s+деньги|верн[её]тся|refund|компенсац|возмещ|гарантия\s+(?:возврата|средств)/i;

function detectRefund(text) {
  if (!text) return null;
  const t = normText(text);
  if (NO_REFUND_RE.test(t)) return false;
  if (YES_REFUND_RE.test(t)) return true;
  return null;
}

const BONUS_RE =
  /(?:^|[^а-яa-z])(?:бонус[а-я]*|bonus|cashback|кэшб[еэ]к|подарок|подарки|промокод|акци[а-я]*|профит)(?![а-яa-z])|остав[а-я]*\s+отзыв|за\s+отзыв|отзыв[а-я]*\s*[+＋]\s*\d|\+\s*\d{1,3}\s*%|бонусн[а-я]*\s+токен/i;
// «без бонусов», «бонусов нет», «бонусы не начисляются» — не считаем бонусом.
const NO_BONUS_RE =
  /(?:без|нет|отсутству[а-я]*|не\s+(?:будет|предусмотрен[а-я]*|начисл[а-я]*|да[ею]м|да[ею]т))\s+(?:[а-я]+\s+){0,2}(?:бонус[а-я]*|подарк[а-я]*|кэшб[еэ]к[а-я]*|промокод[а-я]*)|(?:бонус[а-я]*|подарк[а-я]*|кэшб[еэ]к[а-я]*|промокод[а-я]*)\s+(?:нет|не\s+(?:будет|предусмотрен[а-я]*|начисл[а-я]*))/i;

function detectBonus(text) {
  if (!text) return false;
  const t = normText(text);
  if (!BONUS_RE.test(t)) return false;
  const withoutNegatives = t.replace(NO_BONUS_RE, ' ');
  return BONUS_RE.test(withoutNegatives);
}

const UNLIMITED_WORD = String.raw`(?:безлимит[а-я]*|неограниченн?[а-я]*|unlimited|unlim|unmetered|∞)`;

function detectUnlimited(text) {
  const t = normText(text).toLowerCase();
  // Убираем только отрицаемые упоминания: отдельный положительный безлимит
  // в другом предложении по-прежнему должен распознаваться.
  const withoutNegatives = t
    .replace(new RegExp(`(?:^|[^а-яa-z])(?:не(?:\\s+является)?|нет|без|no|not|non[- ]?)\\s*(?:[а-яa-z]+\\s+){0,2}${UNLIMITED_WORD}`, 'gi'), ' ')
    .replace(new RegExp(`${UNLIMITED_WORD}\\s+(?:нет|отсутствует|не\\s+(?:предусмотрен[а-я]*|является|доступен|будет)|(?:is\\s+)?not\\s+(?:available|included))`, 'gi'), ' ');
  return new RegExp(`(?:^|[^а-яa-z])${UNLIMITED_WORD}(?![а-яa-z])`, 'i').test(withoutNegatives);
}

// Фильтр credits также объединяет обычные подписки без безлимита.
const CREDITS_WORD = String.raw`(?:кредит(?:ы|ов|а|у|ами|ах|ом|е)?|credits?|подписк[а-я]*|subscriptions?)`;
function detectCredits(text) {
  const t = normText(text).toLowerCase()
    .replace(/\bcredit\s+cards?\b|кредитн[а-я]*\s+карт[а-я]*/gi, ' ')
    .replace(new RegExp(`(?:^|[^а-яa-z])(?:без|не|нет|no|not)\\s+(?:[а-яa-z]+\\s+){0,2}${CREDITS_WORD}`, 'gi'), ' ')
    .replace(new RegExp(`${CREDITS_WORD}\\s+(?:нет|не\\s+(?:нужн[а-я]*|требу[а-я]*|предусмотрен[а-я]*)|(?:is\\s+)?not\\s+(?:needed|required))`, 'gi'), ' ');
  return new RegExp(`(?:^|[^а-яa-z])${CREDITS_WORD}(?![а-яa-z])`, 'i').test(t);
}

/* ------------------------------------------------------------------ */
/* access duration                                                     */
/* ------------------------------------------------------------------ */

const DURATION_UNIT = String.raw`(?:minutes?|mins?|минут(?:а|ы|у)?|мин\.?|hours?|hrs?|h|час(?:а|ов)?|ч\.?|days?|d|день|дня|дней|сутки|суток|weeks?|w|недел(?:я|ю|и|ь)|нед\.?|months?|mo|месяц(?:а|ев)?|мес\.?)`;
const IMPLICIT_DURATION_UNIT = String.raw`(?:minute|минута|минуту|hour|час|day|день|сутки|суток|week|неделя|неделю|month|месяц)`;
const ACCESS_CONTEXT = /безлимит[а-я]*|неограниченн?[а-я]*|unlimited|unlim|unmetered|∞|доступ[а-я]*|аренд[а-я]*|подписк[а-я]*|срок(?:\s+действия)?|действител[а-я]*|работает|access|rental|rent|subscription|duration|valid(?:ity)?|expires?|lasts?/gi;
const OTHER_DURATION_CONTEXT = /(?:^|[^а-яa-z])(?:гаранти[а-я]*|warranty|guarantee|ответ[а-я]*|отвеч[а-я]*|response|reply|respond[а-яa-z]*|поддержк[а-я]*|support|авто\s*выда[а-я]*|выда[а-я]*|доставк[а-я]*|delivery|deliver[а-яa-z]*|отправ[а-я]*|получени[а-я]*|активаци[а-я]*|activation|ожидани[а-я]*|ожидать|wait|стаж[а-я]*|на\s+(?:сайте|funpay)|опыт[а-я]*|продаю|работаю|продавец|seller|квот[а-я]*|quota|лимит[а-я]*|limits?|запрос[а-я]*|requests?|сообщени[а-я]*|messages?|ежеднев[а-я]*|daily|reset[а-яa-z]*|обновля[а-я]*|сброс[а-я]*)(?![а-яa-z])/gi;

function durationUnitMinutes(unit) {
  if (/^(?:min|мин)/.test(unit)) return 1;
  if (/^(?:h|ч)/.test(unit)) return 60;
  if (/^(?:d|д|сут)/.test(unit)) return 24 * 60;
  if (/^(?:w|нед)/.test(unit)) return 7 * 24 * 60;
  // Месяц без календарной даты — фиксированные 30 суток.
  return 30 * 24 * 60;
}

function lastContextIndex(re, text) {
  re.lastIndex = 0;
  let last = -1;
  let m;
  while ((m = re.exec(text))) last = m.index;
  return last;
}

/** Срок доступа в минутах; в описании требуется явный контекст доступа. */
function parseDurationMinutes(text, { description = false } = {}) {
  if (!text) return null;
  // Сохраняем границы предложений/строк: гарантия в соседней строке —
  // не характеристика срока доступа из текущей строки.
  const clauses = String(text).split(/[\r\n;!?|•]+|\.(?!\d)/);
  for (const raw of clauses) {
    const t = normText(raw).toLowerCase();
    const candidates = [];
    const numbered = new RegExp(`(^|[^а-яa-z0-9.,/])([0-9]+(?:[.,][0-9]+)?)\\s*(${DURATION_UNIT})(?![а-яa-z0-9])`, 'gi');
    let m;
    while ((m = numbered.exec(t))) {
      candidates.push({ start: m.index + m[1].length, end: numbered.lastIndex, value: Number(m[2].replace(',', '.')), unit: m[3] });
    }
    const implicit = new RegExp(`(^|[^а-яa-z0-9])(?:(?:a|an|one|один|одну|одни|одного)\\s+)?(${IMPLICIT_DURATION_UNIT})(?![а-яa-z0-9])`, 'gi');
    while ((m = implicit.exec(t))) {
      const start = m.index + m[1].length;
      if (candidates.some((c) => start >= c.start && start < c.end)) continue;
      if (/[0-9.,]\s*$/.test(t.slice(0, start))) continue;
      candidates.push({ start, end: implicit.lastIndex, value: 1, unit: m[2] });
    }
    candidates.sort((a, b) => a.start - b.start);
    for (const c of candidates) {
      if (!Number.isFinite(c.value) || c.value <= 0) continue;
      const before = t.slice(Math.max(0, c.start - 100), c.start);
      const after = t.slice(c.end, c.end + 60);
      if (/-\s*$/.test(before) && !/[а-яa-z]\s*-\s*$/i.test(before)) continue;
      const localBefore = before.slice(before.lastIndexOf(',') + 1);
      // «Гарантия доступа» / «выдача доступа» всё ещё описывают гарантию
      // и доставку; слово «доступ» не меняет смысл таких фраз.
      if (/(?:гаранти[а-я]*|warranty|guarantee|ответ[а-я]*|response|reply|поддержк[а-я]*|support|(?:авто\s*)?выда[а-я]*|доставк[а-я]*|delivery)[^,]{0,65}$/i.test(localBefore)) continue;
      // Частоты и квоты (tokens/day, per hour, каждые 24h) не сроки.
      if (/(?:\/|\bper|\bevery|кажд[а-я]*|ежедневно|(?:^|\s)в)\s*$/.test(before)) continue;
      if (/(?:токен[а-я]*|tokens?|кредит[а-я]*|credits?)\s*(?:\/|в|за|на|per|every)\s*$/i.test(before)) continue;
      if (/^\s*(?:в\s+(?:день|сутки|час)|per\s+(?:day|hour)|daily|ежедневно|кажд[а-я]*)(?![а-яa-z])/i.test(after)) continue;
      // Запрещённый контекст ближе к числу, чем «доступ»/«безлимит».
      const accessAt = lastContextIndex(ACCESS_CONTEXT, before);
      const otherAt = lastContextIndex(OTHER_DURATION_CONTEXT, before);
      if (/(?:токен[а-я]*|tokens?|кредит[а-я]*|credits?|requests?)\s*$/i.test(before) && accessAt < 0) continue;
      if (otherAt >= 0 && otherAt >= accessAt) continue;
      // «1 hour response», «24h guarantee» и подобные перестановки.
      if (/^\s*(?:(?:на|для|до|of|to|for|на\s+время)\s+)?(?:гаранти[а-я]*|warranty|guarantee|ответ[а-я]*|response|reply|support|поддержк[а-я]*|автовыдач[а-я]*|выдач[а-я]*|доставк[а-я]*|delivery|ожидани[а-я]*|стаж[а-я]*|на\s+сайте|опыт[а-я]*)/i.test(after)) continue;
      if (description && accessAt < 0 && lastContextIndex(ACCESS_CONTEXT, after.split(',')[0]) < 0) continue;
      const minutes = c.value * durationUnitMinutes(c.unit);
      if (Number.isFinite(minutes) && minutes > 0) return minutes;
    }
  }
  return null;
}

/** Общие вычисляемые поля для новых офферов, описаний и старого кэша. */
function normalizeOfferAccess(offer, extraDescription = '') {
  const title = offer.title || offer.titleFull || '';
  const titleFlags = [offer.titleFull || title, Object.values(offer.fields || {}).join(' ')].join('\n');
  const description = [offer.description || '', extraDescription || offer.accessDetails || ''].filter(Boolean).join('\n');
  const all = titleFlags + '\n' + description;
  offer.flags = offer.flags || {};
  // Пересчитываем из текста и для старых offer: false не доказывает отсутствие
  // схемы, а только отсутствие распознанного заявления в доступных данных.
  const billingFields = Object.entries(offer.fields || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  offer.flags.inputOutput = detectInputOutput([offer.titleFull || title, billingFields, description].join('\n'));
  const wasUnlimited = !!offer.flags.unlimited;
  const mentionsUnlimited = new RegExp(UNLIMITED_WORD, 'i').test(all);
  // В старом кэше флаг мог прийти из не сохранённых полей карточки.
  // Сохраняем его при отсутствии текста, но исправляем явные отрицания.
  offer.flags.unlimited = detectUnlimited(all) || (!mentionsUnlimited && !!offer.flags.unlimited);
  const mentionsCredits = new RegExp(CREDITS_WORD, 'i').test(all);
  offer.flags.credits = !offer.flags.unlimited && (detectCredits(all) || (!mentionsCredits && !!offer.flags.credits));
  if (wasUnlimited && !offer.flags.unlimited && !offer.flags.credits && !offer.tokens) {
    // Старый парсер подавлял числовой пакет даже у «не безлимит».
    const perItem = parsePerItemTokens(title);
    const parsed = perItem ? null : parseTokens(title);
    const fromFields = perItem || parsed ? null : tokensFromFields(offer.fields, offer.price);
    const tokens = perItem || parsed?.value || fromFields;
    if (tokens) {
      offer.tokens = tokens;
      offer.perItemTokens = perItem;
      offer.tokensConfidence = perItem ? 'high' : parsed?.confidence || 'low';
      offer.tokensParsedFrom = perItem ? 'perItem' : parsed ? 'title' : 'field';
      offer.pricePerM = offer.price > 0 && !offer.flags.rateLimited ? offer.price / tokens * 1e6 : null;
    }
  }
  if (offer.flags.unlimited || offer.flags.credits) {
    // Числа в ограничениях безлимита/кредитов — не объём купленного пакета.
    offer.tokens = null;
    offer.perItemTokens = null;
    offer.tokensConfidence = null;
    offer.tokensParsedFrom = null;
    offer.pricePerM = null;
  }
  offer.accessType = offer.flags.unlimited ? 'unlimited'
    : offer.flags.credits ? 'credits'
      : Number.isFinite(offer.tokens) && offer.tokens > 0 ? 'tokens' : 'other';
  offer.durationMinutes = parseDurationMinutes(title)
    ?? parseDurationMinutes(description, { description: true });
  offer.pricePerHour = offer.flags.unlimited && offer.durationMinutes != null
    && Number.isFinite(offer.price) && offer.price >= 0
    ? offer.price * 60 / offer.durationMinutes : null;
  return offer;
}

/* ------------------------------------------------------------------ */
/* list page parsing                                                   */
/* ------------------------------------------------------------------ */

function attrMap(tag) {
  const out = {};
  const re = /([\w:-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = m[2];
  return out;
}

function firstMatch(re, s) {
  const m = re.exec(s);
  return m ? m[1] : null;
}

function parseStars(block) {
  const m = /rating-stars\s+rating-(\d)/.exec(block);
  return m ? parseInt(m[1], 10) : 0;
}

function parseReviews(block) {
  const mini = /rating-mini-count">(\d+)/.exec(block);
  if (mini) return parseInt(mini[1], 10);
  const txt = /media-user-reviews">([\s\S]*?)<\/div>/.exec(block);
  if (!txt) return 0;
  const raw = htmlToText(txt[1]);
  if (/нет отзыв/i.test(raw)) return 0;
  const n = /(\d[\d\s]*)\s*отзыв/i.exec(raw);
  return n ? parseInt(n[1].replace(/\s/g, ''), 10) : 0;
}

function parseAge(block) {
  const m = /media-user-info">([\s\S]*?)<\/div>/.exec(block);
  return m ? htmlToText(m[1]).trim() : '';
}

/** «на сайте 2 года 3 месяца» → 27 (месяцев). Нужно для фильтра по стажу. */
function parseSellerAgeMonths(text) {
  if (!text) return 0;
  const t = String(text).toLowerCase().replace(/\u00a0/g, ' ');
  let months = 0;
  const years = /(\d+)\s*(?:год|года|лет)/.exec(t);
  const mons = /(\d+)\s*месяц/.exec(t);
  const weeks = /(\d+)\s*недел/.exec(t);
  const days = /(\d+)\s*(?:день|дня|дней)/.exec(t);
  if (years) months += parseInt(years[1], 10) * 12;
  if (mons) months += parseInt(mons[1], 10);
  if (weeks) months += parseInt(weeks[1], 10) / 4.345;
  if (days) months += parseInt(days[1], 10) / 30.44;
  if (!months) {
    // \b в JS не работает с кириллицей: буквы не входят в \w.
    const word = (re) => new RegExp(`(^|[^а-яё])${re}([^а-яё]|$)`).test(t);
    if (word('год')) months = 12;
    else if (word('месяц')) months = 1;
    else if (word('недел')) months = 0.25;
    else if (word('(?:день|дня|дней)')) months = 0.05;
  }
  return Math.round(months * 10) / 10;
}

/**
 * FunPay дописывает в заголовок значения лот-полей:
 * "... ТОКЕНОВ, Другое количество, 4кк токенов, Без захода на аккаунт".
 * Отрезаем их, чтобы не путать объём токенов.
 */
function coreTitle(titleFull, fields) {
  const lower = titleFull.toLowerCase();
  let cut = titleFull.length;
  for (const v of Object.values(fields)) {
    if (!v || v.length < 4 || /^\d+$/.test(v)) continue;
    const idx = lower.lastIndexOf(v.toLowerCase());
    if (idx > 3 && idx < cut) cut = idx;
  }
  let core = titleFull.slice(0, cut).replace(/[\s,;·|•\-–—]+$/g, '').trim();
  if (core.length < 10) core = titleFull.trim();
  return core;
}

function buildOffer(raw, catId) {
  const cat = CAT_BY_ID[catId];
  const titleFull = htmlToText(raw.titleHtml);
  const title = coreTitle(titleFull, raw.fields);
  const textForFlags = titleFull + ' ' + Object.values(raw.fields).join(' ');
  const unlimited = detectUnlimited(textForFlags);
  const credits = !unlimited && detectCredits(textForFlags);
  const perItem = unlimited || credits ? null : parsePerItemTokens(title);
  // Только основной заголовок (без дописанных FunPay лот-полей):
  // их значения часто противоречат реальному объёму.
  const parsed = unlimited || credits ? null : parseTokens(title);
  const price = raw.price;
  let tokens = perItem || (parsed ? parsed.value : null);
  let tokensParsedFrom = perItem ? 'perItem' : parsed ? 'title' : null;
  let tokensConfidence = perItem ? 'high' : parsed ? parsed.confidence : null;
  if (!tokens && !unlimited && !credits) {
    const fromFields = tokensFromFields(raw.fields, price);
    if (fromFields) {
      tokens = fromFields;
      tokensParsedFrom = 'field';
      tokensConfidence = 'low';
    }
  }
  // "100 млн токенов В ДЕНЬ" — это суточный лимит, а не объём лота
  const dailyM = new RegExp(
    `(${NUM})\\s*(${UNIT})?\\s*токен[а-я]*\\s*(?:в|за|на)\\s*(?:день|сутки)`,
    'i'
  ).exec(textForFlags);
  const dailyVal = dailyM ? parseNum(dailyM[1], !!dailyM[2]) * unitMult(dailyM[2]) : null;
  const rateLimited = dailyVal != null && (!tokens || dailyVal >= tokens * 0.9);
  const pricePerM = tokens && price > 0 && !rateLimited ? (price / tokens) * 1e6 : null;

  return normalizeOfferAccess({
    id: raw.id,
    cat: catId,
    catName: cat ? cat.name : catId,
    title,
    titleFull,
    model: raw.fields.model || cat?.full || '',
    price,
    tokens,
    tokensConfidence,
    perItemTokens: perItem,
    tokensParsedFrom,
    pricePerM,
    qty: parseQty(titleFull),
    seller: {
      id: raw.sellerId,
      name: raw.sellerName,
      stars: raw.stars,
      reviews: raw.reviews,
      age: raw.age,
      ageMonths: parseSellerAgeMonths(raw.age),
      online: raw.online,
      avatar: raw.avatar,
    },
    auto: raw.auto,
    promo: raw.promoted || raw.promo,
    online: raw.online,
    fields: raw.fields,
    flags: {
      bonus: detectBonus(textForFlags),
      oneToOne: detectOneToOne(textForFlags),
      refund: detectRefund(textForFlags),
      unlimited,
      rateLimited,
      credits,
    },
    descLoaded: false,
  });
}

function parseLotsPage(html, catId) {
  const offers = [];
  const seen = new Set();
  const anchor = /<a\b[^>]*href="https?:\/\/funpay\.com\/lots\/offer\?id=(\d+)"[^>]*>/g;
  let m;
  while ((m = anchor.exec(html))) {
    const openTag = m[0];
    if (!/class="[^"]*\btc-item\b/.test(openTag)) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    const bodyEnd = html.indexOf('</a>', m.index + openTag.length);
    if (bodyEnd < 0) continue;
    const body = html.slice(m.index + openTag.length, bodyEnd);

    const attrs = attrMap(openTag);
    const fields = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('data-f-')) fields[k.slice(7)] = decodeEntities(v);
    }

    const priceM = /class="tc-price"[^>]*data-s="([\d.]+)"/.exec(body);
    if (!priceM) continue;
    const price = parseFloat(priceM[1]);
    if (!isFinite(price)) continue;

    const titleHtml = firstMatch(/<div class="tc-desc-text">([\s\S]*?)<\/div>/, body) || '';
    const sellerName = htmlToText(firstMatch(/<div class="media-user-name">([\s\S]*?)<\/div>/, body) || '').trim();
    const sellerId = attrs['data-user'] || firstMatch(/users\/(\d+)\//, body) || '';
    const avatarM = /avatar-photo[^>]*background-image:\s*url\(([^)]+)\)/.exec(body);

    function absAvatar(raw) {
      const a = raw ? decodeEntities(raw).replace(/^['"]|['"]$/g, '') : '';
      if (!a || a.startsWith('data:')) return a;
      if (a.startsWith('//')) return 'https:' + a;
      if (a.startsWith('/')) return 'https://funpay.com' + a;
      return a;
    }

    seen.add(id);
    offers.push(
      buildOffer(
        {
          id,
          titleHtml,
          price,
          sellerId,
          sellerName,
          stars: parseStars(body),
          reviews: parseReviews(body),
          age: parseAge(body),
          online: attrs['data-online'] === '1',
          auto: attrs['data-auto'] === '1' || /auto-dlv-icon/.test(body),
          promo: attrs['data-promo'] === '1',
          promoted: /offer-promoted/.test(openTag),
          avatar: absAvatar(avatarM ? avatarM[1] : ''),
          fields,
        },
        catId
      )
    );
  }
  return offers;
}

/* ------------------------------------------------------------------ */
/* offer page parsing                                                  */
/* ------------------------------------------------------------------ */

function parseOfferPage(html) {
  const params = {};
  const paramRe = /<div class="param-item"><h5>([\s\S]*?)<\/h5>\s*<div[^>]*>([\s\S]*?)<\/div><\/div>/g;
  let pm;
  while ((pm = paramRe.exec(html))) {
    params[htmlToText(pm[1]).trim()] = htmlToText(pm[2]).replace(/\s+/g, ' ').trim();
  }

  const description =
    params['Подробное описание'] ||
    params['Описание'] ||
    htmlToText(firstMatch(/<div class="offer-description">([\s\S]*?)<\/div>/, html) || '');

  const seller = {
    id: firstMatch(/data-seller="(\d+)"/, html) || '',
    name: htmlToText(firstMatch(/<div class="media-user-name">([\s\S]*?)<\/div>/, html) || '').trim(),
    stars: parseStars(html),
    reviews: parseReviews(html),
    online: /media-user-status">\s*Онлайн/.test(html),
  };
  const reviewsText = firstMatch(/seller-promo-desc">\s*<a[^>]*>([\s\S]*?)<\/a>/, html);
  if (reviewsText) {
    const rt = htmlToText(reviewsText).replace(/\s+/g, ' ');
    const n = /(\d[\d\s]*)\s*отзыв/i.exec(rt);
    if (n) seller.reviews = parseInt(n[1].replace(/\s/g, ''), 10);
    seller.reviewsLabel = rt.trim();
  }

  const titleHtml = firstMatch(/<div class="param-item"><h5>Краткое описание<\/h5><div>([\s\S]*?)<\/div><\/div>/, html);
  const fields = {};
  for (const [k, v] of Object.entries(params)) {
    if (k !== 'Модель' && k !== 'Краткое описание' && k !== 'Подробное описание') fields[k] = v;
  }

  return {
    title: htmlToText(titleHtml || ''),
    model: params['Модель'] || '',
    description,
    params,
    fields,
    auto: /Автоматическая доставка/.test(html),
    seller,
  };
}

/* ------------------------------------------------------------------ */
/* enrichment merge                                                    */
/* ------------------------------------------------------------------ */

function applyDescription(offer, offerPage) {
  const desc = offerPage.description || '';
  const all = [offer.title, desc, Object.values(offerPage.fields || {}).join(' ')].join('\n');

  offer.descLoaded = true;
  offer.description = desc;
  const fieldText = Object.entries(offerPage.fields || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  if (fieldText) offer.accessDetails = fieldText;
  // Сначала тип доступа: ограничения в описании безлимита нельзя
  // интерпретировать как продаваемый пакет токенов даже на один проход.
  normalizeOfferAccess(offer, fieldText);

  if (!offer.tokens && !offer.flags.unlimited && !offer.flags.credits) {
    const perItem = parsePerItemTokens(all);
    if (perItem) {
      offer.perItemTokens = perItem;
      offer.tokens = perItem;
      offer.tokensParsedFrom = 'description';
      offer.tokensConfidence = 'high';
    } else {
      const t = parseTokens(desc) || parseTokens(all);
      if (t) {
        offer.tokens = t.value;
        offer.tokensConfidence = t.confidence;
        offer.tokensParsedFrom = 'description';
      }
    }
    if (offer.tokens && offer.price > 0) offer.pricePerM = (offer.price / offer.tokens) * 1e6;
  }

  if (offer.qty == null) offer.qty = parseQty(all);

  const dailyM = new RegExp(
    `(${NUM})\\s*(${UNIT})?\\s*токен[а-я]*\\s*(?:в|за|на)\\s*(?:день|сутки)`,
    'i'
  ).exec(all);
  if (dailyM) {
    const dailyVal = parseNum(dailyM[1], !!dailyM[2]) * unitMult(dailyM[2]);
    if (!offer.tokens || dailyVal >= offer.tokens * 0.9) {
      offer.flags.rateLimited = true;
      offer.pricePerM = null;
    }
  }

  offer.flags.bonus = offer.flags.bonus || detectBonus(all);
  offer.flags.oneToOne = offer.flags.oneToOne || detectOneToOne(all);
  const dRefund = detectRefund(all);
  if (dRefund === false) offer.flags.refund = false;
  else if (offer.flags.refund == null) offer.flags.refund = dRefund;
  normalizeOfferAccess(offer, fieldText);

  offer.auto = offer.auto || offerPage.auto;
  if (!offer.seller.stars && offerPage.seller.stars) offer.seller.stars = offerPage.seller.stars;
  if (!offer.seller.reviews && offerPage.seller.reviews) offer.seller.reviews = offerPage.seller.reviews;
  if (!offer.seller.name && offerPage.seller.name) offer.seller.name = offerPage.seller.name;

  return offer;
}

module.exports = {
  CATEGORIES,
  CAT_BY_ID,
  parseLotsPage,
  parseOfferPage,
  parseTokens,
  parsePerItemTokens,
  tokensFromFields,
  parseQty,
  parseSellerAgeMonths,
  detectOneToOne,
  detectRefund,
  detectBonus,
  detectUnlimited,
  detectInputOutput,
  parseDurationMinutes,
  normalizeOfferAccess,
  buildOffer,
  htmlToText,
  normText,
  modelLabel,
  applyDescription,
  coreTitle,
};
