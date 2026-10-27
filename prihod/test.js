// Запуск: node --test prihod/test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildFamilies, distribute, parseWeightG, findFamilyByArticle } = require('./family');
const { computePlan, checkTotals } = require('./plan');
const { fillTemplate, verifyFilled, validateTemplate, STORE_CELL } = require('./xlsxFill');
const { candidatesFor } = require('./match');
const { prepareLine, arithmeticOk } = require('./recognize');
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
  assert.strictEqual(families.filter((f) => f.stems.join(' ').includes('мамаприехала')).length, 2);
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
  assert.ok(a.length && a.every((f) => !f.stems.join(' ').includes('лайм')));
  const b = candidatesFor({ name: 'Украли сахар с лаймом', unitWeightG: 150 }, families);
  assert.ok(b.length && b.every((f) => f.stems.join(' ').includes('лайм')));
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
  assert.ok(!text.includes('Остаток'));
  assert.ok(plan.remainders.some((r) => r.article === '200КОМамаПриехала5ШТ' && r.remainder === 2));
  assert.ok(buildReport({ lines, printedTotal: 999 }).text.includes('⚠️ не сходится: у нас 1050.00, в накладной 999.00'));
});

test('Лимончики и Лимонная: оба кандидата, вес 1/250 фильтрует, словарь учится', () => {
  const { families } = buildFamilies(catalog);
  const line = prepareLine({ n: 1, name: 'КАРАМЕЛЬ Лимонная фас_1/250', qty: 20, price: 10, sum: 200 });
  assert.strictEqual(line.unitWeightG, 250);
  const c = candidatesFor(line, families);
  assert.ok(c.some((f) => f.base === '250ЛимоннаяКарамель'));
  const lim = candidatesFor({ name: 'КАРАМЕЛЬ Лимончики фас_1/250', unitWeightG: 250 }, families);
  assert.ok(lim.every((f) => !f.stems.join(' ').includes('лимоннаякарамель')) && lim.some((f) => f.base === '250КАРАМЕЛЬ_Лимончики'));
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
  nm.rememberNone('Эвкалипт-ментол леденцы', []);
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

test('сверка: «Нет в Озоне» входит в сумму, файл по найденным не блокируется', () => {
  const { families } = buildFamilies(catalog);
  const fam = families.find((f) => f.weightG === 200);
  const lines = [
    { n: 1, name: 'Мама', qty: 10, sum: 700, decision: { status: 'matched', family: fam } },
    { n: 2, name: 'Нет такого', qty: 5, sum: 300, decision: { status: 'none' } },
  ];
  const plan = computePlan(lines, 1000);
  assert.ok(plan.check.ok);
  assert.strictEqual(plan.items.length, 4);
  assert.strictEqual(plan.notInOzon.length, 1);
  const bad = computePlan(lines, 700);
  assert.ok(!bad.check.ok && bad.check.reason.includes('Нет в Озоне'));
});

test('сверка в базе без НДС и арифметика строки с НДС', () => {
  const lines = [{ n: 1, sum: 120, sumNoVat: 100 }, { n: 2, sum: 60, sumNoVat: 50 }];
  assert.ok(checkTotals(lines, 999, 150).ok);
  assert.ok(checkTotals(lines, 180, null).ok);
  assert.ok(!checkTotals(lines, 170, null).ok);
  assert.ok(arithmeticOk(60, 10, 720, null)); // 600 × 1,2
  assert.ok(!arithmeticOk(70, 10, 720, null)); // 700 ≠ 600/720
  assert.ok(arithmeticOk(60, 10, null, 600));
});

test('семья целиком даже если вес в артикуле записан не у всех', () => {
  const cat = [
    { article: '200КарамельЭвкалиптМентол1ШТ', name: 'Карамель Эвкалипт-ментол 200 г' },
    { article: 'КарамельЭвкалиптМентол2ШТ', name: 'Карамель Эвкалипт-ментол 200 г 2 шт' },
    { article: '200КарамельЭвкалиптМентол4ШТ', name: 'Карамель Эвкалипт-ментол 200 г 4 шт' },
    { article: '200КарамельЭвкалиптМентол8ШТ', name: 'Карамель Эвкалипт-ментол 200 г 8 шт' },
    { article: '500КарамельЭвкалиптМентол1ШТ', name: 'Карамель Эвкалипт-ментол 500 г' },
  ];
  const { families } = buildFamilies(cat);
  const f200 = families.find((f) => f.weightG === 200);
  assert.deepStrictEqual(f200.members.map((m) => m.pieces), [1, 2, 4, 8]);
  assert.strictEqual(families.find((f) => f.weightG === 500).members.length, 1);
  assert.strictEqual(findFamilyByArticle(families, '200карамельэвкалиптментол4шт'), f200);
  assert.strictEqual(findFamilyByArticle(families, 'нет такого'), null);
});

test('латиница Neo-botanica находит «Необотаника» в каталоге', () => {
  const cat = [
    { article: '200Необотаника_Натура_ЧёрнаяСмородина1ШТ', name: 'Мармелад Необотаника NATURA с чёрной смородиной и семенами чиа 200 г' },
    { article: '200Необотаника_Натура_ЧёрнаяСмородина2ШТ', name: 'Мармелад Необотаника NATURA с чёрной смородиной и семенами чиа 200 г' },
  ];
  const { families } = buildFamilies(cat);
  const c = candidatesFor({ name: 'МАРМЕЛАД Neo-botanica NATURA с чёрной смородиной и семенами чиа (1/200)', unitWeightG: 200 }, families);
  assert.strictEqual(c.length, 1);
});

// ---- реальные артикулы Елены: число штук — просто цифра в конце, без «ШТ»
const realCatalog = [
  ...[1, 2, 4, 8].map((n) => ({ article: `200КарамельЭквалиптМентол${n}`, name: `Карамель Эвкалипт-ментол 200 г ${n} шт` })),
  ...[1, 10].map((n) => ({ article: `350ГрЛюбимыеКонфета${n}`, name: `Н.П. Любимые с детства конфета 350 г ${n} шт` })),
  ...[1, 2, 4].map((n) => ({ article: `Маска300СВафлями${n}`, name: `Маска для лица с вафлями ${n} шт` })), // размеры Маски — условные
];

test('число штук в конце артикула без «ШТ»: семьи собираются целиком', () => {
  const { families } = buildFamilies(realCatalog);
  const by = (b) => families.find((f) => f.base === b);
  assert.deepStrictEqual(by('200КарамельЭквалиптМентол').members.map((m) => m.pieces), [1, 2, 4, 8]);
  assert.deepStrictEqual(by('350ГрЛюбимыеКонфета').members.map((m) => m.pieces), [1, 10]);
  assert.deepStrictEqual(by('Маска300СВафлями').members.map((m) => m.pieces), [1, 2, 4]);
  assert.strictEqual(by('Маска300СВафлями').weightG, 300);
  assert.strictEqual(by('350ГрЛюбимыеКонфета').weightG, 350);
});

test('разнос: Эвкалипт 80, Любимые 40, Маска 16', () => {
  const { families } = buildFamilies(realCatalog);
  const by = (b) => families.find((f) => f.base === b);
  const mk = (n, name, qty, b) => ({ n, name, qty, sum: 100, decision: { status: 'matched', family: by(b) } });
  const plan = computePlan([
    mk(1, 'Эвкалипт-ментол', 80, '200КарамельЭквалиптМентол'),
    mk(2, 'Любимые с детства', 40, '350ГрЛюбимыеКонфета'),
    mk(3, 'Маска с вафлями', 16, 'Маска300СВафлями'),
  ], 300);
  assert.ok(plan.check.ok);
  assert.deepStrictEqual(plan.items.map((i) => [i.article, i.qty]), [
    ['200КарамельЭквалиптМентол1', 80], ['200КарамельЭквалиптМентол2', 40], ['200КарамельЭквалиптМентол4', 20], ['200КарамельЭквалиптМентол8', 10],
    ['350ГрЛюбимыеКонфета1', 40], ['350ГрЛюбимыеКонфета10', 4],
    ['Маска300СВафлями1', 16], ['Маска300СВафлями2', 8], ['Маска300СВафлями4', 4],
  ]);
});

test('словарь: старая запись с одним артикулом мигрирует к основе, семья берётся из каталога', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  const file = path.join(dir, 'map.json');
  fs.writeFileSync(file, JSON.stringify({ entries: [
    { pattern: '^карамель эвкалипт ментол$', family: '200КарамельЭквалиптМентол1', exact: true, article: '200КарамельЭквалиптМентол1' },
    { pattern: '^карамель эвкалипт ментол$', family: '200КарамельЭквалиптМентол1', exact: true },
    { pattern: '^любимые с детства$', family: '350ГрЛюбимыеКонфета10', exact: true, weightG: 350 },
  ] }));
  process.env.PRIHOD_NAME_MAP_PATH = file;
  for (const m of ['./nameMap', './match']) delete require.cache[require.resolve(m)];
  const { matchLines } = require('./match');
  const { families } = buildFamilies(realCatalog);
  const r = await matchLines([{ name: 'Карамель Эвкалипт-ментол', unitWeightG: 200 }, { name: 'Любимые с детства', unitWeightG: 350 }], families);
  assert.deepStrictEqual(r[0].family.members.map((m) => m.pieces), [1, 2, 4, 8]);
  assert.deepStrictEqual(r[1].family.members.map((m) => m.pieces), [1, 10]);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(saved.version, 2);
  assert.strictEqual(saved.entries.length, 2);
  assert.deepStrictEqual(saved.entries.map((e) => e.family), ['200КарамельЭквалиптМентол', '350ГрЛюбимыеКонфета']);
  assert.ok(saved.entries.every((e) => !('article' in e)));
});

test('Маска: словарь потерян/устарел — семья всё равно находится из каталога', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mask-'));
  const file = path.join(dir, 'map.json');
  // старые записи: «Нет в Озоне» из эпохи сломанного разбора и запись с мусорной основой
  fs.writeFileSync(file, JSON.stringify({ entries: [
    { pattern: '^конф кор маска с хрустящими вафлям и 1 300 нд и кп$', none: true, recheck: true, familyCount: 999 },
    { pattern: '^какой то товар$', family: 'НетТакойОсновы', exact: true },
  ] }));
  process.env.PRIHOD_NAME_MAP_PATH = file;
  for (const m of ['./nameMap', './match']) delete require.cache[require.resolve(m)];
  const { matchLines } = require('./match');
  const { families } = buildFamilies(realCatalog);
  const lines = [
    { name: 'КОНФ КОР Маска с хрустящими вафлям и 1/300 НД и КП', unitWeightG: 300 },
    { name: 'КОНФ.КОР Маска с хрустящими вафлями 1/300', unitWeightG: 300 }, // другое чтение того же названия
    { name: 'Какой-то товар', unitWeightG: null },
  ];
  const r = await matchLines(lines, families);
  assert.strictEqual(r[0].status, 'ambiguous'); // старое «Нет» переспрашивается кнопкой
  assert.strictEqual(r[0].options[0].base, 'Маска300СВафлями');
  assert.strictEqual(r[1].status, 'matched'); // начальная запись словаря
  assert.deepStrictEqual(r[1].family.members.map((m) => m.pieces), [1, 2, 4]);
  assert.notStrictEqual(r[2].status, 'matched');
  const nm = require('./nameMap');
  nm.remember('КОНФ КОР Маска с хрустящими вафлям и 1/300 НД и КП', r[1].family);
  const r2 = await matchLines([{ name: 'КОНФ КОР Маска с хрустящими вафлями и 1/300 НД и КП', unitWeightG: 300 }], families);
  assert.strictEqual(r2[0].status, 'matched');
});

