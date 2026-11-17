// Ежедневная проверка Google-таблицы «Задания менеджерам», лист «Елена (Ozon)» (только чтение).
// 07:00 по Бали (catch-up poll раз в 5 мин, см. index.js) + команда /задания (всегда отвечает).
// Ключ строки: Задача + Артикул + Что сделать. Снимок — /data/tasks_sheet_snapshot.json (атомарная запись).
// Новые → «новое от Алины», изменились (тот же ключ, другой Товар/Комментарий) → «изменено», пропали → «✅ Убрано».
// «Проверка (скрипт)» в сравнении НЕ участвует (считается скриптом, менялась бы каждый день).
// Доступ — тот же, что у «Номенклатуры»: сервисный аккаунт (Sheets API, scope readonly), без него — публичная ссылка (gviz CSV).
const fs = require('fs');
const path = require('path');

const SPREADSHEET_ID = process.env.TASKS_SHEET_ID || '1AOxj6UGT4cnMQyJhL-1IJQgdn_YDyChLSYc7j4f9bE4';
const TAB_TITLE = process.env.TASKS_SHEET_TAB || 'Елена (Ozon)';
const SNAP_PATH = process.env.TASKS_SNAPSHOT_PATH || '/data/tasks_sheet_snapshot.json';
const RUN_HOUR = Number(process.env.TASKS_SHEET_HOUR) || 7;
const TITLE = '🛍️📋 Таблица заданий';

const COLS = [
  ['task', /^задача$/i], ['article', /^артикул$/i], ['product', /^товар$/i],
  ['what', /^что сделать$/i], ['check', /^проверка/i], ['comment', /^комментарий$/i],
];
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const norm = (v) => clean(v).toLowerCase().replace(/ё/g, 'е');
const keyOf = (r) => [r.task, r.article, r.what].map(norm).join('|');

// Эмодзи по типу задачи (по ключевым словам в названии задачи/что сделать).
const EMOJI = [
  [/цен|price|скидк|маржа/i, '💰'], [/акци|промо|бустинг/i, '🏷️'], [/реклам|продвиж|бренд/i, '📣'],
  [/остат|склад|постав|fbo|fbs|приход/i, '📦'], [/габарит|размер|вес/i, '📏'],
  [/карточк|фото|описан|название|контент|штрихкод|баркод/i, '🖼️'],
  [/документ|сертиф|декларац|сгр|маркиров/i, '📄'], [/возврат|спор|списан|компенсац/i, '⚖️'],
  [/отзыв|рейтинг|вопрос/i, '⭐'],
];
const emojiFor = (r) => (EMOJI.find(([re]) => re.test(`${r.task} ${r.what}`)) || [null, '📌'])[1];

// values — массив строк листа (как отдаёт Sheets API / CSV).
function parseRows(values) {
  const hi = values.findIndex((row, i) => i < 10 && row.some((c) => /^задача$/i.test(clean(c))) && row.some((c) => /^что сделать$/i.test(clean(c))));
  if (hi < 0) throw new Error('в листе «Елена (Ozon)» не нашёл заголовки «Задача» и «Что сделать» — структура таблицы изменилась');
  const pos = {};
  for (const [k, re] of COLS) pos[k] = values[hi].findIndex((c) => re.test(clean(c)));
  const rows = {};
  for (const raw of values.slice(hi + 1)) {
    const r = {};
    for (const [k] of COLS) r[k] = pos[k] >= 0 ? clean(raw[pos[k]]) : '';
    if (!r.task && !r.article && !r.what) continue;
    rows[keyOf(r)] = r;
  }
  return rows;
}

const sameVisible = (a, b) => norm(a.product) === norm(b.product) && norm(a.comment) === norm(b.comment);
function diff(prev, cur) {
  const added = []; const changed = []; const removed = [];
  for (const [k, r] of Object.entries(cur)) {
    if (!prev[k]) added.push(r); else if (!sameVisible(prev[k], r)) changed.push(r);
  }
  for (const [k, r] of Object.entries(prev)) if (!cur[k]) removed.push(r);
  return { added, changed, removed };
}

const line = (r, mark = '') => `• ${emojiFor(r)} ${r.task || 'Без названия'}: ${r.article || '—'} — ${r.what || '—'}${mark}${r.comment ? ` (${r.comment})` : ''}`;

