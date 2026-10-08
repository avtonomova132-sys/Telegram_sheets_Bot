// Мониторинг остатков на складах Озона (FBO): еда с коротким сроком годности,
// которая лежит на региональном складе маленькой партией (от 3 шт одного
// артикула на одном складе), может испортиться. Раз в день (08:00 по Бали)
// модуль читает остатки через Ozon Seller API (ключ только на ЧТЕНИЕ —
// роль «Admin read only») и шлёт Елене только НОВОЕ. Ничего в кабинете не
// меняет: цену и заявку на вывоз Елена делает сама.
//
// Переменные окружения: OZON_API_KEY, OZON_CLIENT_ID (обязательны),
// FBO_MIN_QTY (порог, по умолчанию 3), FBO_FOOD_KEYWORDS (доп. слова для
// определения еды, через запятую), FBO_EXTRA_CHAT_IDS, FBO_STATE_PATH.

const fs = require('fs');
const path = require('path');

const OZON_HOST = process.env.OZON_API_HOST || 'https://api-seller.ozon.ru';
const STATE_PATH = process.env.FBO_STATE_PATH || '/data/fbo_state.json';
const MIN_QTY = Number(process.env.FBO_MIN_QTY) > 0 ? Number(process.env.FBO_MIN_QTY) : 3;
const PRICE_CUT = 0.08;
const PAGE_LIMIT = 1000;
const REQUEST_TIMEOUT_MS = 40000;

// Признаки еды ищем в названии и артикуле (нижний регистр, «ё» → «е»).
// Это основа ассортимента: кондитерка. Косметика, бирки, пакеты, фрезы
// в список не попадают.
const FOOD_KEYWORDS = [
  'конфет', 'шоколад', 'халв', 'мармелад', 'зефир', 'маршмеллоу', 'печень',
  'пряник', 'карамел', 'вафл', 'драже', 'леденц', 'ирис', 'батончик',
  'пастил', 'сладк', 'кондитер', 'смузи', 'жевательн', 'торт', 'кекс',
  'капкейк', 'крекер', 'цитрон', 'сахар', 'орех', 'мед ', 'варенье',
  'бабаевск', 'рот фронт', 'ротфронт', 'красный октябрь', 'красныйоктябрь',
  'аленк', 'коровка', 'буревестник', 'нука', 'ну-ка', 'хорошая компания',
  'хорошаякомпания', 'украли сахар', 'необотаника', 'neobotanic', 'neo-botanic',
  'dark cream', 'ббтемн', 'шок_', 'мармелад',
  ...String(process.env.FBO_FOOD_KEYWORDS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
];

function norm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е');
}

function isFood(row) {
  const hay = norm(`${row.name} ${row.article}`);
  return FOOD_KEYWORDS.some((k) => hay.includes(norm(k)));
}

// ---------- хранилище состояния ----------

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(data) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

function patchState(patch) {
  const next = { ...readState(), ...patch };
  writeState(next);
  return next;
}

// ---------- Ozon API ----------

function isConfigured() {
  return Boolean(process.env.OZON_API_KEY && process.env.OZON_CLIENT_ID);
}