// ---- /остатки
const ost = require('./ostatki');
const ostCatalog = [
  ...[1, 2, 10].map((n) => ({ article: `Бирка50Петелька${n}ШТ`, name: 'Бирки с петелькой' })),
  ...[1, 5].map((n) => ({ article: `Бирка100Петелька${n}ШТ`, name: 'Бирки с петелькой большие' })),
  { article: '200КарамельЭквалиптМентол1', name: 'Карамель Эвкалипт-ментол 200 г' },
];

test('/остатки: диапазон и количество', () => {
  assert.deepStrictEqual(ost.parseRange('200-260 бирки петельки'), { from: 200, to: 260, hint: 'бирки петельки' });
  assert.deepStrictEqual(ost.parseRange('200–260'), { from: 200, to: 260, hint: '' });
  assert.strictEqual(ost.parseRange('260-200'), null);
  assert.strictEqual(ost.parseRange('abc'), null);
  assert.strictEqual(ost.parseQty('').state, 'empty');
  assert.strictEqual(ost.parseQty('  ').state, 'empty');
  assert.deepStrictEqual(ost.parseQty('0'), { state: 'ok', value: 0 });
  assert.deepStrictEqual(ost.parseQty('1 200'), { state: 'ok', value: 1200 });
  assert.strictEqual(ost.parseQty('нет').state, 'bad');
});

