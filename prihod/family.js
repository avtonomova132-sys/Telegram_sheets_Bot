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
    const g = lead[2] ? Math.round(v * 1000) : Math.round(v);
    return g <= 5000 ? g : null; // «18162БЕЛЫЙ1000» — размер бирки, не вес
  }
  return null;
}

// Артикул каталога: {вес}{БРЕНД_название}{N}ШТ, напр. 200КОМамаПриехала1ШТ,
// 250КАРАМЕЛЬ_Лимончики_1шт. Штуки — хвост «N шт», вес — число в начале.
// Хвост артикула: «…Ментол1», «…Конфета10», «…_2шт», «…4ШТ» — число штук в
// наборе (одна-две цифры, перед ними не цифра, чтобы не резать вес «…200»).
const TRAIL_PIECES_RE = /[\s_\-]*(?<![0-9])(\d{1,2})\s*(?:шт\.?|pcs)?$/i;

function parsePieces(article, name) {
  const t = TRAIL_PIECES_RE.exec(String(article || '').trim());
  if (t) return Number(t[1]);
  for (const src of [article, name]) {
    const m = PIECES_RE.exec(String(src || ''));
    if (m) return Number(m[1]);
  }
  return 1;
}

const LEAD_WEIGHT_RE = /^\s*(\d+(?:[.,]\d+)?)\s*(кг|kg)?(?=[a-zа-я_])/i;
const MAX_WEIGHT_G = 5000; // «18162БЕЛЫЙ1000» — размер бирки 18×162, а не вес

function leadWeight(article) {
  const m = LEAD_WEIGHT_RE.exec(String(article || ''));
  if (!m) return null;
  const v = Number(m[1].replace(',', '.'));
  const g = m[2] ? Math.round(v * 1000) : Math.round(v);
  return g > 0 && g <= MAX_WEIGHT_G ? { g, match: m[0] } : null;
}

function parseArticleWeight(article) {
  const w = leadWeight(article);
  return w ? w.g : null;
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

// Вес «внутри» артикула: Маска300СВафлями → 300 (последний запасной признак).
function embeddedWeight(article) {
  const m = /(?<![0-9])(\d{2,4})(?=[A-Za-zА-Яа-я])/.exec(String(article || ''));
  const v = m ? Number(m[1]) : null;
  return v !== null && v >= 20 && v <= 5000 ? v : null;
}

// Основа без ведущего веса: 200КОМамаПриехала → КОМамаПриехала. Так члены
// семьи, у которых вес в артикуле записан не везде, не расходятся по разным семьям.
function baseNoWeight(base) {
  const w = leadWeight(base);
  return w ? base.slice(w.match.length) : base;
}

// products: [{article, name, barcode, status, archived}]
function buildFamilies(products) {
  const byStem = new Map();
  const skipped = [];
  for (const p of products) {
    const pieces = parsePieces(p.article, p.name);
    if (!SET_SIZES.includes(pieces)) {
      skipped.push({ article: p.article, reason: `размер набора ${pieces} не из списка ${SET_SIZES.join('/')}` });
      continue;
    }
    if (isArchived(p)) {
      skipped.push({ article: p.article, reason: 'в архиве' });
      continue;
    }
    // Вес из артикула надёжнее названия (в названии бывают вес штуки, коробки и т.п.).
    const weightG = parseArticleWeight(p.article) ?? embeddedWeight(articleBase(p.article, p.name)) ?? parseWeightG(p.name) ?? parseWeightG(p.article);
    const base = articleBase(p.article, p.name);
    const key = dense(baseNoWeight(base)) || dense(base);
    if (!byStem.has(key)) byStem.set(key, []);
    byStem.get(key).push({ p, pieces, weightG, base });
  }
  // Внутри одной основы вес должен быть один: безвесовые члены присоединяются
  // к единственному известному весу; два разных веса — две семьи.
  const map = new Map();
  for (const [key, list] of byStem) {
    const known = [...new Set(list.map((x) => x.weightG).filter((w) => w !== null))];
    for (const x of list) {
      const w = known.length === 1 ? known[0] : x.weightG;
      const id = `${key}|${w ?? ''}`;
      let fam = map.get(id);
      if (!fam) {
        fam = { id, key, stem: dense(x.base), stems: new Set(), base: x.base, weightG: w, members: [], names: new Set() };
        map.set(id, fam);
      }
      fam.stems.add(dense(x.base));
      fam.members.push({ article: x.p.article, name: x.p.name, pieces: x.pieces });
      fam.names.add(String(x.p.name || '').replace(PIECES_STRIP_RE, ' ').trim());
    }
  }
  const families = [...map.values()].map((f) => {
    f.stems = [...f.stems];
    f.members.sort((a, b) => a.pieces - b.pieces);
    // Одно число штук — один артикул (дубли в каталоге не удваивают разнос).
    f.members = f.members.filter((m, i, arr) => i === 0 || m.pieces !== arr[i - 1].pieces);
    f.title = [...f.names][0] || f.members[0].article;
    const text = `${[...f.names].join(' ')} ${articleWords(f.base)}`;
    f.tok = new Set(tokens(text));
    f.tri = trigrams(text);
    return f;
  });
  return { families, skipped };
}

// Поиск артикула, введённого Еленой: точный offer_id → его семья.
function findFamilyByArticle(families, text) {
  const want = dense(text);
  if (!want) return null;
  for (const f of families) if (f.members.some((m) => dense(m.article) === want)) return f;
  const byBase = families.filter((f) => f.stems.some((s) => s === want));
  return byBase.length === 1 ? byBase[0] : null;
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

module.exports = { baseNoWeight, findFamilyByArticle, SET_SIZES, parseWeightG, parseArticleWeight, articleBase, parsePieces, buildFamilies, distribute };
