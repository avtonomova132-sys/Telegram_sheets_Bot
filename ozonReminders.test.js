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
test('21.12.2026 09:00: хна, два сообщения (текст + промпт в блоке кода), по времени и после перезапуска', async () => {
  const x = r.load().items.find((i) => i.id === 'oz-1221-hna-spor');
  assert.equal(x.date, '2026-12-21'); assert.equal(x.time, '09:00');
  assert.ok(!ids(r.dueNow('2026-12-20', 23 * 60 + 59, 0)).includes('oz-1221-hna-spor'));
  assert.ok(!ids(r.dueNow('2026-12-21', 8 * 60 + 59, 1)).includes('oz-1221-hna-spor'));   // 08:59 по Бали — ещё рано
  assert.ok(ids(r.dueNow('2026-12-21', 9 * 60, 1)).includes('oz-1221-hna-spor'));          // 09:00 — пора
  assert.ok(ids(r.dueNow('2026-12-21', 15 * 60, 1)).includes('oz-1221-hna-spor'));         // бот был выключен — догонит
  const sent = []; const bot = { sendMessage: async (id, t, o) => { sent.push({ id, t, o }); } };
  await r.send(bot, 42, x);
  assert.equal(sent.length, 2); assert.ok(sent.every((m) => m.id === 42));
  assert.match(sent[0].t, /^⏰ Ozon: Напоминание 21\.12: открыть спор по возврату хны\..*Заявка 1001808079, отправление 50557929-0147-1, артикул 125ХнаБесцветнОтборная1ШТ, 300 ₽\..*60 дней проходит 21\.12\. Открой ветку проекта Ozon и отправь туда промпт ниже\.$/);
  assert.match(sent[1].t, /^<pre>Проект Ozon, кабинет Portretkina Beauty\. Прочитай документ claude\/Ozon_штрафы_претензии_проверка_23-11\.md/);
  assert.match(sent[1].t, /Спор подавать после моего «да»\.<\/pre>$/); assert.equal(sent[1].o.parse_mode, 'HTML'); assert.ok(sent[1].t.length < 4096);
  r.markSent('oz-1221-hna-spor', '2026-12-21');
  delete require.cache[require.resolve('./ozonReminders')];                                  // «перезапуск»: читаем файл заново
  const r3 = require('./ozonReminders');
  assert.ok(!r3.dueNow('2026-12-21', 12 * 60, 1).some((i) => i.id === 'oz-1221-hna-spor'));  // отправленное не повторяется
});

test('29.11.2026 08:40: Альянс Хим, текст + промпт отдельно; правка доезжает до уже сохранённого', async () => {
  // имитируем старую версию в хранилище (09:00, другой текст)
  const d = JSON.parse(fs.readFileSync(process.env.OZON_REMINDERS_PATH, 'utf8'));
  const old = d.items.find((i) => i.id === 'oz-1129-spory-vozvraty'); old.time = '09:00'; old.message = 'старый текст'; delete old.prompt; old.sent = false;
  fs.writeFileSync(process.env.OZON_REMINDERS_PATH, JSON.stringify(d));
  delete require.cache[require.resolve('./ozonReminders')];
  const r4 = require('./ozonReminders');
  const x = r4.load().items.find((i) => i.id === 'oz-1129-spory-vozvraty');
  assert.equal(x.date, '2026-11-29'); assert.equal(x.time, '08:40');
  assert.ok(!r4.dueNow('2026-11-29', 8 * 60 + 39, 0).some((i) => i.id === x.id));
  assert.ok(r4.dueNow('2026-11-29', 8 * 60 + 40, 0).some((i) => i.id === x.id));
  const sent = []; await r4.send({ sendMessage: async (id, t, o) => { sent.push({ t, o }); } }, 7, x);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].t, '⏰ Ozon: Открой ноутбук и Chrome (Claude подключён, Ozon залогинен). Подать споры по пакетам Альянс Хим на 10 900 ₽. Скопируй текст ниже и вставь в чат с Claude.');
  assert.match(sent[1].t, /^<pre>Проект Ozon, кабинет Portretkina Beauty\./); assert.match(sent[1].t, /1002019808, 1002019809, 1002019810 \(отправление 72958848-0061-2, FBS/);
  assert.match(sent[1].t, /хне 1001808079 \(спор подан 25\.11\) и по заявке 1002046457 \(спор от 23\.11\)\. Я даю «да» на подачу\.<\/pre>$/);
  assert.equal(r4.list().match(/29\.11 08:40/) !== null, true);
  const b = { sendMessage: async (cid, m) => { sent.push({ t: m }); } }; ozonMsg.installMarker(b);
  await b.sendMessage(1, sent[0].t); assert.equal(sent[2].t, sent[0].t);                    // 🛍️ / «Зачем» не добавляются
  r4.markSent('oz-1129-spory-vozvraty', '2026-11-29');
  delete require.cache[require.resolve('./ozonReminders')]; const r5 = require('./ozonReminders'); // «перезапуск»
  assert.ok(!ids(r5.dueNow('2026-11-29', 12 * 60, 0)).includes('oz-1129-spory-vozvraty'));
  assert.ok(!ids(r5.dueNow('2026-12-06', 12 * 60, 0)).includes('oz-1129-spory-vozvraty'));  // больше не повторяется
});
