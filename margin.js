// Автоматический алерт по марже для товара, который не продаётся — правило
// Алины (владелец), подтверждённое Еленой в чате 2026-10, и РАСШИРЕННОЕ ею
// же 2026-10-10: действует на ВЕСЬ каталог (не только еду — крафт-пакеты,
// кремы, что угодно), и смотрит остаток и на ФБО, и на ФБС (не только ФБО).
// Если артикул не продаётся NO_SALES_DAYS дней (по умолчанию 30) — считаем
// цену при марже 8% и шлём Елене готовый артикул + цену (ставит в Озоне
// сама, у ключа только чтение). Если и после этого ещё STAGE2_AFTER_DAYS
// дней нет продаж — то же для марже 2%. Бот ничего не меняет в кабинете сам.
//
// Было: сначала только еда (`fbo.isFood`) с истекающей по Ozon партией
// (`/v1/analytics/stocks` → `expiring_stock_count`) — это был первый,
// узкий вариант правила Алины. Елена уточнила 2026-10-10: условие "не
// продаётся" должно применяться к ЛЮБОМУ артикулу независимо от категории
// и независимо от срока годности (у крафт-пакетов его просто нет) — так
// что срок/еда больше не фильтр, кандидаты — весь активный каталог.
//
// Остаток — ФБО+ФБС вместе, через /v4/product/info/stocks (с фолбэком на
// /v3 и /v2, если /v4 не отвечает этому ключу) — отдаёт present по типам
// склада на один запрос, без похода в analytics/stocks (тот был только
// FBO и только для еды).
//
// Продажи — Ozon Analytics (/v1/analytics/data, метрика ordered_units,
// измерение sku) за последние NO_SALES_DAYS дней, одним проходом по всем
// sku (постранично), а не по одному артикулу — экономит запросы.
//
// Себестоимость — живая таблица «Номенклатура» (nomenclature.js, колонка
// «Итого закупка», G), та же, что уже мониторится отдельной фичей.
//
// Цена/комиссия — /v4/product/info/prices (с фолбэком на /v1, если /v4 не
// отвечает). Озон в этом методе иногда не отдаёт полную раскладку по
// логистике/эквайрингу (та есть только в ручном экспорте "Цены товаров",
// см. memory ozon-pricing.md) — если нет, считаем ТОЛЬКО по комиссии и
// тарифной границе 300₽ (23%/40%, подтверждённое правило без исключений),
// без мелких фиксированных сборов, и явно помечаем цену как приближённую.
// Это сознательный компромисс ради полной автоматизации без ручных
// выгрузок — см. /маржа_debug, чтобы проверить, что реально отдаёт Ozon.
//
// ВАЖНО про объём: на весь каталог (~1300+ артикулов) "не продаётся 30
// дней" — это, скорее всего, будет не десяток товаров, а сотни (длинный
// хвост медленно оборачивающихся позиций). При первом включении почти все
// такие артикулы одновременно станут "новыми" в снимке и попадут в первое
// сообщение одним большим списком (дальше — только новые переходы между
// стадиями, не повтор каждый день). Сообщение собирается компактно при
// большом числе позиций (см. COMPACT_THRESHOLD), но сам объём первого
// сообщения всё равно будет заметно больше, чем было в версии "только еда".
//
// Переменные окружения: MARGIN_STATE_PATH, MARGIN_NO_SALES_DAYS (30),
// MARGIN_STAGE2_DAYS (14), MARGIN_STAGE1_PCT (0.08), MARGIN_STAGE2_PCT (0.02),
// MARGIN_EXTRA_CHAT_IDS.

const fs = require('fs');
const path = require('path');
const fbo = require('./fbo');
const nomenclature = require('./nomenclature');

