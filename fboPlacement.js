// Разбор Excel-отчёта Озона «Платное размещение» (Аналитика → управление
// остатками): присланный файл → сводка: что платное СЕЙЧАС, что станет
// платным и когда, еда от порога. Работает по заголовкам колонок, а не по
// буквам. Ничего не меняет в кабинете и не ходит в Озон.

const { readFirstSheet } = require('./miniXlsx');

const SOON_DAYS = 45; // «скоро станет платным» — не дальше этого срока
const FOOD_MIN_QTY = Number(process.env.FBO_MIN_QTY) > 0 ? Number(process.env.FBO_MIN_QTY) : 3;

function clean(v) {
  return String(v ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function num(v) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

// Заголовки двухстрочные: верхняя строка — группа, нижняя — колонка.
// Склеиваем «группа|колонка» и ищем по смыслу.
function buildColumns(rows) {
  const top = rows[0] || [];
  const sub = rows[1] || [];
  let group = '';
  const names = [];
  for (let i = 0; i < Math.max(top.length, sub.length); i += 1) {
    if (clean(top[i])) group = clean(top[i]);
    names.push({ group, sub: clean(sub[i]), top: clean(top[i]) });
  }
  const find = (re, grp) => names.findIndex((c) => re.test(c.sub || c.top) && (!grp || grp.test(c.group)));
  const cols = {
    article: names.findIndex((c) => c.top === 'артикул'),
    name: names.findIndex((c) => c.top === 'название товара'),
    stock: find(/остаток на складах, шт/),
    reserved: find(/зарезервировано под вывоз/),
    transit: find(/транзит, шт/),
    forced: find(/вынужденное размещение, шт/),
    daysToForced: find(/дней до начала вынужденного/),
    forcedDate: find(/дата начала вынужденного/),
    cost28: names.findIndex((c) => /стоимость за последние 28/.test(c.top)),
    forecastMonth: names.findIndex((c) => /прогноз стоимости размещения до конца/.test(c.top)),
  };
  const missing = ['article', 'stock', 'forced'].filter((k) => cols[k] < 0);
  if (missing.length) throw new Error(`в файле нет колонок: ${missing.join(', ')} — это точно отчёт «Платное размещение»?`);
  return cols;
}

function parseReport(buffer) {
  const all = readFirstSheet(buffer);
  const cols = buildColumns(all);
  const items = [];
  for (const r of all.slice(2)) {
    const article = String(r[cols.article] ?? '').trim();
    if (!article) continue;
    items.push({
      article,
      name: String(r[cols.name] ?? '').trim(),
      stock: num(r[cols.stock]),
      reserved: cols.reserved >= 0 ? num(r[cols.reserved]) : 0,
      transit: cols.transit >= 0 ? num(r[cols.transit]) : 0,
      forced: num(r[cols.forced]),
      daysToForced: cols.daysToForced >= 0 && r[cols.daysToForced] !== '' ? num(r[cols.daysToForced]) : null,
      forcedDate: cols.forcedDate >= 0 ? toIsoDate(r[cols.forcedDate]) : '',
      cost28: cols.cost28 >= 0 ? num(r[cols.cost28]) : 0,
      forecastMonth: cols.forecastMonth >= 0 ? num(r[cols.forecastMonth]) : 0,
    });
  }
  return items;
}

// Дата в отчёте бывает числом Excel (дни с 30.12.1899) или строкой ГГГГ-ММ-ДД.
function toIsoDate(v) {
  if (typeof v === 'number' && v > 30000) return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  return String(v ?? '').slice(0, 10);
}

function ruDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso || '';
}

function rub(n) {
  return `${(Math.round(n * 10) / 10).toString().replace('.', ',')} ₽`;
}

// isFood передаём снаружи (из fbo.js), чтобы список слов был один.
function buildSummary(items, isFood) {
  const paidNow = items.filter((i) => i.forced > 0).sort((a, b) => b.cost28 - a.cost28);
  const soon = items
    .filter((i) => i.forced === 0 && i.daysToForced !== null && i.daysToForced <= SOON_DAYS)
    .sort((a, b) => a.daysToForced - b.daysToForced);
  const food = items.filter((i) => isFood({ name: i.name, article: i.article }) && i.stock + i.transit >= FOOD_MIN_QTY);

  const out = [`📦 Платное размещение на FBO (товаров в отчёте: ${items.length})`];
  if (paidNow.length) {
    const sum = paidNow.reduce((s, i) => s + i.forecastMonth, 0);
    out.push(`\n💸 Платное СЕЙЧАС (${paidNow.length}):`);
    for (const i of paidNow) {
      out.push(`• ${i.article} — ${i.forced} шт · за 28 дн ${rub(i.cost28)}, прогноз на месяц ${rub(i.forecastMonth)}`);
    }
    out.push(`Итого прогноз: ${rub(sum)} в месяц. Можно создать заявку на вывоз со стока.`);
  } else {
    out.push('\n💸 Платного размещения сейчас нет ✅');
  }
  if (soon.length) {
    out.push(`\n⏳ Скоро станет платным (в ближайшие ${SOON_DAYS} дн):`);
    for (const i of soon) out.push(`• ${i.article} — с ${ruDate(i.forcedDate)} (через ${i.daysToForced} дн)`);
  }
  if (food.length) {
    out.push(`\n🍫 Еда от ${FOOD_MIN_QTY} шт:`);
    for (const i of food) out.push(`• ${i.article} — ${i.stock} шт на складах${i.transit ? `, в пути ${i.transit}` : ''}`);
  } else {
    out.push(`\n🍫 Еды от ${FOOD_MIN_QTY} шт на складах нет ✅`);
  }
  return out.join('\n');
}

const NOT_REPORT_PREFIX = 'в файле нет колонок';

// ---- Отчёт из API (/v1/report/placement/by-products): строка = день × товар × склад ----
function parseDaily(buffer) {
  return parseDailyRows(readFirstSheet(buffer));
}

// Разбор уже прочитанных строк листа (отдельно от xlsx — чтобы тестировать без файла).
// clean() приводит к нижнему регистру, поэтому и искомая строка — в нижнем
// (раньше сравнение шло с заглавной «Начисленная…» и никогда не срабатывало).
function parseDailyRows(all) {
  const hi = all.findIndex((r) => r.some((c) => clean(c).startsWith('начисленная стоимость')));
  if (hi < 0) throw new Error(`${NOT_REPORT_PREFIX}: «Начисленная стоимость размещения»`);
  const h = all[hi].map(clean);
  const col = (re) => h.findIndex((c) => re.test(c));
  const c = {
    date: col(/^дата$/i), article: col(/^артикул$/i), warehouse: col(/^склад$/i),
    qty: col(/^кол-во экземпляров$/i), paidQty: col(/платных экземпляров/i), cost: col(/начисленная стоимость/i),
  };
  const miss = Object.entries(c).filter(([, v]) => v < 0).map(([k]) => k);
  if (miss.length) throw new Error(`${NOT_REPORT_PREFIX}: ${miss.join(', ')}`);
  // необязательные: SKU и объёмы (нужны для расчёта стоимости хранения в день)
  const opt = {
    sku: col(/^sku$/i), ml: col(/^суммарный объем/i), paidMl: col(/^платный объем/i),
  };
  const rows = [];
  for (const r of all.slice(hi + 1)) {
    const article = String(r[c.article] ?? '').trim();
    if (!article) continue;
    rows.push({
      date: toIsoDate(r[c.date]), article, warehouse: String(r[c.warehouse] ?? '').trim(),
      qty: num(r[c.qty]), paidQty: num(r[c.paidQty]), cost: num(r[c.cost]),
      sku: opt.sku >= 0 ? String(r[opt.sku] ?? '').trim() : '',
      ml: opt.ml >= 0 ? num(r[opt.ml]) : 0,
      paidMl: opt.paidMl >= 0 ? num(r[opt.paidMl]) : 0,
    });
  }
  return rows;
}

// ---- Отчёт по поставкам (/v1/report/placement/by-supplies): прогноз «станет платным» ----
// Строка поставки: SKU (может быть только в итоговой строке товара — переносим вниз),
// склад поставки, «Дней до конца периода», дата окончания, затем колонки по дням.
const DAILY_COL_RE = /^\d{1,2}\.[а-яё]{3,5}\.?$/;
function parseSupplies(all) {
  const hi = all.findIndex((r) => r.some((c) => clean(c).startsWith('дней до конца периода')));
  if (hi < 0) throw new Error(`${NOT_REPORT_PREFIX}: «Дней до конца периода»`);
  const h = all[hi].map(clean);
  const col = (re) => h.findIndex((c) => re.test(c));
  const c = {
    sku: col(/^sku$/i), supply: col(/^номер поставки/i), warehouse: col(/^склад поставки/i),
    days: col(/^дней до конца периода/i), end: col(/^дата окончания периода/i),
  };
  const miss = Object.entries(c).filter(([, v]) => v < 0).map(([k]) => k);
  if (miss.length) throw new Error(`${NOT_REPORT_PREFIX}: ${miss.join(', ')}`);
  let lastDaily = -1;
  h.forEach((x, i) => { if (DAILY_COL_RE.test(x)) lastDaily = i; });
  if (lastDaily < 0) throw new Error(`${NOT_REPORT_PREFIX}: колонки по дням`);
  const out = [];
  let sku = '';
  for (const r of all.slice(hi + 1)) {
    const s = String(r[c.sku] ?? '').trim();
    if (s) sku = s;
    const warehouse = String(r[c.warehouse] ?? '').trim();
    const supply = String(r[c.supply] ?? '').trim();
    const rawDays = r[c.days];
    if (!sku || !warehouse || !supply || rawDays === '' || rawDays == null) continue;
    const days = num(rawDays);
    if (!Number.isFinite(days)) continue;
    const qty = num(r[lastDaily]);
    if (!(qty > 0)) continue; // закрытые поставки / пустой сегодняшний столбец
    out.push({ sku, supply, warehouse, days, qty, endDate: toIsoDate(r[c.end]) });
  }
  return out;
}

const DEFAULT_TARIFF = 2.5; // ₽ за литр в день (выведено по данным отчёта)

// Тариф ₽/л·день — медиана по платным строкам, иначе по умолчанию.
function tariffFrom(prodRows) {
  const v = prodRows.filter((r) => r.paidMl > 0 && r.cost > 0).map((r) => r.cost / (r.paidMl / 1000)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : DEFAULT_TARIFF;
}

// Литров на одну штуку по SKU (последняя дата, где объём известен).
function unitLitres(prodRows) {
  const m = new Map();
  for (const r of prodRows) {
    if (!r.sku || !(r.qty > 0) || !(r.ml > 0)) continue;
    m.set(r.sku, r.ml / r.qty / 1000);
  }
  return m;
}

// Сводка: накопительно — всё, что станет платным в ближайшие windowDays, + уже платное.
// prodRows — parseDailyRows (по товарам), supplies — parseSupplies. Нечего сообщать → text:null.
function buildDigest({ prodRows, supplies, windowDays = 28, todayIso = '' }) {
  const artBySku = new Map();
  for (const r of prodRows) if (r.sku && r.article) artBySku.set(r.sku, r.article);
  const tariff = tariffFrom(prodRows);
  const litres = unitLitres(prodRows);
  const soon = supplies
    .filter((s) => s.days >= 0 && s.days <= windowDays)
    .map((s) => ({
      ...s,
      article: artBySku.get(s.sku) || `SKU ${s.sku}`,
      perDay: (litres.get(s.sku) || 0) * s.qty * tariff,
    }))
    .sort((a, b) => a.days - b.days || a.article.localeCompare(b.article));
  const paid = paidNow(prodRows);

  if (!soon.length && !paid.list.length) return { text: null, soon, paid };
  const out = [];
  if (soon.length) {
    out.push(`⏳ Скоро станет платным на FBO (в ближайшие ${windowDays} дн.):`);
    for (const s of soon) {
      const cost = s.perDay > 0 ? `, ~${rub(s.perDay)}/день после` : '';
      out.push(`• ${s.article} — ${s.qty} шт, ${s.warehouse}, через ${s.days} дн. (${ruDate(s.endDate)})${cost}`);
    }
    out.push('\nЗаявку на вывоз создаёте вы сами; стоимость вывоза бот пока не считает.');
  }
  if (paid.list.length) {
    out.push(`${soon.length ? '\n' : ''}💸 Уже платное (на ${ruDate(paid.last)}):`);
    for (const g of paid.list) out.push(`• ${g.article} — ${g.paidQty} шт, ${g.warehouse}, ${rub(g.cost)}/день`);
  }
  return { text: out.join('\n'), soon, paid };
}

// Платное на последнюю дату отчёта, сгруппировано «артикул|склад».
function paidNow(rows) {
  const last = rows.reduce((m, r) => (r.date > m ? r.date : m), '');
  const map = new Map();
  for (const r of rows) {
    if (r.date !== last || r.paidQty <= 0) continue;
    const key = `${r.article}|${r.warehouse}`;
    const g = map.get(key) || { key, article: r.article, warehouse: r.warehouse, paidQty: 0, cost: 0 };
    g.paidQty += r.paidQty;
    g.cost += r.cost;
    map.set(key, g);
  }
  return { last, list: [...map.values()].sort((a, b) => b.cost - a.cost) };
}

// prev — {key: paidQty}, о чём уже сообщали; onlyNew — слать только новое/выросшее.
function buildPaidMessage(rows, prev = {}, onlyNew = false) {
  const { last, list } = paidNow(rows);
  const fresh = onlyNew ? list.filter((g) => !(prev[g.key] >= g.paidQty)) : list;
  const state = Object.fromEntries(list.map((g) => [g.key, g.paidQty]));
  if (!fresh.length) {
    return { text: onlyNew ? null : `💸 Платного размещения на ${ruDate(last)} нет ✅`, state };
  }
  const out = [`💸 Платное размещение на FBO (на ${ruDate(last)})${onlyNew ? ' — новое' : ''}:`];
  for (const g of fresh) out.push(`• ${g.article} — ${g.paidQty} шт платно, ${g.warehouse}, ${rub(g.cost)} за день`);
  out.push(`\nИтого за день: ${rub(fresh.reduce((s, g) => s + g.cost, 0))}. Можно создать заявку на вывоз со стока.`);
  return { text: out.join('\n'), state };
}


// Диагностика незнакомого отчёта: ВСЕ заголовки колонок с номерами и несколько
// первых строк целиком — чтобы увидеть скрытые середины (раньше показывались
// только 9 первых и 4 последние колонки). Ничего не меняет.
function describeReport(rows, sampleCount = 3) {
  const hi = Math.max(0, rows.findIndex((r) => r.filter((c) => String(c ?? '').trim()).length >= 5));
  const cut = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const headers = (rows[hi] || []).map((c, i) => `${i + 1}. ${cut(c)}`).join('\n');
  const samples = rows.slice(hi + 1, hi + 1 + sampleCount).map((r) => r.map(cut).join(' | ')).join('\n');
  return `Строк в отчёте: ${rows.length}\n\nКолонки:\n${headers}\n\nПервые строки:\n${samples}`;
}

module.exports = {
  parseReport, buildSummary, parseDaily, parseDailyRows, buildPaidMessage, describeReport, NOT_REPORT_PREFIX,
  parseSupplies, buildDigest, tariffFrom,
};
