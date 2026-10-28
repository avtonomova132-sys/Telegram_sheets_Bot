// Поиск товара по АРТИКУЛУ ПОСТАВЩИКА из «Номенклатуры» (столбец «Артикул
// ПОСТАВЩИК», AB). Тот же код напечатан в накладной в колонке «код»
// (РФ25204D108, КО19986R113): в Номенклатуре хранится его начало
// «две буквы + пять цифр» (РФ25204), хвост (D108) — партия.
//
// Доступ: ТОЛЬКО сервисный аккаунт (GOOGLE_SERVICE_ACCOUNT_JSON, «Читатель»).
// Публичную ссылку/CSV не используем — таблица содержит закупочные цены.
// Читаем только 4 колонки по заголовкам (Артикул, Баркод, Количество в наборе,
// Артикул ПОСТАВЩИК) отдельными диапазонами; столбец с ценами не запрашивается,
// ничего на диск не пишется (кэш только в памяти).

const fs = require('fs');
const path = require('path');
const nomenclature = require('../nomenclature');
const { findFamilyByArticle } = require('./family');
const { weightOk } = require('./weight');
const { dense } = require('./text');
const { normBarcode } = require('./barcode');

const SPREADSHEET_ID = process.env.NOMENCLATURE_SPREADSHEET_ID || '16Mq06mwMN9zALJaioiFdBaEe7ucGDBF0Dxp_d6-ti6w';
const TAB_GID = process.env.NOMENCLATURE_GID || '38517625';
const CACHE_MS = 60 * 60 * 1000;
const FETCH_MS = 40000;

// Заголовки первой строки → поле. Колонки находим по заголовку, а не по букве.
const COLS = [
  { key: 'article', header: /^артикул$/i, label: 'Артикул (D)' },
  { key: 'barcode', header: /^(баркод|штрих)/i, label: 'Баркод (F)' },
  { key: 'pieces', header: /количество\s+в\s+наборе/i, label: 'Количество в наборе (W)' },
  { key: 'supplier', header: /артикул\s+поставщик/i, label: 'Артикул ПОСТАВЩИК (AB)' },
];

class SupplierAccessError extends Error {}

// Запасной источник без Google: готовый срез Номенклатуры (только артикул,
// кол-во в наборе, артикул поставщика — БЕЗ цен и баркодов).
// Порядок: /data/supplier_codes.json (на томе, правится без деплоя), затем
// prihod/data/supplier_codes.json (в репозитории, если его туда положили).
const FILE_PATHS = [
  process.env.SUPPLIER_CODES_PATH || '/data/supplier_codes.json',
  path.join(__dirname, 'data', 'supplier_codes.json'),
];

function readSnapshot() {
  for (const p of FILE_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const list = Array.isArray(data) ? data : data.rows;
      if (!Array.isArray(list) || !list.length) continue;
      return list.map((r) => (Array.isArray(r)
        ? { article: clean(r[0]), pieces: clean(r[1]), supplier: clean(r[2]) }
        : { article: clean(r.article), pieces: clean(r.pieces), supplier: clean(r.supplier) }))
        .filter((r) => r.article);
    } catch (err) {
      console.error('[supplier] не прочитала', p, err.message);
    }
  }
  return null;
}

// Латиница, похожая на кириллицу (в накладных «K» бывает латинской) → кириллица.
const LAT2CYR = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У' };
const CODE_RE = /^([А-ЯЁ]{2}\d{5})/;

// Начало кода «две буквы + пять цифр», либо null (в AB у крафта/косметики
// стоит текст-название — по нему код накладной не ищем).
function supplierKey(raw) {
  const s = String(raw ?? '').replace(/\s+/g, '').toUpperCase().replace(/[A-Z]/g, (c) => LAT2CYR[c] || c);
  const m = CODE_RE.exec(s);
  return m ? m[1] : null;
}

