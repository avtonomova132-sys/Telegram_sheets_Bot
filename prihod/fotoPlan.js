// /остатки_фото: поиск товара по штрихкоду/этикетке, разнос остатка по семье,
// «было → стало», текст экрана подтверждения. Чистый код без Telegram и Озона:
// каталог, текущие остатки и Номенклатура приходят аргументами (для тестов).

const { buildFamilies, findFamilyByArticle, distribute } = require('./family');
const { candidatesFor } = require('./match');
const { weightOk } = require('./weight');
const { normBarcode } = require('./barcode');
const { dense } = require('./text');
const nameMap = require('./nameMap');

function makeContext(products) {
  const { families } = buildFamilies(products);
  const famOf = new Map();
  for (const f of families) for (const m of f.members) famOf.set(dense(m.article), f);
  const productByArticle = new Map(products.map((p) => [dense(p.article), p]));
  const byBarcode = new Map();
  for (const p of products) {
    for (const b of p.barcodes && p.barcodes.length ? p.barcodes : p.barcode ? [p.barcode] : []) {
      const k = normBarcode(b);
      if (!k) continue;
      if (!byBarcode.has(k)) byBarcode.set(k, []);
      byBarcode.get(k).push(p);
    }
  }
  return { products, families, famOf, productByArticle, byBarcode };
}

// ключ памяти для штрихкода в name_map (norm() превращает его в «шк 4601…»)
const barcodeKey = (code) => `ШК ${code}`;

function uniqFamilies(list) {
  const out = [];
  for (const f of list) if (f && !out.includes(f)) out.push(f);
  return out;
}

// codes — штрихкоды с фото; label — {article,name,weightG} с этикетки (может быть null);
// articlesByBarcode — async (код) → артикулы из Номенклатуры (столбец F → D).
// Возвращает {status:'matched'|'ambiguous'|'none'|'unsplit', family?, options?, via, product?}.
async function resolveProduct({ codes = [], label = null }, ctx, { articlesByBarcode = async () => [] } = {}) {
  const fams = [];
  const unsplit = [];
  const note = (product) => {
    const f = ctx.famOf.get(dense(product.article));
    if (f) fams.push(f); else unsplit.push(product);
  };
  for (const c of codes) for (const p of ctx.byBarcode.get(normBarcode(c)) || []) note(p);
  if (!fams.length && !unsplit.length) {
    for (const c of codes) {
      let arts = [];
      try { arts = await articlesByBarcode(c); } catch (err) { console.error('[foto] Номенклатура по штрихкоду:', err.message); }
      for (const a of arts) {
        const p = ctx.productByArticle.get(dense(a));
        if (p) note(p);
      }
    }
  }
  const byCode = uniqFamilies(fams);
  if (byCode.length === 1) return { status: 'matched', family: byCode[0], via: 'штрихкод' };
  if (byCode.length > 1) return { status: 'ambiguous', options: byCode.slice(0, 4), via: 'штрихкод: несколько товаров' };
  if (unsplit.length) return { status: 'unsplit', product: unsplit[0], via: 'штрихкод' };

  const article = label && label.article;
  if (article) {
    const f = findFamilyByArticle(ctx.families, article);
    if (f) return { status: 'matched', family: f, via: 'Арт: с этикетки' };
    const raw = ctx.productByArticle.get(dense(article));
    if (raw) return { status: 'unsplit', product: raw, via: 'Арт: с этикетки' };
  }

  const names = [...codes.map(barcodeKey), label && label.name].filter(Boolean);
  for (const n of names) {
    const entry = nameMap.lookup(n);
    if (!entry) continue;
    if (entry.none) return { status: 'none', via: 'запомнено: нет в Озоне', remembered: true };
    let list = ctx.families.filter((f) => nameMap.familyMatches(entry, f));
    if (label && label.weightG && list.some((f) => f.weightG)) list = list.filter((f) => weightOk(label.weightG, f.weightG));
    if (list.length === 1) return { status: 'matched', family: list[0], via: 'карта' };
    if (list.length > 1) return { status: 'ambiguous', options: list.slice(0, 4), via: 'карта' };
  }

  const text = (label && (label.name || label.article)) || '';
  const options = text ? candidatesFor({ name: text, unitWeightG: label && label.weightG }, ctx.families, { max: 4 }) : [];
  return { status: options.length ? 'ambiguous' : 'none', options, via: options.length ? 'похожие по названию' : 'не нашёл' };
}

