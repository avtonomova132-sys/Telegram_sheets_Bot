// Каталог Ozon живьём (только чтение): артикул, название, штрихкод, статус.
// Кэш на 1 час в /data, чтобы не дёргать API на каждую накладную.

const fs = require('fs');
const path = require('path');
const fbo = require('../fbo');

const CACHE_PATH = process.env.PRIHOD_CATALOG_CACHE_PATH || '/data/ozon_catalog_cache.json';
const TTL_MS = 60 * 60 * 1000;

function readCache() {
  try {
    const d = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (Array.isArray(d.products) && Date.now() - d.fetchedAt < TTL_MS) return d;
  } catch { /* нет кэша */ }
  return null;
}

function writeCache(products) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const tmp = `${CACHE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: Date.now(), products }));
    fs.renameSync(tmp, CACHE_PATH);
  } catch (err) {
    console.error('[prihod] не удалось записать кэш каталога:', err.message);
  }
}

async function fetchLive() {
  const listed = [];
  let lastId = '';
  for (let page = 0; page < 30; page += 1) {
    const data = await fbo.ozonPost('/v3/product/list', { filter: { visibility: 'ALL' }, last_id: lastId, limit: 1000 });
    const items = data?.result?.items || data?.items || [];
    listed.push(...items);
    lastId = data?.result?.last_id || data?.last_id || '';
    if (!lastId || items.length < 1000) break;
  }
  const archivedSet = new Set(listed.filter((i) => i.archived).map((i) => i.offer_id));
  const offers = listed.map((i) => i.offer_id).filter(Boolean);
  const products = [];
  for (let i = 0; i < offers.length; i += 1000) {
    const data = await fbo.ozonPost('/v3/product/info/list', { offer_id: offers.slice(i, i + 1000) });
    for (const it of fbo.extractList(data) || []) {
      const article = String(it.offer_id || '').trim();
      if (!article) continue;
      const statuses = it.statuses || {};
      products.push({
        article,
        name: String(it.name || '').trim(),
        barcode: Array.isArray(it.barcodes) ? it.barcodes[0] || '' : String(it.barcode || ''),
        status: String(statuses.status_name || statuses.status || ''),
        archived: Boolean(it.is_archived) || archivedSet.has(article),
      });
    }
  }
  if (!products.length) throw new Error('Озон вернул пустой каталог');
  return products;
}

async function getCatalog({ force = false } = {}) {
  if (!force) {
    const c = readCache();
    if (c) return { products: c.products, cached: true, fetchedAt: c.fetchedAt };
  }
  const products = await fetchLive();
  writeCache(products);
  return { products, cached: false, fetchedAt: Date.now() };
}

module.exports = { getCatalog };
