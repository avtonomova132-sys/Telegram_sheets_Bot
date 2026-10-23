// Запуск: node --test prihod/test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildFamilies, distribute, parseWeightG } = require('./family');
const { computePlan } = require('./plan');
const { fillTemplate, verifyFilled, validateTemplate, STORE_CELL } = require('./xlsxFill');
const { candidatesFor } = require('./match');
const { prepareLine } = require('./recognize');
const { buildReport } = require('./flow');
const nameMap = require('./nameMap');

const catalog = [
  { article: '200КОМамаПриехала1ШТ', name: 'Конфеты Мама приехала 200 г 1 шт' },
  { article: '200КОМамаПриехала2ШТ', name: 'Конфеты Мама приехала 200 г 2 шт' },
  { article: '200КОМамаПриехала5ШТ', name: 'Конфеты Мама приехала 200 г 5 шт' },
  { article: '200КОМамаПриехала10ШТ', name: 'Конфеты Мама приехала 200 г 10 шт' },
  { article: '1КгМамаПриехала1ШТ', name: 'Конфеты Мама приехала 1 кг' },
  { article: '150УкралиСахар_1шт', name: 'Украли сахар 150 г 1 шт' },
  { article: '150УкралиСахарЛайм_1шт', name: 'Украли сахар с лаймом 150 г 1 шт' },
  { article: '250КАРАМЕЛЬ_Лимончики_1шт', name: 'Карамель Рот Фронт Лимончики 250 г' },
  { article: '250КАРАМЕЛЬ_Лимончики_2шт', name: 'Карамель Рот Фронт Лимончики 250 г' },
  { article: '250ЛимоннаяКарамель1ШТ', name: 'Лимонная карамель 250 г' },
  { article: '250ЛимоннаяКарамель3ШТ', name: 'Лимонная карамель 250 г' },
];

test('вес', () => {
  assert.strictEqual(parseWeightG('конфеты 200 г 5 шт'), 200);
  assert.strictEqual(parseWeightG('1 кг'), 1000);
});

test('Мама приехала 200 г, пришло 110 шт → 1шт=110, 2шт=55, 5шт=22, 10шт=11', () => {
  const { families } = buildFamilies(catalog);
  const fam = families.find((f) => f.weightG === 200);
  assert.strictEqual(fam.members.length, 4);
  assert.strictEqual(fam.base, '200КОМамаПриехала');
  const d = distribute(fam, 110);
  assert.deepStrictEqual(d.map((x) => [x.pieces, x.qty, x.remainder]), [[1, 110, 0], [2, 55, 0], [5, 22, 0], [10, 11, 0]]);
  // 1 кг — другая семья, количество на неё не переносится
  assert.strictEqual(families.filter((f) => f.stem.includes('мамаприехала')).length, 2);
  const plan = computePlan([{ n: 1, name: 'Мама приехала', qty: 110, sum: 1100, decision: { status: 'matched', family: fam } }], 1100);
  assert.deepStrictEqual(plan.items.map((i) => i.qty), [110, 55, 22, 11]);
  assert.ok(plan.check.ok);
});

test('остатки от деления и нулевые наборы', () => {
  const { families } = buildFamilies(catalog);
  const fam = families.find((f) => f.weightG === 200);
  const plan = computePlan([{ n: 1, qty: 7, sum: 70, decision: { status: 'matched', family: fam } }], 70);
  assert.deepStrictEqual(plan.items.map((i) => i.qty), [7, 3, 1]);
  assert.deepStrictEqual(plan.zeroSets.map((z) => z.pieces), [10]);
  assert.deepStrictEqual(plan.remainders.map((r) => [r.pieces, r.remainder]), [[2, 1], [5, 2], [10, 7]]);
});

test('сверка с Итого блокирует', () => {
  const plan = computePlan([{ n: 1, qty: 1, sum: 100, decision: { status: 'none' } }], 250);
  assert.strictEqual(plan.check.ok, false);
  assert.strictEqual(plan.notInOzon.length, 1);
});

test('кандидаты: «Украли сахар» ≠ «с лаймом», вес 1 кг не подходит к 200 г', () => {
  const { families } = buildFamilies(catalog);
  const a = candidatesFor({ name: 'Украли сахар', unitWeightG: 150 }, families);
  assert.ok(a.length && a.every((f) => !f.stem.includes('лайм')));
  const b = candidatesFor({ name: 'Украли сахар с лаймом', unitWeightG: 150 }, families);
  assert.ok(b.length && b.every((f) => f.stem.includes('лайм')));
  const c = candidatesFor({ name: 'Мама приехала', unitWeightG: 250 }, families);
  assert.strictEqual(c.length, 0);
});

test('пакеты Альянс Хим ×100 и проверка кол-во×цена', () => {
  const l = prepareLine({ n: 1, name: 'Пакет', qty: 3, price: 10, sum: 30, sterilization_pack: true });
  assert.strictEqual(l.qty, 300);
  assert.deepStrictEqual(l.flags, []);
  const bad = prepareLine({ n: 2, name: 'X', qty: 3, price: 10, sum: 99 });
  assert.strictEqual(bad.flags.length, 1);
});