const STATE_PATH = process.env.MARGIN_STATE_PATH || '/data/margin_state.json';
const NO_SALES_DAYS = Number(process.env.MARGIN_NO_SALES_DAYS) > 0 ? Number(process.env.MARGIN_NO_SALES_DAYS) : 30;
const STAGE2_AFTER_DAYS = Number(process.env.MARGIN_STAGE2_DAYS) > 0 ? Number(process.env.MARGIN_STAGE2_DAYS) : 14;
const STAGE_PCT = {
  stage1: Number(process.env.MARGIN_STAGE1_PCT) > 0 ? Number(process.env.MARGIN_STAGE1_PCT) : 0.08,
  stage2: Number(process.env.MARGIN_STAGE2_PCT) > 0 ? Number(process.env.MARGIN_STAGE2_PCT) : 0.02,
};
// Подтверждено Еленой (memory ozon-pricing.md): жёсткая граница 40% дальше.
const COMMISSION_TIERS = [
  { max: 300, pct: 0.23 },
  { max: Infinity, pct: 0.40 },
];
// Если новых/изменившихся позиций за раз больше этого — компактный формат
// (по одной строке на артикул) вместо полного блока на каждый.
const COMPACT_THRESHOLD = 20;

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

// ---------- остаток (ФБО + ФБС) ----------

// Было: брали остаток только через fbo.js (/v1/analytics/stocks — только
// ФБО, только еда). Теперь — отдельный метод на весь каталог, с разбивкой
// по типу склада, чтобы учитывать и свой склад (ФБС).
async function fetchStocks(articles) {
  const list = [...new Set(articles)].filter(Boolean);
  const map = new Map();
  let sample = null;
  let usedEndpoint = null;
  const endpoints = ['/v4/product/info/stocks', '/v3/product/info/stocks', '/v2/product/info/stocks'];
  for (let i = 0; i < list.length; i += 1000) {
    const chunk = list.slice(i, i + 1000);
    let items = null;
    for (const ep of endpoints) {
      try {
        const data = await fbo.ozonPost(ep, { filter: { offer_id: chunk, visibility: 'ALL' }, limit: 1000 });
        const list2 = fbo.extractList(data);
        if (list2) {
          items = list2;
          usedEndpoint = ep;
          break;
        }
      } catch {
        // пробуем следующий вариант метода
      }
    }
    if (!items) continue;
    if (!sample && items[0]) sample = items[0];
    for (const it of items) {
      const offerId = it.offer_id;
      if (!offerId) continue;
      let fboQty = 0;
      let fbsQty = 0;
      for (const s of it.stocks || []) {
        const present = Number(s.present) || 0;
        const type = String(s.type || '').toLowerCase();
        if (type === 'fbo') fboQty += present;
        else fbsQty += present; // fbs и всё неизвестное — считаем как свой склад
      }
      map.set(offerId, { fbo: fboQty, fbs: fbsQty, total: fboQty + fbsQty });
    }
  }
  return { map, sample, usedEndpoint };
}

// ---------- продажи (Ozon Analytics) ----------

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// Один проход по всем sku за период — экономнее, чем фильтровать по
// каждому артикулу отдельно (у /v1/analytics/data фильтр по значениям
// измерения ненадёжен между версиями API).
async function fetchOrderedUnitsBySku(days) {
  const to = new Date();
  const from = new Date(Date.now() - days * 86400000);
  const map = new Map();
  let sample = null;
  let offset = 0;
  for (let page = 0; page < 50; page += 1) {
    const data = await fbo.ozonPost('/v1/analytics/data', {
      date_from: fmtDate(from),
      date_to: fmtDate(to),
      metrics: ['ordered_units'],
      dimension: ['sku'],
      limit: 1000,
      offset,
    });
    const rows = data?.result?.data || data?.data || [];
    if (!sample && rows[0]) sample = rows[0];
    for (const r of rows) {
      const sku = r?.dimensions?.[0]?.id ?? r?.dimensions?.[0]?.name;
      const units = Number(r?.metrics?.[0]) || 0;
      if (sku) map.set(String(sku), units);
    }
    if (rows.length < 1000) break;
    offset += 1000;
  }
  return { map, sample };
}

// ---------- цена/комиссия (Ozon) ----------

