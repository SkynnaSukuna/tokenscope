/* TokenRadar review phrase highlights. No DOM, HTML input, or network access. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TokenRadarReviewHighlights = factory();
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Bound regex work, candidate storage and generated elements. The unscanned
  // suffix is still escaped and returned verbatim by render().
  var MAX_SCAN = 65536;
  var MAX_PHRASE = 160;
  var MAX_CANDIDATES = 4096;
  var MAX_MARKS = 512;
  var WORD = /[\p{L}\p{M}\p{N}_]/u;
  var H = '[ \\t\\u00a0\\u2007\\u2009\\u202f]';
  var S = H + '{1,8}';
  var RU_HELP = 'помог(?:ла|ли|ло)?';
  var RU_RETURN = 'вернул(?:а|и|о)?' + S + '(?:деньги|средства)';
  var EN_NOT = '(?:(?:do|does|did|would|will|can|could|has|have|had|is|are|was|were)' + S + 'not|(?:don|doesn|didn|wouldn|won|can|couldn|hasn|haven|hadn|isn|aren|wasn|weren)[’\x27]t|cannot|never|not)';
  var EN_NEGATIVE = EN_NOT + S + '(?:(?:be|been)' + S + ')?';
  var EN_MONEY = '(?:(?:the|my|our)' + S + ')?money';
  var rules = [];
  var titles = {
    positive: 'Положительная формулировка автора отзыва. Эвристическое выделение; достоверность не проверена.',
    negative: 'Критическая формулировка автора отзыва. Эвристическое выделение; достоверность не проверена.'
  };

  function add(kind, source) {
    rules.push({ kind: kind, re: new RegExp(source, 'giu') });
  }

  // Explicit complaints include their own negation and beat praise fragments.
  add('negative', 'не' + S + '(?:работа(?:ет|ют)|рекомендую|советую|отвеча(?:ет|ют)|' + RU_RETURN + ')');
  add('negative', 'перестал(?:а|и|о)?' + S + 'работать');
  add('negative', '(?:обман(?:ул(?:а|и|о)?|ом|а|у|е)?|мошенни(?:к(?:а|и|ов|ом)?|ца|цы)|заблокирован(?:а|о|ы)?|медленно)');
  add('negative', EN_NEGATIVE + '(?:work(?:ing|s|ed)?|recommend(?:ed)?|respond(?:ing|s|ed)?|reply|repl(?:ies|ied)|refund(?:ed)?(?:' + S + EN_MONEY + ')?|return(?:ed)?' + S + EN_MONEY + ')');
  add('negative', EN_MONEY + S + '(?:(?:was|is|has|have|had)' + S + ')?not' + S + '(?:been' + S + ')?(?:returned|refunded)');
  add('negative', 'no' + S + '(?:refund|response|reply)');
  add('negative', 'stopped' + S + 'working');
  add('negative', '(?:scam(?:mers|mer|med)?|fraud|blocked|banned|slow(?:ly)?)');

  add('positive', '(?:быстро|вс[её]' + S + 'работает|рекомендую|' + RU_HELP + '|' + RU_RETURN + '|без' + S + 'обмана)');
  add('positive', '(?:fast|quickly|(?:everything|all)' + S + '(?:works|is' + S + 'working)|work(?:s|ed)' + S + '(?:fine|well|perfectly)|recommend(?:ed)?|helped)');
  add('positive', '(?:return(?:ed)?' + S + EN_MONEY + '|refunded(?:' + S + EN_MONEY + ')?|' + EN_MONEY + S + '(?:(?:was|is)' + S + ')?(?:returned|refunded)|(?:got|received)' + S + EN_MONEY + S + 'back|(?:without|no)' + S + 'deception)');

  // Keep context local and bounded. Only a few explicit modifiers can occur
  // between negation and a phrase: do not borrow "без" from "без проблем".
  var MODIFIER = '(?:очень|особо|совсем|слишком|так|такой|никакой|всегда|был|была|было|были|будет|будут|really|very|quite|so|that|at' + S + 'all|a|an|the|actual|actually|real|complete|total|been|be|going|to)';
  var NEGATOR = '(?:не|ни|нет|без|not|no|never|without|cannot|(?:don|doesn|didn|isn|aren|wasn|weren|hasn|haven|hadn|won|wouldn|can|couldn|shouldn|mustn)[’\x27]t)';
  var leftNegation = new RegExp('(?:^|[^\\p{L}\\p{M}\\p{N}_])' + NEGATOR + '(?:' + S + MODIFIER + '){0,2}' + S + '$', 'iu');

  function wordAt(text, index) {
    if (index < 0 || index >= text.length) return false;
    var code = text.charCodeAt(index);
    if (code >= 0xdc00 && code <= 0xdfff && index > 0) index--;
    return WORD.test(String.fromCodePoint(text.codePointAt(index)));
  }

  function negated(text, start) {
    var before = text.slice(Math.max(0, start - 96), start).split(/[\r\n.!?;,|:—–]/).pop();
    return leftNegation.test(before);
  }

  function escape(text) {
    // A single pass preserves entity-looking input and CR/CRLF textContent.
    return text.replace(/[&<>"'\r]/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\r': '&#13;' }[character];
    });
  }

  // Return only displayed annotations, in source order. Offsets are UTF-16 string
  // offsets; text is an exact source slice. No overall rating or truth assessment.
  function analyze(value) {
    var text = value == null ? '' : String(value);
    if (!text) return [];
    var scanned = text.slice(0, MAX_SCAN + MAX_PHRASE);
    var candidates = [];
    for (var r = 0; r < rules.length; r++) {
      var rule = rules[r];
      rule.re.lastIndex = 0;
      var match;
      while ((match = rule.re.exec(scanned))) {
        var start = match.index;
        var end = start + match[0].length;
        if (start >= MAX_SCAN) break;
        if (end > MAX_SCAN || end - start > MAX_PHRASE || wordAt(text, start - 1) || wordAt(text, end)) continue;
        if (negated(text, start)) continue;
        candidates.push({ start: start, end: end, kind: rule.kind, rule: r });
        // Dense input safely degrades to escaped plain text, as description.js does.
        if (candidates.length > MAX_CANDIDATES) return [];
      }
    }
    candidates.sort(function (a, b) {
      var priority = { negative: 0, positive: 1 };
      return priority[a.kind] - priority[b.kind] || a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.rule - b.rule;
    });
    var occupied = new Uint8Array(Math.min(text.length, MAX_SCAN));
    var accepted = [];
    for (var c = 0; c < candidates.length; c++) {
      var item = candidates[c];
      var overlaps = false;
      for (var i = item.start; i < item.end; i++) {
        if (occupied[i]) { overlaps = true; break; }
      }
      if (overlaps) continue;
      occupied.fill(1, item.start, item.end);
      accepted.push(item);
    }
    accepted.sort(function (a, b) { return a.start - b.start; });
    return accepted.slice(0, MAX_MARKS).map(function (item) {
      return { start: item.start, end: item.end, kind: item.kind, text: text.slice(item.start, item.end), title: titles[item.kind] };
    });
  }

  function render(value) {
    var text = value == null ? '' : String(value);
    var matches = analyze(text);
    var parts = [];
    var cursor = 0;
    for (var i = 0; i < matches.length; i++) {
      var phrase = matches[i];
      parts.push(escape(text.slice(cursor, phrase.start)));
      parts.push('<mark class="review-mark review-' + phrase.kind + '" title="' + escape(phrase.title) + '">' + escape(phrase.text) + '</mark>');
      cursor = phrase.end;
    }
    parts.push(escape(text.slice(cursor)));
    return parts.join('');
  }

  return { render: render, analyze: analyze };
}));
