// Каталог Ozon живьём (только чтение): артикул, название, штрихкод, статус.
// Кэш на 1 час в /data, чтобы не дёргать API на каждую накладную.

const fs = require('fs');
const path = require('path');
const fbo = require('../fbo');
const { translit, norm, dense } = require('./text');

const CACHE_PATH = process.env.PRIHOD_CATALOG_CACHE_PATH || '/data/ozon_catalog_cache.json';
const TTL_MS = 60 * 60 * 1000;
const PAGE = 1000;
const INFO_CHUNK = 500;
const MAX_PAGES = 200;

function readCache() {
  try {
    const d = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (Array.isArray(d.products) && Date.now() - d.fetchedAt < TTL_MS) return d;
  } catch { /* нет кэша */ }
  return null;
}

function writeCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const tmp = `${CACHE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, CACHE_PATH);
  } catch (err) {
    console.error('[prihod] не удалось записать кэш каталога:', err.message);
  }
}

// Постранично, пока Озон не отдаст пустую страницу или тот же last_id: порция
// может быть меньше лимита и это не конец списка. visibility ALL = все товары
// кроме архивных.
async function fetchLive() {
  const listed = [];
  let lastId = '';
  let apiTotal = null;
  let pages = 0;
  for (; pages < MAX_PAGES; pages += 1) {
    const data = await fbo.ozonPost('/v3/product/list', { filter: { visibility: 'ALL' }, last_id: lastId, limit: PAGE });
    const items = data?.result?.items || data?.items || [];
    if (data?.result?.total !== undefined) apiTotal = Number(data.result.total);
    listed.push(...items);
    const next = data?.result?.last_id || data?.last_id || '';
    if (!items.length || !next || next === lastId) break;
    lastId = next;
  }
  const archivedSet = new Set(listed.filter((i) => i.archived).map((i) => i.offer_id));
  const offers = [...new Set(listed.map((i) => i.offer_id).filter(Boolean))];
  const byArticle = new Map();
  for (let i = 0; i < offers.length; i += INFO_CHUNK) {
    const data = await fbo.ozonPost('/v3/product/info/list', { offer_id: offers.slice(i, i + INFO_CHUNK) });
    for (const it of fbo.extractList(data) || []) {
      const article = String(it.offer_id || '').trim();
      if (!article) continue;
      const statuses = it.statuses || {};
      byArticle.set(article, {
        article,
        name: String(it.name || '').trim(),
        barcode: Array.isArray(it.barcodes) ? it.barcodes[0] || '' : String(it.barcode || ''),
        barcodes: Array.isArray(it.barcodes) ? it.barcodes.filter(Boolean).map(String) : (it.barcode ? [String(it.barcode)] : []),
        status: String(statuses.status_name || statuses.status || ''),
        archived: Boolean(it.is_archived) || archivedSet.has(article),
      });
    }
  }
  // Артикул есть в списке, а подробностей Озон не вернул — не теряем: ищем хотя бы по артикулу.
  for (const o of offers) if (!byArticle.has(o)) byArticle.set(o, { article: o, name: '', barcode: '', status: 'нет данных', archived: archivedSet.has(o) });
  const products = [...byArticle.values()];
  if (!products.length) throw new Error('Озон вернул пустой каталог');
  const stats = { listed: listed.length, offers: offers.length, loaded: products.length, apiTotal, pages, archived: products.filter((p) => p.archived).length };
  console.log(`[prihod] каталог: ${JSON.stringify(stats)}`);
  return { products, stats };
}

async function getCatalog({ force = false } = {}) {
  if (!force) {
    const c = readCache();
    if (c) return { products: c.products, stats: c.stats || null, cached: true, fetchedAt: c.fetchedAt };
  }
  const { products, stats } = await fetchLive();
  writeCache({ fetchedAt: Date.now(), products, stats });
  return { products, stats, cached: false, fetchedAt: Date.now() };
}

// Для /приход_каталог <текст>: что реально лежит в каталоге по запросу
// (название ИЛИ артикул, с транслитом латиницы).
function searchProducts(products, query, limit = 15) {
  const q = translit(dense(query));
  const words = translit(norm(query)).split(' ').filter((w) => w.length >= 3);
  const out = [];
  for (const p of products) {
    const hay = translit(`${dense(p.article)} ${dense(p.name)}`);
    const hayWords = translit(norm(`${p.article} ${p.name}`));
    if ((q && hay.includes(q)) || (words.length && words.every((w) => hayWords.includes(w)))) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { getCatalog, searchProducts };
