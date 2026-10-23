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

// Общее число штук семьи. Склад пишет остаток в строку «1 шт»; если число есть
// и в других строках, оно должно с ней согласоваться. Нет строки «1 шт» с
// числом — считаем от набора (qty × размер), несколько строк должны совпасть.
function familyTotal(entries, family) {
  const rows = entries.map((e) => ({ ...e, size: pieceSize(family, e.article) }));
  const one = rows.find((r) => r.size === 1);
  if (one) {
    const total = one.qty;
    const bad = rows.filter((r) => r !== one && Math.floor(total / r.size) !== r.qty);
    if (bad.length) {
      const b = bad[0];
      return { conflict: `в таблице набор 1 шт = ${total}, а набор ${b.size} шт = ${b.qty} (должно быть ${Math.floor(total / b.size)})` };
    }
    return { total };
  }
  const totals = [...new Set(rows.map((r) => r.qty * r.size))];
  if (totals.length > 1) {
    return { conflict: `числа в наборах не согласуются: ${rows.map((r) => `набор ${r.size} шт = ${r.qty}`).join(', ')}` };
  }
  return { total: totals[0], derivedFrom: rows[0] };
}

// rows: [{row, article, qtyRaw, subject, brand}]; products — каталог Озона;
// families — buildFamilies(products).families. Номера строк наружу не идут.
function buildPlan(rows, products, families) {
  const byArticle = new Map(products.map((p) => [dense(p.article), p]));
  const famOf = new Map();
  for (const f of families) for (const m of f.members) famOf.set(dense(m.article), f);

  const out = { articles: 0, notInOzon: [], unrecounted: [], bad: [], notSplit: [], conflicts: [], groups: [], items: [] };
  const groups = new Map(); // fam.id → {family, entries, hasAny}
  const seen = new Map();
  for (const r of rows) {
    const article = String(r.article || '').trim();
    if (!article) continue;
    out.articles += 1;
    const key = dense(article);
    const q = parseQty(r.qtyRaw);
    const p = byArticle.get(key);
    const fam = famOf.get(key);
    if (fam && !groups.has(fam.id)) groups.set(fam.id, { family: fam, entries: [] });
    if (q.state === 'empty') continue; // судим по семье: в «1 шт» число есть — остальные пустые нормально
    if (q.state === 'bad') { out.bad.push({ title: (fam && fam.title) || (p && p.name) || article, raw: q.raw }); continue; }
    if (seen.has(key)) {
      if (seen.get(key) !== q.value) out.conflicts.push({ title: (fam && fam.title) || article, text: `артикул ${article} вписан дважды с разными числами (${seen.get(key)} и ${q.value})` });
      continue;
    }
    seen.set(key, q.value);
    if (!p) { out.notInOzon.push({ article, qty: q.value }); continue; }
    if (!fam) { out.notSplit.push({ article, qty: q.value, reason: p.archived ? 'в архиве' : `размер набора не из списка ${SET_SIZES.join('/')}` }); continue; }
    groups.get(fam.id).entries.push({ row: r.row, article, qty: q.value });
  }
  for (const g of groups.values()) {
    if (!g.entries.length) {
      if (!out.bad.some((b) => b.title === g.family.title)) out.unrecounted.push(g.family.title);
      continue;
    }
    const t = familyTotal(g.entries, g.family);
    if (t.conflict) { out.conflicts.push({ title: g.family.title, text: t.conflict }); continue; }
    const members = g.family.members.map((m) => ({ article: m.article, pieces: m.pieces, qty: Math.floor(t.total / m.pieces) }));
    out.groups.push({ family: g.family, total: t.total, members, derivedFrom: t.derivedFrom || null });
    for (const m of members) out.items.push({ article: m.article, qty: m.qty });
  }
  out.unrecounted = [...new Set(out.unrecounted)];
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

const nameOfRow = (r, products) => {
  if (!r) return '—';
  const p = products.find((x) => dense(x.article) === dense(r.article));
  return (p && p.name) || [r.subject, r.brand].filter(Boolean).join(' ') || r.article;
};

function buildText({ from, to, hint, rows, products, plan }) {
  const filled = rows.filter((r) => String(r.article || '').trim());
  const L = [`📋 Строки ${from}–${to}, найдено ${plan.articles} артикулов`];
  L.push(`Диапазон: «${nameOfRow(filled[0], products)}» … «${nameOfRow(filled[filled.length - 1], products)}»`);
  if (hint) {
    const ok = hintMatch(hint, rows, products);
    L.push(ok ? `Подсказка «${hint}»: названия совпадают ✅` : `⚠️ названия не похожи на «${hint}», проверь диапазон`);
  }
  for (const g of plan.groups) {
    L.push('');
    L.push(`📦 ${g.family.title}${g.derivedFrom ? ` (посчитано от набора ${pieceSize(g.family, g.derivedFrom.article)} шт: всего ${g.total} шт)` : ''}`);
    for (const m of g.members) L.push(`${m.article} — ${m.qty}`);
  }
  if (plan.unrecounted.length) {
    L.push('', `⏳ Не пересчитано: ${plan.unrecounted.length} ${plan.unrecounted.length === 1 ? 'товар' : 'товаров'}${plan.unrecounted.length <= 10 ? '' : ' (в файл не попадут)'}`);
    if (plan.unrecounted.length <= 10) for (const t of plan.unrecounted) L.push(`• ${t}`);
  }
  if (plan.notInOzon.length) {
    L.push('', '🚫 Нет в Озоне:');
    for (const r of plan.notInOzon) L.push(`• ${r.article} — ${r.qty}`);
  }
  if (plan.notSplit.length) {
    L.push('', '⚠️ Есть в Озоне, но не разнесла по семье (в файл не попадут):');
    for (const r of plan.notSplit) L.push(`• ${r.article} — ${r.qty}, ${r.reason}`);
  }
  if (plan.bad.length) {
    L.push('', '⚠️ Непонятное количество (в файл не попадут):');
    for (const r of plan.bad) L.push(`• ${r.title}: «${r.raw}»`);
  }
  if (plan.conflicts.length) {
    L.push('', '❌ Конфликт в таблице (в файл не попадут, поправь в таблице и повтори):');
    for (const c of plan.conflicts) L.push(`• ${c.title}: ${c.text}.`);
  }
  return L.join('\n');
}

module.exports = { parseRange, parseQty, familyTotal, buildPlan, hintMatch, buildText, SPREADSHEET_ID, TAB_GID, TAB_TITLE_RE };
