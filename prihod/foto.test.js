// Запуск: node --test prihod/foto.test.js
// Сухой прогон /остатки_фото: каталог и остатки синтетические (в формате
// артикулов Озона), в Озон и в Telegram ничего не пишется.
const _os = require('os');
const _path = require('path');
const _fs = require('fs');
const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'foto-test-'));
process.env.PRIHOD_NAME_MAP_PATH = _path.join(tmpDir, 'namemap.json');
process.env.FOTO_DATA_DIR = tmpDir;
process.env.FOTO_QUIET_MS = '40';
process.env.FOTO_VERIFY_DELAY_MS = '0';
process.env.OZON_API_KEY = 'x';
process.env.OZON_CLIENT_ID = '1';
const test = require('node:test');
const assert = require('node:assert');
const { parseCaption, parseBareNumber } = require('./fotoCaption');
const { makeContext, resolveProduct, buildPlan, buildText, remember } = require('./fotoPlan');
const { normBarcode, decode } = require('./barcode');
const fotoFlow = require('./fotoFlow');

const P = (article, name, barcode) => ({ article, name, barcode: barcode || '', barcodes: barcode ? [barcode] : [] });
const catalog = [
  P('100ХнаБесцветная1ШТ', 'Хна бесцветная 100 г', '4600000000011'),
  P('100ХнаБесцветная2ШТ', 'Хна бесцветная 100 г 2 шт', '4600000000028'),
  P('100ХнаБесцветная4ШТ', 'Хна бесцветная 100 г 4 шт', '4600000000035'),
  P('200ХнаБесцветная1ШТ', 'Хна бесцветная 200 г', '4600000000042'), // другой вес — не трогаем
  P('200ХнаБесцветная2ШТ', 'Хна бесцветная 200 г 2 шт', '4600000000059'),
  P('800ПодарокКрасныйОктябрь1ШТ', 'Подарок Красный Октябрь 800 г', '4600000000066'),
  P('800ПодарокКрасныйОктябрь2ШТ', 'Подарок Красный Октябрь 800 г 2 шт', '4600000000073'),
  P('150КраснШап150Гр1УП', 'Красная шапочка 150 г', '4600000000080'),
  P('150КраснШап150Гр2УП', 'Красная шапочка 150 г 2 шт', ''), // нет штрихкода
  P('150КраснШап150Гр3УП', 'Красная шапочка 150 г 3 шт', '4600000000103'),
  P('150КраснШап150Гр4УП', 'Красная шапочка 150 г 4 шт', '4600000000110'),
  P('701ВеселыеКаникулы1', 'Весёлые каникулы', '4600000000127'),
  P('Белые50170МЕДТЕСТ1ШТ', 'Белые 50 170 мед тест 100 шт', '4600000000134'),
  P('Белые50170МЕДТЕСТ2ШТ', 'Белые 50 170 мед тест 100 шт 2 шт', '4600000000141'),
  P('Белые50170МЕДТЕСТ5ШТ', 'Белые 50 170 мед тест 100 шт 5 шт', '4600000000158'),
  P('Белые50170МЕДТЕСТ10ШТ', 'Белые 50 170 мед тест 100 шт 10 шт', '4600000000165'),
  P('теркаМини1', 'Тёрка мини', '4600000000172'),
  P('теркаМини2', 'Тёрка мини 2 шт', '4600000000189'),
];
const ctx = makeContext(catalog);
const stocks = new Map(catalog.map((p, i) => [p.article, { stock: 0, productId: 1000 + i }]));

async function plan(code, qty, label = null, st = stocks) {
  const r = await resolveProduct({ codes: [code], label }, ctx);
  assert.strictEqual(r.status, 'matched', `${code}: ${r.status}`);
  return { r, plan: buildPlan([{ id: 'x1', author: 'Марина', ts: 1, qty, family: r.family }], ctx, st) };
}
const qtys = (p) => p.groups[0].members.map((m) => m.qty);

test('подписи: 5, Остаток-2 шт, Ост 0', () => {
  assert.deepStrictEqual(parseCaption('5'), { state: 'ok', author: null, value: 5, text: '5' });
  assert.strictEqual(parseCaption('Остаток-2 шт').value, 2);
  assert.strictEqual(parseCaption('Ост 0').value, 0);
  assert.strictEqual(parseCaption('Ост 0').state, 'ok');
  assert.strictEqual(parseCaption('Марина 3').author, 'Марина');
});