// У крафта/бирок/косметики в AB стоит не код, а название товара поставщика
// («Бирка садовая 18х162, белая, 1000 шт, вт. 40»). Сравниваем с названием
// строки накладной после нормализации: размеры 18х162 = 18x162, без «вт. 40».
function textKey(raw) {
  const t = String(raw ?? '')
    .toLowerCase()
    .replace(/(\d)\s*[xх×*]\s*(\d)/g, '$1x$2')
    .replace(/[,;]?\s*вт\.?\s*\d+/g, ' ');
  const d = dense(t);
  return d.length >= 8 ? d : null;
}

function colLetter(i) {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function fetchWithTimeout(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// Чтение четырёх колонок. Возвращает строки {article, barcode, pieces, supplier}.
async function fetchColumns() {
  const sa = nomenclature.loadServiceAccount();
  if (!sa) {
    const snap = readSnapshot();
    if (snap) { source = 'file'; return snap; }
    throw new SupplierAccessError('нужен GOOGLE_SERVICE_ACCOUNT_JSON (сервисный аккаунт с доступом «Читатель» к Номенклатуре) — публичную ссылку не использую, в таблице закупочные цены');
  }
  source = 'sheet';
  const token = await nomenclature.getAccessToken(sa);
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}`;
  const metaRes = await fetchWithTimeout(`${base}?fields=sheets.properties(sheetId,title)`, auth);
  if (metaRes.status === 403 || metaRes.status === 404) {
    throw new SupplierAccessError(`нет доступа к Номенклатуре: дай доступ «Читатель» на ${sa.client_email}`);
  }
  if (!metaRes.ok) throw new Error(`Sheets API HTTP ${metaRes.status}`);
  const sheet = ((await metaRes.json()).sheets || []).map((s) => s.properties).find((s) => String(s.sheetId) === String(TAB_GID));
  if (!sheet) throw new Error(`лист gid ${TAB_GID} не найден в Номенклатуре`);
  const tab = `'${sheet.title.replace(/'/g, "''")}'`;

  // 1) только заголовки (первая строка)
  const headRes = await fetchWithTimeout(`${base}/values/${encodeURIComponent(`${tab}!1:1`)}?valueRenderOption=FORMATTED_VALUE`, auth);
  if (!headRes.ok) throw new Error(`Sheets API HTTP ${headRes.status}`);
  const header = ((await headRes.json()).values || [[]])[0] || [];
  const pos = {};
  for (const c of COLS) {
    const i = header.findIndex((h) => c.header.test(clean(h)));
    if (i < 0) throw new Error(`в Номенклатуре нет столбца «${c.label}» — структура таблицы изменилась`);
    pos[c.key] = i;
  }

  // 2) только нужные колонки отдельными диапазонами (цены не запрашиваются)
  const q = COLS.map((c) => `ranges=${encodeURIComponent(`${tab}!${colLetter(pos[c.key])}2:${colLetter(pos[c.key])}`)}`).join('&');
  const res = await fetchWithTimeout(`${base}/values:batchGet?${q}&majorDimension=COLUMNS&valueRenderOption=FORMATTED_VALUE`, auth);
  if (!res.ok) throw new Error(`Sheets API HTTP ${res.status}`);
  const ranges = (await res.json()).valueRanges || [];
  const cols = {};
  COLS.forEach((c, k) => { cols[c.key] = (ranges[k] && ranges[k].values && ranges[k].values[0]) || []; });
  const n = Math.max(...Object.values(cols).map((a) => a.length));
  const rows = [];
  for (let r = 0; r < n; r += 1) {
    const article = clean(cols.article[r]);
    if (!article) continue;
    rows.push({ article, barcode: clean(cols.barcode[r]), pieces: clean(cols.pieces[r]), supplier: clean(cols.supplier[r]) });
  }
  return rows;
}

let source = 'sheet'; // 'sheet' | 'file' — откуда прочитан последний раз
let cache = null; // { at, index, stats }
let lastError = null;