test('/остатки: пустая G = 0, число в «1 шт» разносится, нули идут в файл', () => {
  const { families } = buildFamilies(ostCatalog);
  const rows = [
    { row: 200, article: 'Бирка50Петелька1ШТ', qtyRaw: '40' },
    { row: 201, article: 'Бирка50Петелька2ШТ', qtyRaw: '' },
    { row: 202, article: 'Бирка50Петелька10ШТ', qtyRaw: '' },
    { row: 203, article: 'Бирка100Петелька1ШТ', qtyRaw: '' }, // пусто → 0
    { row: 204, article: 'Бирка100Петелька5ШТ', qtyRaw: '' },
    { row: 205, article: '200КарамельЭквалиптМентол1', qtyRaw: '0' },
    { row: 206, article: 'НетТакого1ШТ', qtyRaw: '7' },
  ];
  const plan = ost.buildPlan(rows, ostCatalog, families);
  assert.deepStrictEqual(plan.items.map((i) => [i.article, i.qty]), [
    ['Бирка50Петелька1ШТ', 40], ['Бирка50Петелька2ШТ', 20], ['Бирка50Петелька10ШТ', 4],
    ['Бирка100Петелька1ШТ', 0], ['Бирка100Петелька5ШТ', 0], ['200КарамельЭквалиптМентол1', 0],
  ]);
  assert.strictEqual(plan.notInOzon.length, 1);
  const text = ost.buildText({ from: 200, to: 206, hint: '', rows, products: ostCatalog, plan });
  const lines = text.split('\n');
  assert.strictEqual(lines[0], '⚠️ В диапазоне много пустых: проверь номера строк'); // 2 из 3 семей нулевые
  assert.strictEqual(lines[1], '☑️ Проверка склада: строки 200–206, 7 артикулов (с остатком: 3, обнулить: 3)');
  assert.ok(text.includes('П200 Бирка50Петелька1ШТ — 40\nП201 Бирка50Петелька2ШТ — 20\nП202 Бирка50Петелька10ШТ — 4\n\nП203 Бирка100Петелька1ШТ — 0'));
  assert.ok(text.includes('Нет в Озоне:\nП206 НетТакого1ШТ'));
  assert.ok(!/Не пересчитано|Диапазон|Бирки с петелькой|📋/.test(text));
});