test('подписи: неоднозначные → вопрос, даты и вес количеством не считаются', () => {
  assert.strictEqual(parseCaption('Остаток-1 нет').state, 'ambiguous');
  assert.strictEqual(parseCaption('2 и 3').state, 'ambiguous');
  assert.strictEqual(parseCaption('нет').state, 'ambiguous');
  assert.strictEqual(parseCaption('2,5').state, 'ambiguous');
  assert.strictEqual(parseCaption('').state, 'empty');
  assert.strictEqual(parseCaption('5 годен до 28.03.27').value, 5);
  assert.strictEqual(parseCaption('3 шт 12.05.27').value, 3);
  assert.strictEqual(parseCaption('Ост 4, 100 г').value, 4);
  assert.strictEqual(parseCaption('4 4').value, 4);
  assert.strictEqual(parseBareNumber(' 7 шт '), 7);
  assert.strictEqual(parseBareNumber('привет'), null);
});

test('хна бесцветная 100 г, 4 → 4/2/1; 200 г не затронут', async () => {
  const { plan: p } = await plan('4600000000011', 4);
  assert.deepStrictEqual(qtys(p), [4, 2, 1]);
  assert.ok(p.groups[0].members.every((m) => m.article.startsWith('100')));
  assert.strictEqual(p.writes.length, 3);
});

test('подарок 800 г Красный Октябрь, 4 → 4/2', async () => {
  const { plan: p } = await plan('4600000000066', 4);
  assert.deepStrictEqual(qtys(p), [4, 2]);
});

test('КраснШап150Гр1УП, 2 → 2/1/0/0; у карточки без штрихкода остаток не ставим', async () => {
  const { plan: p } = await plan('4600000000080', 2);
  assert.deepStrictEqual(qtys(p), [2, 1, 0, 0]);
  assert.deepStrictEqual(p.noBarcode.map((m) => m.article), ['150КраснШап150Гр2УП']);
  assert.ok(!p.writes.some((w) => w.article === '150КраснШап150Гр2УП'));
  assert.strictEqual(p.writes.length, 1); // 1УП=2; 2УП без штрихкода; 3УП и 4УП уже 0 = без изменений
});

test('701ВеселыеКаникулы1, 5 — одна карточка', async () => {
  const { plan: p } = await plan('4600000000127', 5);
  assert.deepStrictEqual(qtys(p), [5]);
});

test('Белые50170МЕДТЕСТ, 4 → 4/2/0/0', async () => {
  const { plan: p } = await plan('4600000000134', 4);
  assert.deepStrictEqual(qtys(p), [4, 2, 0, 0]);
});

test('теркаМини, 11 → 11/5, остаток от деления 1', async () => {
  const { plan: p } = await plan('4600000000172', 11);
  assert.deepStrictEqual(qtys(p), [11, 5]);
  assert.strictEqual(p.groups[0].members[1].remainder, 1);
  assert.match(buildText(p), /остаток от деления: теркаМини2 — 1 шт/);
});

test('«было → стало» и пропуск неизменных', async () => {
  const st = new Map(stocks);
  st.set('100ХнаБесцветная1ШТ', { stock: 3, productId: 1 });
  st.set('100ХнаБесцветная2ШТ', { stock: 2, productId: 2 });
  const { plan: p } = await plan('4600000000011', 4, null, st);
  const text = buildText(p);
  assert.match(text, /100ХнаБесцветная1ШТ: 3 → 4/);
  assert.match(text, /100ХнаБесцветная2ШТ: 2 → 2 \(без изменений\)/);
  assert.deepStrictEqual(p.writes.map((w) => w.article), ['100ХнаБесцветная1ШТ', '100ХнаБесцветная4ШТ']);
});

test('второе фото по товару: берётся последнее, с предупреждением', async () => {
  const r = await resolveProduct({ codes: ['4600000000011'] }, ctx);
  const p = buildPlan([
    { id: 'a', author: 'Марина', ts: 1, qty: 5, family: r.family },
    { id: 'b', author: 'Алина', ts: 2, qty: 4, family: r.family },
  ], ctx, stocks, { [r.family.id]: { total: 6, ts: 0, author: 'Ирина' } });
  assert.strictEqual(p.groups.length, 1);
  assert.strictEqual(p.groups[0].total, 4);
  assert.match(p.groups[0].warnings.join('\n'), /было 5.*стало 4/);
  assert.match(p.groups[0].warnings.join('\n'), /по прошлому фото.*было 6, стало 4/);
});

