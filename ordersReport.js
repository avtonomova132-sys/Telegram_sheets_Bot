// Отчёты «Заказы с моих складов» / «Заказы со складов ОЗОН» → Google-таблица.
// Этап 1 (диагностика, только чтение): /заказы_шапка и /заказы_ozon_поля.
// Таблица по умолчанию — КОПИЯ для теста; боевую подключаем только переменной
// ORDERS_SPREADSHEET_ID после сверки Еленой. Бот только читает из Озона.
const crypto = require('crypto');
const nomenclature = require('./nomenclature');

const SPREADSHEET_ID = process.env.ORDERS_SPREADSHEET_ID || '1v9f-rGyGan8hMRZ80UvX_855JxW9sxnLFS7I5SBs7jo';
const OZON_HOST = process.env.OZON_API_HOST || 'https://api-seller.ozon.ru';
const TABS = { fbs: 'Заказы с моих складов', fbo: 'Заказы со складов ОЗОН' };

let tokenCache = { token: null, exp: 0 };
async function getToken(sa) {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${sig}`,
  });
  if (!res.ok) throw new Error(`OAuth HTTP ${res.status}`);
  const json = await res.json();
  tokenCache = { token: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return tokenCache.token;
}

async function readRange(tab, range) {
  const sa = nomenclature.loadServiceAccount();
  if (!sa) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON не задан');
  const token = await getToken(sa);
  const a1 = encodeURIComponent(`'${tab}'!${range}`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${a1}?valueRenderOption=FORMATTED_VALUE`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (res.status === 403 || res.status === 404) {
    throw new Error(`нет доступа к таблице — дай доступ редактора на ${sa.client_email}`);
  }
  if (!res.ok) throw new Error(`Sheets HTTP ${res.status}`);
  return (await res.json()).values || [];
}

function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Шапка (строки 1–3) и первая строка данных каждой вкладки: колонка → текст.
async function headersMessage() {
  const parts = [];
  for (const tab of Object.values(TABS)) {
    const rows = await readRange(tab, 'A1:BZ4');
    const lines = [`📄 ${tab}`];
    rows.forEach((row, r) => {
      const cells = row
        .map((v, c) => (String(v).trim() ? `${colName(c)}${r + 1}=${String(v).replace(/\s+/g, ' ').slice(0, 40)}` : null))
        .filter(Boolean);
      lines.push(cells.length ? cells.join(' | ') : `(строка ${r + 1} пустая)`);
    });
    parts.push(lines.join('\n'));
  }
  return `Таблица ${SPREADSHEET_ID}\n\n${parts.join('\n\n')}`;
}