test('/остатки: больше половины пустых семей — предупреждение первой строкой', () => {
  const cat = Array.from({ length: 4 }, (_, i) => ({ article: `Товар${i}Х1ШТ`, name: `Товар ${i}` }));
  const { families } = buildFamilies(cat);
  const rows = cat.map((p, i) => ({ row: 10 + i, article: p.article, qtyRaw: i === 0 ? '5' : '' }));
  const plan = ost.buildPlan(rows, cat, families);
  const text = ost.buildText({ from: 10, to: 13, hint: '', rows, products: cat, plan });
  assert.strictEqual(text.split('\n')[0], '⚠️ В диапазоне много пустых: проверь номера строк');
  assert.strictEqual(plan.items.length, 4);
});

test('/остатки: текст в G нулём не считается; конфликт; расчёт от набора; дубли', () => {
  const { families } = buildFamilies(ostCatalog);
  const bad = ost.buildPlan([
    { row: 5, article: 'Бирка50Петелька1ШТ', qtyRaw: 'вчера' }, { row: 6, article: 'Бирка50Петелька2ШТ', qtyRaw: '' },
  ], ostCatalog, families);
  assert.strictEqual(bad.bad.length, 1);
  assert.strictEqual(bad.items.length, 0); // семья ждёт ответа Елены
  const conflict = ost.buildPlan([
    { row: 3, article: 'Бирка50Петелька1ШТ', qtyRaw: '40' },
    { row: 4, article: 'Бирка50Петелька10ШТ', qtyRaw: '5' },
  ], ostCatalog, families);
  assert.strictEqual(conflict.conflicts.length, 1);
  assert.ok(conflict.conflicts[0].text.includes('П3: набор 1 шт = 40') && conflict.conflicts[0].text.includes('должно быть 4'));
  assert.strictEqual(conflict.items.length, 0);
  const derived = ost.buildPlan([{ row: 3, article: 'Бирка50Петелька10ШТ', qtyRaw: '4' }], ostCatalog, families);
  assert.deepStrictEqual(Object.fromEntries(derived.items.map((i) => [i.article, i.qty])), { Бирка50Петелька1ШТ: 40, Бирка50Петелька2ШТ: 20, Бирка50Петелька10ШТ: 4 });
  const dup = ost.buildPlan([
    { row: 3, article: 'Бирка50Петелька1ШТ', qtyRaw: '40' }, { row: 9, article: 'Бирка50Петелька1ШТ', qtyRaw: '41' },
  ], ostCatalog, families);
  assert.strictEqual(dup.conflicts.length, 1);
});

