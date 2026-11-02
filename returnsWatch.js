// Страж возвратов Ozon: раз в неделю (понедельник, утро по Бали) и по команде
// /возвраты_контроль ищет потерянные возвраты и отмены (FBS → «Возвраты и
// отмены») и коротко пишет Елене, что пора открыть спор.
// ТОЛЬКО ЧТЕНИЕ: ключ OZON_API_KEY (Admin read only) + OZON_CLIENT_ID, метод
// POST /v1/returns/list (курсор last_id). Бот ничего не нажимает: спор не
// открывает, цены и карточки не трогает.
// Схема ответа не сверена с живым Озоном (docs.ozon.ru из сессии разработки
// недоступен) — разбор терпимый, смотреть /возвраты_debug.

const fs = require('fs');
const path = require('path');

const OZON_HOST = process.env.OZON_API_HOST || 'https://api-seller.ozon.ru';
const STATE_PATH = process.env.RETURNS_WATCH_STATE_PATH || '/data/returns_watch_state.json';
const ENDPOINT = process.env.RETURNS_LIST_ENDPOINT || '/v1/returns/list';
const TIMEOUT_MS = 30000;
const PAGE_LIMIT = 500;
const MAX_PAGES = 100;
const DAY_MS = 86400000;

// Пороги (дни) — правила Елены.
const LOST_DAYS = 30; // А: «Списали товар» без компенсации
const SEARCH_DAYS = 20; // Б: «Ищем товар»
const WAY_WARN_DAYS = 50; // В: показывать с 50-го дня
const WAY_LIMIT_DAYS = 60; // В: с 60-го дня можно открывать спор
const REPEAT_DAYS = 60; // повторное напоминание о той же позиции

const GROUPS = {
  A: { title: 'А. Списали товар, компенсации нет', todo: 'открыть спор' },
  B: { title: 'Б. Ищем товар', todo: 'ждать/следить: ищут дольше 20 дней' },
  V: { title: 'В. Долго в пути', todo: '' },
  G: { title: 'Г. Не получена доставкой', todo: 'проверить и открыть спор' },
};

const PATH_HINT = 'Где открыть спор: FBS → Возвраты и отмены → номер заявки → Открыть спор.';

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

// Все возвраты постранично (курсор last_id), без фильтра по датам: старые
// заявки как раз и нужны.
async function listReturns() {
  const out = [];
  let lastId = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = { filter: {}, limit: PAGE_LIMIT };
    if (lastId) body.last_id = lastId;
    const data = await ozon(ENDPOINT, body);
    const list = data.returns || data.result?.returns || [];
    out.push(...list);
    const hasNext = data.has_next ?? data.result?.has_next;
    const lastItem = list[list.length - 1];
    const nextId = lastItem?.id;
    if (!list.length || hasNext === false || !nextId || nextId === lastId) break;
    lastId = nextId;
  }
  return out;
}

async function debugSample() {
  const data = await ozon(ENDPOINT, { filter: {}, limit: 2 });
  return data;
}

// ---------- разбор одной записи ----------

function norm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function statusOf(r) {
  const v = r.visual?.status;
  return String(v?.display_name ?? v?.name ?? r.status_name ?? r.status ?? '');
}

