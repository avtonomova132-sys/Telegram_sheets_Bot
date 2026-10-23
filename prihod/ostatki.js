// /остатки N-M: пересчёт остатков склада. Строки диапазона вкладки «Срок
// годности, остаток ( наш склад )» таблицы «Склад Заказы» → установка остатка
// по семьям артикулов → xlsx для загрузки в Озон. Всё считает код, модель и
// фото не используются.

const { norm, translit, dense } = require('./text');
const { SET_SIZES } = require('./family');

const SPREADSHEET_ID = process.env.OSTATKI_SPREADSHEET_ID || '1LyGp1pDHj-HwYljUfLjix25gXJqoI5Xx0tRT1a4a7es';
const TAB_GID = process.env.OSTATKI_TAB_GID || '85002361';
const TAB_TITLE_RE = /срок годности.*остаток.*наш склад/i;
const MAX_SPAN = 2000;

// «200-260», «200–260 бирки петельки»
function parseRange(text) {
  const m = /^\s*(\d+)\s*(?:[-–—]|\s)\s*(\d+)(?:\s+([\s\S]+))?$/.exec(String(text || ''));
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (from > to || from < 3 || to - from + 1 > MAX_SPAN) return null;
  return { from, to, hint: (m[3] || '').trim() };
}

// Пусто — 0 (решение Елены 23.10.2026: склад оставляет строку пустой, если
// товара нет); число — число; текст/дата — «непонятное», нулём не считаем.
function parseQty(raw) {
  const s = String(raw ?? '').replace(/[\s\u00a0]/g, '').replace(',', '.');
  if (s === '') return { state: 'empty' };
  if (!/^\d+(\.0+)?$/.test(s)) return { state: 'bad', raw: String(raw).trim() };
  return { state: 'ok', value: Math.round(Number(s)) };
}

function pieceSize(family, article) {
  const m = family.members.find((x) => x.article === article);
  return m ? m.pieces : null;
}

// Всего штук семьи = число в строке «1 шт» (пустая = 0). Числа в других
// строках, если они есть, должны согласоваться. Нет строки «1 шт» — считаем
// от набора по строкам с числами; чисел нет совсем — 0.
function familyTotal(entries, family) {
  const rows = entries.map((e) => ({ ...e, size: pieceSize(family, e.article) }));
  const filled = rows.filter((r) => !r.empty);
  const one = rows.find((r) => r.size === 1);
  if (one) {
    const total = one.qty;
    const bad = filled.filter((r) => r !== one && Math.floor(total / r.size) !== r.qty);
    if (bad.length) {
      const b = bad[0];
      return { conflict: `П${one.row}: набор 1 шт = ${total}, а П${b.row}: набор ${b.size} шт = ${b.qty} (должно быть ${Math.floor(total / b.size)})` };
    }
    return { total };
  }
  if (!filled.length) return { total: 0 };
  const totals = [...new Set(filled.map((r) => r.qty * r.size))];
  if (totals.length > 1) {
    return { conflict: `числа в наборах не согласуются: ${filled.map((r) => `П${r.row}: набор ${r.size} шт = ${r.qty}`).join(', ')}` };
  }
  return { total: totals[0], derivedFrom: filled[0] };
}

