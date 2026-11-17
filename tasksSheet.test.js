// node --test tasksSheet.test.js — без сети и Telegram: чтение таблицы подменено.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.TASKS_SNAPSHOT_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ts-')), 's.json');
const ts = require('./tasksSheet');
const H = ['Задача', 'Артикул', 'Товар', 'Что сделать', 'Проверка (скрипт)', 'Комментарий'];
const sheet = (...rows) => async () => [['Задания Елене'], H, ...rows, ['', '', '', '', '', '']];
const A = ['Цена', 'ART1', 'Крем', 'Поставить 500 ₽', 'не выполнено', ''];
const B = ['Остатки', 'ART2', 'Мёд', 'Обнулить остаток', 'не выполнено', ''];

test('первый запуск: снимок + «таблица подключена», все задачи', async () => {
  const r = await ts.check({ read: sheet(A, B) });
  assert.equal(r.firstRun, true);
  assert.match(r.text, /^🛍️📋 Таблица заданий — таблица подключена, вот текущие задачи \(2\)\n\n• 💰 Цена: ART1 — Поставить 500 ₽\n• 📦 Остатки: ART2 — Обнулить остаток$/);
  assert.ok(fs.existsSync(process.env.TASKS_SNAPSHOT_PATH));
});
test('нет изменений: тишина (null), а ручной запуск отвечает', async () => {
  assert.equal((await ts.check({ read: sheet(A, B) })).text, null);
  assert.match((await ts.check({ read: sheet(A, B), manual: true })).text, /нового нет\. Сейчас в листе «Елена \(Ozon\)»: 2 задач/);
});
test('«Проверка (скрипт)» не считается изменением', async () => {
  const A2 = [...A]; A2[4] = 'выполнено';
  assert.equal((await ts.check({ read: sheet(A2, B) })).text, null);
});
test('новая, изменённая и убранная строки', async () => {
  const C = ['Акции', 'ART3', 'Мыло', 'Убрать из акции', '', ''];
  const A3 = [...A]; A3[5] = 'срочно';
  const r = await ts.check({ read: sheet(A3, C) });   // A изменена (комментарий), C новая, B убрана
  assert.equal(r.text, [
    '🛍️📋 Таблица заданий — новое от Алины', '',
    '• 🏷️ Акции: ART3 — Убрать из акции', '',
    '✏️ Изменено:', '• 💰 Цена: ART1 — Поставить 500 ₽ (срочно)', '',
    '✅ Убрано:', '• 📦 Остатки: ART2 — Обнулить остаток'].join('\n'));
  assert.equal((await ts.check({ read: sheet(A3, C) })).text, null);   // снимок обновился
});
test('другой «Что сделать» = новая задача + старая убрана', async () => {
  const C2 = ['Акции', 'ART3', 'Мыло', 'Вернуть в акцию', '', ''];
  const t = (await ts.check({ read: sheet(['Цена', 'ART1', 'Крем', 'Поставить 500 ₽', '', 'срочно'], C2) })).text;
  assert.match(t, /• 🏷️ Акции: ART3 — Вернуть в акцию/); assert.match(t, /✅ Убрано:\n• 🏷️ Акции: ART3 — Убрать из акции/);
});
test('расписание: до 07:00 нет, после — раз в день', async () => {
  assert.equal(ts.dueToday('2026-11-18', 6), false);
  assert.equal(ts.dueToday('2026-11-18', 7), true);
  await ts.check({ read: sheet(A), today: '2026-11-18' });
  assert.equal(ts.dueToday('2026-11-18', 9), false);
  assert.equal(ts.dueToday('2026-11-19', 7), true);
});
test('сломанная структура — понятная ошибка, снимок не портится', async () => {
  const before = fs.readFileSync(process.env.TASKS_SNAPSHOT_PATH, 'utf8');
  await assert.rejects(ts.check({ read: async () => [['x', 'y']] }), /структура таблицы изменилась/);
  assert.equal(fs.readFileSync(process.env.TASKS_SNAPSHOT_PATH, 'utf8'), before);
});
test('длинное сообщение режется < 4096, 🛍️📋 без «Зачем:»', async () => {
  const ozonMsg = require('./ozonMsg');
  const parts = ozonMsg.split(Array.from({ length: 200 }, (_, i) => `• 📌 Задача ${i}: ART${i} — что-то сделать с товаром`).join('\n'));
  assert.ok(parts.length >= 2 && parts.every((p) => p.length < 4096));
  const sent = []; const b = { sendMessage: async (id, t) => { sent.push(t); } }; ozonMsg.installMarker(b);
  await b.sendMessage(1, '🛍️📋 Таблица заданий — новое от Алины\n\n• 🏷️ Акции: ART3 — Убрать из акции товар из списка акций Озона');
  assert.ok(!/Зачем/.test(sent[0]) && sent[0].startsWith('🛍️📋'));
});
