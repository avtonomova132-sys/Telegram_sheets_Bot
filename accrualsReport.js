// Разбор xlsx «Детализация начислений» Озона (Финансы → Начисления и документы →
// Детализация начислений): сводка по «Группа услуг / Тип начисления» за период,
// сравнение с прошлым присланным отчётом (в пересчёте на день — периоды разной
// длины сравнимы). Только чтение файла, в Озон не ходит.
const fs = require('fs');
const path = require('path');
const { readFirstSheet } = require('./miniXlsx');

const SNAP_PATH = process.env.ACCRUALS_SNAPSHOTS_PATH || '/data/accruals_snapshots.json';
const NOT_REPORT_PREFIX = 'не отчёт начислений';
// Обычные расходы продавца и выручка — в сравнении молча, платные/спорные — с флагом.
const ROUTINE = ['вознаграждение за продажу', 'логистика', 'эквайринг', 'доставка до места выдачи',
  'обработка отправления drop-off', 'выручка', 'баллы за скидки', 'программы партнёров',
  'обратная логистика', 'возврат выручки', 'возврат вознаграждения', 'обработка возвратов',
  'упаковка товара партнёрами', 'обеспечение материалами'];

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const num = (v) => { const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const money = (n) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;

function readJson(p, f) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } }
function writeJsonAtomic(p, d) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`; fs.writeFileSync(tmp, JSON.stringify(d, null, 2)); fs.renameSync(tmp, p);
}

const toIso = (s) => `${s.slice(6, 10)}-${s.slice(3, 5)}-${s.slice(0, 2)}`;

function parse(buffer) {
  let rows;
  try { rows = readFirstSheet(buffer); } catch (e) { throw new Error(`${NOT_REPORT_PREFIX} (${e.message})`); }
  const per = /период:\s*(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4})/i.exec(clean(rows[0]?.[0]));
  const hi = rows.findIndex((r) => clean(r[0]).toLowerCase() === 'id начисления');
  if (!per || hi < 0) throw new Error(NOT_REPORT_PREFIX);
  const h = rows[hi].map((c) => clean(c).toLowerCase());
  const iGroup = h.indexOf('группа услуг'); const iType = h.indexOf('тип начисления');
  const iSum = h.findIndex((c) => c.startsWith('сумма итого'));
  if (iGroup < 0 || iType < 0 || iSum < 0) throw new Error(`${NOT_REPORT_PREFIX}: нет нужных колонок`);
  const items = new Map();
  for (const r of rows.slice(hi + 1)) {
    if (!clean(r[iType])) continue;
    const key = `${clean(r[iGroup])} / ${clean(r[iType])}`;
    const cur = items.get(key) || { sum: 0, count: 0 };
    cur.sum += num(r[iSum]); cur.count += 1; items.set(key, cur);
  }
  const from = toIso(per[1]); const to = toIso(per[2]);
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  return { from, to, days, items: Object.fromEntries(items) };
}

const isRoutine = (k) => ROUTINE.some((w) => k.toLowerCase().includes(w));

function buildMessage(rep, prev) {
  const lines = [`📊 Начисления ${rep.from} — ${rep.to} (${rep.days} дн.)`];
  const keys = Object.keys(rep.items);
  const flagged = keys.filter((k) => !isRoutine(k)).sort((a, b) => rep.items[a].sum - rep.items[b].sum);
  const routine = keys.filter(isRoutine).filter((k) => rep.items[k].sum < 0).sort((a, b) => rep.items[a].sum - rep.items[b].sum);
  lines.push('\nВнимание (не обычные расходы):');
  if (!flagged.length) lines.push('• ничего');
  for (const k of flagged) {
    const v = rep.items[k]; const perDay = v.sum / rep.days;
    let cmp = '';
    if (prev) {
      const p = prev.items[k]; const pd = p ? p.sum / prev.days : 0;
      cmp = p ? ` | было ${money(pd)}/день` : ' | раньше не было';
    }
    lines.push(`• ${k}: ${money(v.sum)} (${v.count} шт., ${money(perDay)}/день)${cmp}`);
  }
  if (prev) {
    const gone = Object.keys(prev.items).filter((k) => !isRoutine(k) && !rep.items[k]);
    if (gone.length) lines.push('\n✅ Исчезло с прошлого отчёта: ' + gone.join('; '));
  }
  lines.push('\nОбычные расходы:');
  for (const k of routine) lines.push(`• ${k}: ${money(rep.items[k].sum)}`);
  lines.push(prev ? `\nСравнение — с отчётом ${prev.from} — ${prev.to}.` : '\nЭто первый отчёт — запомнил как точку отсчёта.');
  return lines.join('\n');
}

function process_(buffer) {
  const rep = parse(buffer);
  const snaps = readJson(SNAP_PATH, []);
  const prev = [...snaps].reverse().find((s) => s.to < rep.to) || null;
  const text = buildMessage(rep, prev);
  const next = snaps.filter((s) => !(s.from === rep.from && s.to === rep.to)).concat(rep).slice(-24);
  writeJsonAtomic(SNAP_PATH, next);
  return { text, to: rep.to };
}

module.exports = { process: process_, parse, buildMessage, NOT_REPORT_PREFIX };
