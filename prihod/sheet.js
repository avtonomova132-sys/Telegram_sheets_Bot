// Чтение вкладки «Срок годности, остаток ( наш склад )» таблицы «Склад Заказы»
// (только чтение). Доступ как у «Номенклатуры»: сервисный аккаунт
// GOOGLE_SERVICE_ACCOUNT_JSON (Sheets API) или публичная ссылка (CSV).

const nomenclature = require('../nomenclature');
const { parseCsv, csvUrl } = require('../report');
const { SPREADSHEET_ID, TAB_GID, TAB_TITLE_RE } = require('./ostatki');

class SheetAccessError extends Error {}

async function fetchWithTimeout(url, ms, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// Колонки: A Артикул, C Предмет, E Бренд, G Остаток наш склад. Строка 2 —
// заголовки; не совпали — структура изменилась, читать молча не будем.
function checkHeader(row) {
  const h = row || [];
  if (!/артикул/i.test(clean(h[0])) || !/остаток/i.test(clean(h[6]))) {
    throw new Error(`структура вкладки изменилась: в строке 2 жду «Артикул» в колонке A и «Остаток…» в G, а вижу «${clean(h[0])}» и «${clean(h[6])}»`);
  }
}

function toRows(values, from) {
  return values.map((v, i) => ({
    row: from + i,
    article: clean(v[0]),
    subject: clean(v[2]),
    brand: clean(v[4]),
    qtyRaw: v[6] ?? '',
  }));
}

async function viaApi(sa, from, to) {
  const token = await nomenclature.getAccessToken(sa);
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const metaRes = await fetchWithTimeout(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties(sheetId,title)`, 40000, auth);
  if (metaRes.status === 403 || metaRes.status === 404) {
    throw new SheetAccessError(`нет доступа к таблице «Склад Заказы»: дай доступ «Читатель» на ${sa.client_email}`);
  }
  if (!metaRes.ok) throw new Error(`Sheets API HTTP ${metaRes.status}`);
  const sheets = ((await metaRes.json()).sheets || []).map((s) => s.properties);
  // gid из ссылки Елены, но только если это именно нужная вкладка; иначе ищем по названию.
  const byGid = sheets.find((s) => String(s.sheetId) === String(TAB_GID));
  const tab = byGid && TAB_TITLE_RE.test(byGid.title) ? byGid : sheets.find((s) => TAB_TITLE_RE.test(s.title));
  if (!tab) throw new Error('в таблице нет вкладки «Срок годности, остаток ( наш склад )»');
  const q = (r) => `ranges=${encodeURIComponent(`'${tab.title.replace(/'/g, "''")}'!${r}`)}`;
  const res = await fetchWithTimeout(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values:batchGet?${q('A2:H2')}&${q(`A${from}:H${to}`)}&valueRenderOption=FORMATTED_VALUE`, 40000, auth);
  if (!res.ok) throw new Error(`Sheets API HTTP ${res.status}`);
  const [head, body] = (await res.json()).valueRanges || [];
  checkHeader((head.values || [])[0]);
  return { rows: toRows(body.values || [], from), tab: tab.title, gidMatched: Boolean(byGid && byGid === tab) };
}

async function viaCsv(from, to) {
  const res = await fetchWithTimeout(csvUrl(SPREADSHEET_ID, TAB_GID), 40000);
  const ct = res.headers.get('content-type') || '';
  if ([401, 403, 404].includes(res.status) || /text\/html/i.test(ct)) {
    throw new SheetAccessError('нет доступа к таблице «Склад Заказы»: открой её по ссылке («Все, у кого есть ссылка» → Читатель) или добавь в Railway GOOGLE_SERVICE_ACCOUNT_JSON и дай доступ «Читатель» на email сервисного аккаунта');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const all = parseCsv(await res.text());
  checkHeader(all[1]);
  const slice = [];
  for (let r = from; r <= to; r += 1) slice.push(all[r - 1] || []);
  return { rows: toRows(slice, from), tab: `gid ${TAB_GID}`, gidMatched: true };
}

async function fetchRange(from, to) {
  const sa = nomenclature.loadServiceAccount();
  return sa ? viaApi(sa, from, to) : viaCsv(from, to);
}

module.exports = { fetchRange, SheetAccessError, checkHeader, toRows };
