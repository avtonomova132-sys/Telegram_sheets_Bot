// node --test feesKnown.test.js — без сети и Telegram.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.FEES_KNOWN_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fk-')), 'k.json');
process.env.FEES_WATCH_STATE_PATH = path.join(os.tmpdir(), 'unused-fees-state.json');
const known = require('./feesKnown'); const fw = require('./feesWatch');
const T = (n) => known.classify(n).type;

test('обязательные молчат', () => {
  for (const n of ['Вознаграждение за продажу', 'Возврат вознаграждения', 'Логистика', 'Доставка до места выдачи', 'Обратная логистика', 'Эквайринг',
    'Обработка отправления Drop-off партнёрами (ПВЗ)', 'Упаковка товара партнёрами', 'Обработка возвратов, отмен и невыкупов партнёрами', 'Выручка', 'Баллы за скидки',
    'Программы партнёров', 'Возврат выручки', 'Обеспечение материалами для упаковки товара', 'Размещение товаров на складах', 'Хранение', 'Утилизация товара',
    'Утилизирован Ozon', 'POSTING', 'Корректировка начислений', 'Отмена начисления']) assert.equal(T(n), 'mandatory', n);
});
test('платные известные', () => {
  for (const n of ['Premium Lite', 'AnalyticsLite', 'Подписка Premium Lite (AnalyticsLite)', 'Продвижение бренда', 'Продвижение брендов', 'Подписка «Управление отзывами»']) assert.equal(T(n), 'paid', n);
});
test('всегда сообщать / неизвестное', () => {
  for (const n of ['Звёздные товары', 'Premium', 'Premium Plus', 'Подписка Pro', 'Оплата за клик', 'Оплата за заказ', 'Платное размещение товара', 'Подписка Аналитика']) assert.equal(T(n), 'always', n);
  assert.equal(T('Какая-то новая услуга'), 'unknown');
});
test('команда /озон_знаю: добавить, переопределить «всегда», убрать', () => {
  assert.equal(T('Новая услуга X'), 'unknown');
  known.add('Новая услуга X'); assert.equal(T('новая услуга x за период'), 'mandatory');
  known.add('Звёздные товары', 'mandatory'); assert.equal(T('Звёздные товары'), 'mandatory');
  assert.equal(known.remove('Звёздные товары'), true); assert.equal(T('Звёздные товары'), 'always');
  assert.equal(known.add('ab'), null);
});

const op = (name, amount, day) => ({ name, amount, day });
test('evaluate: обязательное молчит, неизвестное и «всегда» — сообщение, повтор того же дня — нет', () => {
  const ops = [op('Логистика', -500, '2026-11-18'), op('Вознаграждение за продажу', -900, '2026-11-18'), op('Звёздные товары', -120, '2026-11-17'), op('Странный сбор', -40, '2026-11-18')];
  const r = fw.evaluate(ops, {}, '2026-11-18', known);
  assert.deepEqual(r.alerts.map((a) => [a.name, a.type]).sort(), [['Звёздные товары', 'always'], ['Странный сбор', 'unknown']]);
  assert.equal(fw.evaluate(ops, r.patch, '2026-11-18', known).alerts.length, 0);
  assert.equal(fw.evaluate([op('Странный сбор', -40, '2026-11-19')], r.patch, '2026-11-19', known).alerts.length, 1); // новый день = новое списание
});
test('evaluate: известное платное в норме молчит, рост >30% — сообщает один раз в месяц', () => {
  let st = {}; let r;
  // месячная подписка 17.11 — первый раз, сравнивать не с чем
  r = fw.evaluate([op('Premium Lite', -4990, '2026-11-17')], st, '2026-11-17', known); assert.equal(r.alerts.length, 0); st = r.patch;
  // 17.12 тот же размер — тишина
  r = fw.evaluate([op('Premium Lite', -4990, '2026-12-17')], st, '2026-12-17', known); assert.equal(r.alerts.length, 0); st = r.patch;
  // 17.01 подорожала до 7000 — сообщение
  r = fw.evaluate([op('Premium Lite', -7000, '2027-01-17')], st, '2027-01-17', known);
  assert.equal(r.alerts.length, 1); assert.equal(r.alerts[0].type, 'growth'); assert.equal(r.alerts[0].pct, 40);
  assert.equal(fw.evaluate([op('Premium Lite', -7000, '2027-01-17')], r.patch, '2027-01-18', known).alerts.length, 0);
  // ежедневное начисление: +10% — тишина, +60% — сообщение
  let h = {}; const d = ['2026-11-12', '2026-11-13', '2026-11-14']; const e = ['2026-11-15', '2026-11-16', '2026-11-17'];
  r = fw.evaluate(d.map((x) => op('Продвижение бренда', -100, x)).concat(e.map((x) => op('Продвижение бренда', -110, x))), {}, '2026-11-17', known); assert.equal(r.alerts.length, 0);
  r = fw.evaluate(d.map((x) => op('Продвижение бренда', -100, x)).concat(e.map((x) => op('Продвижение бренда', -160, x))), {}, '2026-11-17', known); assert.equal(r.alerts.length, 1);
});
test('формат сообщения: название, сумма, дата, одна строка вердикта, без инструкций', () => {
  const alerts = fw.evaluate([op('Звёздные товары', -120, '2026-11-17'), op('Странный сбор', -40, '2026-11-18')], {}, '2026-11-18', known).alerts;
  const t = fw.formatAlerts(alerts);
  assert.match(t, /^🛍️ 💸 Ozon: в списаниях за последние 3 дн\./);
  assert.match(t, /• Звёздные товары — -?120 ₽, 17\.11\n {3}💸 можно отключить/);
  assert.match(t, /• Странный сбор — -?40 ₽, 18\.11\n {3}❓ не знаю этот вид/);
  assert.ok(!/Как отключить|Витрина услуг|seller\.ozon/.test(t));
});
test('месячный итог: раз в месяц, только если были платные', () => {
  const st = { hist: { 'Premium Lite': { '2026-11-17': -4990 } } };
  const d1 = fw.monthlyDigest(st, '2026-12-01', known); assert.match(d1.text, /итог платных услуг за 11\.2026[\s\S]*Premium Lite — 4\s990 ₽/);
  assert.equal(fw.monthlyDigest({ ...st, ...d1.patch }, '2026-12-02', known).text, null);
  assert.equal(fw.monthlyDigest({}, '2026-12-01', known).text, null);
});
test('длинный список режется, ≤ 25 строк + «и ещё»', () => {
  const ops = Array.from({ length: 30 }, (_, i) => op(`Услуга ${i}`, -1, '2026-11-18'));
  const t = fw.formatAlerts(fw.evaluate(ops, {}, '2026-11-18', known).alerts);
  assert.match(t, /…и ещё 5/);
});
