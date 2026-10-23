// Нормализация текста для сопоставления названий накладной с каталогом Ozon.

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/н\.\s?п\./g, 'новогодний подарок ')
    .replace(/[«»"'`’]/g, '')
    .replace(/[_.,;:()\[\]\/\\+*-]/g, ' ')
    .replace(/(\d)([a-zа-я])/g, '$1 $2')
    .replace(/([a-zа-я])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

// Плотная форма (только буквы/цифры) — для поиска подстроки в артикуле
// вроде «ЗонаБикини_2шт» по значению «ЗонаБикини».
function dense(s) {
  return norm(s).replace(/[^a-zа-я0-9]/g, '');
}

const STOP = new Set([
  'и', 'с', 'со', 'в', 'на', 'для', 'из', 'по', 'шт', 'г', 'гр', 'кг', 'мл', 'л', 'уп', 'пач',
  'конф', 'кор', 'фас', 'нд', 'кп', 'набор', 'товар', 'ооо', 'новогодний', 'подарок',
]);

// Латиница → кириллица (грубо, одинаково для накладной и каталога): в каталоге
// «Необотаника», в накладной «Neo-botanica».
const LAT = { a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'ж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', y: 'и', z: 'з' };
function translit(s) {
  return String(s).replace(/[a-z]/g, (c) => LAT[c]);
}

function tokens(s) {
  return translit(norm(s))
    .split(' ')
    .filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t));
}

function trigrams(s) {
  const d = ` ${translit(dense(s))} `;
  const set = new Set();
  for (let i = 0; i + 3 <= d.length; i += 1) set.add(d.slice(i, i + 3));
  return set;
}

function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return (2 * inter) / (a.size + b.size);
}

// «200КОМамаПриехала» → «200 КО Мама Приехала» (разбор артикула на слова).
function articleWords(article) {
  return String(article || '')
    .replace(/([а-яa-z])([А-ЯA-Z])/g, '$1 $2')
    .replace(/([А-ЯA-Z])([А-ЯA-Z][а-яa-z])/g, '$1 $2')
    .replace(/_/g, ' ');
}

module.exports = { translit, articleWords, norm, dense, tokens, trigrams, dice };
