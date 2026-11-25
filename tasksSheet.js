// Таблица «Задания менеджерам», лист «Елена (Ozon)»: уведомление Елене ТОЛЬКО о действительно новых задачах.
// Бот только читает таблицу (ничего в неё не пишет). 08:00 по Бали (TASKS_SHEET_HOUR) — после обновления таблицы скриптом (~07:30).
//
// «Новая» = отпечаток (id) задачи отсутствует в снимке. Номер строки и количество строк НЕ используются:
// строки сдвигаются, выполненные пропадают. id = sha1( нормализованные A | B | D ), где
//   A — Задача, B — Артикул (как есть), D — «Что сделать» БЕЗ цифр и знаков (скрипт каждое утро пересчитывает
//   цены и остатки: «…3 шт» → «…2 шт» — это та же задача, а не новая).
// Комментарий Елены (F), товар (C) и «Проверка (скрипт)» (E) в id не входят: их изменение — не новая задача.
// Строки без артикула (B) и пустые пропускаются.
// Снимок — /data/tasks_snapshot.json: { id: { A, B, D, first_seen } }; состояние (когда запускали, ошибки) — /data/tasks_state.json.
// Первый запуск (снимка нет) только сохраняет снимок, без уведомления. Исчезнувшие задачи из снимка удаляются.
// Доступ — как у «Номенклатуры»: сервисный аккаунт (Sheets API, readonly), без него — публичная ссылка (gviz CSV).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SPREADSHEET_ID = process.env.TASKS_SHEET_ID || '1AOxj6UGT4cnMQyJhL-1IJQgdn_YDyChLSYc7j4f9bE4';
const TAB_TITLE = process.env.TASKS_SHEET_TAB || 'Елена (Ozon)';
const SNAP_PATH = () => process.env.TASKS_SNAPSHOT_PATH || '/data/tasks_snapshot.json';
const STATE_PATH = () => process.env.TASKS_STATE_PATH || '/data/tasks_state.json';
const RUN_HOUR = Number(process.env.TASKS_SHEET_HOUR) || 8;
const MAX_SHOWN = 15;
const TITLE = '🆕 Новых задач';

