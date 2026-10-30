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

module.exports = { dependenciesMessage, reportProbeMessage, headersMessage, ozonFieldsMessage, readRange, SPREADSHEET_ID, TABS };