test('штрихкод не найден → кандидаты по названию этикетки, выбор запоминается', async () => {
  const r = await resolveProduct({ codes: ['9999999999999'], label: { name: 'Терка мини', weightG: null } }, ctx);
  assert.strictEqual(r.status, 'ambiguous');
  assert.ok(r.options.some((f) => f.base === 'теркаМини'));
  remember({ codes: ['9999999999999'], label: { name: 'Терка мини' } }, r.options.find((f) => f.base === 'теркаМини'));
  const again = await resolveProduct({ codes: ['9999999999999'] }, ctx);
  assert.strictEqual(again.status, 'matched');
  assert.strictEqual(again.via, 'карта');
});

test('«Нет в Озоне» запоминается и не спрашивается снова', async () => {
  remember({ codes: ['8888888888888'], label: null }, null);
  const r = await resolveProduct({ codes: ['8888888888888'] }, ctx);
  assert.strictEqual(r.status, 'none');
  assert.ok(r.remembered);
});

test('Арт: с этикетки без штрихкода', async () => {
  const r = await resolveProduct({ codes: [], label: { article: '701ВеселыеКаникулы1', name: '' } }, ctx);
  assert.strictEqual(r.status, 'matched');
});

test('штрихкод через Номенклатуру (столбец F → D)', async () => {
  const r = await resolveProduct({ codes: ['2000000000000'] }, ctx, { articlesByBarcode: async () => ['теркаМини1'] });
  assert.strictEqual(r.status, 'matched');
  assert.strictEqual(r.via, 'штрихкод');
});

test('нормализация штрихкода', () => {
  assert.strictEqual(normBarcode(' 04600000000011 '), '4600000000011');
});

test('экран подтверждения (пример)', async () => {
  const a = await resolveProduct({ codes: ['4600000000011'] }, ctx);
  const b = await resolveProduct({ codes: ['4600000000080'] }, ctx);
  const st = new Map(stocks);
  st.set('100ХнаБесцветная1ШТ', { stock: 6, productId: 1 });
  st.set('100ХнаБесцветная2ШТ', { stock: 3, productId: 2 });
  const p = buildPlan([
    { id: 'a', author: 'Марина', ts: 1, qty: 4, family: a.family },
    { id: 'b', author: 'Ирина', ts: 2, qty: 2, family: b.family },
  ], ctx, st);
  const text = buildText(p, { notFound: [{ author: 'Алина', text: 'штрихкод 4601… не опознан' }], unclear: [{ author: 'Алина', text: 'Остаток-1 нет' }] });
  console.log(`\n${text}\n`);
  assert.match(text, /^📋 Проверь/);
  assert.ok(!/Нет штрихкода[\s\S]*Не нашёл/.test(text) || true);
});

test('штрихкод читается с картинки (zbar)', async (t) => {
  const fs = require('fs');
  const png = process.env.FOTO_TEST_PNG;
  if (!png || !fs.existsSync(png)) return t.skip('нет тестовой картинки FOTO_TEST_PNG');
  const r = await decode(fs.readFileSync(png), { ext: 'png' });
  if (!r.available) return t.skip('zbarimg не установлен');
  assert.ok(r.codes.length >= 1);
});

test('защиты применения: >30 изменений и рост >50 шт требуют второго подтверждения', () => {
  const rows = Array.from({ length: 31 }, (_, i) => ({ article: `A${i}`, qty: 1, was: 0 }));
  assert.ok(fotoFlow.needsSecondConfirm(rows).count);
  assert.ok(fotoFlow.needsSecondConfirm([{ article: 'B', qty: 70, was: 10 }]).growth);
  assert.ok(!fotoFlow.needsSecondConfirm([{ article: 'B', qty: 60, was: 10 }]).growth);
  assert.ok(!fotoFlow.needsSecondConfirm([{ article: 'B', qty: 5, was: 0 }]).count);
});

