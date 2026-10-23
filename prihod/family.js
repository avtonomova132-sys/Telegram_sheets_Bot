// Семьи артикулов и разнос количества — только код, без модели.
// Семья = все карточки одного товара с ОДИНАКОВЫМ весом единицы, отличающиеся
// числом штук в наборе (1/2/3/4/5/6/8/10/12/20 шт).

const { dense, tokens, trigrams, articleWords } = require('./text');

const SET_SIZES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 20];
const PIECES_RE = /(?:^|[^0-9a-zа-я])(\d{1,2})\s*шт\.?/i;
const PIECES_STRIP_RE = /[\s_\-(]*\d{1,2}\s*шт\.?\)?/gi;
const WEIGHT_RE = /(\d+(?:[.,]\d+)?)\s*(кг|kg|г|гр|g|мл|ml|л)(?![a-zа-я])/i;

// Вес/объём единицы в граммах (мл считаем как г — для сравнения хватает).
function parseWeightG(text) {
  const s = String(text || '').replace(PIECES_STRIP_RE, ' ');
  const m = WEIGHT_RE.exec(s);
  if (m) {
    const v = Number(m[1].replace(',', '.'));
    const u = m[2].toLowerCase();
    if (u === 'кг' || u === 'kg' || u === 'л') return Math.round(v * 1000);
    return Math.round(v);
  }
  // Артикул вида «250КАРАМЕЛЬ_…» / «1КгБатончик…»: число в начале.
  const lead = /^\s*(\d+(?:[.,]\d+)?)\s*(кг|kg)?/i.exec(s);
  if (lead && /[a-zа-я]/i.test(s.slice(lead[0].length, lead[0].length + 1))) {
    const v = Number(lead[1].replace(',', '.'));
    return lead[2] ? Math.round(v * 1000) : Math.round(v);
  }
  return null;
}

// Артикул каталога: {вес}{БРЕНД_название}{N}ШТ, напр. 200КОМамаПриехала1ШТ,
// 250КАРАМЕЛЬ_Лимончики_1шт. Штуки — хвост «N шт», вес — число в начале.
const TRAIL_PIECES_RE = /[\s_\-]*(\d{1,2})\s*шт\.?$/i;

function parsePieces(article, name) {
  const t = TRAIL_PIECES_RE.exec(String(article || '').trim());
  if (t) return Number(t[1]);
  for (const src of [article, name]) {
    const m = PIECES_RE.exec(String(src || ''));
    if (m) return Number(m[1]);
  }
  return 1;
}

function parseArticleWeight(article) {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(кг|kg)?(?=[a-zа-я_])/i.exec(String(article || ''));
  if (!m) return null;
  const v = Number(m[1].replace(',', '.'));
  return m[2] ? Math.round(v * 1000) : Math.round(v);
}

// Основа семьи = артикул без хвоста «N шт» (200КОМамаПриехала).
function articleBase(article, name) {
  const a = String(article || '').trim();
  let base = a.replace(TRAIL_PIECES_RE, '');
  if (base === a) base = a.replace(PIECES_STRIP_RE, '');
  base = base.replace(/[\s_\-]+$/, '');
  return base || String(name || '').replace(PIECES_STRIP_RE, '').trim();
}

function isArchived(p) {
  return Boolean(p.archived) || /архив/i.test(String(p.status || ''));
}

// products: [{article, name, barcode, status, archived}]
function buildFamilies(products) {
  const map = new Map();
  const skipped = [];
  for (const p of products) {
    const pieces = parsePieces(p.article, p.name);
    if (!SET_SIZES.includes(pieces)) {
      skipped.push({ article: p.article, reason: `размер набора ${pieces} не из списка` });
      continue;
    }
    if (isArchived(p)) {
      skipped.push({ article: p.article, reason: 'в архиве' });
      continue;
    }
    const weightG = parseArticleWeight(p.article) ?? parseWeightG(p.name) ?? parseWeightG(p.article);
    const base = articleBase(p.article, p.name);
    const stem = dense(base);
    const id = `${stem}|${weightG ?? ''}`;
    let fam = map.get(id);
    if (!fam) {
      fam = { id, stem, base, weightG, members: [], names: new Set() };
      map.set(id, fam);
    }
    fam.members.push({ article: p.article, name: p.name, pieces });
    fam.names.add(String(p.name || '').replace(PIECES_STRIP_RE, ' ').trim());
  }
  const families = [...map.values()].map((f) => {
    f.members.sort((a, b) => a.pieces - b.pieces);
    f.title = [...f.names][0] || f.members[0].article;
    const text = `${[...f.names].join(' ')} ${articleWords(f.base)}`;
    f.tok = new Set(tokens(text));
    f.tri = trigrams(text);
    return f;
  });
  return { families, skipped };
}

// totalPieces — всего штук единиц товара. Возвращает по каждому члену семьи:
// целая часть и остаток от деления. Нулевые наборы не пишем в файл.
function distribute(family, totalPieces) {
  return family.members.map((m) => ({
    article: m.article,
    pieces: m.pieces,
    qty: Math.floor(totalPieces / m.pieces),
    remainder: totalPieces % m.pieces,
  }));
}

module.exports = { SET_SIZES, parseWeightG, parseArticleWeight, articleBase, parsePieces, buildFamilies, distribute };