test('xlsx: шапка цела, данные записаны, openpyxl и LibreOffice читают', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prh-'));
  const tpl = path.join(dir, 'tpl.xlsx');
  const py = `
import openpyxl
wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Остатки товаров'
ws['A1'] = 'Шаблон для обновления остатков'; ws['A2'] = 'Склад'; ws['B2']='Артикул'; ws['C2']='Название'; ws['D2']='Количество'
ws['A3'] = 'подсказка'
ws['A4'] = 'старый'; ws['B4'] = 'OLD'; ws['D4'] = 5
wb.create_sheet('Другой')
wb.save(r'${tpl}')`;
  require('child_process').execFileSync('python3', ['-c', py]);
  const tbuf = fs.readFileSync(tpl);
  validateTemplate(tbuf);
  const items = [{ article: 'Арт_1шт', qty: 110 }, { article: 'A&B <2шт>', qty: 55 }];
  const out = fillTemplate(tbuf, items);
  verifyFilled(tbuf, out, items);
  const f = path.join(dir, 'out.xlsx');
  fs.writeFileSync(f, out);
  const res = require('child_process').execFileSync('python3', ['-c', `
import openpyxl
ws = openpyxl.load_workbook(r'${f}')['Остатки товаров']
print([[c.value for c in r] for r in ws.iter_rows(min_row=1,max_row=6,max_col=4)])`]).toString();
  assert.ok(res.includes('Шаблон для обновления остатков'));
  assert.ok(res.includes(STORE_CELL) && res.includes('A&B <2шт>') && !res.includes('OLD'));
  require('child_process').execFileSync('soffice', ['--headless', '--convert-to', 'csv', '--outdir', dir, f], { stdio: 'ignore' });
  const csv = fs.readFileSync(path.join(dir, 'out.csv'), 'utf8');
  assert.ok(csv.includes('Арт_1шт') && csv.includes('110'));
});

test('экран проверки = строки xlsx, без шума', () => {
  const { families } = buildFamilies(catalog);
  const fam = families.find((f) => f.weightG === 200);
  const lines = [
    { n: 1, name: 'Мама приехала', qty: 112, sum: 1000, flags: ['кол-во×цена ≠ сумма'], decision: { status: 'matched', family: fam } },
    { n: 2, name: 'Новинка', qty: 3, sum: 50, flags: ['вес ≠ нетто'], decision: { status: 'none' } },
  ];
  const { text, plan } = buildReport({ lines, printedTotal: 1050 });
  assert.ok(!text.includes('⚠️ кол-во') && !text.includes('нетто') && !text.includes('склад'));
  const shown = [...text.matchAll(/^(\S+) — (\d+)$/gm)].map((m) => [m[1], Number(m[2])]);
  assert.deepStrictEqual(shown, plan.items.map((i) => [i.article, i.qty]));
  assert.deepStrictEqual(shown, [['200КОМамаПриехала1ШТ', 112], ['200КОМамаПриехала2ШТ', 56], ['200КОМамаПриехала5ШТ', 22], ['200КОМамаПриехала10ШТ', 11]]);
  assert.ok(text.includes('Сумма строк = Итого накладной ✅'));
  assert.ok(text.includes('Остаток от деления:') && text.includes('200КОМамаПриехала5ШТ — 2 шт'));
  assert.ok(buildReport({ lines, printedTotal: 999 }).text.includes('⚠️ не сходится: у нас 1050.00, в накладной 999.00'));
});

test('Лимончики и Лимонная: оба кандидата, вес 1/250 фильтрует, словарь учится', () => {
  const { families } = buildFamilies(catalog);
  const line = prepareLine({ n: 1, name: 'КАРАМЕЛЬ Лимонная фас_1/250', qty: 20, price: 10, sum: 200 });
  assert.strictEqual(line.unitWeightG, 250);
  const c = candidatesFor(line, families);
  assert.ok(c.some((f) => f.base === '250ЛимоннаяКарамель'));
  const lim = candidatesFor({ name: 'КАРАМЕЛЬ Лимончики фас_1/250', unitWeightG: 250 }, families);
  assert.ok(lim.every((f) => !f.stem.includes('лимоннаякарамель')) && lim.some((f) => f.base === '250КАРАМЕЛЬ_Лимончики'));
  assert.strictEqual(candidatesFor({ name: 'КАРАМЕЛЬ Лимонная', unitWeightG: 500 }, families).length, 0);
});

test('словарь: сохраняет выбор Елены и «Нет в Озоне»', async () => {
  const { matchLines } = require('./match');
  const { families } = buildFamilies(catalog);
  const f = families.find((x) => x.base === '250ЛимоннаяКарамель');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'map-'));
  process.env.PRIHOD_NAME_MAP_PATH = path.join(dir, 'm.json');
  delete require.cache[require.resolve('./nameMap')];
  delete require.cache[require.resolve('./match')];
  const nm = require('./nameMap');
  nm.remember('КАРАМЕЛЬ Лимонная фас_1/250', f);
  nm.rememberNone('Эвкалипт-ментол леденцы', families.length);
  const { matchLines: ml } = require('./match');
  const r = await ml([
    { name: 'КАРАМЕЛЬ Лимонная фас_1/250', unitWeightG: 250 },
    { name: 'Эвкалипт-ментол леденцы', unitWeightG: 100 },
    { name: 'Карамель Лимончики 1/250', unitWeightG: 250 },
  ], families);
  assert.strictEqual(r[0].status, 'matched');
  assert.strictEqual(r[0].family.base, '250ЛимоннаяКарамель');
  assert.strictEqual(r[1].status, 'none');
  assert.strictEqual(r[2].status, 'matched');
  assert.strictEqual(r[2].family.base, '250КАРАМЕЛЬ_Лимончики');
});
