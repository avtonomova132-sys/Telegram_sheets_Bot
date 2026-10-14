// Страж платных списаний Ozon: раз в день читает операции из финансового
// отчёта (только чтение, ключ OZON_API_KEY — роль Admin read only) и пишет
// Елене, когда в списаниях появляется что-то новое или платное: подписки
// (Premium, «Управление отзывами»), «Звёздные товары», сбор отзывов,
// продвижение. Заранее бот узнать об автоподключении не может — только по
// факту списания, поэтому раз в месяц (с FEES_REMINDER_DAY, 25-го) ещё
// напоминает проверить «Финансы → Витрина услуг».
// Схема ответа /v3/finance/transaction/list не сверена с живым Озоном —
// смотреть /списания_debug.

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

function isoDay(ms) { return new Date(ms).toISOString(); }

// Список операций за последние `days` дней (только чтение).
async function listOperations(days = LOOKBACK_DAYS, now = Date.now()) {
  const from = isoDay(now - days * 86400000);
  const to = isoDay(now);
  const ops = [];
  for (let page = 1; page <= 100; page++) {
    const data = await ozon('/v3/finance/transaction/list', {
      filter: { date: { from, to }, operation_type: [], posting_number: '', transaction_type: 'all' },
      page,
      page_size: PAGE_SIZE,
    });
    const list = data.result?.operations || [];
    ops.push(...list);
    const pageCount = Number(data.result?.page_count) || 0;
    if (!list.length || page >= pageCount) break;
  }
  return ops;
}

// Свод по названиям списаний: название → { sum, count }.
// Берём и название операции, и названия услуг внутри неё.
function summarize(ops) {
  const out = new Map();
  const add = (name, sum) => {
    const n = String(name || '').trim();
    if (!n) return;
    const cur = out.get(n) || { sum: 0, count: 0 };
    cur.sum += Number(sum) || 0;
    cur.count += 1;
    out.set(n, cur);
  };
  for (const op of ops) {
    const services = Array.isArray(op.services) ? op.services : [];
    if (services.length) for (const s of services) add(s.name, s.price);
    else add(op.operation_type_name || op.operation_type, op.amount);
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
  getState, patchState, isPaidName,
};
