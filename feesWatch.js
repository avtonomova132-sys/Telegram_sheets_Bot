// Страж платных списаний Ozon: раз в день читает операции из финансового
// отчёта (только чтение, ключ OZON_API_KEY — роль Admin read only) и пишет
// Елене, когда в списаниях появляется что-то новое или платное: подписки
// (Premium, «Управление отзывами»), «Звёздные товары», сбор отзывов,
// продвижение. Заранее бот узнать об автоподключении не может — только по
// факту списания, поэтому раз в месяц (с FEES_REMINDER_DAY, 25-го) ещё
// напоминает проверить «Финансы → Витрина услуг».
// Старый /v3/finance/transaction/list Ozon закрыл — читаем
// /v1/finance/accrual/by-day (по одному дню) и справочник
// /v1/finance/accrual/types. Схема не сверена с живым Озоном — смотреть
// /списания_debug.

const fs = require('fs');
const path = require('path');

const OZON_HOST = process.env.OZON_API_HOST || 'https://api-seller.ozon.ru';
const STATE_PATH = process.env.FEES_WATCH_STATE_PATH || '/data/fees_watch_state.json';
const TIMEOUT_MS = 30000;
const PAGE_SIZE = 1000;
const LOOKBACK_DAYS = Number(process.env.FEES_LOOKBACK_DAYS) || 3;
// Слова, по которым название списания считается «платной программой».
const PAID_WORDS = (process.env.FEES_PAID_WORDS ||
  'подписк,premium,премиум,звёзд,звезд,star,отзыв,review,продвижен,реклам,бренд,promo,трафарет,клик')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}
function getState() { return readJson(STATE_PATH, {}); }
function patchState(patch) { writeJsonAtomic(STATE_PATH, { ...getState(), ...patch }); }

function isConfigured() {
  return Boolean(process.env.OZON_API_KEY && process.env.OZON_CLIENT_ID);
}

async function ozon(endpoint, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${OZON_HOST}${endpoint}`, {
      method: 'POST',
      headers: {
        'Client-Id': String(process.env.OZON_CLIENT_ID).trim(),
        'Api-Key': String(process.env.OZON_API_KEY).trim(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Озон ${endpoint}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

function dayStr(ms) { return new Date(ms).toISOString().slice(0, 10); }

// Справочник типов начислений: type_id → название (только чтение).
// Форма ответа не сверена с живым Озоном — разбираем осторожно.
async function loadTypes() {
  const data = await ozon('/v1/finance/accrual/types', {});
  const list = data.result?.types || data.result?.accrual_types || data.types || data.result || [];
  const map = new Map();
  if (Array.isArray(list)) {
    for (const t of list) {
      const id = t.id ?? t.type_id;
      const name = t.name ?? t.title ?? t.type_name;
      if (id !== undefined && name) map.set(String(id), String(name));
    }
  }
  return map;
}

// Все начисления за один день (курсор last_id).
async function accrualsForDay(day) {
  const out = [];
  let lastId = '';
  for (let guard = 0; guard < 200; guard++) {
    const body = { date: day };
    if (lastId) body.last_id = lastId;
    const data = await ozon('/v1/finance/accrual/by-day', body);
    const list = data.accruals || data.result?.accruals || [];
    out.push(...list);
    lastId = data.last_id || data.result?.last_id || '';
    if (!lastId || !list.length) break;
  }
  return out;
}

function amountOf(o) {
  const v = o.total_amount?.amount ?? o.amount?.amount ?? o.amount ?? o.price ?? o.total;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Ищем в начислении все объекты с type_id (услуги/сборы лежат на разной
// глубине: posting.products[].delivery.services, item_fees.fees[].fees,
// non_item_fee, container_fees…). Возвращаем [{ typeId, amount }].
function collectFees(node, acc = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return acc;
  if (Array.isArray(node)) { for (const x of node) collectFees(x, acc, depth + 1); return acc; }
  if (node.type_id !== undefined && node.type_id !== null) {
    acc.push({ typeId: String(node.type_id), amount: amountOf(node) });
  }
  for (const k of Object.keys(node)) {
    if (node[k] && typeof node[k] === 'object') collectFees(node[k], acc, depth + 1);
  }
  return acc;
}

// Операции за последние `days` дней, уже в виде [{ name, amount }].
async function listOperations(days = LOOKBACK_DAYS, now = Date.now()) {
  const types = await loadTypes().catch(() => new Map());
  const ops = [];
  for (let i = 0; i < days; i++) {
    const day = dayStr(now - i * 86400000);
    for (const acc of await accrualsForDay(day)) {
      const fees = collectFees(acc);
      if (!fees.length) {
        ops.push({ name: types.get(String(acc.type_id)) || acc.accrued_category || 'начисление', amount: amountOf(acc) });
        continue;
      }
      for (const f of fees) ops.push({ name: types.get(f.typeId) || `тип ${f.typeId}`, amount: f.amount });
    }
  }
  return ops;
}

// Для отладки: один «живой» пример начисления и кусок справочника.
async function debugSample() {
  const types = await loadTypes().catch((e) => `ошибка: ${e.message}`);
  const day = dayStr(Date.now() - 86400000);
  const list = await accrualsForDay(day);
  return { day, count: list.length, sample: list[0] || null, typesCount: types instanceof Map ? types.size : types, typesSample: types instanceof Map ? [...types.entries()].slice(0, 5) : null };
}

// Свод по названиям: название → { sum, count }.
function summarize(ops) {
  const out = new Map();
  for (const op of ops) {
    const n = String(op.name || '').trim();
    if (!n) continue;
    const cur = out.get(n) || { sum: 0, count: 0 };
    cur.sum += Number(op.amount) || 0;
    cur.count += 1;
    out.set(n, cur);
  }
  return out;
}

function isPaidName(name) {
  const l = name.toLowerCase();
  return PAID_WORDS.some((w) => l.includes(w));
}

const money = (n) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;

// Сравнение с тем, что уже видели. Возвращает { alerts, known }.
function diff(summary, state, monthKey) {
  const known = new Set(state.knownNames || []);
  const firstRun = !state.knownNames;
  const paidSeen = { ...(state.paidSeen || {}) };
  const alerts = [];
  for (const [name, v] of summary) {
    const paid = isPaidName(name);
    const k = `${name}|${monthKey}`;
    if (paid && !paidSeen[k]) {
      alerts.push({ name, ...v, why: 'платная программа' });
      paidSeen[k] = true;
    } else if (!paid && !firstRun && !known.has(name)) {
      alerts.push({ name, ...v, why: 'новый вид списания' });
    }
    known.add(name);
  }
  return { alerts, known: [...known], paidSeen };
}

function formatAlerts(alerts, days = LOOKBACK_DAYS) {
  const lines = alerts.map((a) => `• ${a.name} — ${money(a.sum)} (${a.count} шт.), ${a.why}`);
  return `💸 Ozon: в списаниях за последние ${days} дн. —\n${lines.join('\n')}\n\nЕсли это не нужно — «Финансы → Витрина услуг», там отключить.`;
}

function formatSummary(summary) {
  if (!summary.size) return 'За период списаний не нашёл.';
  const rows = [...summary.entries()].sort((a, b) => a[1].sum - b[1].sum)
    .map(([n, v]) => `${isPaidName(n) ? '💸' : '•'} ${n}: ${money(v.sum)} (${v.count})`);
  return rows.join('\n');
}

module.exports = {
  isConfigured, listOperations, summarize, diff, formatAlerts, formatSummary,
  getState, patchState, isPaidName, debugSample,
};