async function ozonPost(endpoint, body) {
  const res = await fetch(`${OZON_HOST}${endpoint}`, {
    method: 'POST',
    headers: {
      'Client-Id': String(process.env.OZON_CLIENT_ID).trim(),
      'Api-Key': String(process.env.OZON_API_KEY).trim(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ozon ${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// Пути полей ответа с типом значения (самих значений не показываем — там данные покупателей).
function fieldPaths(obj, prefix = '', out = []) {
  if (Array.isArray(obj)) {
    if (obj.length) fieldPaths(obj[0], `${prefix}[]`, out);
    else out.push(`${prefix}[] (пусто)`);
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) fieldPaths(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.push(`${prefix}: ${obj === null ? 'null' : typeof obj}`);
  }
  return out;
}

async function ozonFieldsMessage() {
  const to = new Date();
  const since = new Date(to.getTime() - 30 * 86400000);
  const range = { since: since.toISOString(), to: to.toISOString() };
  const lines = [];
  try {
    const r = await ozonPost('/v3/posting/fbs/list', {
      dir: 'DESC', filter: range, limit: 1, offset: 0,
      with: { analytics_data: true, financial_data: true },
    });
    const p = (r.result?.postings || [])[0];
    lines.push('FBS /v3/posting/fbs/list:', ...(p ? fieldPaths(p) : ['(нет отправлений за 30 дн.)']));
  } catch (e) { lines.push(`FBS: ${e.message}`); }
  lines.push('');
  try {
    const r = await ozonPost('/v2/posting/fbo/list', {
      dir: 'DESC', filter: range, limit: 1, offset: 0,
      with: { analytics_data: true, financial_data: true },
    });
    const p = (r.result || [])[0];
    lines.push('FBO /v2/posting/fbo/list:', ...(p ? fieldPaths(p) : ['(нет отправлений за 30 дн.)']));
  } catch (e) { lines.push(`FBO: ${e.message}`); }
  return lines.join('\n');
}


// ---- Проба методов Озона (только чтение/формирование отчёта) ----
async function ozonRaw(endpoint, body) {
  const res = await fetch(`${OZON_HOST}${endpoint}`, {
    method: 'POST',
    headers: {
      'Client-Id': String(process.env.OZON_CLIENT_ID).trim(),
      'Api-Key': String(process.env.OZON_API_KEY).trim(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не JSON */ }
  return { status: res.status, text, json };
}

function csvHeader(text) {
  const line = text.replace(/^\uFEFF/, '').split(/\r?\n/)[0] || '';
  const sep = line.includes(';') ? ';' : ',';
  return line.split(sep).map((c) => c.replace(/^"|"$/g, '').trim());
}

async function probeMethods() {
  const day = 86400000;
  const range = { since: new Date(Date.now() - 3 * day).toISOString(), to: new Date().toISOString() };
  const lines = ['Какие методы списков отвечают (только статус):'];
  for (const ep of ['/v3/posting/fbs/list', '/v4/posting/fbs/list', '/v2/posting/fbo/list', '/v3/posting/fbo/list', '/v4/posting/fbo/list']) {
    const r = await ozonRaw(ep, { dir: 'ASC', filter: range, limit: 1, offset: 0 });
    lines.push(`${ep} → HTTP ${r.status} ${r.status === 200 ? 'OK' : r.text.slice(0, 120)}`);
  }
  return lines.join('\n');
}

// Формирует «Отчёт об отправлениях» (аналог выгрузки кабинета) и сравнивает его шапку со строкой 2 вкладки.
async function probeReport(schema) {
  const tab = schema === 'fbs' ? TABS.fbs : TABS.fbo;
  const day = 86400000;
  const from = new Date(Date.now() - 3 * day);
  const to = new Date(Date.now() - day);
  const created = await ozonRaw('/v1/report/postings/create', {
    filter: { processed_at_from: from.toISOString(), processed_at_to: to.toISOString(), delivery_schema: [schema] },
    language: 'DEFAULT',
  });
  const code = created.json?.result?.code;
  if (!code) return `${schema.toUpperCase()}: отчёт не создан, HTTP ${created.status} ${created.text.slice(0, 200)}`;
  let info = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    info = await ozonRaw('/v1/report/info', { code });
    const st = info.json?.result?.status;
    if (st === 'success' || st === 'failed') break;
  }
  const result = info?.json?.result;
  if (result?.status !== 'success' || !result.file) return `${schema.toUpperCase()}: отчёт не готов (${result?.status || info?.status}) ${result?.error || ''}`;
  const file = await fetch(result.file, { signal: AbortSignal.timeout(60000) });
  const header = csvHeader(await file.text());
  const sheet = ((await readRange(tab, 'A2:BZ2'))[0] || []).map((c) => String(c).trim());
  const missing = header.filter((h) => !sheet.includes(h));
  const absent = sheet.filter((h) => h && !header.includes(h));
  return [
    `${schema.toUpperCase()}: колонок в отчёте API ${header.length}, в строке 2 вкладки «${tab}» ${sheet.filter(Boolean).length}`,
    `Порядок совпадает: ${header.every((h, i) => h === sheet[i]) ? 'да' : 'нет'}`,
    `Есть в API, нет во вкладке: ${missing.join(', ') || '—'}`,
    `Есть во вкладке, нет в API: ${absent.join(', ') || '—'}`,
    `Шапка API: ${header.join(' | ')}`,
  ].join('\n');
}

async function reportProbeMessage() {
  const out = [await probeMethods(), ''];
  for (const schema of ['fbs', 'fbo']) {
    try { out.push(await probeReport(schema), ''); } catch (e) { out.push(`${schema.toUpperCase()}: ${e.message}`, ''); }
  }
  return out.join('\n');
}


// ---- Зависимости: какие столбцы двух вкладок используют формулы других вкладок ----
function colIndex(letters) {
  return letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

async function sheetsGet(path) {
  const sa = nomenclature.loadServiceAccount();
  if (!sa) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON не задан');
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}${path}`, {
    headers: { Authorization: `Bearer ${await getToken(sa)}` },
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`Sheets HTTP ${res.status}`);
  return res.json();
}

async function dependenciesMessage() {
  const meta = await sheetsGet('?fields=sheets.properties(title,gridProperties(rowCount,columnCount)),namedRanges(name,range)');
  const titles = meta.sheets.map((x) => x.properties.title);
  const names = Object.values(TABS);
  const headers = {};
  for (const t of names) headers[t] = ((await readRange(t, 'A2:BZ2'))[0] || []).map((c) => String(c).trim());

  const refRe = new RegExp(
    `(?:'(${names.join('|')})'|(${names.map((n) => n.replace(/\s/g, '\\s')).join('|')}))!\\$?([A-Z]{1,3})(?:\\$?\\d+)?(?::\\$?([A-Z]{1,3})(?:\\$?\\d+)?)?`,
    'g'
  );
  const found = {}; // 'вкладка-потребитель → вкладка-источник' → {cols:Set, count, sample}
  let scanned = 0;
  for (const t of titles) {
    const rows = (await sheetsGet(`/values/${encodeURIComponent(`'${t}'!A1:CZ`)}?valueRenderOption=FORMULA`)).values || [];
    scanned += 1;
    for (const row of rows) {
      for (const cell of row) {
        if (typeof cell !== 'string' || cell[0] !== '=' || !names.some((n) => cell.includes(n))) continue;
        for (const m of cell.matchAll(refRe)) {
          const src = m[1] || m[2];
          const a = colIndex(m[3]);
          const b = m[4] ? colIndex(m[4]) : a;
          const key = `${t} → ${src}`;
          const f = (found[key] ||= { cols: new Set(), count: 0, sample: cell.slice(0, 140) });
          for (let i = Math.min(a, b); i <= Math.max(a, b) && i < 80; i++) f.cols.add(i);
          f.count += 1;
        }
        if (/INDIRECT/i.test(cell)) {
          const f = (found[`${t} → INDIRECT`] ||= { cols: new Set(), count: 0, sample: cell.slice(0, 140) });
          f.count += 1;
        }
      }
    }
  }
  const lines = [`Просмотрено вкладок: ${scanned}. Именованные диапазоны: ${(meta.namedRanges || []).map((n) => n.name).join(', ') || 'нет'}`];
  const keys = Object.keys(found);
  if (!keys.length) lines.push('Формул, ссылающихся на две вкладки заказов, не найдено.');
  for (const key of keys) {
    const src = key.split(' → ')[1];
    const cols = [...found[key].cols].sort((x, y) => x - y)
      .map((i) => `${colName(i)} «${(headers[src] || [])[i] || '?'}»`);
    lines.push('', `${key}: формул ${found[key].count}`, `столбцы: ${cols.join('; ') || '—'}`, `пример: ${found[key].sample}`);
  }
  return lines.join('\n');
}


// ======================= /заказы_отчёт: заполнение вкладок =======================
// Базовые столбцы — «Отчёт об отправлениях» Seller API (та же выгрузка, что в кабинете),
// недостающие — из списков отправлений (/v4/posting/fbs/list, /v3/posting/fbo/list)
// по «Номеру отправления». Пишем ТОЛЬКО значения в A2 двух вкладок, строку 1 не трогаем.
const COPY_ID = '1v9f-rGyGan8hMRZ80UvX_855JxW9sxnLFS7I5SBs7jo';
const MSK_MS = 3 * 3600000;
const DAY_MS = 86400000;
const CLEAR_COLS = 'BZ';

function mskDay(d) { // 'YYYY-MM-DD' по Москве
  return new Date(d.getTime() + MSK_MS).toISOString().slice(0, 10);
}
function mskStart(ymd) { return new Date(`${ymd}T00:00:00+03:00`); }
function mskEnd(ymd) { return new Date(`${ymd}T23:59:59+03:00`); }

function parseArgs(text) {
  const dates = [];
  for (const t of String(text || '').split(/\s+/)) {
    let m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) dates.push(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(t)) dates.push(t);
  }
  const dry = /(^|\s)(сухо|dry)(\s|$)/i.test(text || '');
  const yesterday = mskDay(new Date(Date.now() - DAY_MS));
  const from = dates[0] || mskDay(new Date(Date.now() - 30 * DAY_MS));
  const to = dates[1] || yesterday;
  if (to > yesterday) throw new Error('Сегодняшний день не берём: конец периода не позже вчера');
  if (from > to) throw new Error('Начало периода позже конца');
  return { from, to, dry };
}

function parseCsv(text) {
  const t = text.replace(/^﻿/, '');
  const sep = (t.split(/\r?\n/)[0] || '').includes(';') ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

async function fetchReportRows(schema, from, to) {
  const created = await ozonRaw('/v1/report/postings/create', {
    filter: { processed_at_from: mskStart(from).toISOString(), processed_at_to: mskEnd(to).toISOString(), delivery_schema: [schema] },
    language: 'DEFAULT',
  });
  const code = created.json?.result?.code;
  if (!code) throw new Error(`отчёт ${schema.toUpperCase()} не создан: HTTP ${created.status} ${created.text.slice(0, 200)}`);
  let result = null;
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const info = await ozonRaw('/v1/report/info', { code });
    result = info.json?.result;
    if (result?.status === 'success' || result?.status === 'failed') break;
  }
  if (result?.status !== 'success' || !result.file) throw new Error(`отчёт ${schema.toUpperCase()} не готов: ${result?.status || 'таймаут'} ${result?.error || ''}`);
  const file = await fetch(result.file, { signal: AbortSignal.timeout(120000) });
  const text = await file.text();
  const table = parseCsv(text);
  if (!table.length) return { header: [], rows: [], badEncoding: false };
  return { header: table[0].map((h) => h.trim()), rows: table.slice(1), badEncoding: text.includes('�') };
}

function flatten(obj, prefix = '', out = {}) {
  if (Array.isArray(obj)) return out; // товары сюда не нужны
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (obj !== null && obj !== undefined && obj !== '') out[prefix] = obj;
  return out;
}

const yesNo = (v) => (v === true ? 'да' : v === false ? 'нет' : v);
const premium = (v) => (v === true ? 'Премиум' : v === false ? 'Не премиум' : v);

// Столбец таблицы → [пути в ответе списка отправлений, преобразование].
// Если пути не нашлись — столбец остаётся пустым и попадает в сводку «не заполнено».
const ENRICH = {
  'Верхний штрихкод': [['barcodes.upper_barcode']],
  'Нижний штрихкод': [['barcodes.lower_barcode']],
  'Кластер отгрузки': [['financial_data.cluster_from']],
  'Кластер доставки': [['financial_data.cluster_to']],
  'Регион доставки': [['analytics_data.region']],
  'Город доставки': [['analytics_data.city']],
  'Способ доставки': [['analytics_data.delivery_type']],
  'Сегмент клиента': [['analytics_data.is_premium'], premium],
  'Способ оплаты': [['analytics_data.payment_type_group_name']],
  'Юридическое лицо': [['analytics_data.is_legal'], yesNo],
  'Наименование': [['legal_info.company_name']],
  'ИНН': [['legal_info.inn']],
  'КПП': [['legal_info.kpp']],
  'Имя покупателя': [['customer.name']],
  'Email покупателя': [['customer.email']],
  'Имя получателя': [['addressee.name']],
  'Телефон получателя': [['addressee.phone', 'customer.phone']],
  'Адрес доставки': [['customer.address.address_tail']],
  'Адрес покупателя': [['customer.address.address_tail']],
  'Индекс': [['customer.address.zip_code']],
  'Склад отгрузки': [['analytics_data.warehouse_name', 'analytics_data.warehouse', 'delivery_method.warehouse']],
  'Перевозчик': [['analytics_data.tpl_provider', 'delivery_method.tpl_provider']],
  'Название метода': [['delivery_method.name']],
};

async function fetchPostingList(schema, from, to) {
  const isFbs = schema === 'fbs';
  const endpoint = isFbs ? '/v4/posting/fbs/list' : '/v3/posting/fbo/list';
  const filter = { since: new Date(mskStart(from).getTime() - DAY_MS).toISOString(), to: new Date(mskEnd(to).getTime() + DAY_MS).toISOString() };
  const withFlags = { analytics_data: true, financial_data: true, legal_info: true, barcodes: true };
  const map = new Map();
  let note = '';
  const limit = isFbs ? 1000 : 1000;
  let offset = 0;
  let cursor = '';
  for (let page = 0; page < 200; page++) {
    const base = { dir: 'ASC', filter, limit, offset };
    if (cursor) base.cursor = cursor;
    let r = await ozonRaw(endpoint, { ...base, with: withFlags });
    if (r.status === 400) {
      r = await ozonRaw(endpoint, base);
      note = 'список без with-флагов (Озон отклонил запрос с ними)';
    }
    if (r.status !== 200) throw new Error(`${endpoint} HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    const body = r.json?.result ?? r.json ?? {};
    const list = Array.isArray(body) ? body : body.postings || r.json?.postings || [];
    for (const p of list) if (p.posting_number) map.set(String(p.posting_number), flatten(p));
    const next = body.cursor || r.json?.cursor || '';
    const hasNext = body.has_next ?? r.json?.has_next;
    if (next && next !== cursor) { cursor = next; if (hasNext === false) break; continue; }
    if (hasNext === false || list.length < limit) break;
    offset += limit;
  }
  return { map, note };
}

function toCell(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (/^-?(0|[1-9]\d*)([.,]\d+)?$/.test(s)) return Number(s.replace(',', '.')); // числа — числами, как при вставке из Excel
  return s;
}

function buildRows(sheetHeader, report, postings) {
  const idx = Object.fromEntries(report.header.map((h, i) => [h, i]));
  const numIdx = idx['Номер отправления'];
  const filled = Object.fromEntries(sheetHeader.map((h) => [h, 0]));
  const rows = report.rows.map((r) => {
    const flat = postings.map.get(String(r[numIdx] || '').trim()) || {};
    return sheetHeader.map((h) => {
      let v = '';
      if (h in idx) v = r[idx[h]];
      else if (ENRICH[h]) {
        const [paths, fn] = ENRICH[h];
        const key = paths.find((p) => flat[p] !== undefined);
        if (key) v = fn ? fn(flat[key]) : flat[key];
      }
      const cell = toCell(v);
      if (cell !== '') filled[h] += 1;
      return cell;
    });
  });
  return { rows, filled };
}

async function sheetsWrite(method, path, body) {
  const sa = nomenclature.loadServiceAccount();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await getToken(sa)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (res.status === 403) throw new Error(`нет прав редактора — дай доступ редактора на ${sa.client_email}`);
  if (!res.ok) throw new Error(`Sheets HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function writeTab(tab, sheetHeader, rows) {
  const lastCol = colName(sheetHeader.length - 1);
  const needRows = rows.length + 2;
  const meta = await sheetsGet('?fields=properties.locale,sheets.properties(sheetId,title,gridProperties(rowCount))');
  const sh = meta.sheets.find((x) => x.properties.title === tab);
  if (!sh) throw new Error(`вкладка «${tab}» не найдена`);
  if (sh.properties.gridProperties.rowCount < needRows) {
    await sheetsWrite('POST', ':batchUpdate', {
      requests: [{ appendDimension: { sheetId: sh.properties.sheetId, dimension: 'ROWS', length: needRows - sh.properties.gridProperties.rowCount } }],
    });
  }
  // Строка 2 (шапка) остаётся прежней, данные — с A3: как при вставке выгрузки с заголовком в A2.
  const CHUNK = 1500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const start = 3 + i;
    await sheetsWrite('PUT', `/values/${encodeURIComponent(`'${tab}'!A${start}:${lastCol}${start + part.length - 1}`)}?valueInputOption=USER_ENTERED`, {
      values: part,
    });
  }
  // Старые строки ниже вставленного блока — убрать.
  await sheetsWrite('POST', `/values/${encodeURIComponent(`'${tab}'!A${rows.length + 3}:${CLEAR_COLS}`)}:clear`, {});
  return meta.properties.locale;
}

let running = false;
async function runOrdersReport(argText) {
  if (running) throw new Error('отчёт уже идёт, подожди окончания');
  running = true;
  try {
    const { from, to, dry } = parseArgs(argText);
    if (!dry && SPREADSHEET_ID !== COPY_ID && process.env.ORDERS_ALLOW_PROD !== '1') {
      throw new Error('запись разрешена только в копию для теста (ORDERS_ALLOW_PROD не включён)');
    }
    const started = Date.now();
    const out = [`Заказы Озона ${dry ? '(сухой прогон, в таблицу НЕ пишу)' : ''}\nПериод: ${from} — ${to} (по Москве)\nТаблица: ${SPREADSHEET_ID === COPY_ID ? 'копия для теста' : SPREADSHEET_ID}`];
    let locale = '';
    for (const schema of ['fbs', 'fbo']) {
      const tab = TABS[schema];
      try {
        const sheetHeader = ((await readRange(tab, 'A2:BZ2'))[0] || []).map((c) => String(c).trim());
        const lastIdx = sheetHeader.map((h) => !!h).lastIndexOf(true);
        const header = sheetHeader.slice(0, lastIdx + 1);
        if (!header.length) throw new Error('в строке 2 нет шапки');
        const report = await fetchReportRows(schema, from, to);
        const unknown = report.header.filter((h) => !header.includes(h));
        if (unknown.length) throw new Error(`в отчёте API есть столбцы, которых нет во вкладке: ${unknown.join(', ')} — не пишу`);
        if (!report.rows.length) { out.push('', `📄 ${tab}: за период нет заказов — вкладку не трогаю`); continue; }
        let postings = { map: new Map(), note: '' };
        try { postings = await fetchPostingList(schema, from, to); } catch (e) { postings.note = `детали отправлений не получены: ${e.message}`; }
        const { rows, filled } = buildRows(header, report, postings);
        if (!dry) locale = await writeTab(tab, header, rows);
        const empty = header.filter((h) => !filled[h]);
        out.push('', `📄 ${tab}: ${dry ? 'было бы вставлено' : 'вставлено'} строк: ${rows.length}`);
        out.push(`Совпало с деталями отправлений: ${rows.filter((_, i) => postings.map.has(String(report.rows[i][report.header.indexOf('Номер отправления')] || '').trim())).length} из ${rows.length}`);
        if (postings.note) out.push(`⚠️ ${postings.note}`);
        if (report.badEncoding) out.push('⚠️ в файле отчёта есть нечитаемые символы (кодировка)');
        out.push(`Пустые во всех строках: ${empty.join(', ') || 'нет'}`);
      } catch (e) {
        out.push('', `📄 ${tab}: ❌ ${e.message}`);
      }
    }
    const t = new Date();
    out.push('', `Время: ${new Date(t.getTime() + MSK_MS).toISOString().slice(0, 16).replace('T', ' ')} МСК, заняло ${Math.round((t - started) / 1000)} с${locale ? `, локаль таблицы ${locale}` : ''}`);
    return out.join('\n');
  } finally {
    running = false;
  }
}

module.exports = { buildRows, runOrdersReport, parseArgs, parseCsv, dependenciesMessage, reportProbeMessage, headersMessage, ozonFieldsMessage, readRange, SPREADSHEET_ID, TABS };