function buildMessage({ added, changed, removed }, firstRun, total) {
  if (firstRun) {
    const all = [...added];
    return `${TITLE} — таблица подключена, вот текущие задачи (${all.length})\n\n` + (all.length ? all.map((r) => line(r)).join('\n') : 'Пока в листе «Елена (Ozon)» задач нет.');
  }
  if (!added.length && !changed.length && !removed.length) return null;
  const parts = [`${TITLE} — новое от Алины`];
  if (added.length) parts.push(added.map((r) => line(r)).join('\n'));
  if (changed.length) parts.push('✏️ Изменено:\n' + changed.map((r) => line(r)).join('\n'));
  if (removed.length) parts.push('✅ Убрано:\n' + removed.map((r) => `• ${emojiFor(r)} ${r.task || 'Без названия'}: ${r.article || '—'} — ${r.what || '—'}`).join('\n'));
  if (!added.length && !changed.length) parts[0] = `${TITLE} — изменения`;
  return parts.join('\n\n');
}

function readSnap() { try { return JSON.parse(fs.readFileSync(SNAP_PATH, 'utf8')); } catch { return null; } }
function writeSnap(d) {
  fs.mkdirSync(path.dirname(SNAP_PATH), { recursive: true });
  const tmp = `${SNAP_PATH}.tmp`; fs.writeFileSync(tmp, JSON.stringify(d, null, 2)); fs.renameSync(tmp, SNAP_PATH);
}
function patchSnap(p) { writeSnap({ ...(readSnap() || {}), ...p }); }

class AccessError extends Error {}

// Чтение листа: сервисный аккаунт (readonly) → иначе публичный CSV по названию листа. Ничего не пишет.
async function fetchValues() {
  const nomenclature = require('./nomenclature');
  const { parseCsv, fetchWithTimeout } = require('./report');
  const sa = nomenclature.loadServiceAccount();
  if (sa) {
    const token = await nomenclature.getAccessToken(sa);
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}`;
    const metaRes = await fetchWithTimeout(`${base}?fields=sheets.properties(sheetId,title)`, 40000, auth);
    if (metaRes.status === 403 || metaRes.status === 404) throw new AccessError(`нет доступа к таблице «Задания менеджерам»: дай доступ «Читатель» на ${sa.client_email}`);
    if (!metaRes.ok) throw new Error(`Sheets API HTTP ${metaRes.status}`);
    const tabs = ((await metaRes.json()).sheets || []).map((s) => s.properties.title);
    const title = tabs.find((t) => norm(t) === norm(TAB_TITLE));
    if (!title) throw new Error(`лист «${TAB_TITLE}» не найден (есть: ${tabs.join(', ')})`);
    const range = encodeURIComponent(`'${title.replace(/'/g, "''")}'!A:Z`);
    const res = await fetchWithTimeout(`${base}/values/${range}?valueRenderOption=FORMATTED_VALUE`, 40000, auth);
    if (!res.ok) throw new Error(`Sheets API HTTP ${res.status}`);
    return (await res.json()).values || [];
  }
  const res = await fetchWithTimeout(`https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(TAB_TITLE)}`, 40000);
  const ct = res.headers.get('content-type') || '';
  if ([401, 403, 404].includes(res.status) || /text\/html/i.test(ct)) throw new AccessError('нет доступа к таблице «Задания менеджерам»: открой её по ссылке («Все, у кого есть ссылка» → Читатель) или задай GOOGLE_SERVICE_ACCOUNT_JSON и дай доступ «Читатель» на email сервисного аккаунта');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseCsv(await res.text());
}

// Одна проверка. Возвращает { text|null, firstRun, total }. Снимок обновляется всегда (после успешного чтения).
async function check({ manual = false, read = fetchValues, today = null } = {}) {
  const cur = parseRows(await read());
  const snap = readSnap();
  const firstRun = !snap || !snap.rows;
  const d = firstRun ? { added: Object.values(cur), changed: [], removed: [] } : diff(snap.rows, cur);
  let text = buildMessage(d, firstRun, Object.keys(cur).length);
  if (!text && manual) text = `${TITLE} — нового нет. Сейчас в листе «Елена (Ozon)»: ${Object.keys(cur).length} задач.`;
  writeSnap({ ...(snap || {}), rows: cur, updatedAt: new Date().toISOString(), ...(today ? { lastRunDate: today } : {}), errorNotified: false, lastErrorAt: null });
  return { text, firstRun, total: Object.keys(cur).length };
}

const dueToday = (today, hour) => hour >= RUN_HOUR && (readSnap() || {}).lastRunDate !== today;

module.exports = { parseRows, diff, buildMessage, emojiFor, check, dueToday, readSnap, patchSnap, AccessError, TITLE, RUN_HOUR };