function statusMomentOf(r) {
  const raw = r.visual?.change_moment ?? r.status_change_moment ?? r.change_moment ?? null;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function priceOf(r) {
  const p = r.product?.price;
  const v = (p && typeof p === 'object') ? (p.price ?? p.amount) : p;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtDate(ms) {
  const d = new Date(ms + 8 * 3600000); // по Бали (UTC+8)
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
}

const money = (n) => (n == null ? '—' : `${Math.round(n).toLocaleString('ru-RU')} ₽`);

function normalizeItem(r) {
  const status = statusOf(r);
  const ms = statusMomentOf(r);
  return {
    key: `${r.id ?? r.return_id ?? ''}|${r.product?.sku ?? ''}`,
    status,
    s: norm(status),
    ms,
    offerId: r.product?.offer_id ?? r.product?.offerId ?? '',
    sku: r.product?.sku ?? '',
    claim: r.id ?? r.return_id ?? r.return_number ?? '',
    posting: r.posting_number ?? r.order_number ?? r.logistic?.barcode ?? '',
    orderKey: String(r.order_id ?? r.order_number ?? r.posting_number ?? ''),
    price: priceOf(r),
    compensated: Boolean(r.logistic?.cancelled_with_compensation_moment),
  };
}

// Классификация: возвращает [{ ...item, group, days, daysLeft?, todo }].
function classify(returns, now = Date.now()) {
  const items = returns.map(normalizeItem);
  // «Вы получили компенсацию» могла прийти отдельной записью по той же позиции.
  const compensatedKeys = new Set();
  for (const it of items) {
    if (it.s.includes('получили компенсацию') || it.compensated) {
      compensatedKeys.add(`${it.orderKey}|${it.sku}`);
      compensatedKeys.add(`#${it.claim}`);
    }
  }
  const out = [];
  for (const it of items) {
    if (it.ms == null) continue;
    const days = Math.floor((now - it.ms) / DAY_MS);
    let group = null;
    let todo = '';
    let daysLeft = null;
    if (it.s.includes('списали товар')) {
      const comp = compensatedKeys.has(`${it.orderKey}|${it.sku}`) || compensatedKeys.has(`#${it.claim}`);
      if (!comp && days > LOST_DAYS) { group = 'A'; todo = GROUPS.A.todo; }
    } else if (it.s.includes('ищем товар')) {
      if (days > SEARCH_DAYS) { group = 'B'; todo = GROUPS.B.todo; }
    } else if (['ожидает отправки', 'едет к вам', 'едет на склад ozon', 'едет на склад озон'].some((w) => it.s.includes(w))) {
      if (days > WAY_WARN_DAYS) {
        group = 'V';
        daysLeft = Math.max(0, WAY_LIMIT_DAYS - days);
        todo = days >= WAY_LIMIT_DAYS ? 'прошло 60 дней — открыть спор' : `до 60 дней осталось ${daysLeft}`;
      }
    } else if (it.s.includes('не получена доставкой')) {
      group = 'G'; todo = GROUPS.G.todo;
    }
    if (group) out.push({ ...it, group, days, daysLeft, todo });
  }
  return out;
}

// ---------- дедупликация ----------

// Что слать: новое, сменившее группу, либо напоминание через REPEAT_DAYS.
function pickNew(found, sent, now = Date.now()) {
  return found.filter((f) => {
    const prev = sent[f.key];
    if (!prev) return true;
    if (prev.group !== f.group) return true;
    return now - prev.at >= REPEAT_DAYS * DAY_MS;
  });
}

function markSent(sent, list, now = Date.now()) {
  const next = { ...sent };
  for (const f of list) next[f.key] = { group: f.group, at: now };
  // чистим записи старше года
  for (const [k, v] of Object.entries(next)) if (now - v.at > 365 * DAY_MS) delete next[k];
  return next;
}

// ---------- текст ----------

function line(f) {
  return `• ${f.offerId || '—'} · SKU ${f.sku || '—'} · заявка ${f.claim || '—'} · отпр. ${f.posting || '—'} · ${fmtDate(f.ms)} · ${money(f.price)} · ${f.days} дн. · ${f.todo}`;
}

function formatReport(found, { header = '📦 Ozon: контроль возвратов' } = {}) {
  if (!found.length) return `${header}\n\n✅ Потерянных возвратов не нашёл.`;
  const order = ['A', 'B', 'V', 'G'];
  const parts = [header];
  for (const g of order) {
    const rows = found.filter((f) => f.group === g).sort((a, b) => b.days - a.days);
    if (!rows.length) continue;
    const title = g === 'V' ? `${GROUPS.V.title} (${WAY_WARN_DAYS}+ дней, лимит ${WAY_LIMIT_DAYS})` : GROUPS[g].title;
    parts.push(`\n${title}:\n${rows.map(line).join('\n')}`);
  }
  parts.push(`\n${PATH_HINT}`);
  return parts.join('\n');
}

// Режем под лимит Telegram, не разрывая строки.
function splitMessage(text, max = 3800) {
  if (text.length <= max) return [text];
  const chunks = [];
  let cur = '';
  for (const ln of text.split('\n')) {
    if (cur.length + ln.length + 1 > max && cur) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + ln;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

module.exports = {
  isConfigured, listReturns, debugSample, classify, pickNew, markSent,
  formatReport, splitMessage, getState, patchState, fmtDate, PATH_HINT,
};