async function ozonPost(endpoint, body) {
  if (!isConfigured()) {
    throw new Error('не заданы OZON_API_KEY / OZON_CLIENT_ID в Railway');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
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
    if (!res.ok) {
      const err = new Error(`Озон ${endpoint}: HTTP ${res.status} ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Озон ${endpoint}: нет ответа за ${REQUEST_TIMEOUT_MS / 1000} с`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Ответы разных версий метода лежат в разных местах — достаём список строк.
function extractList(data) {
  if (Array.isArray(data)) return data;
  const candidates = [data?.items, data?.rows, data?.result?.rows, data?.result?.items, data?.result];
  return candidates.find(Array.isArray) || null;
}

function normalizeRow(it) {
  const available = it.available_stock_count ?? it.free_to_sell_amount ?? it.valid_stock_count ?? 0;
  return {
    sku: it.sku,
    article: String(it.offer_id || it.item_code || '').trim(),
    name: String(it.name || it.item_name || '').trim(),
    cluster: String(it.cluster_name || '').trim(),
    warehouse: String(it.warehouse_name || it.cluster_name || 'склад не указан').trim(),
    available: num(available),
    returning: num(it.return_from_customer_stock_count),
    transit: num(it.transit_stock_count),
    expiring: num(it.expiring_stock_count),
  };
}

// ---- Полный отчёт (как «Управление остатками» в кабинете): остатки по
// кластерам с возвратами и товарами в пути. Нужны SKU — берём их из каталога,
// только у еды (иначе тысячи лишних запросов).
async function fetchCatalog() {
  const items = [];
  let lastId = '';
  for (let page = 0; page < 20; page += 1) {
    const data = await ozonPost('/v3/product/list', { filter: { visibility: 'ALL' }, last_id: lastId, limit: 1000 });
    const list = data?.result?.items || data?.items || [];
    items.push(...list);
    lastId = data?.result?.last_id || data?.last_id || '';
    if (!lastId || list.length < 1000) break;
  }
  const offers = items.map((i) => i.offer_id).filter(Boolean);
  const info = [];
  let sample = null;
  for (let i = 0; i < offers.length; i += 1000) {
    const data = await ozonPost('/v3/product/info/list', { offer_id: offers.slice(i, i + 1000) });
    const list = extractList(data) || [];
    if (!sample && list[0]) sample = list[0];
    info.push(...list);
  }
  const products = info.map((it) => ({
    article: String(it.offer_id || '').trim(),
    name: String(it.name || '').trim(),
    sku: it.sku || (it.sources || []).map((x) => x.sku).find(Boolean) || null,
  }));
  return { products, sample };
}

async function fetchViaAnalytics() {
  const { products, sample: catalogSample } = await fetchCatalog();
  const food = products.filter((p) => p.sku && isFood(p));
  if (!food.length) throw new Error(`каталог: товаров ${products.length}, еды с SKU 0 (поля товара: ${catalogSample ? Object.keys(catalogSample).join(', ') : '—'})`);
  const byDigits = new Map(food.map((p) => [String(p.sku), p]));
  const skus = food.map((p) => String(p.sku));
  const rows = [];
  let sample = null;
  for (let i = 0; i < skus.length; i += 100) {
    const data = await ozonPost('/v1/analytics/stocks', { skus: skus.slice(i, i + 100) });
    const list = extractList(data);
    if (!list) throw new Error(`/v1/analytics/stocks: неожиданный формат ответа (ключи: ${Object.keys(data || {}).join(', ') || 'пусто'})`);
    if (!sample && list[0]) sample = list[0];
    for (const it of list) {
      const prod = byDigits.get(String(it.sku)) || {};
      rows.push(normalizeRow({ ...it, offer_id: it.offer_id || prod.article, name: it.name || prod.name }));
    }
  }
  return { endpoint: '/v1/analytics/stocks', rows, sample, foodSkus: skus.length };
}

// Остатки по складам. Сначала новый отчёт «управление остатками»; если Озон
// его не принял (другая схема/доступ) — старый «остатки на складах».
async function fetchStockRows() {
  const attempts = [
    { endpoint: '/v2/analytics/stock_on_warehouses', body: (offset) => ({ limit: PAGE_LIMIT, offset, warehouse_type: 'ALL' }) },
  ];
  let lastErr;
  const errors = [];
  // Полный отчёт (с возвратами и «в пути»). Не вышло — запасной старый метод,
  // в нём только «доступно к продаже».
  try {
    const full = await fetchViaAnalytics();
    return { ...full, errors };
  } catch (err) {
    errors.push(`полный отчёт: ${err.message.slice(0, 220)}`);
    if (err.status === 401 || err.status === 403) throw err;
  }
  for (const a of attempts) {
    try {
      const rows = [];
      let sample = null;
      for (let offset = 0, page = 0; page < 50; page += 1) {
        const data = await ozonPost(a.endpoint, a.body(offset));
        const list = extractList(data);
        if (!list) throw new Error(`${a.endpoint}: неожиданный формат ответа (ключи: ${Object.keys(data || {}).join(', ') || 'пусто'})`);
        if (!sample && list[0]) sample = list[0];
        rows.push(...list.map(normalizeRow));
        if (list.length < PAGE_LIMIT) break;
        offset += PAGE_LIMIT;
      }
      return { endpoint: a.endpoint, rows, errors, sample };
    } catch (err) {
      lastErr = err;
      errors.push(err.message.slice(0, 220));
      // 401/403 — ключ/доступ, пробовать другой метод бессмысленно
      if (err.status === 401 || err.status === 403) throw err;
    }
  }
  throw lastErr;
}

// Текущая цена — необязательная подсказка («-8%»). Любая ошибка = без цены.
async function fetchPrices(articles) {
  const prices = {};
  const list = [...new Set(articles)].filter(Boolean);
  for (let i = 0; i < list.length; i += 100) {
    try {
      const data = await ozonPost('/v3/product/info/list', { offer_id: list.slice(i, i + 100) });
      for (const it of extractList(data) || []) {
        const p = num(it.price?.price ?? it.price);
        if (it.offer_id && p > 0) prices[it.offer_id] = p;
      }
    } catch (err) {
      console.error('[fbo] цены не получены:', err.message);
      break;
    }
  }
  return prices;
}

// ---------- анализ ----------

// Склеиваем строки по паре «артикул + склад» (на один склад Озон может
// отдать несколько строк) и оставляем только еду.
function groupFood(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!r.article || !isFood(r)) continue;
    const key = `${r.article}|${r.warehouse}`;
    const g = map.get(key) || { key, article: r.article, name: r.name, warehouse: r.warehouse, qty: 0, available: 0, returning: 0, transit: 0, expiring: 0 };
    g.available += r.available;
    g.returning += r.returning || 0;
    g.transit += r.transit || 0;
    g.qty += r.available + (r.returning || 0) + (r.transit || 0);
    g.expiring += r.expiring;
    map.set(key, g);
  }
  return [...map.values()];
}

function pickAlerts(groups) {
  return groups.filter((g) => g.qty >= MIN_QTY || g.expiring > 0).sort((a, b) => b.qty - a.qty);
}

function formatRub(n) {
  return `${Math.round(n)} ₽`;
}

function itemLine(g, prices) {
  const detail = [g.available && `в продаже ${g.available}`, g.returning && `возвращаются ${g.returning}`, g.transit && `в пути ${g.transit}`].filter(Boolean).join(', ');
  const parts = [`• ${g.warehouse} — ${g.qty} шт${detail && g.qty !== g.available ? ` (${detail})` : ''}`];
  if (g.expiring > 0) parts.push(`⏳ срок истекает: ${g.expiring} шт`);
  const p = prices[g.article];
  if (p && g.qty >= MIN_QTY) parts.push(`цена ${formatRub(p)} → −8% = ${formatRub(p * (1 - PRICE_CUT))}`);
  return parts.join(' · ');
}

function buildMessage(items, prices, title) {
  const byArticle = new Map();
  for (const g of items) {
    if (!byArticle.has(g.article)) byArticle.set(g.article, []);
    byArticle.get(g.article).push(g);
  }
  const blocks = [];
  for (const [article, list] of byArticle) {
    blocks.push([`${list[0].name || article} (${article})`, ...list.map((g) => itemLine(g, prices))].join('\n'));
  }
  return `${title}\n\n${blocks.join('\n\n')}`;
}

// save=true — запоминаем, о чём уже сообщили; fresh = то, что появилось
// или выросло с прошлой отправки. Вернувшееся ниже порога забываем, чтобы
// при новом превышении сообщить снова.
async function runCheck({ save = false } = {}) {
  const { endpoint, rows } = await fetchStockRows();
  const groups = groupFood(rows);
  const alerts = pickAlerts(groups);
  const state = readState();
  const prev = state.alerted || {};
  const fresh = alerts.filter((g) => {
    const p = prev[g.key];
    return !p || g.qty > p.qty || g.expiring > p.expiring;
  });
  const next = {};
  for (const g of alerts) next[g.key] = { qty: g.qty, expiring: g.expiring };
  if (save) patchState({ alerted: next, lastCheckAt: Date.now() });
  return { endpoint, rows, groups, alerts, fresh };
}

async function buildReport(items) {
  const prices = await fetchPrices(items.map((g) => g.article));
  return { prices };
}

// Ответ на /fbo: полная картина «сейчас», одной строкой, если нечего возвращать.
async function currentMessage() {
  const result = await runCheck({ save: false });
  if (!result.alerts.length) {
    return { text: `Нечего возвращать ✅ (еды на FBO: ${result.groups.reduce((s, g) => s + g.qty, 0)} шт, ни одного артикула от ${MIN_QTY} шт на складе)`, result };
  }
  const { prices } = await buildReport(result.alerts);
  return { text: buildMessage(result.alerts, prices, `🍫 FBO: еда на складах Озона (порог ${MIN_QTY} шт)`), result };
}

// Для ежедневной проверки: только новое; null, если новостей нет.
async function dailyMessage() {
  const result = await runCheck({ save: true });
  if (!result.fresh.length) return { text: null, result };
  const { prices } = await buildReport(result.fresh);
  return { text: buildMessage(result.fresh, prices, '🍫 FBO: новое на складах Озона'), result };
}

// Отладка первой настоящей проверки: какой метод ответил, сколько строк,
// что считаем едой, а что нет — чтобы подправить список слов.
async function debugMessage() {
  const { endpoint, rows, errors, sample, foodSkus } = await fetchStockRows();
  const label = (r) => `${r.article} — «${r.name.slice(0, 40)}» — ${r.warehouse}: продаже ${r.available}, возвр. ${r.returning || 0}, в пути ${r.transit || 0}, срок ${r.expiring}`;
  const food = rows.filter(isFood).map(label);
  const other = rows.filter((r) => !isFood(r)).map(label);
  const cut = (arr) => arr.slice(0, 30).join('\n') + (arr.length > 30 ? `\n… (+${arr.length - 30})` : '');
  return [
    `🔧 FBO отладка`,
    `Метод: ${endpoint}`,
    errors.length ? `Ошибки до этого:\n${errors.join('\n')}` : null,
    `Поля первой строки: ${sample ? Object.keys(sample).join(', ') : '—'}`,
    foodSkus ? `Еды с SKU в каталоге: ${foodSkus}` : null,
    `Строк в ответе: ${rows.length}`,
    `Едой считаю (${food.length}):\n${cut(food) || '—'}`,
    `Не едой (${other.length}):\n${cut(other) || '—'}`,
    `Порог: ${MIN_QTY} шт`,
  ].filter(Boolean).join('\n\n');
}


// Разведка: какие методы Озона вообще существуют для этого ключа. Шлём пустое
// тело (ничего не создаётся и не меняется): 404 = такого метода нет,
// 400/200/403 = метод есть.
const PROBE_PATHS = [
  '/v3/product/list',
  '/v1/analytics/stocks',
  '/v1/analytics/turnover/stocks',
  '/v1/report/placement/by-products/create',
  '/v1/report/placement/by-supplies/create',
  '/v1/analytics/placement',
  '/v1/analytics/placement/products',
  '/v1/analytics/storage',
  '/v1/analytics/storage-fee',
  '/v1/analytics/forced-placement',
  '/v1/analytics/stocks/placement',
  '/v1/finance/placement',
  '/v1/fbo/placement',
  '/v1/stocks/placement',
  '/v1/analytics/manage/stocks',
  '/v1/analytics/manage/stocks/placement',
  '/v1/report/stocks/create',
  '/v1/report/info',
];

async function probeMessage() {
  if (!isConfigured()) throw new Error('не заданы OZON_API_KEY / OZON_CLIENT_ID в Railway');
  const lines = [];
  for (const path of PROBE_PATHS) {
    try {
      const res = await fetch(`${OZON_HOST}${path}`, {
        method: 'POST',
        headers: {
          'Client-Id': String(process.env.OZON_CLIENT_ID).trim(),
          'Api-Key': String(process.env.OZON_API_KEY).trim(),
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      const text = (await res.text()).replace(/\s+/g, ' ').slice(0, 70);
      lines.push(`${res.status === 404 ? '❌' : '✅'} ${res.status} ${path}${res.status === 404 ? '' : ` — ${text}`}`);
    } catch (err) {
      lines.push(`⚠️ ${path} — ${err.message.slice(0, 60)}`);
    }
  }
  return `🔧 FBO разведка методов Озона\n\n${lines.join('\n')}`;
}

module.exports = {
  probeMessage,
  isConfigured,
  readState,
  patchState,
  isFood,
  groupFood,
  pickAlerts,
  buildMessage,
  runCheck,
  currentMessage,
  dailyMessage,
  debugMessage,
};