// rows: [{row, article, qtyRaw, subject, brand}]; products — каталог Озона;
// families — buildFamilies(products).families.
function buildPlan(rows, products, families) {
  const byArticle = new Map(products.map((p) => [dense(p.article), p]));
  const famOf = new Map();
  for (const f of families) for (const m of f.members) famOf.set(dense(m.article), f);

  const out = { articles: 0, notInOzon: [], bad: [], notSplit: [], conflicts: [], groups: [], items: [], zeroFamilies: 0 };
  const groups = new Map(); // fam.id → {family, entries, bad}
  const rowOf = new Map();
  const seen = new Map();
  for (const r of rows) {
    const article = String(r.article || '').trim();
    if (!article) continue;
    out.articles += 1;
    const key = dense(article);
    if (!rowOf.has(key)) rowOf.set(key, r.row);
    const q = parseQty(r.qtyRaw);
    const p = byArticle.get(key);
    const fam = famOf.get(key);
    if (fam && !groups.has(fam.id)) groups.set(fam.id, { family: fam, entries: [], bad: false });
    if (q.state === 'bad') {
      out.bad.push({ row: r.row, article, raw: q.raw });
      if (fam) groups.get(fam.id).bad = true;
      continue;
    }
    const value = q.state === 'empty' ? 0 : q.value;
    if (seen.has(key)) {
      const prev = seen.get(key);
      if (q.state !== 'empty' && prev.filled && prev.value !== value) {
        out.conflicts.push({ text: `артикул ${article} вписан дважды с разными числами (П${prev.row}: ${prev.value}, П${r.row}: ${value})` });
      }
      continue;
    }
    seen.set(key, { row: r.row, value, filled: q.state !== 'empty' });
    if (!p) { out.notInOzon.push({ row: r.row, article }); continue; }
    if (!fam) { out.notSplit.push({ row: r.row, article, reason: p.archived ? 'в архиве' : `размер набора не из списка ${SET_SIZES.join('/')}` }); continue; }
    groups.get(fam.id).entries.push({ row: r.row, article, qty: value, empty: q.state === 'empty' });
  }
  const built = [];
  for (const g of groups.values()) {
    if (g.bad || !g.entries.length) continue; // непонятное значение — сначала уточняем у Елены
    const t = familyTotal(g.entries, g.family);
    if (t.conflict) { out.conflicts.push({ text: t.conflict }); continue; }
    const members = g.family.members
      .map((m) => ({ article: m.article, pieces: m.pieces, qty: Math.floor(t.total / m.pieces), row: rowOf.get(dense(m.article)) }))
      .sort((x, y) => (x.row ?? Infinity) - (y.row ?? Infinity) || x.pieces - y.pieces);
    built.push({ family: g.family, total: t.total, members, derivedFrom: t.derivedFrom || null, firstRow: members[0].row ?? Infinity });
  }
  built.sort((x, y) => x.firstRow - y.firstRow);
  for (const g of built) {
    out.groups.push(g);
    if (g.total === 0) out.zeroFamilies += 1;
    for (const m of g.members) out.items.push({ article: m.article, qty: m.qty });
  }
  out.withStock = out.items.filter((i) => i.qty > 0).length;
  out.toZero = out.items.filter((i) => i.qty === 0).length;
  return out;
}

// Подсказка склада («бирки петельки») против текста строк: доля строк,
// где совпало хотя бы одно слово подсказки (по первым 5 буквам).
function hintMatch(hint, rows, products) {
  const words = translit(norm(hint)).split(' ').filter((w) => w.length >= 3).map((w) => w.slice(0, 5));
  if (!words.length) return null;
  const nameOf = new Map(products.map((p) => [dense(p.article), p.name]));
  const filled = rows.filter((r) => String(r.article || '').trim());
  if (!filled.length) return false;
  const hit = filled.filter((r) => {
    const hay = translit(norm(`${r.subject || ''} ${r.brand || ''} ${r.article || ''} ${nameOf.get(dense(r.article)) || ''}`));
    return words.some((w) => hay.includes(w));
  }).length;
  return hit / filled.length >= 0.5;
}

// Экран проверки /остатки: без названий; строки «П<номер строки> артикул — количество»,
// семьи через пустую строку, по номерам строк. Нули — в общем списке (идут в файл).
function buildText({ from, to, hint, rows, products, plan }) {
  const L = [];
  if (plan.groups.length && plan.zeroFamilies * 2 > plan.groups.length) L.push('⚠️ В диапазоне много пустых: проверь номера строк');
  L.push(`☑️ Проверка склада: строки ${from}–${to}, ${plan.articles} артикулов (с остатком: ${plan.withStock}, обнулить: ${plan.toZero})`);
  for (const g of plan.groups) {
    L.push('');
    for (const m of g.members) L.push(`${m.row ? `П${m.row}` : 'П—'} ${m.article} — ${m.qty}`);
  }
  const tail = [];
  if (plan.bad.length) tail.push(`❓ Непонятное значение в таблице (нужно уточнить):\n${plan.bad.map((r) => `П${r.row} ${r.article}: «${r.raw}»`).join('\n')}`);
  if (plan.notInOzon.length) tail.push(`Нет в Озоне:\n${plan.notInOzon.map((r) => `П${r.row} ${r.article}`).join('\n')}`);
  if (plan.notSplit.length) tail.push(`Не разнесла по семье (в файл не попадут):\n${plan.notSplit.map((r) => `П${r.row} ${r.article}, ${r.reason}`).join('\n')}`);
  if (plan.conflicts.length) tail.push(`Конфликт в таблице (в файл не попадут):\n${plan.conflicts.map((c) => `${c.text}.`).join('\n')}`);
  if (hint && !hintMatch(hint, rows, products)) tail.push(`⚠️ названия не похожи на «${hint}», проверь диапазон`);
  for (const t of tail) L.push('', t);
  return L.join('\n');
}

module.exports = { parseRange, parseQty, familyTotal, buildPlan, hintMatch, buildText, SPREADSHEET_ID, TAB_GID, TAB_TITLE_RE };
