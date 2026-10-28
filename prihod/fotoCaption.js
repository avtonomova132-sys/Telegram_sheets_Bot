// Подпись склада к фото этикетки → количество. Только код, без модели.
// «5», «Остаток-2 шт», «Ост 0» → число; «Остаток-1 нет», несколько разных
// чисел, дробь, слово без числа → ambiguous (бот спрашивает кнопками).
// Даты срока годности, вес/объём и прочие пометки количеством не считаются.

const WORKERS = [
  { re: /ирин\w*/i, name: 'Ирина' },
  { re: /марин\w*/i, name: 'Марина' },
  { re: /алин\w*/i, name: 'Алина' },
];

// 28.03, 28.03.27, 12.2027, 12/27, «до 2027», «годен до …»
const DATE_RES = [
  /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g,
  /\b\d{1,2}[./]\d{2,4}\b/g,
  /(?:годен|срок\w*|до|bb|exp)\s*(?:до)?\s*[:\-]?\s*\d{2,4}/gi,
];
// «100 г», «250гр», «1,5 кг», «500 мл» — вес на этикетке, не остаток
const UNIT_RE = /\d+(?:[.,]\d+)?\s*(?:кг|гр|г|мг|мл|л|kg|g|ml)(?![a-zа-я])/gi;
// слова-отрицания рядом с числом делают подпись неоднозначной
const NEG_RE = /(?:^|[^а-яё])(?:нет|нету|закончил\w*|кончил\w*|отсутств\w*)(?![а-яё])/i;

function findAuthor(text) {
  for (const w of WORKERS) if (w.re.test(text)) return w.name;
  return null;
}

function parseCaption(raw) {
  const original = String(raw || '').trim();
  if (!original) return { state: 'empty', author: null };
  const author = findAuthor(original);
  let s = original.toLowerCase().replace(/ё/g, 'е');
  for (const re of DATE_RES) s = s.replace(re, ' ');
  s = s.replace(UNIT_RE, ' ');
  // «Остаток-2», «ост:5», «ост 0» — дефис/двоеточие перед числом не минус
  const nums = [];
  let fractional = false;
  for (const m of s.matchAll(/(\d+)(?:[.,](\d+))?/g)) {
    if (m[2] !== undefined && Number(m[2]) !== 0) fractional = true;
    nums.push(Number(m[1]));
  }
  const distinct = [...new Set(nums)];
  const neg = NEG_RE.test(s);
  if (!nums.length) return { state: 'ambiguous', author, text: original, numbers: neg ? [0] : [], why: neg ? 'есть слово «нет», но нет числа' : 'в подписи нет числа' };
  if (fractional) return { state: 'ambiguous', author, text: original, numbers: distinct, why: 'дробное число' };
  if (distinct.length > 1) return { state: 'ambiguous', author, text: original, numbers: distinct, why: 'несколько чисел' };
  if (neg && distinct[0] !== 0) return { state: 'ambiguous', author, text: original, numbers: [...distinct, 0], why: `«${original}»: число и слово «нет»` };
  if (distinct[0] > 100000) return { state: 'ambiguous', author, text: original, numbers: distinct, why: 'слишком большое число' };
  return { state: 'ok', author, value: distinct[0], text: original };
}

// Число, присланное отдельным сообщением: «4», «4 шт», «0».
function parseBareNumber(raw) {
  const m = /^\s*(\d{1,5})\s*(?:шт\.?|штук\w*)?\s*$/i.exec(String(raw || ''));
  return m ? Number(m[1]) : null;
}

module.exports = { parseCaption, parseBareNumber, findAuthor };
