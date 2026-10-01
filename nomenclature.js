// Фоновая проверка Google-таблицы «Номенклатура» (штрих-коды, габариты/вес,
// документы по артикулам) — полностью отдельная фича, с host-tracking и
// programsWatch не пересекается. Переиспользует из report.js только
// генерические утилиты (CSV-парсинг, fetch с таймаутом).
//
// Чтение таблицы: по умолчанию публичный CSV-экспорт (так же читаются все
// остальные таблицы бота, сервисного аккаунта в боте НЕТ — таблица должна быть
// открыта «всем, у кого есть ссылка» как Читатель). Если задана переменная
// GOOGLE_SERVICE_ACCOUNT_JSON — читаем через Sheets API, а автора правок
// определяем через Drive API (revisions.list). Без неё автор = «не определён».

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseCsv, fetchWithTimeout, csvUrl } = require('./report');

const SPREADSHEET_ID = process.env.NOMENCLATURE_SPREADSHEET_ID || '16Mq06mwMN9zALJaioiFdBaEe7ucGDBF0Dxp_d6-ti6w';
const TAB_GID = process.env.NOMENCLATURE_GID || '38517625';
const SNAPSHOT_PATH = process.env.NOMENCLATURE_SNAPSHOT_PATH || '/data/nomenclature_snapshot.json';
const STATE_PATH = process.env.NOMENCLATURE_STATE_PATH || '/data/nomenclature_state.json';

// key → поле, letter → ожидаемая колонка (0-индекс считаем из буквы),
// header → регэксп для проверки заголовка первой строки.
const COLUMN_SPECS = [
  { key: 'article', letter: 'D', header: /артикул/i, label: 'Артикул' },
  { key: 'barcode', letter: 'F', header: /баркод|штрих/i, label: 'Штрих-код' },
  { key: 'width', letter: 'K', header: /ширин/i, label: 'Ширина' },
  { key: 'length', letter: 'L', header: /длин/i, label: 'Длина' },
  { key: 'height', letter: 'M', header: /высот/i, label: 'Высота' },
  { key: 'weight', letter: 'N', header: /вес/i, label: 'Вес' },
  { key: 'doc', letter: 'AH', header: /декларац|сертификат|документ/i, label: 'Декларация/сертификат' },
  { key: 'sgr', letter: 'AK', header: /сгр|\bру\b|регистрац/i, label: 'СГР/РУ' },
  { key: 'tnved', letter: 'AE', header: /тн\s*вэд/i, label: 'ТН ВЭД' },
  { key: 'marking', letter: 'AP', header: /честный|маркиров/i, label: 'Маркировка' },
];
const FIELD_KEYS = COLUMN_SPECS.filter((c) => c.key !== 'article').map((c) => c.key);
const REQUIRED_FOR_CARD = ['barcode', 'width', 'length', 'height', 'weight'];
const NUMERIC_KEYS = new Set(['width', 'length', 'height', 'weight']);

// «Обычно вносит…» — только подсказка, не факт.
const USUAL_AUTHOR = {
  barcode: 'Катя',
  width: 'склад', length: 'склад', height: 'склад', weight: 'склад',
  doc: 'Елена/Claude', sgr: 'Елена/Claude',
};

function letterToIndex(letter) {
  let n = 0;
  for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ---------- состояние ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readState() {
  return readJson(STATE_PATH, {});
}
function patchState(patch) {
  writeJson(STATE_PATH, { ...readState(), ...patch });
}

// ---------- чтение таблицы ----------

function loadServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const sa = JSON.parse(text);
    if (!sa.client_email || !sa.private_key) return null;
    return sa;
  } catch {
    return null;
  }
}

let tokenCache = { token: null, exp: 0 };
async function getAccessToken(sa) {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly',
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

class AccessError extends Error {}

async function fetchRows() {
  const sa = loadServiceAccount();
  if (sa) {
    const token = await getAccessToken(sa);
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const metaRes = await fetchWithTimeout2(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties(sheetId,title)`,
      auth
    );
    if (metaRes.status === 403 || metaRes.status === 404) {
      throw new AccessError(
        `нет доступа к таблице — дай доступ «Читатель» на ${sa.client_email}`
      );
    }
    if (!metaRes.ok) throw new Error(`Sheets API HTTP ${metaRes.status}`);
    const meta = await metaRes.json();
    const sheet = (meta.sheets || []).find((s) => String(s.properties.sheetId) === String(TAB_GID));
    if (!sheet) throw new Error(`лист gid ${TAB_GID} не найден в таблице`);
    const range = encodeURIComponent(`'${sheet.properties.title.replace(/'/g, "''")}'!A:AP`);
    const res = await fetchWithTimeout2(
      `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}?valueRenderOption=FORMATTED_VALUE`,
      auth
    );
    if (!res.ok) throw new Error(`Sheets API HTTP ${res.status}`);
    const json = await res.json();
    return json.values || [];
  }

  const res = await fetchWithTimeout(csvUrl(SPREADSHEET_ID, TAB_GID), 40000);
  const ct = res.headers.get('content-type') || '';
  if (res.status === 401 || res.status === 403 || res.status === 404 || /text\/html/i.test(ct)) {
    throw new AccessError(
      'нет доступа к таблице — открой её по ссылке («Все, у кого есть ссылка» → Читатель) ' +
        'или задай GOOGLE_SERVICE_ACCOUNT_JSON и дай доступ «Читатель» на email сервисного аккаунта'
    );
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseCsv(await res.text());
}

async function fetchWithTimeout2(url, opts, ms = 40000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- разбор ----------

function clean(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s || /^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?)$/i.test(s)) return '';
  return s;
}

