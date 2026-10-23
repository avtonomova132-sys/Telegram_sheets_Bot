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

// Пусто — «не пересчитано»; 0 — настоящий ноль; мусор — «непонятное».
function parseQty(raw) {
  const s = String(raw ?? '').replace(/[\s ]/g, '').replace(',', '.');
  if (s === '') return { state: 'empty' };
  if (!/^\d+(\.0+)?$/.test(s)) return { state: 'bad', raw: String(raw).trim() };
  return { state: 'ok', value: Math.round(Number(s)) };
}

function pieceSize(family, article) {
  const m = family.members.find((x) => x.article === article);
  return m ? m.pieces : null;
}

// Общее число штук семьи по строкам диапазона. Основа — строка «1 шт»;
// нет её — считаем от набора (qty × размер), несколько строк должны совпасть.
function familyTotal(entries, family) {
  const rows = entries.map((e) => ({ ...e, size: pieceSize(family, e.article) }));
  const one = rows.find((r) => r.size === 1);
  if (one) {
    const total = one.qty;
    const bad = rows.filter((r) => r !== one && Math.floor(total / r.size) !== r.qty);
    if (bad.length) {
      return { conflict: `строка ${one.row} (${one.article}) = ${one.qty} шт, а ${bad.map((r) => `строка ${r.row} (${r.article}) = ${r.qty}`).join(', ')} — не сходится` };
    }
    return { total };
  }
  const totals = [...new Set(rows.map((r) => r.qty * r.size))];
  if (totals.length > 1) {
    return { conflict: `числа не согласуются: ${rows.map((r) => `строка ${r.row} (${r.article}) = ${r.qty} × ${r.size} шт`).join('; ')}` };
  }
  return { total: totals[0], derivedFrom: rows[0] };
}

// rows: [{row, article, qtyRaw, subject, brand}]; products — каталог Озона;
// families — buildFamilies(products).families.
function buildPlan(rows, products, families) {
  const byArticle = new Map(products.map((p) => [dense(p.article), p]));
  const famOf = new Map();
  for (const f of families) for (const m of f.members) famOf.set(dense(m.article), f);

  const out = { articles: 0, notInOzon: [], empty: [], bad: [], notSplit: [], conflicts: [], groups: [], items: [] };
  const groups = new Map();
  const seen = new Map();
  for (const r of rows) {
    const article = String(r.article || '').trim();
    if (!article) continue;
    out.articles += 1;
    const q = parseQty(r.qtyRaw);
    if (q.state === 'empty') { out.empty.push({ row: r.row, article }); continue; }
    if (q.state === 'bad') { out.bad.push({ row: r.row, article, raw: q.raw }); continue; }
    const key = dense(article);
    if (seen.has(key)) {
      const prev = seen.get(key);
      if (prev.qty !== q.value) out.conflicts.push({ title: article, text: `артикул в строках ${prev.row} и ${r.row} с разными числами (${prev.qty} и ${q.value})` });
      continue;
    }
    seen.set(key, { row: r.row, qty: q.value });
    if (!byArticle.has(key)) { out.notInOzon.push({ row: r.row, article, qty: q.value }); continue; }
    const fam = famOf.get(key);
    if (!fam) {
      const p = byArticle.get(key);
      out.notSplit.push({ row: r.row, article, qty: q.value, reason: p.archived ? 'в архиве' : `размер набора не из списка ${SET_SIZES.join('/')}` });
      continue;
    }
    if (!groups.has(fam.id)) groups.set(fam.id, { family: fam, entries: [] });
    groups.get(fam.id).entries.push({ row: r.row, article, qty: q.value });
  }
  for (const g of groups.values()) {
    const t = familyTotal(g.entries, g.family);
    if (t.conflict) { out.conflicts.push({ title: g.family.title, text: t.conflict }); continue; }
    const members = g.family.members.map((m) => ({ article: m.article, pieces: m.pieces, qty: Math.floor(t.total / m.pieces) }));
    out.groups.push({ family: g.family, total: t.total, members, derivedFrom: t.derivedFrom || null });
    for (const m of members) out.items.push({ article: m.article, qty: m.qty });
  }
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

const label = (r, products) => {
  if (!r) return '—';
  const p = products.find((x) => dense(x.article) === dense(r.article));
  const name = (p && p.name) || [r.subject, r.brand].filter(Boolean).join(' ') || 'без названия';
  return `строка ${r.row}: ${name} (${r.article})`;
};

function buildText({ from, to, hint, rows, products, plan }) {
  const filled = rows.filter((r) => String(r.article || '').trim());
  const L = [`📋 Строки ${from}–${to}, найдено ${plan.articles} артикулов`];
  L.push(`Первая — ${label(filled[0], products)}`);
  L.push(`Последняя — ${label(filled[filled.length - 1], products)}`);
  if (hint) {
    const ok = hintMatch(hint, rows, products);
    L.push(ok ? `Подсказка «${hint}»: названия совпадают ✅` : `⚠️ названия не похожи на «${hint}», проверь диапазон`);
  }
  for (const g of plan.groups) {
    L.push('');
    L.push(`📦 ${g.family.title}${g.derivedFrom ? ` (посчитано от набора ${pieceSize(g.family, g.derivedFrom.article)} шт: всего ${g.total} шт)` : ''}`);
    for (const m of g.members) L.push(`${m.article} — ${m.qty}`);
  }
  if (plan.notInOzon.length) {
    L.push('', '🚫 Нет в Озоне:');
    for (const r of plan.notInOzon) L.push(`• ${r.article} (строка ${r.row}) — ${r.qty}`);
  }
  if (plan.notSplit.length) {
    L.push('', '⚠️ Есть в Озоне, но не разнесла по семье (в файл не попадут):');
    for (const r of plan.notSplit) L.push(`• ${r.article} (строка ${r.row}) — ${r.qty}, ${r.reason}`);
  }
  if (plan.empty.length) {
    L.push('', '⏳ Пустое количество (не пересчитано, в файл не попадут):');
    L.push(plan.empty.map((r) => `${r.article} (${r.row})`).join(', '));
  }
  if (plan.bad.length) {
    L.push('', '⚠️ Непонятное количество (в файл не попадут):');
    for (const r of plan.bad) L.push(`• ${r.article} (строка ${r.row}): «${r.raw}»`);
  }
  if (plan.conflicts.length) {
    L.push('', '❌ Конфликт в таблице (в файл не попадут, поправь в таблице и повтори):');
    for (const c of plan.conflicts) L.push(`• ${c.title}: ${c.text}`);
  }
  return L.join('\n');
}

module.exports = { parseRange, parseQty, familyTotal, buildPlan, hintMatch, buildText, SPREADSHEET_ID, TAB_GID, TAB_TITLE_RE };
