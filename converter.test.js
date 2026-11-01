const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/converter.js');

const cbrSample = {
  Date: '2026-10-10T11:30:00+03:00',
  PreviousURL: '//www.cbr-xml-daily.ru/archive/2026/10/09/daily_json.js',
  Valute: {
    USD: { CharCode: 'USD', Name: 'Доллар США', Nominal: 1, Value: 80, Previous: 79 },
    EUR: { CharCode: 'EUR', Name: 'Евро', Nominal: 1, Value: 90, Previous: 91 },
    JPY: { CharCode: 'JPY', Name: 'Японских иен', Nominal: 100, Value: 55, Previous: 54 },
  },
};

test('parseCbr: учитывает номинал и добавляет рубль', () => {
  const r = C.parseCbr(cbrSample);
  assert.equal(r.rates.RUB.rub, 1);
  assert.equal(r.rates.JPY.rub, 0.55);
  assert.equal(r.date, '2026-10-10');
  assert.equal(r.previousUrl, 'https://www.cbr-xml-daily.ru/archive/2026/10/09/daily_json.js');
});

test('parseCbr: бросает ошибку на мусоре', () => {
  assert.throws(() => C.parseCbr({}));
  assert.throws(() => C.parseCbr(null));
});

test('convert: прямая и кросс-конвертация', () => {
  const { rates } = C.parseCbr(cbrSample);
  assert.equal(C.convert(10, 'USD', 'RUB', rates), 800);
  assert.equal(C.convert(800, 'RUB', 'USD', rates), 10);
  assert.ok(Math.abs(C.convert(90, 'USD', 'EUR', rates) - 80) < 1e-9);
  assert.throws(() => C.convert(1, 'USD', 'XXX', rates));
});

test('convert: туда-обратно возвращает исходную сумму', () => {
  const { rates } = C.parseCbr(cbrSample);
  const there = C.convert(123.45, 'EUR', 'JPY', rates);
  assert.ok(Math.abs(C.convert(there, 'JPY', 'EUR', rates) - 123.45) < 1e-9);
});

test('parseErApi: считает рубли за единицу валюты', () => {
  const r = C.parseErApi({ result: 'success', rates: { USD: 1, RUB: 80, EUR: 0.9 } });
  assert.equal(r.rates.USD.rub, 80);
  assert.ok(Math.abs(r.rates.EUR.rub - 80 / 0.9) < 1e-9);
  assert.throws(() => C.parseErApi({ result: 'error' }));
});

test('parseAmount: разные форматы ввода', () => {
  assert.equal(C.parseAmount('100'), 100);
  assert.equal(C.parseAmount('1 000,50'), 1000.5);
  assert.equal(C.parseAmount('1 000,5'), 1000.5);
  assert.equal(C.parseAmount('1,000.50'), 1000.5);
  assert.equal(C.parseAmount('1.000,50'), 1000.5);
  assert.equal(C.parseAmount('0,5'), 0.5);
  assert.equal(C.parseAmount('0'), 0);
});

test('parseAmount: мусор и отрицательные значения -> NaN', () => {
  for (const bad of ['', '   ', 'abc', '-5', '1e5', '1.2.3', '1,2,3', '12a', null, undefined]) {
    assert.ok(Number.isNaN(C.parseAmount(bad)), `ожидали NaN для ${JSON.stringify(bad)}`);
  }
});

test('formatNumber: два знака и значимые цифры для малых сумм', () => {
  assert.equal(C.formatNumber(1234.5, 'en-US'), '1,234.50');
  assert.equal(C.formatNumber(0.012345, 'en-US'), '0.01235');
  assert.equal(C.formatNumber(NaN), '—');
});

test('percentChange', () => {
  assert.equal(C.percentChange(110, 100), 10);
  assert.equal(C.percentChange(90, 100), -10);
  assert.equal(C.percentChange(5, 0), 0);
});

test('sortCodes: популярные сверху, остальные по алфавиту', () => {
  const { popular, rest } = C.sortCodes(['ZAR', 'USD', 'AUD', 'RUB'], ['RUB', 'USD', 'EUR']);
  assert.deepEqual(popular, ['RUB', 'USD']);
  assert.deepEqual(rest, ['AUD', 'ZAR']);
});
