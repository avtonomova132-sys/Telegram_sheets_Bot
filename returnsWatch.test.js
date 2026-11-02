const test = require('node:test');
const assert = require('node:assert');
const rw = require('./returnsWatch');

const NOW = Date.parse('2026-11-02T02:00:00Z');
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const mk = (id, status, daysAgo, extra = {}) => ({
  id, posting_number: `P-${id}`, order_id: id,
  product: { offer_id: `ART${id}`, sku: 100 + id, price: { price: '50.5' } },
  visual: { status: { display_name: status }, change_moment: ago(daysAgo) },
  ...extra,
});

test('четыре группы и пороги', () => {
  const f = rw.classify([
    mk(1, 'Списали товар', 31),
    mk(2, 'Списали товар', 29),
    mk(3, 'Ищем товар', 21),
    mk(4, 'Ищем товар', 19),
    mk(5, 'Едет к вам', 55),
    mk(6, 'Едет на склад Ozon', 49),
    mk(7, 'Ожидает отправки', 61),
    mk(8, 'Не получена доставкой', 1),
    mk(9, 'Вы получили компенсацию', 40),
  ], NOW);
  const by = Object.fromEntries(f.map((x) => [x.claim, x]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['1', '3', '5', '7', '8']);
  assert.strictEqual(by[5].daysLeft, 5);
  assert.match(by[7].todo, /60 дней/);
});

test('компенсация по той же позиции снимает группу А', () => {
  const a = mk(1, 'Списали товар', 40);
  const c = mk(2, 'Вы получили компенсацию', 5, { order_id: 1, product: a.product });
  assert.strictEqual(rw.classify([a, c], NOW).length, 0);
  const d = mk(3, 'Списали товар', 40, { logistic: { cancelled_with_compensation_moment: ago(2) } });
  assert.strictEqual(rw.classify([d], NOW).length, 0);
});

test('дедуп: смена группы или 60 дней', () => {
  const f = rw.classify([mk(1, 'Ищем товар', 25)], NOW);
  assert.strictEqual(rw.pickNew(f, {}, NOW).length, 1);
  const sent = rw.markSent({}, f, NOW);
  assert.strictEqual(rw.pickNew(f, sent, NOW + 7 * 86400000).length, 0);
  assert.strictEqual(rw.pickNew(f, sent, NOW + 61 * 86400000).length, 1);
  const moved = rw.classify([mk(1, 'Списали товар', 35)], NOW);
  assert.strictEqual(rw.pickNew(moved, sent, NOW).length, 1);
});

test('формат: поля и путь внизу', () => {
  const t = rw.formatReport(rw.classify([mk(1, 'Списали товар', 40)], NOW));
  for (const w of ['ART1', 'SKU 101', 'заявка 1', 'P-1', '51 ₽', '40 дн.', 'открыть спор', 'FBS → Возвраты и отмены → номер заявки → Открыть спор']) {
    assert.ok(t.includes(w), w);
  }
});
