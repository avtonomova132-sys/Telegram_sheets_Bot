const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
process.env.DISPUTES_STATE_PATH = path.join(os.tmpdir(), `disputes_${process.pid}.json`);
const d = require('./disputes');

test('известные октябрьские случаи: поданные убраны, остаётся ПЛАМЯ в «Скоро»', () => {
  const s = d.getState();
  assert.strictEqual(d.candidatesFromWriteoffs(s.writeoffs, '2026-11-06').length, 0);
  const r = d.buildReport(s, [], '2026-11-06');
  assert.strictEqual(r.toDispute.length, 0);
  assert.deepStrictEqual(r.soon.map((x) => x.article), ['025ПЛАМЯ025СИНП1ШТ']);
  assert.strictEqual(r.soon[0].deadlineIso, '2026-11-29');
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
  const c = d.candidatesFromWriteoffs([{ id: 'q', article: 'ART', sku: '5', posting: 'P-5', date: '2026-10-10', qty: 2, scheme: 'FBS', reason: 'по результатам проверки', compensation: '' }], '2026-11-02')[0];
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

test('подано: бирки не напоминаем, номер отправления сохранён, блок «Уже подано»', () => {
  const s = d.getState();
  const b = s.writeoffs.find((w) => w.article === '13162БиркаСадовая2000шт');
  assert.strictEqual(b.posting, '46145506-0435-1');
  assert.strictEqual(b.filed.date, '2026-11-02');
  assert.strictEqual(b.filed.claims, '1002115720–1002115723');
  assert.ok(!d.candidatesFromWriteoffs(s.writeoffs, '2026-11-14').some((x) => x.article === b.article));
  assert.match(d.formatFiled(s.writeoffs), /46145506-0435-1.*подано 02\.11\.2026, заявки 1002115720–1002115723/);
  const r = d.markFiled({ writeoffs: [{ id: 'z', article: 'Z', date: '2026-10-01', compensation: '' }] }, 'z; 03.11.2026; 111; P-9');
  assert.strictEqual(r.writeoffs[0].posting, 'P-9');
});

test('В: показываем реальные дни, не «60»', () => {
  const mk = (days, left) => ({ group: 'V', article: 'A', sku: 1, ref: 'x', dateIso: '2026-08-01', days, daysLeft: left, price: 10 });
  assert.match(d.formatCandidates([mk(53, 7)]), /прошло 53 дн\., до 60 осталось 7/);
  assert.match(d.formatCandidates([mk(75, 0)]), /прошло 75 дн\. \(больше 60/);
});

test('нет дубля: возврат, уже стоящий в А, не показывается', () => {
  const w = [{ id: 'a', article: 'X', posting: 'P-1', date: '2026-10-01', compensation: '' }];
  const cands = [
    { group: 'W', article: 'X', posting: 'P-1' },
    { group: 'V', article: 'X', posting: 'P-1' },
    { group: 'V', article: 'X', posting: '' },
    { group: 'V', article: 'Y', posting: 'P-2' },
  ];
  const out = d.dropDuplicatesOfWriteoffs(cands, w);
  assert.deepStrictEqual(out.map((c) => `${c.group}${c.article}${c.posting}`), ['WXP-1', 'VYP-2']);
});

// ---- короткий отчёт «К спору» ----
const ret = (claim, status, daysAgo, art = 'R') => ({
  key: `R|${claim}`, group: 'V', article: `${art}${claim}`, claim: String(claim), posting: '',
  status, days: daysAgo, dateIso: d.msToIso(Date.parse('2026-11-06T00:00:00Z') - daysAgo * 86400000),
});

test('К спору: только Ожидает отправки / Едет на склад >=60 дн., не старше 180', () => {
  const st = { writeoffs: [] };
  const r = d.buildReport(st, [
    ret(1, 'Ожидает отправки', 70), ret(2, 'Едет на склад Ozon', 61), ret(3, 'Едет к вам', 90),
    ret(4, 'Провели декомпенсацию', 100), ret(5, 'Ожидает отправки', 200), ret(6, 'Ожидает отправки', 55),
    ret(7, 'Ищем товар', 40),
  ], '2026-11-06');
  assert.deepStrictEqual(r.toDispute.map((c) => c.claim).sort(), ['1', '2']);
  assert.strictEqual(r.soon.length, 1); // 55 дней
});

test('Подано: заявки из реестра (диапазон) и бирки/москва/пенал не в «К спору»', () => {
  const s = d.getState();
  const r = d.buildReport({ ...s, filedClaims: ['1002200001-1002200002'] }, [
    ret(1002115721, 'Ожидает отправки', 70), ret(1002200002, 'Ожидает отправки', 70), ret(1002097775, 'Едет на склад Ozon', 70),
    ret(1001782331, 'Ожидает отправки', 70), ret(999, 'Ожидает отправки', 70),
  ], '2026-11-06');
  assert.deepStrictEqual(r.toDispute.map((c) => c.claim), ['999']);
  assert.ok(d.filedClaimSet(s).has('1002097776'));
  const names = d.candidatesFromWriteoffs(s.writeoffs, '2026-11-06').map((c) => c.article);
  assert.ok(!names.some((n) => /БиркаСадовая|МОСКВА|ПеналЧерный/.test(n)));
});

test('Списания: с 14-го дня и не позже 30-го; младше 14 — «Скоро»', () => {
  const st = { writeoffs: [
    { id: 'a', article: 'A', date: '2026-10-20', compensation: '' }, // 17 дн.
    { id: 'b', article: 'B', date: '2026-09-20', compensation: '' }, // 47 дн. — срок вышел
    { id: 'c', article: 'C', date: '2026-10-30', compensation: '' }, // 7 дн.
    { id: 'd', article: 'D', date: '2026-10-20', compensation: 'Предварительная' },
  ] };
  const r = d.buildReport(st, [], '2026-11-06');
  assert.deepStrictEqual(r.toDispute.map((c) => c.article), ['A']);
  assert.strictEqual(r.soon.length, 1);
  assert.strictEqual(r.soon[0].deadlineIso, '2026-11-29');
});

test('Формат строго по образцу', () => {
  const r = { toDispute: [{ article: 'ART1', claim: '1002000001' }, { article: 'ART2', posting: 'P-2' }],
    soon: [{ deadlineIso: '2026-11-29' }, { deadlineIso: '2026-11-24' }] };
  assert.strictEqual(d.formatShort(r),
    '⚖️ К спору: 2\n\t1.\tART1 · заявка 1002000001\n\t2.\tART2 · отпр. P-2\nОтветь «подавай» и перешли мне это сообщение.\n\nСкоро: 2 поз., ближайший срок 24.11');
  assert.strictEqual(d.formatShort({ toDispute: [], soon: [] }), '✅ Сейчас подавать нечего');
  assert.strictEqual(d.formatShort({ toDispute: [], soon: [{ deadlineIso: '2026-11-24' }] }),
    '✅ Сейчас подавать нечего\n\nСкоро: 1 поз., ближайший срок 24.11');
});
