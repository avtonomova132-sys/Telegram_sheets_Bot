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
// Достаём из произвольного JSON все пары «id → название»: массивы объектов,
// где есть id/type_id и name/title/… (схема справочника не задокументирована).
function extractTypeMap(node, map = new Map(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return map;
  if (Array.isArray(node)) {
    for (const t of node) {
      if (t && typeof t === 'object' && !Array.isArray(t)) {
        const id = t.id ?? t.type_id ?? t.code;
        const name = t.name ?? t.title ?? t.type_name ?? t.description ?? t.label;
        if (id !== undefined && id !== null && typeof name === 'string' && name) map.set(String(id), name);
      }
      extractTypeMap(t, map, depth + 1);
    }
    return map;
  }
  // Вариант «объект-словарь»: { "1": "Комиссия", ... } или { "1": {name: ...} }
  for (const [k, v] of Object.entries(node)) {
    if (/^\d+$/.test(k)) {
      if (typeof v === 'string') map.set(k, v);
      else if (v && typeof v === 'object') {
        const name = v.name ?? v.title ?? v.type_name;
        if (typeof name === 'string') map.set(k, name);
      }
    } else if (v && typeof v === 'object') extractTypeMap(v, map, depth + 1);
  }
  return map;
}

let typesRawSample = null;
async function loadTypes() {
  let data = await ozon('/v1/finance/accrual/types', {});
  let map = extractTypeMap(data);
  if (!map.size) {
    // Возможно, метод ждёт GET-подобный пустой запрос с другим телом.
    data = await ozon('/v1/finance/accrual/types', { language: 'RU' }).catch(() => data);
    map = extractTypeMap(data);
  }
  typesRawSample = map.size ? null : JSON.stringify(data).slice(0, 1200);
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

// Начисления без type_id (категория POSTING и т.п. — суммы по отправлению, а не услуга):
// в сводке видны, но «новым видом списания» не считаются.
const UNTYPED = '(без типа)';

function amountOf(o) {
  const v = o.accrued?.amount ?? o.total_amount?.amount ?? o.amount?.amount ?? o.amount ?? o.price ?? o.total;
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
        ops.push({ name: types.get(String(acc.type_id)) || `${UNTYPED} ${acc.accrued_category || 'начисление'}`, amount: amountOf(acc), day });
        continue;
      }
      for (const f of fees) ops.push({ name: types.get(f.typeId) || `тип ${f.typeId}`, amount: f.amount, day });
    }
  }
  return ops;
}

