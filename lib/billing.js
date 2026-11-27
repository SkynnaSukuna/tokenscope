'use strict';

// Это распознавание заявленной схемы, а не проверка фактического биллинга.
// false означает «не распознано по тексту», включая неизвестное описание.
const INPUT = String.raw`(?<![a-zа-я0-9_])(?:inputs?(?:\s+tokens?)?|вход(?:ящ[а-я]*|н[а-я]*|а|у|ом|е)?(?:\s+токен[а-я]*)?)(?:(?![a-zа-я0-9_])|(?=[xх]\d))`;
const OUTPUT = String.raw`(?<![a-zа-я0-9_])(?:outputs?(?:\s+tokens?)?|(?:выход(?:ящ[а-я]*|н[а-я]*|а|у|ом|е)?|исходящ[а-я]*)(?:\s+токен[а-я]*)?)(?:(?![a-zа-я0-9_])|(?=[xх]\d))`;
const CONNECTOR = String.raw`(\+|плюс|и|and|&)`;
const BILLING = /(?:^|[^a-zа-я])(?:спис[а-я]*|учет[а-я]*|учитыва[а-я]*|расход[а-я]*|расчет[а-я]*|рассчит[а-я]*|счита[а-я]*|оплат[а-я]*|плат[а-я]*|тарифи[а-я]*|стоимост[а-я]*|формул[а-я]*|биллинг[а-я]*|сумм[а-я]*|bill(?:ing|ed)?|charges?|charged|charging|deduct[a-z]*|count[a-z]*|meter[a-z]*|cost[a-z]*|account(?:ed|ing)?|sum(?:med)?)(?![a-zа-я])/g;
const FEATURES = /(?:^|[^a-zа-я])(?:поддерж[а-я]*|возможност[а-я]*|функци[а-я]*|интерфейс[а-я]*|умеет|supports?|features?|capabilities|modalit(?:y|ies))(?![a-zа-я])/g;
const IGNORED_SIDE = new RegExp(`(?:${INPUT}|${OUTPUT})\\s*(?:[—–:=,-]\\s*)?(?:(?:вообще|здесь)\\s+)?(?:не\\s+(?:учитыва[а-я]*|списыва[а-я]*|счита[а-я]*|оплачива[а-я]*)|(?:(?:is|are)\\s+)?not\\s+(?:counted|charged|billed|included))`, 'g');

function lastMatch(re, text) {
  re.lastIndex = 0;
  let at = -1;
  let match;
  while ((match = re.exec(text))) at = match.index;
  return at;
}

function negated(clause, before, after) {
  // Отрицание самой формулы, а не случайное «не» в соседнем условии.
  if (/(?:не\s+(?:по\s+)?(?:этой\s+)?формул[а-я]*|не\s+(?:использу[а-я]*|применя[а-я]*)\s+(?:(?:эту|такую)\s+)?(?:формул[а-я]*|схем[а-я]*)|не\s+пут[а-я]*\s+с\s+формул[а-я]*|(?:no|not)\s+(?:the\s+)?formula)/.test(clause)) return true;
  if (/(?:не\s+(?:учитыва[а-я]*|списыва[а-я]*|счита[а-я]*|оплачива[а-я]*)|not\s+(?:billed|charged|counted|calculated|deducted))(?:\s+(?:as|by|using|with|как))?\s*[«\"'(=:—–-]*\s*$/.test(before)) return true;
  if (/(?:не|без|not|no)\s*(?:(?:по|как|the)\s+)?[«"'(=:—–-]*\s*$/.test(before)) return true;
  if (/(?:в\s+отличие\s+от|instead\s+of|rather\s+than)\s*[«"'(]*\s*$/.test(before)) return true;
  if (/^\s*[)»"']*\s*(?:[xх×*]\s*(?:\d+(?:[.,]\d+)?|[a-zа-я]+))?\s*(?:[,—–:-]\s*)?(?:не\s+(?:использу[а-я]*|применя[а-я]*|учитыва[а-я]*|списыва[а-я]*|поддерж[а-я]*|явля[а-я]*)|отсутств[а-я]*|(?:is\s+)?not\s+(?:used|applied|counted|charged|supported))/.test(after)) return true;
  if (/(?:без\s+учета\s+(?:вход[а-я]*|выход[а-я]*|исходящ[а-я]*)|(?:excluding|without)\s+(?:input|output)(?:\s+tokens?)?)/.test(clause)) return true;
  IGNORED_SIDE.lastIndex = 0;
  let match;
  while ((match = IGNORED_SIDE.exec(clause))) {
    // Исключение для кэшированного входа совместимо с общей суммой.
    const prefix = clause.slice(Math.max(0, match.index - 45), match.index);
    if (!/(?:к[эе]ш[а-я]*|cache[а-яa-z]*)\s*$/.test(prefix)) return true;
  }
  return false;
}

/** input + output, с любым множителем или без него; «и» требует контекста учёта. */
function detectInputOutput(text) {
  const normalized = String(text || '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е')
    .replace(/\s*[\r\n]+\s*(?=\+)/g, ' ')
    .replace(/(\+)\s*[\r\n]+\s*/g, '$1 ');
  // Границы сохраняются: описание возможностей не получает контекст списания
  // из соседнего предложения, заголовка или другого поля карточки.
  const clauses = normalized.split(/[\r\n;!?|•]+|\.(?!\d)/);
  for (let i = 0; i < clauses.length; i++) {
    const previous = clauses[i - 1] || '';
    // Короткий заголовок «Списание:»/«Возможности:» относится и к следующей
    // строке; это также сохраняет отрицание «не по формуле:\n(input+output)».
    const clause = previous.length <= 160 && /:\s*$/.test(previous)
      ? previous + ' ' + clauses[i] : clauses[i];
    for (const [left, right] of [[INPUT, OUTPUT], [OUTPUT, INPUT]]) {
      const pairs = new RegExp(`${left}\\s*${CONNECTOR}\\s*${right}`, 'g');
      let match;
      while ((match = pairs.exec(clause))) {
        const before = clause.slice(Math.max(0, match.index - 160), match.index);
        const after = clause.slice(pairs.lastIndex, pairs.lastIndex + 160);
        const local = before + match[0] + after;
        if (negated(local, before, after)) continue;
        const billingBefore = lastMatch(BILLING, before);
        const featureBefore = lastMatch(FEATURES, before);
        const billingAfter = lastMatch(BILLING, after);
        const featureAfter = lastMatch(FEATURES, after);
        // «Поддерживает input + output, streaming…» — перечень возможностей.
        // Но «поддерживает списание input + output» явно описывает биллинг.
        if (featureBefore > billingBefore) continue;
        if (billingBefore < 0 && billingAfter < 0 && featureAfter >= 0) continue;
        if (match[1] === '+' || match[1] === 'плюс' || billingBefore >= 0 || billingAfter >= 0) return true;
      }
    }
  }
  return false;
}

module.exports = { detectInputOutput };