async function fetchPriceInfo(articles) {
  const list = [...new Set(articles)].filter(Boolean);
  const map = new Map();
  let sample = null;
  let usedEndpoint = null;
  const endpoints = ['/v5/product/info/prices', '/v4/product/info/prices', '/v1/product/info/prices'];
  for (let i = 0; i < list.length; i += 1000) {
    const chunk = list.slice(i, i + 1000);
    let items = null;
    for (const ep of endpoints) {
      try {
        const data = await fbo.ozonPost(ep, { filter: { offer_id: chunk, visibility: 'ALL' }, limit: 1000 });
        const list2 = fbo.extractList(data);
        if (list2) {
          items = list2;
          usedEndpoint = ep;
          break;
        }
      } catch {
        // пробуем следующий вариант метода
      }
    }
    if (!items) continue;
    if (!sample && items[0]) sample = items[0];
    for (const it of items) {
      const offerId = it.offer_id;
      if (!offerId) continue;
      const price = Number(it.price?.price ?? it.price) || null;
      const c = it.commissions || it.price?.commissions || {};
      const feeKeys = [
        'fbo_fulfillment_amount',
        'fbo_direct_flow_trans_min_amount',
        'fbo_deliv_to_customer_amount',
        'fbo_return_flow_amount',
      ];
      const known = feeKeys.some((k) => c[k] !== undefined);
      const fixedFees = known ? feeKeys.reduce((s, k) => s + (Number(c[k]) || 0), 0) : null;
      map.set(offerId, { price, fixedFees, commissionsRaw: c });
    }
  }
  return { map, sample, usedEndpoint };
}

// ---------- расчёт цены под целевую маржу ----------
// Margin = (Price - Cost - Price*Comm% - FixedFees) / Price
// => Price*(1 - Comm% - Margin) = Cost + FixedFees
// => Price = (Cost + FixedFees) / (1 - Comm% - Margin)
function priceForMargin(cost, commissionPct, fixedFees, targetMargin) {
  const denom = 1 - commissionPct - targetMargin;
  if (denom <= 0) return null;
  return (cost + fixedFees) / denom;
}

// Граница 300₽ завязана на саму цену — решаем подбором по тарифам и
// проверяем самосогласованность результата.
function resolvePriceWithTier(cost, fixedFees, targetMargin) {
  for (const t of COMMISSION_TIERS) {
    const price = priceForMargin(cost, t.pct, fixedFees, targetMargin);
    if (price == null) continue;
    const consistent = t.max === 300 ? price <= 300 : price > 300;
    if (consistent) return { price, commissionPct: t.pct, uncertain: false };
  }
  // ни один вариант не самосогласован (случается у товаров около границы) —
  // возвращаем расчёт по 40% и явно помечаем, чтобы проверили вручную.
  const fallback = priceForMargin(cost, 0.40, fixedFees, targetMargin);
  return { price: fallback, commissionPct: 0.40, uncertain: true };
}

// ---------- основная проверка ----------

// Кандидаты: ВЕСЬ каталог (не только еда), остаток > 0 на ФБО и/или ФБС.
async function findCandidates() {
  const { products } = await fbo.fetchCatalog();
  const articles = products.map((p) => p.article).filter(Boolean);
  const { map: stocks, sample: stockSample, usedEndpoint: stockEndpoint } = await fetchStocks(articles);
  const candidates = [];
  for (const p of products) {
    const s = stocks.get(p.article);
    if (!s || s.total <= 0) continue;
    candidates.push({ article: p.article, name: p.name, sku: p.sku, fbo: s.fbo, fbs: s.fbs, qty: s.total });
  }
  return { candidates, stockSample, stockEndpoint, totalCatalog: products.length };
}

