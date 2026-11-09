// node --test ozonMsg.test.js — без реальной отправки: бот-заглушка.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
process.env.CONTROL_POINTS_PATH = path.join(dir, 'cp.json');
process.env.ACCRUALS_SNAPSHOTS_PATH = path.join(dir, 'snap.json');
const ozonMsg = require('./ozonMsg'); const cp = require('./controlPoints');

const fakeBot = () => { const sent = []; return { sent, sendMessage: async (id, t, o) => { sent.push({ id, t, o }); } }; };

test('период: со дня после прошлого отчёта; нет файла — с 1-го числа', () => {
  assert.equal(ozonMsg.periodLine('2026-11-09', '2026-11-03'), 'Период: с 04.11 по 09.11');
  assert.equal(ozonMsg.periodLine('2026-11-09', null), 'Период: с 01.11 по 09.11');
  assert.equal(ozonMsg.periodLine('2026-11-09', '2026-11-09'), 'Период: с 09.11 по 09.11');
});
test('деление длинного текста < 4096', () => {
  const parts = ozonMsg.split(('строка '.repeat(30) + '\n').repeat(60));
  assert.ok(parts.length > 1 && parts.every((p) => p.length < 4096));
});
test('🛍️ ставится на Озон-сообщения в личке, не в группах и не дважды', async () => {
  const b = fakeBot(); ozonMsg.installMarker(b);
  await b.sendMessage(1, 'Списания Ozon за 7 дней'); await b.sendMessage(1, '🛍️ уже'); await b.sendMessage(-100, 'Ozon акции'); await b.sendMessage(1, 'Привет');
  assert.deepEqual(b.sent.map((x) => x.t), ['🛍️ Списания Ozon за 7 дней', '🛍️ уже', 'Ozon акции', 'Привет']);
});
test('точка brand-promo-1113: 09:30, два сообщения, промпт в <pre>', async () => {
  const pts = cp.load().points; const p = pts.find((x) => x.id === 'brand-promo-1113'); assert.ok(p);
  assert.equal(cp.dueNow('2026-11-13', 9, 29).some((x) => x.id === p.id), false);
  assert.equal(cp.dueNow('2026-11-13', 9, 30).some((x) => x.id === p.id), true);
  assert.equal(cp.dueNow('2026-11-12', 12, 0).some((x) => x.id === p.id), false);
  const b = fakeBot(); await cp.send(b, 1, p, '2026-11-13');
  assert.equal(b.sent.length, 2);
  assert.match(b.sent[0].t, /^🛍️ Контрольная точка — Продвижение бренда Озон\nЗачем: решить, оставляем ли платную услугу/);
  assert.match(b.sent[0].t, /Период: 31\.10–13\.11 против 17–30\.10/);
  assert.match(b.sent[0].t, /\/контроль_готово brand-promo-1113/);
  assert.equal((b.sent[0].t.match(/\/контроль_готово/g) || []).length, 1);
  assert.match(b.sent[1].t, /^<pre>ЗАЧЕМ ЭТО\./); assert.equal(b.sent[1].o.parse_mode, 'HTML'); assert.ok(b.sent[1].t.length < 4096);
});
test('старые точки: Зачем/Период, /контроль и закрытие', () => {
  const pts = cp.load().points;
  for (const p of pts) assert.match(cp.format(p, '2026-11-09'), /^🛍️ Контрольная точка — .+\nЗачем: .+/);
  const m = cp.format(pts.find((x) => x.id === 'seed-month'), '2026-11-09'); assert.match(m, /\nПериод: с 01\.11 по 09\.11\n/);
  assert.match(cp.list('2026-11-09'), /^🛍️ Контрольные точки\nЗачем:/);
  assert.match(cp.formatDone(pts[0]), /^🛍️ Закрыл: /);
});

test('WVP/хосты не трогаем, у прочих Озон-алертов «Зачем:» по теме', async () => {
  const b = fakeBot(); ozonMsg.installMarker(b);
  await b.sendMessage(1, 'Анонс эфиров: остатки свободных мест, акции на курс');
  await b.sendMessage(1, '⚖️ К спору: 2\nПГ123 · заявка 1002115720\nОтветь «подавай» и перешли мне это сообщение.');
  await b.sendMessage(1, 'Не заданы OZON_API_KEY / OZON_CLIENT_ID в Railway.');
  assert.equal(b.sent[0].t.startsWith('🛍️'), false);
  assert.match(b.sent[1].t, /^🛍️ ⚖️ К спору: 2\nЗачем: не потерять деньги/);
  assert.match(b.sent[2].t, /^🛍️ Не заданы/); assert.ok(!/Зачем/.test(b.sent[2].t));
});