function buildIndex(rows) {
  const index = new Map(); // ключ кода → [{article, pieces}]
  const textIndex = new Map(); // нормализованное название → [{article, pieces}]
  const barIndex = new Map(); // нормализованный штрихкод (столбец F) → [артикул]
  let filled = 0;
  let codeForm = 0;
  for (const r of rows) {
    const bc = normBarcode(r.barcode);
    if (bc) { if (!barIndex.has(bc)) barIndex.set(bc, []); barIndex.get(bc).push(r.article); }
    if (r.supplier) filled += 1;
    const entry = { article: r.article, pieces: Number(String(r.pieces).replace(',', '.')) || null };
    const k = supplierKey(r.supplier);
    if (!k) {
      const tk = r.supplier ? textKey(r.supplier) : null;
      if (tk) { if (!textIndex.has(tk)) textIndex.set(tk, []); textIndex.get(tk).push(entry); }
      continue;
    }
    codeForm += 1;
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(entry);
  }
  const total = rows.length;
  return {
    index,
    textIndex,
    barIndex,
    stats: { total, filled, empty: total - filled, codeForm, textOnly: filled - codeForm, codes: index.size, texts: textIndex.size },
  };
}

async function load({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache;
  try {
    const { index, textIndex, barIndex, stats } = buildIndex(await fetchColumns());
    cache = { at: Date.now(), index, textIndex, barIndex, stats };
    lastError = null;
    return cache;
  } catch (err) {
    lastError = err;
    throw err;
  }
}

// Семьи Озона по коду из накладной. status: 'matched' | 'ambiguous' | 'none'.
// none = кода нет в AB или его артикулов нет в каталоге Озона → ищем по названию.
async function resolve(line, families) {
  const { index, textIndex } = await load();
  const key = supplierKey(line.supplierCode);
  let entries = key ? index.get(key) : null;
  let how = key ? `код поставщика ${key}` : '';
  if (!entries || !entries.length) {
    const tk = textKey(line.name);
    entries = tk ? textIndex.get(tk) : null;
    how = 'название поставщика из Номенклатуры';
  }
  if (!entries || !entries.length) {
    return { status: 'none', why: key ? `код ${key} и название не найдены в Номенклатуре` : 'нет кода поставщика, название не найдено в AB' };
  }

  const fams = [];
  for (const e of entries) {
    const f = findFamilyByArticle(families, e.article);
    if (f && !fams.includes(f)) fams.push(f);
  }
  if (!fams.length) return { status: 'none', why: `артикулов из Номенклатуры (${how}) нет в каталоге Озона` };

  // Один код у нескольких весов/товаров: оставляем только тот же вес, что в накладной.
  let list = fams;
  if (line.unitWeightG && list.some((f) => f.weightG)) {
    const byW = list.filter((f) => weightOk(line.unitWeightG, f.weightG));
    if (byW.length) list = byW;
  }
  if (list.length === 1) return { status: 'matched', family: list[0], via: how, key };
  return { status: 'ambiguous', options: list.slice(0, 4), via: `${how}: несколько товаров`, key };
}

// Для /приход_коды: сколько строк Номенклатуры, где поиск по коду работает.
async function coverage() {
  const { stats } = await load({ force: true });
  return stats;
}

// E-mail сервисного аккаунта (не секрет) — чтобы Елена знала, кому дать доступ «Читатель».
function accountEmail() {
  const sa = nomenclature.loadServiceAccount();
  return sa ? sa.client_email : null;
}

// Артикулы Озона (столбец D) по штрихкоду из столбца F Номенклатуры. Нет доступа
// к таблице — [] (поиск идёт дальше по каталогу Озона и «Арт:» с этикетки).
async function articlesByBarcode(barcode) {
  const key = normBarcode(barcode);
  if (!key) return [];
  const { barIndex } = await load();
  return (barIndex && barIndex.get(key)) || [];
}

function status() {
  return { lastError, loadedAt: cache ? cache.at : null, source };
}

// Только для тестов: подставить готовый индекс вместо чтения таблицы.
function _setIndex(rows) {
  const { index, textIndex, barIndex, stats } = buildIndex(rows);
  cache = { at: Date.now(), index, textIndex, barIndex, stats };
  lastError = null;
}

module.exports = { articlesByBarcode, accountEmail, _setIndex, supplierKey, resolve, coverage, status, load, buildIndex, colLetter, SupplierAccessError };