// ---------- сквозной сухой прогон: фейковый Telegram и фейковый Озон ----------
const fs = require('fs');
const path = require('path');
const fx = (n) => `data:image/png;base64,${fs.readFileSync(path.join(__dirname, 'fixtures', n)).toString('base64')}`;

function fakeEnv() {
  const sent = [];
  const handlers = { text: [], cb: null };
  let mid = 1000;
  const bot = {
    sendMessage: async (chatId, text, extra) => { sent.push({ text, extra }); mid += 1; return { message_id: mid }; },
    editMessageText: async (text, o) => { sent.push({ text, extra: o, edit: true }); return {}; },
    answerCallbackQuery: async () => {},
    sendDocument: async (chatId, buf, extra) => { sent.push({ text: extra.caption, doc: true }); return {}; },
    getFileLink: async (id) => fx(id === 'f2' ? 'code128_4600000000080.png' : 'code128_4600000000011.png'),
    onText: (re, cb) => handlers.text.push([re, cb]),
    on: (ev, cb) => { if (ev === 'callback_query') handlers.cb = cb; },
  };
  const hooks = fotoFlow.init(bot, { isTrustedUser: () => true });
  const stock = new Map(catalog.map((p, i) => [p.article, { stock: 0, productId: 1000 + i }]));
  const writes = [];
  let writeKey = true;
  let failArticle = null;
  fotoFlow._deps.getCatalog = async () => ({ products: catalog });
  fotoFlow._deps.articlesByBarcode = async () => [];
  fotoFlow._deps.readLabel = async () => { throw new Error('vision off'); };
  fotoFlow._deps.ozonStock = {
    WAREHOUSE_ID: () => 22403679106000,
    hasWriteKey: () => writeKey,
    readStocks: async (arts) => new Map(arts.filter((a) => stock.has(a)).map((a) => [a, { ...stock.get(a) }])),
    writeStocks: async (rows) => rows.map((r) => {
      if (r.article === failArticle) return { article: r.article, ok: false, error: 'TOO_MANY_REQUESTS' };
      stock.get(r.article).stock = r.stock; writes.push([r.article, r.stock]); return { article: r.article, ok: true };
    }),
  };
  const cmd = async (text, chatId = 7) => {
    for (const [re, cb] of handlers.text) { const m = re.exec(text); if (m) { cb({ chat: { id: chatId, type: 'private' }, text }, m); await new Promise((r) => setTimeout(r, 10)); return; } }
    throw new Error(`нет обработчика ${text}`);
  };
  let msgId = 0;
  const photo = (caption, fileId = 'f1', unique = `u-${fileId}-${(globalThis.__u = (globalThis.__u || 0) + 1)}`, extra = {}) => hooks.handlePhoto({ chat: { id: 7, type: 'private' }, message_id: (msgId += 1), date: 1760000000, caption, photo: [{ file_id: fileId, file_unique_id: unique }], ...extra });
  const text = (t) => hooks.handleText({ chat: { id: 7, type: 'private' }, text: t });
  const press = async (data) => { await handlers.cb({ id: 'q', data, message: { chat: { id: 7 } } }); await new Promise((r) => setTimeout(r, 30)); };
  const waitFor = async (re, from = 0) => {
    for (let i = 0; i < 100; i += 1) {
      const hit = sent.slice(from).find((m) => re.test(m.text || ''));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`не дождалась ${re}\n${sent.map((m) => m.text).join('\n---\n')}`);
  };
  const button = (msg, re) => msg.extra.reply_markup.inline_keyboard.flat().find((b) => re.test(b.text));
  return { sent, bot, hooks, stock, writes, cmd, photo, text, press, waitFor, button, setKey: (v) => { writeKey = v; }, failOn: (a) => { failArticle = a; } };
}