test('/остатки 1204-1268: 65 артикулов, 50 с остатком, 15 обнулить (имитация таблицы)', () => {
  const cat = []; const rows = []; let r = 1204;
  const fam = (base, sizes, total) => sizes.forEach((n, i) => {
    const article = `${base}${n}`;
    cat.push({ article, name: `${base} длинное название` });
    rows.push({ row: r, article, qtyRaw: i === 0 && total !== null ? String(total) : '' });
    r += 1;
  });
  const sizes3 = [1, 2, 4];
  ['1КгПраздничный', '1КгШоколадныйЗодиак', '1КгЗолотойВек'].forEach((b) => fam(b, sizes3, 100));            // 1204–1212
  fam('800ГрЗвездочетик', sizes3, null);                                                                        // 1213–1215 (пусто)
  for (let i = 0; i < 6; i += 1) fam(`Товар${i}Х`, sizes3, 60);                                                   // 1216–1233
  fam('550ЧудесныеМгновения', [1, 2], null); fam('624ГрСказочныйКарнавал', sizes3, null);                         // 1234–1238
  fam('310НовогоднийСувенир', [1, 2, 4, 8], null); fam('315ГрЗимнееУтро', sizes3, null);                        // 1239–1245
  for (let i = 0; i < 7; i += 1) fam(`Другой${i}Х`, sizes3, 80);                                                  // 1246–1266
  fam('ПоследнийТовар', [1, 2], 30);                                                                             // 1267–1268
  assert.strictEqual(r, 1269);
  const { families } = buildFamilies(cat);
  const plan = ost.buildPlan(rows, cat, families);
  assert.strictEqual(plan.articles, 65);
  assert.strictEqual(plan.withStock, 50);
  assert.strictEqual(plan.toZero, 15);
  assert.strictEqual(plan.items.length, 65);
  const text = ost.buildText({ from: 1204, to: 1268, hint: '', rows, products: cat, plan });
  assert.strictEqual(text.split('\n')[0], '☑️ Проверка склада: строки 1204–1268, 65 артикулов (с остатком: 50, обнулить: 15)');
  assert.ok(!text.includes('много пустых'));
  assert.ok(text.includes('П1213 800ГрЗвездочетик1 — 0') && text.includes('П1204 1КгПраздничный1 — 100\nП1205 1КгПраздничный2 — 50\nП1206 1КгПраздничный4 — 25'));
});

// ---- бирки: размер в начале артикула
const tagCatalog = [
  { article: '18162БЕЛЫЙ1000', name: 'Бирка садовая 18х162 мм белая 1000 шт' },
  { article: '18162БЕЛЫЙ2000', name: 'Бирка садовая 18х162 мм белая 2000 шт' },
  { article: '18162ЗЕЛЁНЫЙ1000', name: 'Бирка садовая 18х162 мм зелёная 1000 шт' },
  { article: '20162БЕЛЫЙ1000', name: 'Бирка садовая 20х162 мм белая 1000 шт' },
  { article: '13162БЕЛЫЙ1000', name: 'Бирка садовая 13х162 мм белая 1000 шт' },
];

test('бирки: размер ШxД → код, семьи разных размеров не склеиваются', () => {
  const { sizeCode, sizeCandidates } = require('./match');
  assert.strictEqual(sizeCode('Бирка садовая 18x162, белая'), '18162');
  assert.strictEqual(sizeCode('Бирка 20x162(70) белая'), '20162');
  assert.strictEqual(sizeCode('Бирка 13х162'), '13162'); // кириллическая «х»
  assert.strictEqual(sizeCode('Бирка 20x200'), '20200');
  assert.strictEqual(sizeCode('Набор 1x5'), null);
  const { families } = buildFamilies(tagCatalog);
  assert.strictEqual(families.length, 5);
  assert.ok(families.every((f) => f.weightG === null)); // 18162 — не вес
  const one = sizeCandidates({ name: 'Бирка садовая 18x162, белая, 1000 шт, вт. 40' }, families);
  assert.deepStrictEqual(one.list.map((f) => f.base), ['18162БЕЛЫЙ1000']);
  const two = sizeCandidates({ name: 'Бирка садовая 18x162' }, families);
  assert.strictEqual(two.list.length, 3); // цвет и упаковка не названы — решает Елена
});

