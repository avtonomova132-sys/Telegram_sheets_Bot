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

module.exports = { headersMessage, ozonFieldsMessage, readRange, SPREADSHEET_ID, TABS };