// Запоминаем выбор Елены (штрихкод и название этикетки → основа семьи / «нет в Озоне»).
function remember(item, family) {
  const keys = [...(item.codes || []).map(barcodeKey), item.label && item.label.name].filter(Boolean);
  for (const k of keys) {
    try { if (family) nameMap.remember(k, family); else nameMap.rememberNone(k, []); } catch (err) { console.error('[foto] карта названий:', err.message); }
  }
}

// items: [{id, author, ts, qty, family, codes, label}] — подтверждённые (товар найден, число известно).
// stocks: Map article → {stock, productId} (текущее из Озона) либо null, если Озон недоступен.
// lastTotals: {famId → {total, ts, author}} из прошлых партий (/data) для предупреждения.
function buildPlan(items, ctx, stocks = null, lastTotals = {}) {
  const byFam = new Map();
  for (const it of [...items].sort((a, b) => a.ts - b.ts)) {
    let g = byFam.get(it.family.id);
    if (!g) { g = { family: it.family, entries: [] }; byFam.set(it.family.id, g); }
    g.entries.push(it);
  }
  const groups = [];
  const writes = [];
  const noBarcode = [];
  for (const g of byFam.values()) {
    const last = g.entries[g.entries.length - 1];
    const earlier = g.entries.slice(0, -1).filter((e) => e.qty !== last.qty);
    const prev = lastTotals[g.family.id] || null;
    const members = distribute(g.family, last.qty).map((m) => {
      const product = ctx.productByArticle.get(dense(m.article)) || {};
      const hasBarcode = Boolean((product.barcodes && product.barcodes.length) || product.barcode);
      const cur = stocks ? stocks.get(m.article) : null;
      const row = { article: m.article, pieces: m.pieces, qty: m.qty, remainder: m.remainder, hasBarcode, was: cur ? cur.stock : null, productId: cur ? cur.productId : null };
      if (!hasBarcode) noBarcode.push(row);
      else if (row.was === null || row.was !== row.qty) writes.push(row);
      return row;
    });
    groups.push({
      family: g.family,
      total: last.qty,
      author: last.author,
      authors: [...new Set(g.entries.map((e) => e.author).filter(Boolean))],
      ids: g.entries.map((e) => e.id),
      warnings: [
        ...earlier.map((e) => `в этой партии было ${e.qty}${e.author ? ` (${e.author})` : ''}, стало ${last.qty}: берётся последнее фото`),
        ...(prev && prev.total !== last.qty ? [`по прошлому фото${prev.author ? ` (${prev.author})` : ''} было ${prev.total}, стало ${last.qty}`] : []),
      ],
      members,
    });
  }
  return { groups, writes, noBarcode, stocksKnown: Boolean(stocks) };
}

const fmtMove = (m) => `${m.was === null ? '?' : m.was} → ${m.qty}`;

// Экран «📋 Проверь»: по товарам автор, артикул, было → стало; пустая строка между
// семьями; блоки «Не нашёл», «Нет штрихкода», «Неясная подпись» — только если есть.
function buildText(plan, { notFound = [], unclear = [], skippedSame = 0 } = {}) {
  const L = ['📋 Проверь'];
  for (const g of plan.groups) {
    L.push('');
    L.push(`${g.authors.length ? g.authors.join(', ') : 'автор не указан'} · всего ${g.total} шт`);
    for (const m of g.members) {
      const mark = m.hasBarcode ? '' : ' ⚠️ нет штрихкода';
      const same = m.hasBarcode && m.was !== null && m.was === m.qty ? ' (без изменений)' : '';
      L.push(`${m.article}: ${fmtMove(m)}${same}${mark}`);
    }
    const rem = g.members.filter((m) => m.remainder > 0);
    if (rem.length) L.push(`остаток от деления: ${rem.map((m) => `${m.article} — ${m.remainder} шт`).join('; ')}`);
    for (const w of g.warnings) L.push(`⚠️ ${w}`);
  }
  if (notFound.length) L.push('', 'Не нашёл:', ...notFound.map((x) => `${x.author ? `${x.author}: ` : ''}${x.text}`));
  if (plan.noBarcode.length) L.push('', 'Нет штрихкода (остаток не ставлю, только сообщаю):', ...plan.noBarcode.map((m) => `${m.article} — было бы ${m.qty}`));
  if (unclear.length) L.push('', 'Неясная подпись:', ...unclear.map((x) => `${x.author ? `${x.author}: ` : ''}«${x.text}»`));
  if (!plan.stocksKnown) L.push('', '⚠️ Текущие остатки из Озона не прочитались — «было» = ?');
  return L.join('\n');
}

module.exports = { makeContext, resolveProduct, remember, buildPlan, buildText, barcodeKey };