// Для отладки: один «живой» пример начисления и кусок справочника.
async function debugSample() {
  const types = await loadTypes().catch((e) => `ошибка: ${e.message}`);
  const day = dayStr(Date.now() - 86400000);
  const list = await accrualsForDay(day);
  return { day, count: list.length, sample: list[0] || null, typesCount: types instanceof Map ? types.size : types, typesSample: types instanceof Map ? [...types.entries()].slice(0, 5) : null, typesRaw: typesRawSample };
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

// Пошаговые инструкции «как отключить» по ключевым словам названия списания.
// Пути взяты из уведомлений самого Озона (чат «Подписки и лояльность»).
const HOWTO = [
  { words: ['premium', 'премиум', 'аналитика premium'], steps: [
    'Premium (подписка):',
    '1) seller.ozon.ru → «Настройки» → «Договоры»',
    '2) блок «Premium для продавцов» → кнопка «Отключить подписку»',
    '3) придёт сообщение «Скоро отключим Premium» — значит отключено со следующего периода.' ] },
  { words: ['звёзд', 'звезд', 'star'], steps: [
    'Звёздные товары (1,5% с продаж):',
    '1) верхнее меню «Продвижение» → слева «Повысить лояльность» → у «Звёздных товаров» «Перейти»',
    '2) если программа включена — «Отключить»; если видите «Подключить бесплатно на 14 дней» — она уже выключена (не нажимайте!).' ] },
  { words: ['бренд'], steps: [
    'Продвижение брендов (1% с продаж):',
    '1) верхнее меню «Товары» → «Бренды» (в ряде кабинетов «Товары и цены» → «Бренды»)',
    '2) по каждому бренду выключить «Продвигать» и акцию «Морковск».' ] },
  { words: ['отзыв', 'review'], steps: [
    'Подписка «Управление отзывами» (1,3% с цены каждого проданного товара):',
    '1) «Финансы» → «Начисления и документы» → «Витрина услуг» (или seller.ozon.ru/app/finances/services-showcase)',
    '2) карточка «Подписка Управление отзывами» → «Управлять подпиской» → «Отключить подписку» → «Отказаться» → причина → «Отключить»',
    '3) отключится только по окончании оплаченного периода — отключайте сразу после подключения.',
    'Сбор отзывов: «Товары» → «Отзывы» → «Ускоренный сбор отзывов» — в кампании удалить товары корзинкой.' ] },
];
const GENERIC_HOWTO = 'Где отключить: «Финансы» → «Начисления и документы» → «Витрина услуг» (seller.ozon.ru/app/finances/services-showcase), открыть карточку услуги. Если такого пункта нет — в строке поиска вверху кабинета введите название услуги и откройте её страницу.';

function howTo(name) {
  const l = name.toLowerCase();
  const h = HOWTO.find((x) => x.words.some((w) => l.includes(w)));
  return h ? h.steps.join('\n') : GENERIC_HOWTO;
}

// ---------- Новая логика оповещения (2026-11-18) ----------
// Сообщаем ТОЛЬКО о: (а) виде списания, которого нет в списках «знаю» (feesKnown.js), включая «всегда сообщать»
// (звёздные, клики/заказы, платное размещение, новые подписки и Premium других тарифов);
// (б) известной платной услуге, сумма которой за последние LOOKBACK_DAYS выросла больше чем на 30% к предыдущему периоду.
// Обязательные списания молчат всегда. Раз в месяц — один итог по известным платным.
const GROWTH = Number(process.env.FEES_GROWTH_PCT) || 30;
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dm = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

// ops: [{name, amount, day}] за 2×LOOKBACK_DAYS дней. state — снимок бота. today — ГГГГ-ММ-ДД по Бали.
// → { alerts, patch }. Сам ничего не отправляет и не пишет.
function evaluate(ops, state, today, known, days = LOOKBACK_DAYS) {
  const hist = JSON.parse(JSON.stringify(state.hist || {}));
  const reported = { ...(state.reported || {}) };
  const growthAlerted = { ...(state.growthAlerted || {}) };
  const winFrom = addDays(today, -(days - 1));
  const prevFrom = addDays(today, -(2 * days - 1));
  const byName = new Map(); // название → день → { sum, count }
  for (const op of ops) {
    const name = String(op.name || '').trim();
    if (!name || name.startsWith(UNTYPED)) continue;
    const day = op.day || today;
    const m = byName.get(name) || new Map();
    const c = m.get(day) || { sum: 0, count: 0 };
    c.sum += Number(op.amount) || 0; c.count += 1; m.set(day, c); byName.set(name, m);
  }
  const alerts = [];
  for (const [name, dayMap] of byName) {
    const cls = known.classify(name);
    if (cls.type === 'mandatory') continue;
    if (cls.type === 'paid') {
      const h = hist[name] || (hist[name] = {});
      for (const [day, c] of dayMap) h[day] = c.sum;
      const sumIn = (from, to) => Object.entries(h).filter(([d]) => d >= from && d <= to).reduce((a, [, v]) => a + Math.abs(v), 0);
      const cur = sumIn(winFrom, today); const prev = sumIn(prevFrom, addDays(winFrom, -1));
      let ref = prev; let grown = false;
      if (prev > 0) grown = cur > prev * (1 + GROWTH / 100);
      else if (cur > 0) { // разовое/месячное списание: сравниваем с самым большим дневным списанием за прошлые 45 дней
        const older = Object.entries(h).filter(([d]) => d < prevFrom && d >= addDays(today, -45)).map(([, v]) => Math.abs(v));
        ref = older.length ? Math.max(...older) : 0;
        const curMax = Math.max(...Object.entries(h).filter(([d]) => d >= winFrom).map(([, v]) => Math.abs(v)));
        grown = ref > 0 && curMax > ref * (1 + GROWTH / 100);
      }
      const gk = `${name}|${today.slice(0, 7)}`;
      if (grown && !growthAlerted[gk]) {
        growthAlerted[gk] = true;
        const lastDay = Object.keys(h).filter((d) => d >= winFrom).sort().pop() || today;
        alerts.push({ type: 'growth', name, sum: cur, prev: ref, pct: Math.round((cur / ref - 1) * 100), days: [lastDay], count: 1 });
      }
      continue;
    }
    // «всегда» и «неизвестное»: каждый новый (название, день) сообщаем один раз; только за последние LOOKBACK_DAYS
    const fresh = [...dayMap].filter(([day]) => day >= winFrom && !reported[`${name}|${day}`]);
    if (!fresh.length) continue;
    for (const [day] of fresh) reported[`${name}|${day}`] = true;
    alerts.push({ type: cls.type === 'always' ? 'always' : 'unknown', name, sum: fresh.reduce((a, [, c]) => a + c.sum, 0), count: fresh.reduce((a, [, c]) => a + c.count, 0), days: fresh.map(([d]) => d).sort() });
  }
  // чистка старого
  const cutH = addDays(today, -75); const cutR = addDays(today, -120);
  for (const h of Object.values(hist)) for (const d of Object.keys(h)) if (d < cutH) delete h[d];
  for (const k of Object.keys(reported)) if (k.slice(k.lastIndexOf('|') + 1) < cutR) delete reported[k];
  return { alerts, patch: { v2: true, hist, reported, growthAlerted } };
}

const dateOf = (a) => (a.days.length > 1 ? `${dm(a.days[0])}–${dm(a.days[a.days.length - 1])}` : dm(a.days[0]));
const VERDICT = {
  always: '💸 можно отключить (платная услуга)',
  unknown: '❓ не знаю этот вид: обязательное или можно отключить? Если обязательное — /озон_знаю <название>',
};
const MAX_LINES = 25;
// Сообщение: название, сумма, дата и одна строка «обязательное / можно отключить». Без инструкций.
function formatAlerts(alerts, days = LOOKBACK_DAYS) {
  const lines = alerts.slice(0, MAX_LINES).map((a) => {
    const verdict = a.type === 'growth' ? `💸 можно отключить — выросло на ${a.pct}% (было ${money(a.prev)})` : VERDICT[a.type];
    return `• ${a.name} — ${money(a.sum)}, ${dateOf(a)}\n   ${verdict}`;
  });
  if (alerts.length > MAX_LINES) lines.push(`…и ещё ${alerts.length - MAX_LINES}`);
  return require('./ozonMsg').build({
    title: `💸 Ozon: в списаниях за последние ${days} дн.`,
    why: 'увидеть новое или подорожавшее платное списание, остальное молчит.',
    body: lines.join('\n'),
  });
}

// Раз в месяц (первый запуск нового месяца) — один итог по известным платным услугам (по данным, что бот видел).
function monthlyDigest(state, today, known) {
  const monthKey = today.slice(0, 7);
  if (state.digestMonth === monthKey) return { text: null, patch: {} };
  const [y, m] = monthKey.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const rows = [];
  for (const [name, h] of Object.entries(state.hist || {})) {
    const sum = Object.entries(h).filter(([d]) => d.startsWith(prev)).reduce((a, [, v]) => a + Math.abs(v), 0);
    if (sum > 0) rows.push(`• ${name} — ${money(sum)}`);
  }
  const patch = { digestMonth: monthKey };
  if (!rows.length) return { text: null, patch };
  return { text: require('./ozonMsg').build({ title: `💸 Ozon: итог платных услуг за ${prev.slice(5)}.${prev.slice(0, 4)}`, why: 'раз в месяц видеть, сколько стоят платные услуги, о которых ты знаешь.', body: rows.join('\n') }), patch };
}

// Раз в месяц повторяющиеся списания (одна операция за период) запоминаем с числом
// месяца — за PREWARN_DAYS дней до следующего такого числа предупреждаем заранее.
const PREWARN_DAYS = Number(process.env.FEES_PREWARN_DAYS) || 5;
function trackMonthly(alerts, state, todayStr) {
  const monthly = { ...(state.monthly || {}) };
  const day = Number(todayStr.slice(8, 10));
  for (const a of alerts) {
    if (a.count <= 1 && !monthly[a.name]) monthly[a.name] = { day, sum: a.sum };
  }
  return monthly;
}
function prewarnDue(state, todayStr) {
  const monthly = state.monthly || {};
  const warned = state.prewarned || {};
  const [y, m, d] = todayStr.split('-').map(Number);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out = [];
  for (const [name, v] of Object.entries(monthly)) {
    // следующее списание: ближайшая дата с этим числом (в короткие месяцы — последний день)
    let ny = y, nm = m;
    let cd = Math.min(v.day, dim);
    if (cd <= d) { nm = m + 1; if (nm > 12) { nm = 1; ny += 1; } cd = Math.min(v.day, new Date(Date.UTC(ny, nm, 0)).getUTCDate()); }
    const target = Date.UTC(ny, nm - 1, cd);
    const left = Math.round((target - Date.UTC(y, m - 1, d)) / 86400000);
    const key = `${name}|${ny}-${nm}`;
    if (left <= PREWARN_DAYS && !warned[key]) out.push({ name, sum: v.sum, left, date: `${String(cd).padStart(2, '0')}.${String(nm).padStart(2, '0')}`, key });
  }
  return out;
}
function formatPrewarn(items) {
  const lines = items.map((i) => `• ${i.name} — около ${money(i.sum)}, примерно ${i.date} (через ${i.left} дн.)`);
  const seen = new Set();
  const guides = [];
  for (const i of items) { const g = howTo(i.name); if (!seen.has(g)) { seen.add(g); guides.push(g); } }
  return `⏰ Скоро может списаться:\n${lines.join('\n')}\n\nЕсли не нужно — отключите заранее:\n\n${guides.join('\n\n')}`;
}

function formatSummary(summary) {
  if (!summary.size) return 'За период списаний не нашёл.';
  const rows = [...summary.entries()].sort((a, b) => a[1].sum - b[1].sum)
    .map(([n, v]) => `${isPaidName(n) ? '💸' : '•'} ${n}: ${money(v.sum)} (${v.count})`);
  return rows.join('\n');
}

module.exports = {
  isConfigured, listOperations, summarize, evaluate, monthlyDigest, formatAlerts, formatSummary, LOOKBACK_DAYS,
  getState, patchState, isPaidName, debugSample, trackMonthly, prewarnDue, formatPrewarn, howTo,
};
