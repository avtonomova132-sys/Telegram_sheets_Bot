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

module.exports = { parseReport, buildSummary, NOT_REPORT_PREFIX };
