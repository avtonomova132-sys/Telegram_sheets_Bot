// Итоговый расчёт по подтверждённым строкам: разнос по семьям, остатки,
// «нет в Озоне», сверка суммы с печатным «Итого». Чистый код, без Telegram.

const { distribute } = require('./family');

const TOTAL_TOLERANCE = 1; // руб., на округления

// line: {n, name, qty, sum, flags, decision: {status:'matched'|'none'|'removed', family}}
const near = (a, b) => Math.abs(a - b) <= TOTAL_TOLERANCE;

// Итоги сравниваем в той же базе, что и печатное «Итого»: с НДС (колонка
// суммы) или без НДС, если в накладной есть отдельный итог без налога.
function checkTotals(active, printedTotal, printedNoVat = null) {
  const round2 = (v) => Math.round(v * 100) / 100;
  const sumLines = round2(active.reduce((x, l) => x + (l.sum || 0), 0));
  const noVatKnown = active.length > 0 && active.every((l) => l.sumNoVat !== null && l.sumNoVat !== undefined);
  const sumNoVat = noVatKnown ? round2(active.reduce((x, l) => x + l.sumNoVat, 0)) : null;
  const hasTotal = (printedTotal !== null && printedTotal !== undefined) || (printedNoVat !== null && printedNoVat !== undefined);
  if (!hasTotal) return { ok: false, sumLines, reason: 'не нашла «Итого» накладной — пришли лист с итогом' };
  const missing = active.filter((l) => (l.sum === null || l.sum === undefined) && (l.sumNoVat === null || l.sumNoVat === undefined));
  const withVatOk = printedTotal !== null && printedTotal !== undefined && !active.some((l) => l.sum === null || l.sum === undefined) && near(sumLines, printedTotal);
  const noVatOk = sumNoVat !== null && printedNoVat !== null && printedNoVat !== undefined && near(sumNoVat, printedNoVat);
  if (withVatOk || noVatOk) return { ok: true, sumLines, reason: 'Сумма строк = Итого накладной' };
  if (missing.length) return { ok: false, sumLines, reason: `не прочитана сумма в строках: ${missing.map((l) => l.n).join(', ')}` };
  const want = printedTotal !== null && printedTotal !== undefined ? printedTotal : printedNoVat;
  const have = printedTotal !== null && printedTotal !== undefined ? sumLines : sumNoVat ?? sumLines;
  return { ok: false, sumLines, reason: `не сходится: у нас ${have.toFixed(2)}, в накладной ${Number(want).toFixed(2)}` };
}

function computePlan(lines, printedTotal, printedNoVat = null) {
  const active = lines.filter((l) => l.decision && l.decision.status !== 'removed');
  const groups = new Map(); // family.id → {family, total, lines:[n]}
  const notInOzon = [];
  const notArrived = [];
  for (const l of active) {
    if (l.decision.status === 'not_arrived') { notArrived.push(l); continue; } // сумма в сверке остаётся
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
  // Сверяем сумму ВСЕХ прочитанных строк (и найденных, и «Нет в Озоне»).
  const check = checkTotals(active, printedTotal, printedNoVat);
  const sumLines = check.sumLines;
  if (!check.ok && notInOzon.length && check.reason.startsWith('не сходится')) {
    const missing = Math.round(notInOzon.reduce((x, l) => x + (l.sum || 0), 0) * 100) / 100;
    check.reason += ` (в сумме есть «Нет в Озоне»: ${missing.toFixed(2)})`;
  }
  // Правки по пометкам: считаем расхождение с напечатанным количеством.
  const edited = active.filter((l) => l.origQty !== undefined && l.decision.status !== 'not_arrived' && l.origQty !== l.qty);
  const markDiff = edited.reduce((x, l) => x + (l.origQty - l.qty), 0) + notArrived.reduce((x, l) => x + (l.qty || 0), 0);
  return { groups: [...groups.values()], items, remainders, zeroSets, notInOzon, notArrived, edited, markDiff, sumLines, check };
}

module.exports = { computePlan, checkTotals };
