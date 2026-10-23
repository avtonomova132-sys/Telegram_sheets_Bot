// Семьи артикулов и разнос количества — только код, без модели.
// Семья = все карточки одного товара с ОДИНАКОВЫМ весом единицы, отличающиеся
// числом штук в наборе (1/2/3/4/5/6/8/10/12/20 шт).

const { norm, dense, tokens, trigrams } = require('./text');

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

function parsePieces(article, name) {
  for (const src of [article, name]) {
    const m = PIECES_RE.exec(String(src || ''));
    if (m) return Number(m[1]);
  }
  return 1;
}

function stem(article, name) {
  const a = String(article || '').replace(PIECES_STRIP_RE, '');
  return dense(a) || dense(String(name || '').replace(PIECES_STRIP_RE, ''));
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
    const weightG = parseWeightG(p.name) ?? parseWeightG(p.article);
    const id = `${stem(p.article, p.name)}|${weightG ?? ''}`;
    let fam = map.get(id);
    if (!fam) {
      fam = { id, stem: stem(p.article, p.name), weightG, members: [], names: new Set() };
      map.set(id, fam);
    }
    fam.members.push({ article: p.article, name: p.name, pieces });
    fam.names.add(String(p.name || '').replace(PIECES_STRIP_RE, ' ').trim());
  }
  const families = [...map.values()].map((f) => {
    f.members.sort((a, b) => a.pieces - b.pieces);
    f.title = [...f.names][0] || f.members[0].article;
    const text = `${[...f.names].join(' ')} ${f.members.map((m) => m.article).join(' ')}`;
    f.tok = new Set(tokens(text));
    f.tri = trigrams([...f.names].join(' ') + ' ' + f.members[0].article);
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

module.exports = { SET_SIZES, parseWeightG, parsePieces, buildFamilies, distribute };
