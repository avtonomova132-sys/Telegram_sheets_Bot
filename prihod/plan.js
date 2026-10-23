// Итоговый расчёт по подтверждённым строкам: разнос по семьям, остатки,
// «нет в Озоне», сверка суммы с печатным «Итого». Чистый код, без Telegram.

const { distribute } = require('./family');

const TOTAL_TOLERANCE = 1; // руб., на округления

// line: {n, name, qty, sum, flags, decision: {status:'matched'|'none'|'removed', family}}
function computePlan(lines, printedTotal) {
  const active = lines.filter((l) => l.decision && l.decision.status !== 'removed');
  const groups = new Map(); // family.id → {family, total, lines:[n]}
  const notInOzon = [];
  for (const l of active) {
    if (l.decision.status === 'none') { notInOzon.push(l); continue; }
    const fam = l.decision.family;
    let g = groups.get(fam.id);
    if (!g) { g = { family: fam, total: 0, lines: [], names: [] }; groups.set(fam.id, g); }
    g.total += l.qty || 0;
    g.lines.push(l.n);
    if (!g.names.includes(l.name)) g.names.push(l.name);
  }
  const items = [];
  const remainders = [];
  const zeroSets = [];
  for (const g of groups.values()) {
    g.members = distribute(g.family, g.total);
    for (const m of g.members) {
      if (m.qty > 0) items.push({ article: m.article, qty: m.qty });
      else zeroSets.push({ article: m.article, pieces: m.pieces, total: g.total });
      if (m.remainder > 0) remainders.push({ article: m.article, pieces: m.pieces, remainder: m.remainder, family: g.family.title });
    }
  }
  const missingSums = active.filter((l) => l.sum === null || l.sum === undefined);
  const sumLines = Math.round(active.reduce((s, l) => s + (l.sum || 0), 0) * 100) / 100;
  let check;
  if (printedTotal === null || printedTotal === undefined) check = { ok: false, reason: 'не нашла «Итого» накладной — пришли лист с итогом' };
  else if (missingSums.length) check = { ok: false, reason: `не прочитана сумма в строках: ${missingSums.map((l) => l.n).join(', ')}` };
  else if (Math.abs(sumLines - printedTotal) > TOTAL_TOLERANCE) check = { ok: false, reason: `не сходится: у нас ${sumLines.toFixed(2)}, в накладной ${Number(printedTotal).toFixed(2)}` };
  else check = { ok: true, reason: 'Сумма строк = Итого накладной' };
  return { groups: [...groups.values()], items, remainders, zeroSets, notInOzon, sumLines, check };
}

module.exports = { computePlan };
