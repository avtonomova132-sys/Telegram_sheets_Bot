// Автоматический алерт по марже для товара с истекающим сроком годности,
// который не продаётся — правило Алины (владелец), подтверждённое Еленой
// в чате 2026-10: если партия еды с истекающим сроком не продаётся
// ЕЖЕДНЕВНАЯ_ПРОВЕРКА.NO_SALES_DAYS дней — считаем цену при марже 8% и
// шлём Елене готовый артикул + цену (ставит в Озоне сама, у ключа только
// чтение). Если и после этого ещё STAGE2_AFTER_DAYS дней нет продаж —
// то же для марже 2%. Бот ничего не меняет в кабинете сам.
//
// "Истекает" берём из ТОГО ЖЕ метода Ozon, что уже используется в fbo.js
// (/v1/analytics/stocks → expiring_stock_count) — живой сигнал от самого
// Озона, без зависимости от ручной таблицы Кати (там как раз выяснилось,
// что актуального источника сроков по всем товарам нет). Это сознательно
// уже предложенный Еленой диапазон: "истекающий срок + еда", как и в FBO.
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

// Кандидаты: еда (как в fbo.js), остаток > 0, есть партия с истекающим
// сроком (expiring_stock_count > 0 хотя бы на одном складе).
async function findCandidates() {
  const { rows } = await fbo.fetchStockRows();
  const groups = fbo.groupFood(rows); // уже отфильтровано по eде, сгруппировано по артикул+склад
  const byArticle = new Map();
  for (const g of groups) {
    const a = byArticle.get(g.article) || { article: g.article, name: g.name, qty: 0, expiring: 0 };
    a.qty += g.qty;
    a.expiring += g.expiring;
    if (!a.name && g.name) a.name = g.name;
    byArticle.set(g.article, a);
  }
  return [...byArticle.values()].filter((a) => a.qty > 0 && a.expiring > 0);
}

async function runCheck({ save = false } = {}) {
  if (!fbo.isConfigured()) throw new Error('не заданы OZON_API_KEY / OZON_CLIENT_ID в Railway');
  const candidates = await findCandidates();
  if (!candidates.length) return { candidates: [], alerts: [], skippedNoSku: [] };

  const { products } = await fbo.fetchCatalog();
  const skuByArticle = new Map(products.map((p) => [p.article, p.sku]));
  for (const c of candidates) c.sku = skuByArticle.get(c.article) || null;

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
      alerts.push({ article: c.article, name: c.name, stage, orders, qty: c.qty, expiring: c.expiring, error: 'нет себестоимости в «Номенклатуре» (колонка «Итого закупка»)' });
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
      expiring: c.expiring,
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

function formatAlert(a) {
  const stageLabel = a.stage === 'stage1' ? '8%' : '2%';
  if (a.error) {
    return `⚠️ ${a.name || a.article} (${a.article}) — не продаётся ${NO_SALES_DAYS}+ дней, срок истекает, но ${a.error} — маржу не считаю`;
  }
  const lines = [
    `${a.stage === 'stage1' ? '📉' : '🔴'} ${a.name || a.article} (${a.article})`,
    `Заказов за ${NO_SALES_DAYS} дней: ${a.orders}. Истекает партия: ${a.expiring} шт, на складе всего: ${a.qty} шт`,
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

function buildMessage(alerts) {
  if (!alerts.length) return null;
  return ['💸 Маржа вниз: истекает срок, не продаётся', '', ...alerts.map(formatAlert)].join('\n\n');
}

async function dailyMessage() {
  const { alerts } = await runCheck({ save: true });
  return { text: buildMessage(alerts), alerts };
}

async function currentMessage() {
  const { alerts, candidates } = await runCheck({ save: false });
  if (!candidates.length) {
    return { text: 'Нет еды с истекающей партией и остатком на складе — проверять не на чём 🙂' };
  }
  if (!alerts.length) {
    return { text: `Товаров с истекающим сроком на складе: ${candidates.length} — но сегодня новых решений нет (либо продаются, либо стадия не изменилась со вчера)` };
  }
  return { text: buildMessage(alerts) };
}

async function debugMessage() {
  if (!fbo.isConfigured()) throw new Error('не заданы OZON_API_KEY / OZON_CLIENT_ID в Railway');
  const candidates = await findCandidates();
  const { products } = await fbo.fetchCatalog();
  const skuByArticle = new Map(products.map((p) => [p.article, p.sku]));
  for (const c of candidates) c.sku = skuByArticle.get(c.article) || null;
  const { map: ordered, sample: orderedSample } = await fetchOrderedUnitsBySku(NO_SALES_DAYS);
  const { map: priceInfo, sample: priceSample, usedEndpoint } = await fetchPriceInfo(candidates.filter((c) => c.sku).map((c) => c.article));
  const lines = [
    `🔧 Маржа — отладка`,
    `Кандидатов (еда, остаток>0, истекает>0): ${candidates.length}`,
    `Без sku в каталоге: ${candidates.filter((c) => !c.sku).length}`,
    `/v1/analytics/data — поля первой строки: ${orderedSample ? JSON.stringify(orderedSample).slice(0, 300) : '—'}`,
    `Цены — рабочий метод: ${usedEndpoint || 'ни один не ответил'}`,
    `Цены — поля первой строки: ${priceSample ? JSON.stringify(priceSample).slice(0, 400) : '—'}`,
  ];
  const rows = candidates.slice(0, 15).map((c) => {
    const orders = c.sku ? ordered.get(String(c.sku)) ?? '—' : '—(нет sku)';
    const info = priceInfo.get(c.article) || {};
    return `• ${c.article} — остаток ${c.qty}, истекает ${c.expiring}, заказов/${NO_SALES_DAYS}д: ${orders}, цена сейчас: ${info.price ?? '—'}, fixedFees: ${info.fixedFees ?? 'не получены'}`;
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