const COLS = [
  ['task', /^задача$/i], ['article', /^артикул$/i], ['product', /^товар$/i],
  ['what', /^что сделать$/i], ['check', /^проверка/i], ['comment', /^комментарий$/i],
];
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const norm = (v) => clean(v).toLowerCase().replace(/ё/g, 'е');
// D без цифр, знаков препинания и символов (₽, %, +, ·): остаются только слова.
const normWhat = (v) => norm(v).replace(/[\d\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
const idOf = (r) => crypto.createHash('sha1').update([norm(r.task), norm(r.article), normWhat(r.what)].join('\u0001')).digest('hex').slice(0, 16);

// values — массив строк листа (как отдаёт Sheets API / CSV). Возвращает { id: { A, B, C, D, F } } в порядке листа.
function parseRows(values) {
  const hi = values.findIndex((row, i) => i < 10 && row.some((c) => /^задача$/i.test(clean(c))) && row.some((c) => /^что сделать$/i.test(clean(c))));
  if (hi < 0) throw new Error('в листе «Елена (Ozon)» не нашёл заголовки «Задача» и «Что сделать» — структура таблицы изменилась');
  const pos = {};
  for (const [k, re] of COLS) pos[k] = values[hi].findIndex((c) => re.test(clean(c)));
  const rows = {};
  for (const raw of values.slice(hi + 1)) {
    const r = {};
    for (const [k] of COLS) r[k] = pos[k] >= 0 ? clean(raw[pos[k]]) : '';
    if (!r.article) continue; // пустые строки и строки без артикула (B)
    const id = idOf(r);
    if (!rows[id]) rows[id] = { A: r.task, B: r.article, C: r.product, D: r.what, F: r.comment };
  }
  return rows;
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJson(p, d) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`; fs.writeFileSync(tmp, JSON.stringify(d, null, 2)); fs.renameSync(tmp, p);
}
const readSnap = () => readJson(SNAP_PATH());
const readState = () => readJson(STATE_PATH()) || {};
const patchState = (p) => writeJson(STATE_PATH(), { ...readState(), ...p });

// Новые = id нет в снимке (в порядке листа).
const newIds = (snap, cur) => Object.keys(cur).filter((id) => !snap[id]);
// Новый снимок: только то, что сейчас в таблице; у старых first_seen сохраняется.
function nextSnap(snap, cur, nowIso) {
  const out = {};
  for (const [id, r] of Object.entries(cur)) out[id] = { A: r.A, B: r.B, D: r.D, first_seen: (snap && snap[id] && snap[id].first_seen) || nowIso };
  return out;
}

function taskBlock(r, n) {
  const lines = [`${n}) ${r.B}${r.C ? ` — ${r.C}` : ''}`];
  if (r.A) lines.push(`Задача: ${r.A}`);
  if (r.D) lines.push(`Что сделать: ${r.D}`);
  if (r.F) lines.push('(комментарий уже есть)');
  return lines.join('\n');
}
function buildMessage(cur, ids) {
  const shown = ids.slice(0, MAX_SHOWN);
  const parts = [`${TITLE}: ${ids.length}`, ...shown.map((id, i) => taskBlock(cur[id], i + 1))];
  if (ids.length > shown.length) parts.push(`и ещё ${ids.length - shown.length}`);
  return parts.join('\n\n');
}

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


const NO_ROWS = 'лист «Елена (Ozon)» прочитался пустым — не трогаю снимок, проверю позже (возможно, таблицу как раз обновляет скрипт)';

// Плановая проверка. send(text) — отправка Елене; снимок и метка дня пишутся ТОЛЬКО после успешной отправки
// (упала отправка/чтение — ничего не сохраняется, следующий тик повторит). Возвращает { first, sent, newCount, total }.
async function check({ today, read = fetchValues, send, now = () => new Date() } = {}) {
  const cur = parseRows(await read());
  const snap = readSnap();
  const total = Object.keys(cur).length;
  const nowIso = now().toISOString();
  if (!snap) { // первый запуск: только запоминаем, что есть сейчас
    writeJson(SNAP_PATH(), nextSnap(null, cur, nowIso));
    patchState({ ...(today ? { lastRunDate: today } : {}), lastErrorAt: null });
    return { first: true, sent: false, newCount: 0, total };
  }
  if (!total && Object.keys(snap).length) throw new Error(NO_ROWS);
  const ids = newIds(snap, cur);
  let sent = false;
  if (ids.length) { await send(buildMessage(cur, ids)); sent = true; }
  else if (process.env.SHEET_EMPTY_NOTICE === '1') { await send(`Новых задач нет. Всего активных: ${total}.`); sent = true; }
  writeJson(SNAP_PATH(), nextSnap(snap, cur, nowIso));
  patchState({ ...(today ? { lastRunDate: today } : {}), lastErrorAt: null });
  return { first: false, sent, newCount: ids.length, total };
}

// /задания: что было бы новым прямо сейчас. Ничего не записывает (ни снимок, ни метки).
async function preview({ read = fetchValues } = {}) {
  const cur = parseRows(await read());
  const snap = readSnap();
  const total = Object.keys(cur).length;
  if (!snap) return { text: `Снимка ещё нет: ближайшая проверка в ${String(RUN_HOUR).padStart(2, '0')}:00 по Бали сохранит текущие задачи как «уже известные» и ничего не пришлёт. Сейчас в листе активных задач: ${total}.`, newCount: 0, total };
  const ids = newIds(snap, cur);
  const text = ids.length ? `${buildMessage(cur, ids)}\n\nВсего активных: ${total}.` : `Новых задач нет. Всего активных: ${total}.`;
  return { text, newCount: ids.length, total };
}

const dueToday = (today, hour) => hour >= RUN_HOUR && readState().lastRunDate !== today;

module.exports = { parseRows, idOf, normWhat, buildMessage, check, preview, dueToday, readSnap, readState, patchState, AccessError, TITLE, RUN_HOUR, MAX_SHOWN };