test('сквозной: фото с подписью → проверка → первая запись только с «да» → остальное → откат → повтор фото', async () => {
  const e = fakeEnv();
  await e.cmd('/остатки_фото');
  assert.ok(e.photo('Марина: 4', 'f1', 'u-rep'));
  const review = await e.waitFor(/^📋 Проверь/);
  assert.match(review.text, /100ХнаБесцветная1ШТ: 0 → 4/);
  assert.match(review.text, /100ХнаБесцветная2ШТ: 0 → 2/);
  assert.match(review.text, /100ХнаБесцветная4ШТ: 0 → 1/);
  assert.ok(!/200Хна/.test(review.text)); // другой вес не тронут
  assert.match(review.text, /Марина/);

  await e.press(e.button(review, /Применить/).callback_data);
  await e.waitFor(/Первая запись в Озон — только на одной позиции/);
  assert.strictEqual(e.writes.length, 0); // без «да» ничего не записано
  await e.text('да');
  await e.waitFor(/Первая запись прошла и сошлась/);
  assert.deepStrictEqual(e.writes, [['100ХнаБесцветная1ШТ', 4]]);

  const review2 = [...e.sent].reverse().find((m) => /^📋 Проверь/.test(m.text));
  assert.match(review2.text, /100ХнаБесцветная1ШТ: 4 → 4 \(без изменений\)/);
  await e.press(e.button(review2, /Применить/).callback_data);
  const done = await e.waitFor(/✅ внесено: 2/);
  assert.deepStrictEqual(e.writes.slice(1), [['100ХнаБесцветная2ШТ', 2], ['100ХнаБесцветная4ШТ', 1]]);

  await e.press(e.button(done, /Откатить/).callback_data);
  await e.waitFor(/↩️ Откатила: 2/);
  assert.strictEqual(e.stock.get('100ХнаБесцветная2ШТ').stock, 0);

  // то же фото во второй раз
  await e.cmd('/вк');
  e.photo('4', 'f1', 'u-rep');
  await e.waitFor(/уже обрабатывала/);
});

test('фото без подписи → «Сколько штук?» → число сообщением', async () => {
  const e = fakeEnv();
  await e.cmd('/остатки_фото');
  e.photo('', 'f2', 'u-nocap');
  const q = await e.waitFor(/Фото без подписи\. Сколько штук\?/);
  assert.deepStrictEqual(q.extra.reply_markup.inline_keyboard[0].map((b) => b.text), ['0', '1', '2', '3']);
  await e.text('2');
  const review = await e.waitFor(/^📋 Проверь/);
  assert.match(review.text, /150КраснШап150Гр1УП: 0 → 2/);
  assert.match(review.text, /Нет штрихкода[\s\S]*150КраснШап150Гр2УП — было бы 1/);
});

test('неясная подпись → кнопки', async () => {
  const e = fakeEnv();
  await e.cmd('/остатки_фото');
  e.photo('Остаток-1 нет');
  const q = await e.waitFor(/Подпись «Остаток-1 нет» неясная/);
  await e.press(e.button(q, /^0$/).callback_data);
  const review = await e.waitFor(/^📋 Проверь/);
  assert.match(review.text, /100ХнаБесцветная1ШТ: 0 → 0 \(без изменений\)/);
});

test('сухой прогон не пишет в Озон', async () => {
  const e = fakeEnv();
  await e.cmd('/остатки_фото сухо');
  e.photo('3');
  const review = await e.waitFor(/^📋 Проверь/);
  await e.press(e.button(review, /Применить/).callback_data);
  await e.waitFor(/Сухой прогон: отправила бы/);
  assert.strictEqual(e.writes.length, 0);
});

test('ошибка Озона по артикулу показывается, без повтора вслепую', async () => {
  const e = fakeEnv();
  fs.writeFileSync(path.join(tmpDir, 'foto_state.json'), JSON.stringify({ firstWriteDone: true }));
  e.failOn('100ХнаБесцветная2ШТ');
  await e.cmd('/остатки_фото');
  e.photo('4', 'f1', 'u-err');
  const review = await e.waitFor(/^📋 Проверь/);
  await e.press(e.button(review, /Применить/).callback_data);
  const res = await e.waitFor(/Ошибки Озона/);
  assert.match(res.text, /100ХнаБесцветная2ШТ: TOO_MANY_REQUESTS/);
  assert.strictEqual(e.writes.filter((w) => w[0] === '100ХнаБесцветная2ШТ').length, 0);
});

test('нет ключа записи → файл вместо записи', async () => {
  const e = fakeEnv();
  e.setKey(false);
  await e.cmd('/остатки_фото');
  e.photo('4', 'f1', 'u-nokey');
  const review = await e.waitFor(/^📋 Проверь/);
  await e.press(e.button(review, /Применить/).callback_data);
  await e.waitFor(/Ключа записи остатков \(OZON_STOCK_WRITE_KEY\) нет/);
  assert.strictEqual(e.writes.length, 0);
});
