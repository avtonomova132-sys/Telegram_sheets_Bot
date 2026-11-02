const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
process.env.DISPUTES_STATE_PATH = path.join(os.tmpdir(), `disputes_${process.pid}.json`);
const d = require('./disputes');

test('известные октябрьские случаи и сроки', () => {
  const s = d.getState();
  const c = d.candidatesFromWriteoffs(s.writeoffs, '2026-11-02');
  const by = Object.fromEntries(c.map((x) => [x.article, x]));
  assert.strictEqual(by['13162БиркаСадовая2000шт'].daysLeft, 16); // срок 18.11
  assert.strictEqual(c.length, 1); // остальные моложе 14 дней
  const e = d.earlyWriteoffs(s.writeoffs, '2026-11-02');
  const eb = Object.fromEntries(e.map((x) => [x.article, x]));
  assert.strictEqual(eb['МОСКВА1ШТ'].daysLeft, 22); // срок 24.11
  assert.strictEqual(eb['ПеналЧерный1'].daysLeft, 27); // 29.11
  assert.strictEqual(eb['025ПЛАМЯ025СИНП1ШТ'].daysLeft, 27);
  assert.match(d.formatEarly(e), /Ещё рано/);
});

test('до 14-го дня не показываем, на 14-й показываем', () => {
  const w = [{ id: 'a', article: 'X', date: '2026-10-19', compensation: '' }];
  assert.strictEqual(d.candidatesFromWriteoffs(w, '2026-10-31').length, 0);
  assert.strictEqual(d.candidatesFromWriteoffs(w, '2026-11-02').length, 1);
});

test('компенсация убирает из списка', () => {
  const st = { writeoffs: [{ id: 'a', article: 'X', date: '2026-10-01', compensation: '' }] };
  const r = d.setCompensation(st, 'x', '120');
  assert.strictEqual(d.candidatesFromWriteoffs(r.writeoffs, '2026-11-02').length, 0);
  assert.strictEqual(d.candidatesFromWriteoffs([{ id: 'b', article: 'Y', date: '2026-10-01', compensation: 'Предварительная' }], '2026-11-02').length, 0);
});

test('дедуп: один раз, напоминание на 25-й день, смена группы', () => {
  const w = [{ id: 'a', article: 'X', date: '2026-10-19', compensation: '' }];
  const c14 = d.candidatesFromWriteoffs(w, '2026-11-02');
  let sent = d.markSent({}, d.pickNew(c14, {}));
  assert.strictEqual(d.pickNew(c14, sent).length, 0);
  const c20 = d.candidatesFromWriteoffs(w, '2026-11-08');
  assert.strictEqual(d.pickNew(c20, sent).length, 0);
  const c25 = d.candidatesFromWriteoffs(w, '2026-11-13');
  assert.strictEqual(d.pickNew(c25, sent).length, 1);
  sent = d.markSent(sent, c25);
  assert.strictEqual(d.pickNew(c25, sent).length, 0);
  assert.strictEqual(d.pickNew([{ ...c25[0], group: 'G' }], sent).length, 1);
});

test('добавление списания и разбор даты', () => {
  const r = d.addWriteoff({ writeoffs: [] }, 'ART1; 123; -; 05.10.2026; 2; fbo; 99,5');
  assert.strictEqual(r.added.scheme, 'FBO');
  assert.strictEqual(r.added.date, '2026-10-05');
  assert.strictEqual(r.added.price, 99.5);
  assert.ok(d.addWriteoff({ writeoffs: [] }, 'ART1; ; ; 31.02.2026').error);
});

test('тексты: до 1000 символов, магазин, Client ID, тема, склад', () => {
  const c = d.candidatesFromWriteoffs(d.getState().writeoffs, '2026-11-02')[0];
  const t = d.supportText(c);
  assert.ok(t.length <= 1000);
  for (const w of ['Portretkina Beauty', '247027', c.article, 'Видео сборки']) assert.ok(t.includes(w), w);
  assert.match(d.topicOf(c), /^FBS\./);
  assert.match(d.topicOf({ scheme: 'FBO' }), /^FBO\./);
  const msgs = d.approvalMessages([c]);
  assert.match(msgs[0], /Видео сборки/);
  assert.match(msgs.at(-1), /подай обращение по/);
  assert.match(d.formatCandidates([c]), /Да \/ Нет \/ Позже/);
});
