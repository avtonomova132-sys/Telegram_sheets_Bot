// Тест разбора API-отчёта «размещение по товарам» на строках из живого ответа Озона
// (присланы Еленой 04.11.2026 из /fbo_report). Запуск: node --test fboPlacement.test.js
const test = require('node:test');
const assert = require('node:assert');
const fp = require('./fboPlacement');

// Середина заголовка (колонки 10–?) в живом ответе не видна — ставим заглушку.
const HEADER = [
  'Дата', 'SKU', 'Артикул', 'Категория товара', 'Описательный тип', 'Склад', 'Признак товара',
  'Суммарный объем в миллилитрах', 'Кол-во экземпляров', 'заглушка',
  'Кол-во экземпляров', 'Платный объем в миллилитрах', 'Кол-во платных экземпляров', 'Начисленная стоимость размещения',
];
const row = (date, sku, art, wh, vol, qty, paidVol, paidQty, cost) => [
  date, sku, art, 'кат', 'тип', wh, '', vol, qty, '', qty, paidVol, paidQty, cost,
];

const ROWS = [
  HEADER,
  row(46300, 1544818529, 'КОРИЧ100200МЕДТЕСТ200ШТ', 'НОВОРОССИЙСК_РФЦ', 1160, 1, 1160, 1, 2.9),
  row(46300, 1050731951, 'ВанильныйЙогурт1ШТ', 'Новосибирск_РФЦ_НОВЫЙ', 410, 1, 0, 0, 0),
  row(46300, 1099262114, '050ЦилиндрПолусфераСиняя|10шт', 'КРАСНОЯРСК_МРФЦ', 40, 1, 40, 1, 0.1),
  row(46301, 1544818529, 'КОРИЧ100200МЕДТЕСТ200ШТ', 'НОВОРОССИЙСК_РФЦ', 1160, 1, 1160, 1, 2.9),
  row(46301, 1050731951, 'ВанильныйЙогурт1ШТ', 'Новосибирск_РФЦ_НОВЫЙ', 410, 1, 0, 0, 0),
];

test('parseDailyRows читает отчёт с заголовком «Начисленная стоимость размещения»', () => {
  const rows = fp.parseDailyRows(ROWS);
  assert.strictEqual(rows.length, 5);
  assert.strictEqual(rows[0].article, 'КОРИЧ100200МЕДТЕСТ200ШТ');
  assert.strictEqual(rows[0].warehouse, 'НОВОРОССИЙСК_РФЦ');
  assert.strictEqual(rows[0].paidQty, 1);
  assert.strictEqual(rows[0].cost, 2.9);
});

test('дата Excel 46300 = 05.10.2026', () => {
  assert.strictEqual(fp.parseDailyRows(ROWS)[0].date, '2026-10-05');
});

test('buildPaidMessage берёт последнюю дату отчёта и только платные', () => {
  const { text } = fp.buildPaidMessage(fp.parseDailyRows(ROWS));
  assert.match(text, /КОРИЧ100200МЕДТЕСТ200ШТ/);
  assert.match(text, /НОВОРОССИЙСК_РФЦ/);
  assert.doesNotMatch(text, /ВанильныйЙогурт/);
  assert.doesNotMatch(text, /050Цилиндр/); // на 46301 его уже нет в платных
});

test('чужой лист даёт понятную ошибку', () => {
  assert.throws(() => fp.parseDailyRows([['a', 'b'], [1, 2]]), /в файле нет колонок/);
});

test('describeReport показывает ВСЕ колонки с номерами', () => {
  const out = fp.describeReport(ROWS);
  assert.match(out, /1\. Дата/);
  assert.match(out, /14\. Начисленная стоимость размещения/);
  assert.match(out, /Строк в отчёте: 6/);
});

// ---- by-supplies: структура как в живом отчёте (222 строки, колонки по дням) ----
const SUP_HEADER = [
  'SKU', 'Признак товара', 'Категория', 'Описательный тип', 'Остаток на складах на (04.11.2026)',
  'Номер поставки', 'Склад поставки', 'Дней до конца периода', 'Дата окончания периода по поставкам',
  '03.нояб', '04.нояб',
];
const sup = (sku, supply, wh, days, end, a, b) => [sku, '', '', '', '', supply, wh, days, end, a, b];
const SUP = [
  SUP_HEADER,
  [396742554, '', '', '', 5, '', '', '', '', '', ''], // итоговая строка товара
  sup('', '111', 'ХОРУГВИНО_РФЦ', 364, 46694, 5, 5),
  [1544818529, '', '', '', 3, '', '', '', '', '', ''],
  sup('', '222', 'НОВОРОССИЙСК_РФЦ', 20, 46350, 2, 2),
  sup('', '223', 'НОВОРОССИЙСК_РФЦ', 10, 46340, 1, 0), // сегодня 0 — не считается
  sup('', '224', 'НОВОРОССИЙСК_РФЦ', 40, 46370, 1, 1), // дальше окна
];

test('parseSupplies: SKU переносится вниз, пустые/закрытые отбрасываются', () => {
  const s = require('./fboPlacement').parseSupplies(SUP);
  assert.strictEqual(s.length, 3);
  assert.strictEqual(s[0].sku, '396742554');
  assert.strictEqual(s[0].days, 364);
  assert.strictEqual(s[0].endDate, '2027-11-03');
  assert.strictEqual(s[1].sku, '1544818529');
  assert.strictEqual(s[1].qty, 2);
});

test('buildDigest: окно 28 дней + уже платное, артикул по SKU', () => {
  const prod = fp.parseDailyRows(ROWS.map((r, i) => (i === 0 ? r : r))) ; // SKU в колонке 2
  const d = fp.buildDigest({ prodRows: prod, supplies: fp.parseSupplies(SUP), windowDays: 28 });
  assert.strictEqual(d.soon.length, 1);
  assert.match(d.text, /КОРИЧ100200МЕДТЕСТ200ШТ — 2 шт, НОВОРОССИЙСК_РФЦ, через 20 дн\./);
  assert.match(d.text, /Уже платное/);
  assert.doesNotMatch(d.text, /через 364/);
});

test('buildDigest: нечего сообщать → text null', () => {
  const d = fp.buildDigest({ prodRows: [], supplies: fp.parseSupplies(SUP).filter((s) => s.days > 28) });
  assert.strictEqual(d.text, null);
});
