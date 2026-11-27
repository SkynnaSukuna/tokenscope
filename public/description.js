/* TokenRadar description annotations. No HTML input, DOM access, or network access. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TokenRadarDescription = factory();
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Only a bounded prefix is annotated. The entire original string is still escaped
  // and returned. Caps also bound candidate storage and the number of DOM elements.
  var MAX_SCAN = 65536;
  var MAX_PHRASE = 160;
  var MAX_CANDIDATES = 4096;
  var MAX_MARKS = 512;
  var WORD = /[\p{L}\p{M}\p{N}_]/u;
  var H = '[ \\t\\u00a0\\u2007\\u2009\\u202f]';
  var S = H + '{1,8}';
  var O = H + '{0,8}';
  var NUM = '(?:[0-9]{1,3}(?:[ \\u00a0\\u202f.,][0-9]{3}){1,4}|[0-9]{1,15})(?:[.,][0-9]{1,6})?';
  var SCALE = '(?:миллиард(?:а|ов)?|миллион(?:а|ов)?|billion|million|млрд|млн|тыс\\.?|кк|[kmbкм])';
  var AMOUNT = NUM + '(?:' + O + SCALE + ')?';
  var TOKENS = '(?:токен(?:ов|ами|а|ы)?|tokens?)';
  var CREDITS = '(?:кредит(?:ов|ами|а|ы)?|credits?)';
  var COUNTS = '(?:' + TOKENS + '|' + CREDITS + '|запрос(?:ов|а|ы)?|сообщени(?:й|я|е)|requests?|messages?)';
  var TIME = '(?:минут(?:а|ы|у)?|мин\\.?|час(?:а|ов)?|день|дня|дней|сутки|суток|недел(?:я|ю|и|ь)|месяц(?:а|ев)?|мес\\.?|лет|год(?:а|ов)?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)';
  var PERIOD = '(?:день|дня|дней|сутки|суток|час(?:а|ов)?|минут(?:а|ы|у)?|недел(?:ю|и|ь)|месяц(?:а|ев)?|days?|hours?|minutes?|weeks?|months?)';
  var RATE = '(?:' + O + '(?:/|в|за|на|per)' + O + '(?:[0-9]{1,3}' + O + ')?' + PERIOD + ')';
  var UNLIMITED = '(?:безлимит(?:ный|ная|ное|ные|ного|ом|а)?|неограниченн(?:ый|ая|ое|ые|ого|ой|ым|ыми|ых|ую)|unlimited|unmetered)';
  var ACCESS = '(?:доступ|тариф|аккаунт|запросы|access|plan|account|requests)';
  var RU_SUBJECT = '(?:возврат(?:а|ы|ов)?|гаранти(?:я|и|й|ю)|замен(?:а|ы|у)|поддержк(?:а|и|у))';
  var RU_DENIAL = '(?:нет|отсутству(?:ет|ют)|не' + S + '(?:предусмотрен[а-яё]{0,2}|предоставля[а-яё]{2,4}|предоставлен[а-яё]{0,2}|возмож[а-яё]{2,4}|гарантиру[а-яё]{2,4}|осуществля[а-яё]{2,4}|принима[а-яё]{2,4}|производ[а-яё]{2,4}|да[её]м|да[её]тся|даю|дают|оказыва[а-яё]{2,4}|распространя[а-яё]{2,4}|будет))';
  var EN_SUBJECT = '(?:refunds?|replacements?|guarantees?|warrant(?:y|ies)|support)';
  var EN_DENIAL = '(?:(?:(?:is|are)' + S + ')?not' + S + '(?:provided|available|offered|guaranteed|included|supported)|unavailable)';
  // These terms are deliberately bounded and require a billing/cache/model context.
  // A bare number, percentage, or "half" is never a claim by itself.
  var MODEL_COUNT = '[0-9]{1,6}';
  var MODELS = '(?:модел(?:ь|и|ей)|models?)';
  var CACHE_RU = 'к[еэ]ш(?:ир[а-яё]{1,16}|ерован[а-яё]{1,12}|а|е|у|ем)?';
  var INPUT = '(?:вход(?:(?:ящие|ящих|ные|ных)' + S + 'токен(?:ы|ов))?|input(?:' + S + 'tokens?)?)';
  var OUTPUT = '(?:выход(?:(?:ящие|ящих|ные|ных)' + S + 'токен(?:ы|ов))?|исходящ(?:ие|их)' + S + 'токен(?:ы|ов)|output(?:' + S + 'tokens?)?)';
  var CACHE = '(?:' + CACHE_RU + '(?:' + S + '(?:вход|токен(?:ы|ов)))?|(?:cached' + S + '(?:input|tokens?)|cache(?:d|s)?(?:' + S + '(?:hits?|input|tokens?))?|caching))';
  var PERCENT = '[0-9]{1,3}(?:[.,][0-9]{1,2})?' + O + '%';
  var DISCOUNT = '(?:скидк(?:а|и|у|ой|е|ок)|discounts?|savings?)';
  var DISCOUNT_AMOUNT = '(?:' + O + '(?::|[—–-])?' + O + '(?:на' + S + '|of' + S + ')?[-−]?' + O + PERCENT + ')?';
  var CACHE_RATE = CACHE + '(?:' + O + '[:=—–-]?' + O + PERCENT + '(?:' + S + '(?:стоимости|цены|cost|price))?)?';
  var CACHE_DISCOUNT = '(?:' + O + '[:=—–]?' + O + '[-−]' + O + PERCENT + '|' + O + '[:=—–-]?' + O + '(?:за' + S + 'половину(?:' + S + '(?:цены|стоимости))?|половин(?:а|у)' + S + '(?:цены|стоимости)|вдвое' + S + 'дешевле|(?:(?:at|is)' + S + ')?half' + S + 'price|' + PERCENT + S + '(?:off|(?:скидк(?:а|и)|discount))))';
  var DISCOUNT_CLAIM = '(?:' + DISCOUNT + DISCOUNT_AMOUNT + '(?:' + S + '(?:на|за|для|on|for)' + S + CACHE + ')?|' + PERCENT + S + '(?:скидк(?:а|и)|discount|off))';
  var BILLING_CLAIM = '(?:' + CACHE + CACHE_DISCOUNT + '|' + CACHE_RATE + '(?:' + S + DISCOUNT + DISCOUNT_AMOUNT + ')?|' + DISCOUNT_CLAIM + ')';
  var BILLING_DENIAL = '(?:нет|отсутству(?:ет|ют)|недоступ(?:ен|на|но|ны)|(?:отключ[её]н|выключ[её]н)(?:а|о|ы)?|не' + S + '(?:поддержива[а-яё]{2,4}|применя[а-яё]{2,4}|работа[а-яё]{2,4}|действу[а-яё]{2,4}|будет|использу[а-яё]{2,4}|учитыва[а-яё]{2,4}|предусмотрен[а-яё]{0,2}|предоставля[а-яё]{2,4}|предоставлен[а-яё]{0,2}|доступ(?:ен|на|но|ны)|включ[её]н[а-яё]{0,2})|(?:(?:is|are)' + S + ')?(?:unavailable|disabled|unsupported|not' + S + '(?:supported|available|enabled|applied|included|provided|offered|used)))';
  var ACCOUNTING = '(?:(?:уч[её]т|расч[её]т|оплата|списание|учитыва(?:ется|ются)|счита(?:ется|ются)|списыва(?:ется|ются)|оплачива(?:ется|ются)|billing|billed|charged|usage)' + O + '[:=—–-]?' + O + ')';
  var SUM = INPUT + '(?:' + O + '[+＋]' + O + '|' + S + '(?:плюс|и|and)' + S + ')' + OUTPUT;
  var FACTOR = '(?:(?:множитель|коэффициент|multiplier|coefficient)(?:' + S + NUM + ')?|' + NUM + ')';
  var FORMULA = '(?:\\(' + O + SUM + O + '\\)|' + SUM + ')(?:' + O + '[×*xх]' + O + FACTOR + '|' + S + '(?:с' + S + ')?(?:множителем|коэффициентом)(?:' + S + NUM + ')?|' + S + '(?:times|with' + S + 'multiplier)' + S + FACTOR + ')?';
  var BALANCE = '(?:(?:остат(?:ок|ка)|баланс(?:а|е|ом)?)(?:' + S + '(?:средств|кредитов|токенов))?|balance|remaining' + S + '(?:balance|credits?|tokens?))';
  var BALANCE_PLACE = '(?:на' + S + 'странице' + S + '(?:API' + S + ')?ключа|в' + S + '(?:вашем' + S + ')?(?:личном' + S + ')?кабинете|(?:on|in)' + S + '(?:(?:the|your)' + S + ')?(?:API' + S + 'key' + S + 'page|key' + S + 'page|dashboard|account(?:' + S + 'page)?|control' + S + 'panel))';
  var BALANCE_VIEW = '(?:виден|видно|доступен|доступно|отображается|показывается|проверяется|смотрите|проверяйте|(?:можно' + S + ')?(?:посмотреть|проверить|увидеть|узнать)|(?:(?:is|can' + S + 'be)' + S + ')?(?:shown|visible|available|checked|viewed))';
  var rules = [];

  var titles = {
    refund: 'Заявление продавца о возврате или замене; не проверено TokenRadar.',
    guarantee: 'Гарантия — заявление продавца, а не подтверждённая проверка TokenRadar.',
    bonus: 'Продавец заявляет бонус; условия и получение не проверены.',
    delivery: 'Продавец заявляет автоматическую или мгновенную выдачу; не проверено.',
    limits: 'Продавец явно заявляет отсутствие ограничений; не проверено.',
    private: 'Продавец заявляет личный аккаунт или ключ; не проверено.',
    expiry: 'Продавец явно заявляет отсутствие срока действия или комиссии; не проверено.',
    exclusion: 'В описании указано отсутствие возврата, гарантии, замены или поддержки.',
    restriction: 'В описании указано ограничение или отсутствие безлимита.',
    shared: 'В описании указан общий аккаунт.',
    vpn: 'В описании указан обязательный VPN.',
    manual: 'В описании указаны ручная выдача, активация или ожидание.',
    risk: 'В описании указан риск блокировки или отзыва ключа.',
    oneToOne: 'В описании токен приравнен к человеку; это не подтверждённый объём токенов.',
    unlimited: 'Заявленный безлимит — тип доступа, а не оценка качества; условия не проверены.',
    duration: 'Указанный продавцом срок действия; не проверено.',
    quantity: 'Указанное продавцом количество или соотношение; не проверено.',
    models: 'Указанное продавцом число моделей; не проверено.',
    cache: 'Указанные продавцом условия кеширования или учёта кешированного входа; не проверено.',
    discount: 'Продавец явно заявляет снижение стоимости; условия и получение не проверены.',
    billingExclusion: 'В описании явно указано отсутствие кеширования или скидки.',
    extraCharge: 'В описании явно указаны дополнительные списания или платежи.',
    accounting: 'Указанный продавцом способ учёта входа и выхода; не проверено.',
    balance: 'Указанное продавцом место просмотра остатка или баланса; не проверено.'
  };

  function add(kind, title, source) {
    rules.push({ kind: kind, title: titles[title], re: new RegExp(source, 'giu') });
  }

  // Whole negative constructions win over positive fragments and neutral numbers.
  add('negative', 'oneToOne', '1' + O + TOKENS + O + '[=＝]' + O + '1' + O + '(?:человек|person|user)');
  add('negative', 'exclusion', '(?:никаких|никакой|отсутствие|отсутствует)' + S + RU_SUBJECT);
  add('negative', 'exclusion', '(?:без|нет)' + S + RU_SUBJECT + '(?:' + S + '(?:денег|средств|возврата))?' + '(?:' + S + '(?:и|или)' + S + RU_SUBJECT + '){0,2}');
  add('negative', 'exclusion', RU_SUBJECT + '(?:' + S + '(?:денег|средств|возврата))?' + S + RU_DENIAL);
  add('negative', 'exclusion', 'не' + S + '(?:предусмотрен[а-яё]{0,2}|предоставля[а-яё]{2,4}|гарантиру[а-яё]{2,4}|принима[а-яё]{2,4}|осуществля[а-яё]{2,4})' + S + RU_SUBJECT);
  add('negative', 'exclusion', 'деньги' + S + 'не' + S + 'возвраща[а-яё]{2,4}');
  add('negative', 'exclusion', '(?:no|without)' + S + EN_SUBJECT + '(?:' + S + '(?:and|or)' + S + EN_SUBJECT + '){0,2}');
  add('negative', 'exclusion', EN_SUBJECT + S + EN_DENIAL);
  add('negative', 'exclusion', '(?:do' + S + 'not|don[’\x27]t)' + S + '(?:provide|offer|allow)' + S + EN_SUBJECT);
  add('negative', 'restriction', '(?:не|нет|not|no)' + S + UNLIMITED + '(?:' + S + ACCESS + ')?');
  add('negative', 'restriction', UNLIMITED + '(?:' + S + ACCESS + ')?' + S + '(?:' + RU_DENIAL + '|' + EN_DENIAL + ')');
  add('negative', 'restriction', '(?:не' + S + 'без' + S + '(?:ограничений|лимитов|лимита)|без' + S + '(?:ограничений|лимитов|лимита)' + S + '(?:нет|не' + S + 'бывает))');
  add('negative', 'restriction', '(?:(?:суточный|дневной|daily|hourly)' + S + ')?(?:лимит(?:ы|ов)?|ограничени(?:е|я)|квота|limits?|quota)' + O + '[:—–-]?' + O + '(?:до' + S + ')?' + AMOUNT + O + COUNTS + '(?:' + RATE + ')?');
  add('negative', 'restriction', '(?:лимит|ограничение|time' + S + 'limit|limit)' + O + '[:—–-]?' + O + NUM + O + TIME);
  add('negative', 'restriction', AMOUNT + O + COUNTS + S + '(?:максимум|max(?:imum)?|limit)');
  add('negative', 'restriction', '(?:до|не' + S + 'более|максимум|up' + S + 'to|at' + S + 'most)' + S + AMOUNT + O + COUNTS + '(?:' + RATE + ')?');
  add('negative', 'restriction', AMOUNT + O + COUNTS + RATE);
  add('negative', 'restriction', '(?:дневн(?:ой|ые)|суточн(?:ый|ые)|временн(?:ой|ые)|почасов(?:ой|ые)|daily|hourly|time|request|token)' + S + '(?:лимит(?:ы|ов)?|ограничени(?:е|я)|limits?)');
  add('negative', 'restriction', '(?:лимит(?:ы|ов)?|ограничени(?:е|я))' + S + '(?:по' + S + ')?(?:времени|запросам|запросов|токенам|токенов)');
  add('negative', 'restriction', '(?:ограничен(?:о|а|ы)?' + S + '(?:до' + S + ')?|limited' + S + '(?:to' + S + ')?)' + NUM + O + TIME);
  add('negative', 'shared', '(?:общий|общие|совместный)' + S + '(?:аккаунт(?:ы)?|доступ|ключ(?:и)?)|общая' + S + 'уч[её]тная' + S + 'запись|shared' + S + '(?:accounts?|keys?)');
  add('negative', 'vpn', '(?:обязателен|требуется|необходим)' + S + 'VPN|VPN' + S + '(?:обязателен|необходим|требуется)|(?:mandatory|required)' + S + 'VPN|VPN' + S + '(?:is' + S + ')?(?:required|mandatory)');
  add('negative', 'manual', '(?:ручная' + S + '(?:активация|выдача)|активация' + S + 'вручную|manual' + S + '(?:activation|delivery))');
  add('negative', 'manual', '(?:ожидание|ожидать|ждать|ожидайте|wait)(?:' + S + '(?:до|up' + S + 'to|for))?' + S + NUM + O + TIME);
  add('negative', 'risk', 'риск(?:и)?' + S + '(?:блокировк(?:и|ок)|бан(?:а|ов)|отзыва' + S + 'ключа)|отзыв' + S + '(?:ключа|ключей)|ключ(?:и)?' + S + '(?:может|могут)' + S + '(?:быть' + S + ')?(?:отозван(?:ы)?|заблокирован(?:ы)?)|key' + S + 'revocation|risk' + S + 'of' + S + '(?:bans?|suspension|key' + S + 'revocation)|(?:account|key)' + S + '(?:may|can)' + S + 'be' + S + '(?:banned|revoked)');

  // Absence is red only when it is actually asserted. More specific negative
  // spans include the advertised rate so a green percentage cannot escape them.
  add('negative', 'billingExclusion', '(?:без|нет|отсутствие|отсутствует|никакого|никакой|никаких|no|without)' + S + BILLING_CLAIM);
  add('negative', 'billingExclusion', BILLING_CLAIM + O + '[:—–-]?' + O + BILLING_DENIAL);
  add('negative', 'billingExclusion', '(?:не' + S + '(?:поддержива[а-яё]{2,4}|применя[а-яё]{2,4}|предоставля[а-яё]{2,4}|предусмотрен[а-яё]{0,2})|(?:do' + S + 'not|does' + S + 'not)' + S + '(?:support|apply|provide|offer))' + S + BILLING_CLAIM);
  add('negative', 'billingExclusion', '(?:' + INPUT + S + '(?:(?:is' + S + ')?not' + S + 'cached|не' + S + 'к[еэ]ширу(?:ется|ются))|не' + S + 'к[еэ]ширу(?:ется|ются))');
  add('negative', 'extraCharge', '(?:(?:дополнительн(?:ое|ые|ых|ого|ая|ой|ую)|повторн(?:ое|ые|ых|ого|ая|ой|ую))' + S + '(?:списани(?:е|я|й)|плат[её]ж(?:и|ей)?|комисси(?:я|и|й|ю|ей))|дополнительно' + S + '(?:списыва(?:ется|ются)|взима(?:ется|ются)|снима(?:ется|ются))|(?:additional|extra)' + S + '(?:charges?|fees?|deductions?)|charged' + S + 'extra)(?:' + O + '[:—–-]?' + O + '(?:ещ[её]' + S + ')?' + PERCENT + ')?');

  add('positive', 'refund', '(?:гаранти(?:я|и)|гарантируем|гарантирую|гарантированн(?:ый|ая|ое|ые))' + S + '(?:возврат(?:а)?|замен(?:а|ы|у))(?:' + S + '(?:денег|средств))?');
  add('positive', 'refund', '(?:возврат|замена)(?:' + S + '(?:денег|средств))?' + S + '(?:гарантирован(?:а)?|гарантиру(?:ем|ю)|предусмотрен(?:а)?|возмож(?:ен|на))');
  add('positive', 'refund', '(?:guaranteed' + S + '(?:refunds?|replacements?)|(?:refunds?|replacements?)(?:' + S + '(?:is|are))?' + S + '(?:guaranteed|available|provided))');
  add('positive', 'guarantee', '(?:гаранти(?:я|и|й|ю|ей)|guarantees?|warrant(?:y|ies))');
  add('positive', 'bonus', '(?:бонус(?:ы|а|ов|ом|ами)?|bonuses|bonus)(?:' + O + '[:+＋]?' + O + '[0-9]{1,3}' + O + '%)?');
  add('positive', 'delivery', '(?:автовыдача|авто' + S + 'выдача|автоматическая' + S + '(?:выдача|доставка)|(?:мгновенная|моментальная)' + S + '(?:выдача|доставка)|(?:auto|automatic|instant|immediate)' + S + 'delivery)');
  add('positive', 'limits', 'без' + S + '(?:(?:суточных|дневных|скрытых|каких-либо)' + S + ')?(?:ограничений|лимитов|лимита)|лимитов' + S + 'нет|(?:no|without)' + S + '(?:usage' + S + ')?(?:limits?|restrictions?)');
  add('positive', 'private', '(?:личный|персональный|приватный)' + S + '(?:аккаунт|ключ)|личная' + S + 'уч[её]тная' + S + 'запись|(?:personal|private|individual)' + S + '(?:accounts?|(?:API' + S + ')?keys?)');
  add('positive', 'expiry', 'без' + S + '(?:срока' + S + '(?:действия|годности)|ограничения' + S + 'срока|комисси(?:и|й))|бессрочн(?:ый|ая|ое|ые|о)|(?:no|without)' + S + '(?:expiry|expiration)(?:' + S + 'date)?|(?:no|zero|without)' + S + '(?:commissions?|fees?)|(?:does' + S + 'not|never)' + S + 'expire');

  add('positive', 'discount', CACHE + CACHE_DISCOUNT);
  add('positive', 'discount', DISCOUNT + O + '[:—–-]?' + O + '(?:на' + S + '|of' + S + ')?[-−]?' + O + PERCENT);
  add('positive', 'discount', PERCENT + S + '(?:скидк(?:а|и)|discount|off)');
  add('positive', 'discount', '(?:на' + S + PERCENT + S + 'дешевле|вдвое' + S + 'дешевле|(?:за' + S + ')?половин(?:а|у)' + S + '(?:цены|стоимости)|half' + S + 'price|' + PERCENT + S + '(?:cheaper|less))');

  add('neutral', 'models', '(?:не' + S + '(?:более|менее)' + S + '|(?:более|свыше|около|до|от|over|about)' + S + '|more' + S + 'than' + S + '|up' + S + 'to' + S + ')?' + MODEL_COUNT + S + MODELS);
  add('neutral', 'models', MODELS + O + '[:=—–-]' + O + MODEL_COUNT);
  add('neutral', 'cache', CACHE_RATE);
  add('neutral', 'accounting', '(?:' + ACCOUNTING + ')?' + FORMULA);
  add('neutral', 'balance', '(?:(?:посмотреть|проверить|проверьте|смотреть|узнать|check|view|see)' + S + '(?:the' + S + ')?)?' + BALANCE + S + '(?:' + BALANCE_VIEW + S + ')?' + BALANCE_PLACE);
  add('neutral', 'balance', BALANCE_PLACE + S + '(?:' + BALANCE_VIEW + S + ')' + BALANCE);

  add('neutral', 'unlimited', UNLIMITED + '(?:' + S + ACCESS + ')?');
  add('neutral', 'duration', '(?:срок' + S + '(?:действия|доступа)|доступ|подписка|ключ' + S + 'действителен)(?:' + S + '(?:на|в' + S + 'течение))?' + O + '[:—–-]?' + O + NUM + O + TIME);
  add('neutral', 'duration', '(?:valid' + S + 'for|validity(?:' + S + 'period)?|access' + S + 'for|subscription' + S + 'for|expires' + S + 'in)' + O + '[:—–-]?' + O + NUM + O + TIME);
  add('neutral', 'duration', '(?:действителен' + S + 'до|срок' + S + 'действия' + S + 'до|valid' + S + 'until)' + S + '(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{2}\\.[0-9]{2}\\.[0-9]{4})');
  add('neutral', 'quantity', AMOUNT + O + CREDITS + O + '(?:=|→|≈|equals?)' + O + AMOUNT + O + TOKENS);
  add('neutral', 'quantity', AMOUNT + O + '(?:' + TOKENS + '|' + CREDITS + ')');

  // These bounded context checks suppress negated fragments even when an unfamiliar
  // construction is not in the explicit negative rule set. Never cross a sentence
  // or line to borrow negation from a different claim.
  var leftNegation = new RegExp('(?:^|[^\\p{L}\\p{M}\\p{N}_])(?:не|нет|без|никак(?:их|ой|ого)|отсутствие|отсутству(?:ет|ют)|not|no|without|never)(?:' + S + '[\\p{L}]{1,24}){0,2}' + S + '$', 'iu');
  var rightNegation = new RegExp('^' + O + '(?:[:—–-]' + O + ')?(?:(?:is|are|будет)' + S + ')?(?:нет|отсутству(?:ет|ют)|не' + S + '(?:предусмотрен[а-яё]{0,2}|предоставля[а-яё]{2,4}|предоставлен[а-яё]{0,2}|начисля[а-яё]{2,4}|включен[а-яё]{0,2}|доступен|доступна|гарантиру[а-яё]{2,4}|гарантирован[а-яё]{0,2}|да[её]м|да[её]тся|даю|дают|оказыва[а-яё]{2,4}|распространя[а-яё]{2,4}|требуется|нужен|нужна|обязателен|отзывается|будет)|not(?:' + S + '(?:available|included|provided|offered|guaranteed|required|mandatory))?)(?![\\p{L}\\p{M}\\p{N}_])', 'iu');

  var rightBillingNegation = new RegExp('^' + O + '(?:[:—–-]' + O + ')?(?:' + BILLING_DENIAL + '|не' + S + '(?:производ[а-яё]{2,4}|взима[а-яё]{2,4}|списыва[а-яё]{2,4}|снима[а-яё]{2,4}|отобража[а-яё]{2,4}|обеща[а-яё]{2,4}|обещан[а-яё]{0,2}|виден|видно)|(?:do|does)' + S + 'not' + S + '(?:apply|occur))(?![\\p{L}\\p{M}\\p{N}_])', 'iu');

  function negated(text, start, end) {
    var before = text.slice(Math.max(0, start - 80), start).split(/[\r\n.!?;,|]/).pop();
    var after = text.slice(end, end + 80).split(/[\r\n.!?;,|]/)[0];
    return leftNegation.test(before) || rightNegation.test(after) || rightBillingNegation.test(after);
  }

  function wordAt(text, index) {
    if (index < 0 || index >= text.length) return false;
    var code = text.charCodeAt(index);
    if (code >= 0xdc00 && code <= 0xdfff && index > 0) index--;
    return WORD.test(String.fromCodePoint(text.codePointAt(index)));
  }

  function escape(text) {
    // Character references preserve CR/CRLF through HTML's newline normalization.
    // Escape ampersands first in one pass: entity-looking descriptions remain text.
    return text.replace(/[&<>"'\r]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\r': '&#13;' }[c];
    });
  }

  function render(value) {
    var text = value == null ? '' : String(value);
    if (!text) return '';
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
        if (negated(text, start, end)) continue;
        candidates.push({ start: start, end: end, kind: rule.kind, title: rule.title, rule: r });
        // In a pathological description, safely fall back to escaped plain text.
        if (candidates.length > MAX_CANDIDATES) return escape(text);
      }
    }
    var rank = { negative: 0, positive: 1, neutral: 2 };
    candidates.sort(function (a, b) {
      return rank[a.kind] - rank[b.kind] || a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.rule - b.rule;
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
    var parts = [];
    var cursor = 0;
    for (var a = 0; a < Math.min(accepted.length, MAX_MARKS); a++) {
      var phrase = accepted[a];
      parts.push(escape(text.slice(cursor, phrase.start)));
      parts.push('<mark class="desc-highlight desc-' + phrase.kind + '" title="' + escape(phrase.title) + '">' + escape(text.slice(phrase.start, phrase.end)) + '</mark>');
      cursor = phrase.end;
    }
    parts.push(escape(text.slice(cursor)));
    return parts.join('');
  }

  return { render: render };
}));