test('бирки: единственный подходящий подставляется без вопроса', async () => {
  process.env.PRIHOD_NAME_MAP_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tag-')), 'm.json');
  for (const m of ['./nameMap', './match']) delete require.cache[require.resolve(m)];
  const { matchLines } = require('./match');
  const { families } = buildFamilies(tagCatalog);
  const r = await matchLines([{ name: 'Бирка садовая 18x162, белая, 1000 шт, вт. 40', unitWeightG: null }, { name: 'Бирка садовая 20x162(70) белая 1000 шт', unitWeightG: null }], families);
  assert.strictEqual(r[0].status, 'matched');
  assert.strictEqual(r[0].family.base, '18162БЕЛЫЙ1000');
  assert.strictEqual(r[1].family.base, '20162БЕЛЫЙ1000');
});

// ---- счёт № 56: «никогда не в Нет в Озоне сам», пометки, контроль полноты
const stakeCatalog = [
  { article: '9518КолышекЛента2000', name: 'Колышек в ленте 95х18 мм, рулон 2000 шт' },
  { article: '9518КолышекЛента1000', name: 'Колышек в ленте 95х18 мм, рулон 1000 шт' },
  { article: '12040ПлёнкаРулон', name: 'Плёнка рулон' },
];

test('строка без уверенного совпадения становится вопросом с кандидатами, а не «Нет в Озоне»', async () => {
  const { looseCandidates } = require('./match');
  const { applyResults, buildReport } = require('./flow');
  const { families } = buildFamilies(stakeCatalog);
  const line = { n: 1, name: 'Колышек в ленте, 95х18, 2000 шт. рул, вт.40', qty: 5, unitWeightG: null };
  const c = looseCandidates(line, families, 4);
  assert.ok(c.length >= 1 && c[0].base.startsWith('9518'));
  const lines = [{ ...line }, { n: 2, name: 'Совсем неизвестная вещь', qty: 1, unitWeightG: null }];
  applyResults(lines, [{ status: 'none', via: 'модель: нет' }, { status: 'none', via: 'нет кандидатов' }], families);
  assert.strictEqual(lines[0].decision, null);
  assert.strictEqual(lines[0].match.status, 'ambiguous');
  assert.ok(lines[0].match.fromNone && lines[0].match.options.length >= 1);
  assert.strictEqual(lines[1].decision, null); // даже без кандидатов — вопрос с кнопками «Ввести артикул» / «Нет в Озоне»
  // память Елены («Нет в Озоне» по кнопке) уважается
  const mem = [{ n: 3, name: 'x', qty: 1 }];
  applyResults(mem, [{ status: 'none', via: 'запомнено: нет в Озоне' }], families);
  assert.strictEqual(mem[0].decision.status, 'none');
});

test('пометки: «нет» и другое число; сверка по напечатанному; контроль полноты', () => {
  const { buildReport } = require('./flow');
  const { families } = buildFamilies(realCatalog);
  const fam = families.find((f) => f.base === '350ГрЛюбимыеКонфета');
  const lines = [
    { n: 1, name: 'Любимые', qty: 93, origQty: 100, sum: 1000, decision: { status: 'matched', family: fam }, arithmetic: true },
    { n: 2, name: 'Колышек', qty: 5, sum: 500, decision: { status: 'not_arrived' }, arithmetic: true },
    { n: 3, name: 'Нет в каталоге', qty: 2, sum: 100, decision: { status: 'none' }, arithmetic: true },
  ];
  const { text, plan } = buildReport({ lines, printedTotal: 1600 });
  assert.ok(plan.check.ok); // по напечатанным суммам
  assert.ok(text.includes('Не пришло по пометке:\n• Колышек — 5 шт'));
  assert.ok(text.includes('• Любимые: было 100 → стало 93 (по пометке)'));
  assert.ok(text.includes('Расхождение из-за пометок: 12 шт')); // 7 + 5
  assert.ok(!text.includes('✅'));
  assert.ok(!text.includes('Не обработано строк'));
  assert.deepStrictEqual(plan.items.slice(0, 1).map((i) => i.qty), [93]);
  // потерянная строка (нет решения) → предупреждение
  const lost = buildReport({ lines: [...lines, { n: 4, name: 'Потерянная', qty: 1, sum: 0, decision: null }], printedTotal: 1600 }).text;
  assert.ok(lost.startsWith('⚠️ Не обработано строк: 1\n• 4. Потерянная'));
  // без пометок — обычный ✅
  const plain = buildReport({ lines: [lines[2], { ...lines[0], origQty: undefined, qty: 100 }], printedTotal: 1100 }).text;
  assert.ok(plain.includes('Сумма строк = Итого накладной ✅'));
});