async function runCheck({ save = false } = {}) {
  if (!fbo.isConfigured()) throw new Error('не заданы OZON_API_KEY / OZON_CLIENT_ID в Railway');
  const { candidates } = await findCandidates();
  if (!candidates.length) return { candidates: [], alerts: [], skippedNoSku: [] };

  const skippedNoSku = candidates.filter((c) => !c.sku).map((c) => c.article);
  const withSku = candidates.filter((c) => c.sku);

  const { map: ordered } = await fetchOrderedUnitsBySku(NO_SALES_DAYS);
  const nomen = await nomenclature.runCheck({ save: false });
  const costByArticle = nomen.items || {};
  const { map: priceInfo } = await fetchPriceInfo(withSku.map((c) => c.article));

  const state = readState();
  const prevItems = { ...(state.items || {}) };
  const nextItems = { ...prevItems };
  const alerts = [];
  const nowIso = new Date().toISOString();

  for (const c of withSku) {
    const orders = ordered.get(String(c.sku)) ?? 0;
    const prev = prevItems[c.article];
    if (orders > 0) {
      // снова продаётся — сбрасываем каскад, чтобы следующий раз отсчёт
      // 30 дней начался заново
      if (prev) delete nextItems[c.article];
      continue;
    }

    let stage = 'stage1';
    let since = nowIso;
    if (prev) {
      stage = prev.stage;
      since = prev.since;
      if (prev.stage === 'stage1') {
        const daysSince = (Date.now() - new Date(prev.since).getTime()) / 86400000;
        if (daysSince >= STAGE2_AFTER_DAYS) {
          stage = 'stage2';
          since = nowIso;
        }
      }
    }
    const changed = !prev || prev.stage !== stage;
    nextItems[c.article] = { stage, since, lastOrders: orders, lastCheckedAt: nowIso };
    if (!changed) continue;

    const costRaw = costByArticle[c.article]?.cost;
    const cost = Number(String(costRaw || '').replace(',', '.'));
    if (!cost) {
      alerts.push({ article: c.article, name: c.name, stage, orders, qty: c.qty, fbo: c.fbo, fbs: c.fbs, error: 'нет себестоимости в «Номенклатуре» (колонка «Итого закупка»)' });
      continue;
    }
    const info = priceInfo.get(c.article) || {};
    const fixedFees = info.fixedFees || 0;
    const targetMargin = STAGE_PCT[stage];
    const resolved = resolvePriceWithTier(cost, fixedFees, targetMargin);
    alerts.push({
      article: c.article,
      name: c.name,
      stage,
      orders,
      qty: c.qty,
      fbo: c.fbo,
      fbs: c.fbs,
      cost,
      price: resolved.price,
      commissionPct: resolved.commissionPct,
      uncertain: resolved.uncertain,
      fixedFeesKnown: info.fixedFees != null,
      currentPrice: info.price || null,
    });
  }

  if (save) patchState({ items: nextItems, lastCheckAt: nowIso });
  return { candidates, alerts, skippedNoSku };
}

// ---------- сообщения ----------

function stockLabel(a) {
  const parts = [];
  if (a.fbo) parts.push(`ФБО ${a.fbo}`);
  if (a.fbs) parts.push(`ФБС ${a.fbs}`);
  return parts.join(', ') || `${a.qty} шт`;
}

function formatAlert(a) {
  const stageLabel = a.stage === 'stage1' ? '8%' : '2%';
  if (a.error) {
    return `⚠️ ${a.name || a.article} (${a.article}) — не продаётся ${NO_SALES_DAYS}+ дней, но ${a.error} — маржу не считаю`;
  }
  const lines = [
    `${a.stage === 'stage1' ? '📉' : '🔴'} ${a.name || a.article} (${a.article})`,
    `Заказов за ${NO_SALES_DAYS} дней: ${a.orders}. На складе: ${stockLabel(a)}`,
    `Новая цена при марже ${stageLabel}: ${Math.round(a.price)} ₽${a.currentPrice ? ` (сейчас ${Math.round(a.currentPrice)} ₽)` : ''}`,
  ];
  if (!a.fixedFeesKnown) {
    lines.push('⚠️ Ozon не отдал логистику/эквайринг по API — цена посчитана только по комиссии (без мелких сборов), сверь перед тем как ставить');
  }
  if (a.uncertain) {
    lines.push('⚠️ цена около границы комиссии 300₽ — проверь вручную, расчёт может быть неточным');
  }
  return lines.join('\n');
}

function compactLine(a) {
  if (a.error) return `• ${a.article} — нет себестоимости`;
  const stageLabel = a.stage === 'stage1' ? '8%' : '2%';
  const uncertainMark = a.uncertain || !a.fixedFeesKnown ? ' ⚠️' : '';
  return `• ${a.article} (${a.name ? `${a.name.slice(0, 40)}, ` : ''}${stockLabel(a)}) → ${Math.round(a.price)} ₽ при марже ${stageLabel}${uncertainMark}`;
}