function isZeroNumber(s) {
  return /^0+([.,]0*)?$/.test(s);
}

// Находит колонки: основная опора — буква, заголовок это проверяет. Если на
// букве другой заголовок — ищем колонку по заголовку; не нашли однозначно —
// ошибка (лучше сказать, чем молча читать не то).
function resolveColumns(rows) {
  const header = rows[0] || [];
  const cols = {};
  for (const spec of COLUMN_SPECS) {
    const idx = letterToIndex(spec.letter);
    if (spec.header.test(clean(header[idx]))) {
      cols[spec.key] = idx;
      continue;
    }
    const matches = header.map((h, i) => (spec.header.test(clean(h)) ? i : -1)).filter((i) => i >= 0);
    if (matches.length === 1) {
      cols[spec.key] = matches[0];
    } else {
      throw new Error(
        `структура таблицы изменилась: в колонке ${spec.letter} ожидала «${spec.label}», а там «${clean(header[idx]) || 'пусто'}»`
      );
    }
  }
  return cols;
}

function parseNomenclature(rows) {
  const cols = resolveColumns(rows);
  const items = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const article = clean(row[cols.article]);
    if (!article) continue;
    const rec = {};
    for (const key of FIELD_KEYS) {
      let v = clean(row[cols[key]]);
      if (NUMERIC_KEYS.has(key) && isZeroNumber(v)) v = '';
      rec[key] = v;
    }
    if (items[article]) {
      // дубль артикула — дополняем только пустое
      for (const key of FIELD_KEYS) if (!items[article][key]) items[article][key] = rec[key];
    } else {
      items[article] = rec;
    }
  }
  return items;
}

function isComplete(rec) {
  return !!rec && REQUIRED_FOR_CARD.every((k) => rec[k]);
}

function missingFields(rec) {
  const names = { barcode: 'штрих-код', width: 'ширина', length: 'длина', height: 'высота', weight: 'вес' };
  return REQUIRED_FOR_CARD.filter((k) => !rec[k]).map((k) => names[k]);
}

// ---------- сравнение ----------

const EMPTY = Object.fromEntries(FIELD_KEYS.map((k) => [k, '']));

// Возвращает [{ article, changes: {key: {from, to}}, becameComplete }]
function diffSnapshots(prev, next) {
  const out = [];
  for (const [article, rec] of Object.entries(next)) {
    const old = prev[article] || EMPTY;
    const changes = {};
    for (const k of FIELD_KEYS) {
      if ((old[k] || '') !== rec[k]) changes[k] = { from: old[k] || '', to: rec[k] };
    }
    if (Object.keys(changes).length === 0) continue;
    out.push({ article, changes, becameComplete: isComplete(rec) && !isComplete(prev[article]) });
  }
  return out;
}

// ---------- авторы ----------

