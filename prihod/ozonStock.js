// Остатки Озона: чтение (общий read-only ключ OZON_API_KEY через fbo.ozonPost) и
// ЗАПИСЬ отдельным ключом OZON_STOCK_WRITE_KEY (+ OZON_CLIENT_ID). Read-only ключ
// остатки менять не может и здесь не используется. Ключ нигде не печатается.
//
// Метод записи по умолчанию — POST /v2/products/stocks (offer_id, product_id,
// stock, warehouse_id; до 100 позиций в запросе, ~80 запросов в минуту, один
// и тот же товар на одном складе — не чаще раза в 2 минуты). Сверить с
// актуальной документацией Озона; путь переопределяется OZON_STOCK_WRITE_ENDPOINT.

const fbo = require('../fbo');

const HOST = process.env.OZON_API_HOST || 'https://api-seller.ozon.ru';
const WRITE_ENDPOINT = () => process.env.OZON_STOCK_WRITE_ENDPOINT || '/v2/products/stocks';
const WAREHOUSE_ID = () => Number(process.env.OZON_WAREHOUSE_ID || 22403679106000);
const CHUNK = 100;
const TIMEOUT_MS = 30000;

const hasWriteKey = () => Boolean(process.env.OZON_STOCK_WRITE_KEY && process.env.OZON_CLIENT_ID);

// Текущие остатки своего склада (FBS) по артикулам: Map offer_id → {stock, productId}.
async function readStocks(articles) {
  const out = new Map();
  const list = [...new Set(articles)];
  for (let i = 0; i < list.length; i += CHUNK) {
    const data = await fbo.ozonPost('/v4/product/info/stocks', { filter: { offer_id: list.slice(i, i + CHUNK), visibility: 'ALL' }, limit: CHUNK });
    for (const it of fbo.extractList(data) || []) {
      if (!it.offer_id) continue;
      let fbs = 0;
      for (const s of it.stocks || []) {
        if (String(s.type || '').toLowerCase() !== 'fbo') fbs += Number(s.present) || 0;
      }
      out.set(String(it.offer_id), { stock: fbs, productId: it.product_id ?? null });
    }
  }
  return out;
}

class OzonWriteError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function post(endpoint, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${HOST}${endpoint}`, {
      method: 'POST',
      headers: {
        'Client-Id': String(process.env.OZON_CLIENT_ID).trim(),
        'Api-Key': String(process.env.OZON_STOCK_WRITE_KEY).trim(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new OzonWriteError(`Озон ${endpoint}: HTTP ${res.status} ${text.slice(0, 300)}`, res.status);
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === 'AbortError') throw new OzonWriteError(`Озон ${endpoint}: нет ответа за ${TIMEOUT_MS / 1000} с`, 0);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// rows: [{article, productId?, stock}] → [{article, ok, error}]. Каждая порция —
// один запрос; при ошибке запроса повторов нет, ошибка возвращается как есть.
async function writeStocks(rows) {
  if (!hasWriteKey()) throw new OzonWriteError('не задан OZON_STOCK_WRITE_KEY', 401);
  const results = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const stocks = part.map((r) => ({
      offer_id: r.article,
      ...(r.productId ? { product_id: r.productId } : {}),
      stock: r.stock,
      warehouse_id: WAREHOUSE_ID(),
    }));
    let data;
    try {
      data = await post(WRITE_ENDPOINT(), { stocks });
    } catch (err) {
      if (err.status === 401 || err.status === 403) throw err; // нет прав — выше решат про xlsx
      for (const r of part) results.push({ article: r.article, ok: false, error: err.message });
      continue;
    }
    const byOffer = new Map((data.result || []).map((x) => [String(x.offer_id), x]));
    for (const r of part) {
      const x = byOffer.get(r.article);
      if (!x) results.push({ article: r.article, ok: false, error: 'Озон не вернул результат по артикулу' });
      else if (x.updated === false || (x.errors && x.errors.length)) {
        results.push({ article: r.article, ok: false, error: (x.errors || []).map((e) => `${e.code || ''} ${e.message || ''}`.trim()).join('; ') || 'не обновлено' });
      } else results.push({ article: r.article, ok: true });
    }
  }
  return results;
}

module.exports = { readStocks, writeStocks, hasWriteKey, OzonWriteError, WAREHOUSE_ID };
