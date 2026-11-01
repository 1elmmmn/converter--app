/**
 * Чистая логика конвертера: без DOM и сети, поэтому легко тестируется.
 * Работает и в браузере (window.Converter), и в Node (require).
 *
 * Внутренний формат курсов:
 *   { source, date (ISO), rates: { USD: { code, name, rub, prevRub } }, previousUrl }
 * где rub — стоимость ОДНОЙ единицы валюты в рублях.
 * Кросс-курс любой пары считается через рубль.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Converter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RUB = { code: 'RUB', name: 'Российский рубль', rub: 1, prevRub: 1 };

  /** Ответ ЦБ РФ (cbr-xml-daily.ru) -> внутренний формат. */
  function parseCbr(data) {
    if (!data || typeof data.Valute !== 'object') throw new Error('Некорректный ответ ЦБ');
    const rates = { RUB: { ...RUB } };
    for (const v of Object.values(data.Valute)) {
      if (!v.Nominal || !v.Value) continue;
      rates[v.CharCode] = {
        code: v.CharCode,
        name: v.Name,
        rub: v.Value / v.Nominal,
        prevRub: (v.Previous || v.Value) / v.Nominal,
      };
    }
    return {
      source: 'ЦБ РФ',
      date: String(data.Date || '').slice(0, 10),
      rates,
      previousUrl: data.PreviousURL ? normalizeUrl(data.PreviousURL) : null,
    };
  }

  /** Запасной источник (open.er-api.com, база USD) -> внутренний формат. */
  function parseErApi(data) {
    if (!data || data.result !== 'success' || !data.rates || !data.rates.RUB) {
      throw new Error('Некорректный ответ запасного API');
    }
    let names = null;
    try { names = new Intl.DisplayNames(['ru'], { type: 'currency' }); } catch (e) { /* старый браузер */ }
    const rubPerUsd = data.rates.RUB;
    const rates = {};
    for (const [code, perUsd] of Object.entries(data.rates)) {
      if (!perUsd) continue;
      const rub = rubPerUsd / perUsd;
      let name = code;
      try { name = (names && names.of(code)) || code; } catch (e) { /* неизвестный код */ }
      rates[code] = { code, name: capitalize(name), rub, prevRub: rub };
    }
    return {
      source: 'open.er-api.com',
      date: data.time_last_update_utc ? new Date(data.time_last_update_utc).toISOString().slice(0, 10) : '',
      rates,
      previousUrl: null,
    };
  }

  function normalizeUrl(url) {
    return url.startsWith('//') ? 'https:' + url : url;
  }

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  /** Конвертация через рубль. */
  function convert(amount, from, to, rates) {
    const a = rates[from];
    const b = rates[to];
    if (!a || !b) throw new Error('Неизвестная валюта');
    return (amount * a.rub) / b.rub;
  }

  /** Курс 1 from = X to. */
  function pairRate(from, to, rates) {
    return convert(1, from, to, rates);
  }

  /**
   * Разбор введённой пользователем суммы.
   * Понимает "1 000,50", "1,000.50", "1000.5", "1\u00a0000". Возвращает NaN для мусора и отрицательных.
   */
  function parseAmount(input) {
    if (typeof input !== 'string') return NaN;
    let s = input.replace(/[\s\u00a0\u202f]/g, '');
    if (!s || !/^[0-9.,]+$/.test(s)) return NaN;
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastDot !== -1 && lastComma !== -1) {
      // последний разделитель — десятичный, остальные — разряды
      const dec = lastDot > lastComma ? '.' : ',';
      const grp = dec === '.' ? ',' : '.';
      s = s.split(grp).join('').replace(dec, '.');
    } else if (lastComma !== -1) {
      if (s.split(',').length > 2) return NaN;
      s = s.replace(',', '.');
    } else if (s.split('.').length > 2) {
      return NaN;
    }
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  }

  /** Красивый вывод числа: 2 знака для обычных сумм, больше для очень маленьких. */
  function formatNumber(value, locale) {
    if (!Number.isFinite(value)) return '—';
    const abs = Math.abs(value);
    const opts =
      abs !== 0 && abs < 1
        ? { maximumSignificantDigits: 4 }
        : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    return new Intl.NumberFormat(locale || 'ru-RU', opts).format(value);
  }

  /** Процентное изменение. */
  function percentChange(current, previous) {
    if (!previous) return 0;
    return ((current - previous) / previous) * 100;
  }

  /** Список кодов: популярные сверху, остальные по алфавиту. */
  function sortCodes(codes, popular) {
    const pop = popular.filter((c) => codes.includes(c));
    const rest = codes.filter((c) => !pop.includes(c)).sort();
    return { popular: pop, rest };
  }

  return { parseCbr, parseErApi, convert, pairRate, parseAmount, formatNumber, percentChange, sortCodes };
});
