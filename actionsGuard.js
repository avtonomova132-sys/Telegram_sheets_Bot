// Страж акций Ozon: смотрит, какие товары сидят в акциях «от Ozon»
// (по ним уходит скидка вплоть до 50% и товар продаётся в минус),
// и по команде владельца убирает их оттуда.
// Отдельный ключ с ролью «Actions» (OZON_ACTIONS_API_KEY) — остальные
// Ozon-модули его не используют. Чтение ничего не меняет; удаление —
// только метод /v1/actions/products/deactivate.

const fs = require('fs');
const path = require('path');

const OZON_HOST = process.env.OZON_API_HOST || 'https://api-seller.ozon.ru';
const STATE_PATH = process.env.ACTIONS_GUARD_STATE_PATH || '/data/actions_guard_state.json';
const TIMEOUT_MS = 30000;
const PAGE = 1000;
const DEACTIVATE_CHUNK = 100;

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

function isConfigured() {
  return Boolean(process.env.OZON_CLIENT_ID && process.env.OZON_ACTIONS_API_KEY);
}

async function ozon(method, endpoint, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${OZON_HOST}${endpoint}`, {
      method,
      headers: {
        'Client-Id': String(process.env.OZON_CLIENT_ID).trim(),
        'Api-Key': String(process.env.OZON_ACTIONS_API_KEY).trim(),
        'Content-Type': 'application/json',
      },
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Озон ${endpoint}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

// Только чтение: список акций.
async function listActions() {
  const data = await ozon('GET', '/v1/actions');
  return (data.result || []).map((a) => ({
    id: a.id,
    title: a.title || `Акция ${a.id}`,
    type: a.action_type || '',
    dateEnd: a.date_end || '',
    count: Number(a.participating_products_count) || 0,
  }));
}

// Только чтение: все товары, которые сейчас участвуют в акции.
async function listParticipants(actionId) {
  const ids = [];
  let lastId = '';
  for (let guard = 0; guard < 200; guard++) {
    const body = { action_id: actionId, limit: PAGE };
    if (lastId) body.last_id = lastId;
    const data = await ozon('POST', '/v1/actions/products', body);
    const products = data.result?.products || [];
    for (const p of products) ids.push(p.id);
    lastId = data.result?.last_id || '';
    if (!lastId || products.length < PAGE) break;
  }
  return ids;
}

// Снимок: акции, в которых реально есть наши товары.
async function snapshot() {
  const actions = await listActions();
  const out = [];
  for (const a of actions) {
    if (!a.count) continue;
    const ids = await listParticipants(a.id);
    if (ids.length) out.push({ ...a, productIds: ids });
  }
  return out;
}

function formatSnapshot(snap) {
  if (!snap.length) return 'Сейчас ни один товар не участвует в акциях от Ozon ✅';
  const total = snap.reduce((s, a) => s + a.productIds.length, 0);
  const lines = snap.map((a) => `• ${a.title} — ${a.productIds.length} шт.`);
  return `В акциях от Ozon сейчас ${total} товар(ов):\n${lines.join('\n')}`;
}

// ИЗМЕНЯЕТ данные: убирает товары из акции. Вызывать только после
// подтверждения владельца (или при ACTIONS_AUTO_REMOVE=1).
async function removeProducts(actionId, productIds) {
  let removed = 0;
  const rejected = [];
  for (let i = 0; i < productIds.length; i += DEACTIVATE_CHUNK) {
    const chunk = productIds.slice(i, i + DEACTIVATE_CHUNK);
    const data = await ozon('POST', '/v1/actions/products/deactivate', {
      action_id: actionId,
      product_ids: chunk,
    });
    removed += (data.result?.product_ids || []).length;
    for (const r of data.result?.rejected || []) rejected.push(r);
  }
  return { removed, rejected };
}

async function removeAll(snap) {
  const lines = [];
  for (const a of snap) {
    try {
      const { removed, rejected } = await removeProducts(a.id, a.productIds);
      const why = rejected.length
        ? ` (не убрались ${rejected.length}: ${rejected[0].reason || 'причина не указана'})`
        : '';
      lines.push(`• ${a.title}: убрано ${removed} из ${a.productIds.length}${why}`);
    } catch (err) {
      lines.push(`• ${a.title}: ошибка — ${err.message.slice(0, 150)}`);
    }
  }
  return lines.join('\n');
}

const getState = () => readJson(STATE_PATH, { lastCheckDate: null, errorNotified: false });
const patchState = (patch) => writeJsonAtomic(STATE_PATH, { ...getState(), ...patch });

module.exports = {
  isConfigured, snapshot, formatSnapshot, removeAll, getState, patchState,
};
