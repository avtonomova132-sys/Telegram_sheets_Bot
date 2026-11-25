// node --test tasksSheet.test.js — без сети и Telegram: чтение таблицы и отправка подменены.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-'));
process.env.TASKS_SNAPSHOT_PATH = path.join(dir, 'snap.json');
process.env.TASKS_STATE_PATH = path.join(dir, 'state.json');
const ts = require('./tasksSheet');
const H = ['Задача', 'Артикул', 'Товар', 'Что сделать', 'Проверка (скрипт)', 'Комментарий'];
const sheet = (...rows) => async () => [['Елена — задачи на Ozon · обновлено 21.11.2026 14:40'], H, ...rows, ['', '', '', '', '', '']];
const sent = []; const send = async (t) => { sent.push(t); };
const reset = () => { sent.length = 0; };
const A = ['Снизить цену (короткий срок)', 'КрасныйМак', 'Конфеты Красный мак', 'Поставить 1729 ₽ (было 1802) · годен до 31.12.2026 · 3 шт', '✓ цена 1729', ''];
const B = ['Фото: перенести с WB на Ozon', 'МОСКВА2ШТ', 'Конфеты Москва', 'на Ozon 10 фото, на WB 12 — загрузить недостающие', 'сейчас на Ozon 10', ''];
const C = ['Задача от руководителя (с 19.11)', 'ЗеленаяТретьяковка1ШТ', 'Третьяковская зелёная', 'Поднять цену до 1 390 ₽', '', 'сделано'];
const D = ['У нас есть остаток, а на Ozon 0', 'ШОК75', 'Шоколад', 'у нас 19 шт', '', ''];
const run = (read, extra = {}) => ts.check({ today: '2026-11-26', read, send, ...extra });