function buildMessage(alerts) {
  if (!alerts.length) return null;
  const stage1 = alerts.filter((a) => a.stage === 'stage1');
  const stage2 = alerts.filter((a) => a.stage === 'stage2');
  const blocks = ['💸 Маржа вниз: не продаётся'];
  if (alerts.length > COMPACT_THRESHOLD) {
    if (stage1.length) blocks.push([`📉 Снижаем до 8% (${stage1.length}):`, ...stage1.map(compactLine)].join('\n'));
    if (stage2.length) blocks.push([`🔴 Снижаем до 2% (${stage2.length}):`, ...stage2.map(compactLine)].join('\n'));
    blocks.push('⚠️ строки с ⚠️ — цена приблизительная (без логистики/эквайринга или около границы 300₽), сверь перед тем как ставить');
  } else {
    blocks.push(...alerts.map(formatAlert));
  }
  return blocks.join('\n\n');
}

async function dailyMessage() {
  const { alerts } = await runCheck({ save: true });
  return { text: buildMessage(alerts), alerts };
}

async function currentMessage() {
  const { alerts, candidates } = await runCheck({ save: false });
  if (!candidates.length) {
    return { text: 'Нет товаров с остатком на складе — проверять не на чём 🙂' };
  }
  if (!alerts.length) {
    return { text: `Товаров с остатком на складе: ${candidates.length} — но сегодня новых решений нет (либо продаются, либо стадия не изменилась со вчера)` };
  }
  return { text: buildMessage(alerts) };
}

async function debugMessage() {
  if (!fbo.isConfigured()) throw new Error('не заданы OZON_API_KEY / OZON_CLIENT_ID в Railway');
  const { candidates, stockSample, stockEndpoint, totalCatalog } = await findCandidates();
  const { map: ordered, sample: orderedSample } = await fetchOrderedUnitsBySku(NO_SALES_DAYS);
  const { map: priceInfo, sample: priceSample, usedEndpoint } = await fetchPriceInfo(candidates.filter((c) => c.sku).map((c) => c.article));
  const lines = [
    `🔧 Маржа — отладка`,
    `Каталог: ${totalCatalog} артикулов, с остатком (ФБО+ФБС) > 0: ${candidates.length}`,
    `Без sku в каталоге: ${candidates.filter((c) => !c.sku).length}`,
    `Остатки — рабочий метод: ${stockEndpoint || 'ни один не ответил'}`,
    `Остатки — поля первой строки: ${stockSample ? JSON.stringify(stockSample).slice(0, 300) : '—'}`,
    `/v1/analytics/data — поля первой строки: ${orderedSample ? JSON.stringify(orderedSample).slice(0, 300) : '—'}`,
    `Цены — рабочий метод: ${usedEndpoint || 'ни один не ответил'}`,
    `Цены — поля первой строки: ${priceSample ? JSON.stringify(priceSample).slice(0, 400) : '—'}`,
  ];
  const rows = candidates.slice(0, 15).map((c) => {
    const orders = c.sku ? ordered.get(String(c.sku)) ?? '—' : '—(нет sku)';
    const info = priceInfo.get(c.article) || {};
    return `• ${c.article} — ФБО ${c.fbo}, ФБС ${c.fbs}, заказов/${NO_SALES_DAYS}д: ${orders}, цена сейчас: ${info.price ?? '—'}, fixedFees: ${info.fixedFees ?? 'не получены'}`;
  });
  if (rows.length) lines.push(`Первые кандидаты:\n${rows.join('\n')}`);
  return lines.join('\n\n');
}

module.exports = {
  isConfigured: fbo.isConfigured,
  readState,
  patchState,
  runCheck,
  dailyMessage,
  currentMessage,
  debugMessage,
  resolvePriceWithTier,
  priceForMargin,
  NO_SALES_DAYS,
  STAGE2_AFTER_DAYS,
};