test('распознавание пометок: уверенное «нет», число, неуверенное → вопрос', () => {
  const a = prepareLine({ n: 1, name: 'А', qty: 100, price: 10, sum: 1000, handwritten: { kind: 'not_arrived', text: 'нет', confident: true } });
  assert.deepStrictEqual([a.mark.kind, a.mark.pending, a.qty], ['not_arrived', false, 100]);
  const b = prepareLine({ n: 2, name: 'Б', qty: 100, price: 10, sum: 1000, handwritten: { kind: 'qty_changed', qty: 93, text: '93 шт', confident: true } });
  assert.deepStrictEqual([b.mark.kind, b.mark.qty, b.mark.pending], ['qty_changed', 93, false]);
  const c = prepareLine({ n: 3, name: 'В', qty: 100, price: 10, sum: 1000, handwritten: { kind: 'qty_changed', qty: 93, confident: false } });
  assert.strictEqual(c.mark.pending, true);
  const d = prepareLine({ n: 4, name: 'Г', qty: 100, price: 10, sum: 1000, handwritten: { kind: 'qty_changed', qty: null } });
  assert.deepStrictEqual([d.mark.kind, d.mark.pending], ['unclear', true]);
  assert.strictEqual(prepareLine({ n: 5, name: 'Д', qty: 1, price: 1, sum: 1 }).mark, null);
});

// ---------- поиск по артикулу поставщика (Номенклатура, AB) ----------
const supplier = require('./supplier');
const { matchLines } = require('./match');

test('код поставщика: начало «две буквы + пять цифр», латиница → кириллица', () => {
  assert.strictEqual(supplier.supplierKey('РФ25204D108'), 'РФ25204');
  assert.strictEqual(supplier.supplierKey('КО19986R113'), 'КО19986');
  assert.strictEqual(supplier.supplierKey('KO19986R113'), 'КО19986'); // латинские K, O
  assert.strictEqual(supplier.supplierKey(' ББ 12694 K562'), 'ББ12694');
  assert.strictEqual(supplier.supplierKey('Педикюрная терка MANITA 60/120'), null);
  assert.strictEqual(supplier.supplierKey(''), null);
});

test('поиск по коду поставщика: семья из AB, вес и каталог Озона сверяются', async () => {
  const cat = [
    ...[1, 2, 4, 6, 10].map((k) => ({ article: `150NeoBotanikaСмузиЧерникаБанан${k}ШТ`, name: 'Мармелад 150 г' })),
    ...[1, 2, 3, 5, 10].map((k) => ({ article: `200DarkCreamТемныйШоколадМиндальФундук${k}шт`, name: 'Dark Cream 200 г' })),
    ...[1, 2, 3, 5, 10].map((k) => ({ article: `ЗЕЛБабаевскийDC${k}ШТ`, name: 'Бабаевский DC 200 г' })),
  ];
  const { families } = buildFamilies(cat);
  supplier._setIndex([
    ...[1, 2, 4, 6, 10].map((k) => ({ article: `150NeoBotanikaСмузиЧерникаБанан${k}ШТ`, barcode: '1', pieces: String(k), supplier: 'РФ25204' })),
    ...[1, 2, 3, 5, 10].map((k) => ({ article: `200DarkCreamТемныйШоколадМиндальФундук${k}шт`, barcode: '1', pieces: String(k), supplier: 'ББ12694' })),
    ...[1, 2, 3, 5, 10].map((k) => ({ article: `ЗЕЛБабаевскийDC${k}ШТ`, barcode: '1', pieces: String(k), supplier: 'ББ12692' })),
    { article: 'Крафт60100MANITA100ШТ', barcode: '', pieces: '1', supplier: 'Педикюрная терка MANITA' },
    { article: 'Пустой1шт', barcode: '', pieces: '1', supplier: '' },
  ]);
  const lines = [
    { name: 'КОНФ_ВЕС_Neo_botanica_СМУЗИ_Light_черника_банан_1/150', supplierCode: 'РФ25204D108', unitWeightG: 150 },
    { name: 'КОНФ_КОР_Бабаевские_Цел_фунд_и_орех_крем_Dark_cream_1/200', supplierCode: 'ББ12692К501', unitWeightG: 200 },
    { name: 'КОНФ_КОР_Бабаевские_Дробл_мина_Dark_cream_collection_1/200', supplierCode: 'ББ12694K562', unitWeightG: 200 },
  ];
  const res = await matchLines(lines, families);
  assert.strictEqual(res[0].status, 'matched');
  assert.strictEqual(res[0].family.base, '150NeoBotanikaСмузиЧерникаБанан');
  assert.match(res[0].via, /код поставщика РФ25204/);
  assert.strictEqual(res[1].family.base, 'ЗЕЛБабаевскийDC');
  assert.strictEqual(res[2].family.base, '200DarkCreamТемныйШоколадМиндальФундук');
  const st = await supplier.coverage.call(null).catch(() => null); // без доступа к таблице — не падаем
  assert.ok(st === null || typeof st.total === 'number');
});