test('первый запуск: только снимок, без уведомления', async () => {
  const r = await run(sheet(A, B, C));
  assert.equal(r.first, true); assert.equal(sent.length, 0);
  const snap = JSON.parse(fs.readFileSync(process.env.TASKS_SNAPSHOT_PATH, 'utf8'));
  assert.equal(Object.keys(snap).length, 3);
  const one = Object.values(snap)[0]; assert.deepEqual(Object.keys(one).sort(), ['A', 'B', 'D', 'first_seen']);
  assert.equal(ts.readState().lastRunDate, '2026-11-26');
});
test('второй запуск без изменений — тишина', async () => {
  const r = await run(sheet(A, B, C));
  assert.equal(r.newCount, 0); assert.equal(sent.length, 0);
});
test('сдвиг строк (другой порядок, строки сверху) — не новая', async () => {
  await run(sheet(C, B, A)); await run(sheet(['x', '', '', '', '', ''], C, A, B));
  assert.equal(sent.length, 0);
});
test('комментарий Елены (F), товар (C) и «Проверка» (E) — не новая', async () => {
  const A2 = [...A]; A2[5] = 'поставила 1729'; A2[2] = 'Другое название'; A2[4] = 'сейчас 1800';
  const B2 = [...B]; B2[5] = '10';
  await run(sheet(A2, B2, C)); assert.equal(sent.length, 0);
});
test('цифры в «Что сделать» (цена, остаток) пересчитаны — не новая', async () => {
  const A3 = [...A]; A3[3] = 'Поставить 1699 ₽ (было 1802) · годен до 31.12.2026 · 2 шт';
  const B3 = [...B]; B3[3] = 'на Ozon 11 фото, на WB 12 — загрузить недостающие';
  await run(sheet(A3, B3, C)); assert.equal(sent.length, 0);
});
test('пустые строки и строки без артикула пропускаются', async () => {
  const noArt = ['Ответить на отзывы', '', '', 'Ozon не отдаёт отзывы', '', ''];
  await run(sheet(A, B, C, noArt)); assert.equal(sent.length, 0);
  assert.equal(Object.keys(ts.parseRows(await sheet(A, noArt)())).length, 1);
});
test('действительно новая строка — ровно она, а потом снова тишина', async () => {
  reset();
  const r = await run(sheet(D, A, B, C));
  assert.equal(r.newCount, 1); assert.equal(sent.length, 1);
  assert.equal(sent[0], '🆕 Новых задач: 1\n\n1) ШОК75 — Шоколад\nЗадача: У нас есть остаток, а на Ozon 0\nЧто сделать: у нас 19 шт');
  reset(); await run(sheet(D, A, B, C)); assert.equal(sent.length, 0);
});
test('«(комментарий уже есть)» у новой строки с комментарием', async () => {
  reset();
  const E = ['Фото: перенести', 'АРТ_E', 'Товар E', 'загрузить фото', '', 'ок']; // новая, но Елена уже написала в F
  await run(sheet(D, A, B, C, E));
  assert.match(sent[0], /1\) АРТ_E — Товар E\nЗадача: Фото: перенести\nЧто сделать: загрузить фото\n\(комментарий уже есть\)$/);
});
test('исчезла из таблицы — молча уходит из снимка; вернулась — снова новая', async () => {
  reset();
  await run(sheet(D, A, B)); assert.equal(sent.length, 0);                 // C и E исчезли
  assert.equal(Object.keys(ts.readSnap()).length, 3);
  await run(sheet(D, A, B, C)); assert.equal(sent.length, 1);               // C вернулась
  assert.match(sent[0], /^🆕 Новых задач: 1\n\n1\) ЗеленаяТретьяковка1ШТ/);
});
test('больше 15 новых: первые 15 и «и ещё N»', async () => {
  reset();
  const many = Array.from({ length: 20 }, (_, i) => [`Задача${i}`, `ART${i}`, `Товар${i}`, `сделать что-то ${i}`, '', '']);
  await run(sheet(D, A, B, C, ...many));
  assert.match(sent[0], /^🆕 Новых задач: 20\n/); assert.match(sent[0], /15\) ART14/); assert.ok(!/16\) ART15/.test(sent[0]));
  assert.match(sent[0], /\n\nи ещё 5$/);
});
test('SHEET_EMPTY_NOTICE=1 — «новых задач нет»; по умолчанию молчит', async () => {
  reset(); const cur = [D, A, B, C, ...Array.from({ length: 20 }, (_, i) => [`Задача${i}`, `ART${i}`, `Товар${i}`, `сделать что-то ${i}`, '', ''])];
  await run(sheet(...cur)); assert.equal(sent.length, 0);
  process.env.SHEET_EMPTY_NOTICE = '1';
  await run(sheet(...cur)); delete process.env.SHEET_EMPTY_NOTICE;
  assert.match(sent[0], /^Новых задач нет\. Всего активных: 24\.$/);
});
test('отправка упала — снимок и метка дня не сохраняются, следующий запуск повторит', async () => {
  reset(); const before = fs.readFileSync(process.env.TASKS_SNAPSHOT_PATH, 'utf8');
  const cur = [D, A, B, C, ['Новая', 'NEW1', 'Т', 'сделать', '', '']];
  const bad = ts.check({ today: '2026-11-27', read: sheet(...cur), send: async () => { throw new Error('telegram down'); } });
  await assert.rejects(bad, /telegram down/);
  assert.equal(fs.readFileSync(process.env.TASKS_SNAPSHOT_PATH, 'utf8'), before);
  assert.notEqual(ts.readState().lastRunDate, '2026-11-27');
  await ts.check({ today: '2026-11-27', read: sheet(...cur), send }); assert.match(sent[0], /NEW1/);
});
test('лист прочитался пустым / сломалась структура — ошибка, снимок цел', async () => {
  const before = fs.readFileSync(process.env.TASKS_SNAPSHOT_PATH, 'utf8');
  await assert.rejects(run(sheet()), /прочитался пустым/);
  await assert.rejects(run(async () => [['x', 'y']]), /структура таблицы изменилась/);
  assert.equal(fs.readFileSync(process.env.TASKS_SNAPSHOT_PATH, 'utf8'), before);
});
test('/задания (preview): показывает новое и «сколько активных», ничего не пишет', async () => {
  const before = fs.readFileSync(process.env.TASKS_SNAPSHOT_PATH, 'utf8'); const st = fs.readFileSync(process.env.TASKS_STATE_PATH, 'utf8');
  const cur = [D, A, B, C, ['Другая', 'ZZ9', 'Т', 'сделать', '', '']];
  const r = await ts.preview({ read: sheet(...cur) });
  assert.equal(r.newCount, 1); assert.match(r.text, /ZZ9/); assert.match(r.text, /Всего активных: 5\.$/);
  assert.equal((await ts.preview({ read: sheet(D, A, B, C) })).text, 'Новых задач нет. Всего активных: 4.');
  assert.equal(fs.readFileSync(process.env.TASKS_SNAPSHOT_PATH, 'utf8'), before); assert.equal(fs.readFileSync(process.env.TASKS_STATE_PATH, 'utf8'), st);
});
test('расписание: до 08:00 нет, после — раз в день', async () => {
  assert.equal(ts.dueToday('2026-12-01', 7), false);
  assert.equal(ts.dueToday('2026-12-01', 8), true);
  await run(sheet(D, A, B, C, ['Новая', 'NEW1', 'Т', 'сделать', '', '']), { today: '2026-12-01' });
  assert.equal(ts.dueToday('2026-12-01', 12), false); assert.equal(ts.dueToday('2026-12-02', 8), true);
});
test('сообщение не получает 🛍️ и «Зачем» от ozonMsg, длинное режется < 4096', async () => {
  const ozonMsg = require('./ozonMsg'); reset();
  const out = []; const b = { sendMessage: async (id, t) => { out.push(t); } }; ozonMsg.installMarker(b);
  const long = '🆕 Новых задач: 15\n\n' + Array.from({ length: 15 }, (_, i) => `${i + 1}) АРТ${i} — Товар\nЗадача: Снизить цену на Ozon (акции, остатки)\nЧто сделать: ${'проверить габариты и остатки '.repeat(10)}`).join('\n\n');
  await ozonMsg.sendParts(b, 1, long);
  assert.ok(out.length >= 2 && out.every((p) => p.length < 4096 && !p.startsWith('🛍️') && !/Зачем/.test(p)));
});