async function fetchEditors(sinceIso) {
  const sa = loadServiceAccount();
  if (!sa) return { known: false, names: [] };
  try {
    const token = await getAccessToken(sa);
    const names = new Set();
    let pageToken = '';
    do {
      const url =
        `https://www.googleapis.com/drive/v3/files/${SPREADSHEET_ID}/revisions` +
        `?pageSize=1000&fields=nextPageToken,revisions(modifiedTime,lastModifyingUser(displayName,emailAddress))` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const res = await fetchWithTimeout2(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return { known: false, names: [] };
      const json = await res.json();
      for (const rev of json.revisions || []) {
        if (sinceIso && rev.modifiedTime <= sinceIso) continue;
        const u = rev.lastModifyingUser;
        if (u) names.add(u.displayName || u.emailAddress || 'неизвестный');
      }
      pageToken = json.nextPageToken || '';
    } while (pageToken);
    return { known: names.size > 0, names: [...names] };
  } catch {
    return { known: false, names: [] };
  }
}

// ---------- сообщения ----------

const FIELD_LABEL = { doc: 'Документ', sgr: 'СГР/РУ' };

function describeStatus(entries) {
  // entries: [{from,to}] — все только появились → «появился/появились», иначе «изменился»
  return entries.every((e) => !e.from && e.to);
}

function articleBlock(item, rec, authors) {
  const { changes } = item;
  const lines = [item.article];

  if (changes.barcode) {
    const c = changes.barcode;
    if (!c.to) lines.push(`• Штрих-код: удалён (был ${c.from})`);
    else if (!c.from) lines.push(`• Штрих-код: ${c.to} (появился)`);
    else lines.push(`• Штрих-код: ${c.from} → ${c.to} (изменился)`);
  }

  const dimKeys = ['width', 'length', 'height', 'weight'].filter((k) => changes[k]);
  if (dimKeys.length) {
    const show = (get) => {
      const v = (k) => get(k) || '—';
      return `${v('length') === '—' && v('width') === '—' && v('height') === '—' ? '—' : `${v('width')} × ${v('length')} × ${v('height')} см`}, вес ${v('weight')} кг`;
    };
    const now = show((k) => rec[k]);
    const appeared = describeStatus(dimKeys.map((k) => changes[k]));
    if (appeared) {
      lines.push(`• Габариты: ${now} (появились)`);
    } else {
      const before = show((k) => (changes[k] ? changes[k].from : rec[k]));
      lines.push(`• Габариты: ${now} (изменились, было: ${before})`);
    }
  }

  for (const k of ['doc', 'sgr']) {
    const c = changes[k];
    if (!c) continue;
    if (!c.to) lines.push(`• ${FIELD_LABEL[k]}: удалён (был ${c.from})`);
    else if (!c.from) lines.push(`• ${FIELD_LABEL[k]}: ${c.to} (появился)`);
    else lines.push(`• ${FIELD_LABEL[k]}: ${c.from} → ${c.to} (изменился)`);
  }

  const ref = [];
  if (changes.tnved) ref.push(`ТН ВЭД ${changes.tnved.to || 'пусто'} (${!changes.tnved.from ? 'появился' : 'изменился'})`);
  if (changes.marking) ref.push(`маркировка: ${changes.marking.to || 'пусто'} (${!changes.marking.from ? 'появилась' : 'изменилась'})`);
  if (ref.length) lines.push(`• Справочно: ${ref.join('; ')}`);

  lines.push(`Кто: ${authors.text}${authors.hint(Object.keys(changes))}`);
  return lines.join('\n');
}

function buildAuthors(editors) {
  const text = editors.known ? `${editors.names.join(', ')} (по Drive)` : 'автор не определён';
  const hint = (keys) => {
    const who = [...new Set(keys.map((k) => USUAL_AUTHOR[k]).filter(Boolean))];
    return who.length ? `; обычно вносит: ${who.join(', ')}` : '';
  };
  return { text, hint };
}

const COMPACT_THRESHOLD = 8;

function buildMessages(diffs, next, editors) {
  if (!diffs.length) return [];
  const authors = buildAuthors(editors);
  const out = [];
  const ready = diffs.filter((d) => d.becameComplete);

  if (diffs.length <= COMPACT_THRESHOLD) {
    out.push(['📦 Номенклатура: новое', ...diffs.map((d) => articleBlock(d, next[d.article], authors))].join('\n\n'));
  } else {
    const tag = (d) => {
      const t = [];
      if (d.changes.barcode) t.push('штрих-код');
      if (['width', 'length', 'height', 'weight'].some((k) => d.changes[k])) t.push('габариты/вес');
      if (d.changes.doc || d.changes.sgr) t.push('документ');
      if (d.changes.tnved || d.changes.marking) t.push('справочно');
      return `• ${d.article} — ${t.join(', ')}`;
    };
    out.push(
      [`📦 Номенклатура: новое (${diffs.length} артикулов)`, ...diffs.map(tag), '', `Кто: ${authors.text}`].join('\n')
    );
  }

  if (ready.length) {
    out.push(['✅ Можно создавать карточку', ...ready.map((d) => d.article)].join('\n'));
  }
  return out;
}

function buildWeeklyMessage(items) {
  const lacking = Object.entries(items).filter(([, rec]) => !isComplete(rec));
  if (!lacking.length) return null;
  const MAX = 30;
  const lines = lacking.slice(0, MAX).map(([a, rec]) => `• ${a} — нет: ${missingFields(rec).join(', ')}`);
  if (lacking.length > MAX) lines.push(`…и ещё ${lacking.length - MAX}`);
  return [`🗓 Номенклатура: где ещё не хватает данных (${lacking.length} из ${Object.keys(items).length})`, ...lines].join('\n');
}

// ---------- запуск ----------

// opts.save=false — отладка: показать diff, снимок не трогать.
async function runCheck({ save = true } = {}) {
  const rows = await fetchRows();
  const next = parseNomenclature(rows);
  const snap = readJson(SNAPSHOT_PATH, null);
  const nowIso = new Date().toISOString();

  if (!snap || !snap.items) {
    if (save) writeJson(SNAPSHOT_PATH, { checkedAt: nowIso, items: next });
    return { firstRun: true, count: Object.keys(next).length, messages: [], items: next };
  }

  const diffs = diffSnapshots(snap.items, next);
  let messages = [];
  if (diffs.length) {
    const editors = await fetchEditors(snap.checkedAt);
    messages = buildMessages(diffs, next, editors);
  }
  if (save) writeJson(SNAPSHOT_PATH, { checkedAt: nowIso, items: next });
  return { firstRun: false, count: Object.keys(next).length, messages, items: next, diffCount: diffs.length };
}

module.exports = {
  runCheck,
  parseNomenclature,
  diffSnapshots,
  buildMessages,
  buildWeeklyMessage,
  isComplete,
  AccessError,
  readState,
  patchState,
};