test('код не найден в AB → поиск по названию как раньше; вес отсекает чужой вес того же кода', async () => {
  const cat = [
    { article: '250ТестКонфета1шт', name: 'Тест 250 г' },
    { article: '1КгТестКонфета1шт', name: 'Тест 1 кг' },
  ];
  const { families } = buildFamilies(cat);
  supplier._setIndex([
    { article: '250ТестКонфета1шт', barcode: '1', pieces: '1', supplier: 'РФ11111' },
    { article: '1КгТестКонфета1шт', barcode: '1', pieces: '1', supplier: 'РФ11111' },
  ]);
  const res = await matchLines([
    { name: 'Тестовая конфета 1/250', supplierCode: 'РФ11111A101', unitWeightG: 250 },
    { name: 'Тестовая конфета 1/1000', supplierCode: 'РФ11111A101', unitWeightG: 1000 },
    { name: 'Неизвестная 1/250', supplierCode: 'РФ99999A101', unitWeightG: 250 },
  ], families);
  assert.strictEqual(res[0].family.weightG, 250);
  assert.strictEqual(res[1].family.weightG, 1000);
  assert.notStrictEqual(res[2].via && res[2].via.startsWith('код поставщика'), true);
});

test('prepareLine переносит код поставщика', () => {
  const l = prepareLine({ n: 1, name: 'X', qty: 3, supplier_code: 'РФ25204D108' });
  assert.strictEqual(l.supplierCode, 'РФ25204D108');
});

test('AB с названием поставщика (бирки/крафт): совпадение по названию строки накладной', async () => {
  const cat = ['18162БЕЛЫЙ1000', '20162БЕЛЫЙ1000', '20162МЕТКАБЕЛЫЙ1000', '13162БиркаСадовая2000шт'].map((a) => ({ article: a, name: 'Бирка садовая' }));
  const { families } = buildFamilies(cat);
  supplier._setIndex([
    { article: '18162БЕЛЫЙ1000', barcode: '1', pieces: '1', supplier: 'Бирка садовая 18х162, белая, 1000 шт, вт. 40' },
    { article: '20162БЕЛЫЙ1000', barcode: '1', pieces: '1', supplier: 'Бирка садовая 20х162(70), белая, 1000 шт, вт. 40' },
    { article: '20162МЕТКАБЕЛЫЙ1000', barcode: '1', pieces: '1', supplier: 'Бирка садовая 20х162(70), белая с меткой, 1000 шт, вт. 40' },
    { article: '13162БиркаСадовая2000шт', barcode: '1', pieces: '1', supplier: 'Бирка садовая 13х162, 2000 шт, рул.' },
  ]);
  const res = await matchLines([
    { name: 'Бирка садовая 18x162, белая, 1000 шт, вт. 40', supplierCode: '' },
    { name: 'Бирка садовая 20x162(70), белая с меткой, 1000 шт', supplierCode: '' },
    { name: 'Бирка садовая 13x162, 2000 шт, рул.', supplierCode: '' },
  ], families);
  assert.deepStrictEqual(res.map((r) => r.status), ['matched', 'matched', 'matched']);
  assert.strictEqual(res[0].family.members[0].article, '18162БЕЛЫЙ1000');
  assert.strictEqual(res[1].family.members[0].article, '20162МЕТКАБЕЛЫЙ1000');
  assert.strictEqual(res[2].family.members[0].article, '13162БиркаСадовая2000шт');
});

test('набор из 11 штук (Мама приехала 11ШТ, Мишка 11ШТ) входит в семью', () => {
  const cat = [1, 2, 4, 11].map((k) => ({ article: `200КОМамаПриехала${k}ШТ`, name: 'Мама приехала 200 г' }));
  const { families, skipped } = buildFamilies(cat);
  assert.strictEqual(skipped.length, 0);
  assert.deepStrictEqual(distribute(families[0], 110).map((x) => [x.pieces, x.qty]), [[1, 110], [2, 55], [4, 27], [11, 10]]);
});
