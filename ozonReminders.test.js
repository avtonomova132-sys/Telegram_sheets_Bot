// node --test ozonReminders.test.js — без Telegram, без отправки.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.OZON_REMINDERS_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oz-')), 'r.json');
const r = require('./ozonReminders'); const ozonMsg = require('./ozonMsg');
const ids = (a) => a.map((x) => x.id);

test('шаблон сообщения', () => {
  const t = r.format(r.SEED[0]).split('\n');
  assert.equal(t[0], '⏰ Ozon: Ответы по спорам');
  assert.equal(t[1], '💻 Открой ноутбук и Chrome (расширение Claude подключено).');
  assert.equal(t[2], '📋 Куда: проект «Ozon» в Claude, новый чат.');
  assert.equal(t[3], '📝 Скопируй и отправь:');
  assert.match(t[4], /^«Проверь ответы Ozon по спорам.*только коротко доложи\.»$/);
});
test('время: до срока не шлёт, в срок шлёт; пн 08:00 — спор + FBS', () => {
  assert.deepEqual(ids(r.dueNow('2026-11-14', 8 * 60, 6)), []);               // сб
  assert.deepEqual(ids(r.dueNow('2026-11-16', 7 * 60 + 59, 1)), []);          // пн до 08:00
  assert.deepEqual(ids(r.dueNow('2026-11-16', 8 * 60, 1)).sort(), ['oz-1116-spory', 'oz-weekly-fbs']);
  assert.deepEqual(ids(r.dueNow('2026-11-19', 8 * 60 + 59, 4)), ['oz-1116-spory']); // 19.11 до 09:00: 16.11 ещё не отправлено — догоняет
  assert.ok(ids(r.dueNow('2026-11-19', 9 * 60, 4)).includes('oz-1119-itemcomp'));
  assert.ok(ids(r.dueNow('2026-11-24', 8 * 60 + 30, 2)).includes('oz-1124-fbo'));
});
test('отправленное не повторяется, еженедельное — раз в день; не отправленное переживает «перезапуск»', () => {
  r.markSent('oz-1116-spory', '2026-11-16'); r.markSent('oz-weekly-fbs', '2026-11-16');
  assert.deepEqual(ids(r.dueNow('2026-11-16', 12 * 60, 1)), []);
  delete require.cache[require.resolve('./ozonReminders')]; const r2 = require('./ozonReminders'); // перечитывает файл
  assert.deepEqual(ids(r2.dueNow('2026-11-16', 12 * 60, 1)), []);
  assert.ok(ids(r2.dueNow('2026-11-17', 12 * 60, 2)).includes('oz-1119-itemcomp') === false);
  assert.deepEqual(ids(r2.dueNow('2026-11-23', 8 * 60, 1)).sort(), ['oz-1119-itemcomp', 'oz-weekly-fbs']); // + догон пропущенного 19.11
  assert.deepEqual(ids(r2.dueNow('2026-11-26', 12 * 60, 4)).sort(), ['oz-1119-itemcomp', 'oz-1124-fbo']); // пропущенные уйдут поздно, но не потеряются
});
test('/напомнить_озон: разбор и ошибки', () => {
  const a = r.add('20.11 09:00 | Проверка | Текст | с чертой', '2026-11-14');
  assert.equal(a.date, '2026-11-20'); assert.equal(a.time, '09:00'); assert.equal(a.text, 'Текст | с чертой');
  assert.equal(r.add('20.11 9:5 | a | b', '2026-11-14'), null);
  assert.equal(r.add('20.11 09:00 | только название', '2026-11-14'), null);
  assert.match(r.list(), /20\.11 09:00 — Проверка/);
});
test('🛍️ и «Зачем» к шаблону не добавляются', async () => {
  const sent = []; const b = { sendMessage: async (id, t) => { sent.push(t); } }; ozonMsg.installMarker(b);
  await b.sendMessage(1, r.format(r.SEED[1]));
  assert.ok(sent[0].startsWith('⏰ Ozon:') && !/Зачем|🛍️/.test(sent[0]));
});
