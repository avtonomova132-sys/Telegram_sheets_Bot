const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// /data — тот же примонтированный Railway Volume, что уже используется для
// прогресса стихов и передач (см. verse/progress.js, peredachi/store.js).
// Файл всегда хранится как CSV независимо от формата загрузки (CSV/XLSX) —
// так его проще открыть руками для проверки, если что-то пошло не так.
const ARTICLES_PATH = process.env.ARTICLES_PATH || '/data/articles.csv';

// Разные названия одной и той же колонки в реальных выгрузках Ozon и в
// файлах, которые готовят вручную — сравниваем без учёта регистра/пробелов.
const ARTICLE_HEADER_ALIASES = ['артикул', 'арт', 'арт.'];
const SKU_HEADER_ALIASES = ['sku'];
const NAME_HEADER_ALIASES = ['название', 'название товара', 'наименование', 'name'];

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase();
}

// Excel/WPS иногда подставляет ведущий апостроф перед значением, чтобы
// принудительно хранить его как текст (встречается в выгрузках Ozon,
// пересохранённых в Excel) — убираем, иначе точное сравнение с артикулом
// на фото не сработает.
function cleanValue(v) {
  return String(v ?? '').trim().replace(/^'/, '');
}

function findHeaderKey(headers, aliases) {
  return headers.find((h) => aliases.includes(normalizeHeader(h)));
}

// Разбирает буфер CSV или Excel-файла (XLSX сам определяет формат и
// разделитель CSV по содержимому) и приводит строки к виду
// {article, sku, name}. Бросает понятную ошибку, если не нашлись
// обязательные колонки.
function parseArticlesBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('в файле нет ни одного листа');
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  if (rows.length === 0) {
    throw new Error('файл пустой или не удалось прочитать строки');
  }

  const headers = Object.keys(rows[0]);
  const articleKey = findHeaderKey(headers, ARTICLE_HEADER_ALIASES);
  const skuKey = findHeaderKey(headers, SKU_HEADER_ALIASES);
  const nameKey = findHeaderKey(headers, NAME_HEADER_ALIASES);

  if (!articleKey || !skuKey) {
    throw new Error('не найдены обязательные колонки "Артикул" и/или "SKU" — проверь заголовки в первой строке файла');
  }

  return rows
    .map((row) => ({
      article: cleanValue(row[articleKey]),
      sku: cleanValue(row[skuKey]),
      name: nameKey ? cleanValue(row[nameKey]) : '',
    }))
    .filter((r) => r.article && r.sku);
}

// Перезаписывает /data/articles.csv нормализованным содержимым (колонки
// Артикул/SKU/Название), атомарно (tmp + rename), как остальные хранилища
// на volume. Возвращает количество сохранённых строк.
function saveArticlesFile(buffer) {
  const records = parseArticlesBuffer(buffer);
  if (records.length === 0) {
    throw new Error('в файле не нашлось ни одной строки с заполненными Артикул и SKU');
  }

  const sheet = XLSX.utils.json_to_sheet(
    records.map((r) => ({ Артикул: r.article, SKU: r.sku, Название: r.name }))
  );
  const csv = XLSX.utils.sheet_to_csv(sheet);

  fs.mkdirSync(path.dirname(ARTICLES_PATH), { recursive: true });
  const tmpPath = `${ARTICLES_PATH}.tmp`;
  fs.writeFileSync(tmpPath, csv, 'utf8');
  fs.renameSync(tmpPath, ARTICLES_PATH);

  return records.length;
}

function readArticles() {
  let text;
  try {
    text = fs.readFileSync(ARTICLES_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      const notLoaded = new Error('список артикулов ещё не загружен');
      notLoaded.code = 'ARTICLES_NOT_LOADED';
      throw notLoaded;
    }
    throw err;
  }

  const workbook = XLSX.read(text, { type: 'string' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  return rows.map((row) => ({
    article: cleanValue(row['Артикул']),
    sku: cleanValue(row['SKU']),
    name: cleanValue(row['Название']),
  }));
}

// Точное совпадение по артикулу (без учёта регистра и краевых пробелов).
// Кидает ошибку с кодом ARTICLES_NOT_LOADED, если файл ещё не загружали.
function findArticle(articleId) {
  const rows = readArticles();
  const target = String(articleId || '').trim().toLowerCase();
  const found = rows.find((r) => r.article.toLowerCase() === target);
  return found ? { sku: found.sku, name: found.name } : null;
}

module.exports = { saveArticlesFile, findArticle, ARTICLES_PATH };
