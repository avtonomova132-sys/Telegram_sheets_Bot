// Что про списания Ozon Елена уже знает (настройки бота, /data/ozon_known_fees.json).
// «mandatory» — обязательные, бот молчит всегда; «paid» — платные услуги, о которых она знает:
// молчим, пока сумма в норме (рост больше чем на 30% или новый вид — сообщаем). Всё остальное — новое.
// Добавить вид одной командой: /озон_знаю <название> (обязательное) или /озон_знаю платное <название>.
// Совпадение — по вхождению названия записи в название списания (без регистра, ё = е).
const fs = require('fs');
const path = require('path');

const PATH = process.env.FEES_KNOWN_PATH || '/data/ozon_known_fees.json';
const PREMIUM_LITE = 'Premium Lite (AnalyticsLite) 4 990 ₽ в месяц, период 17.11–17.12 (подключила Алина)';

const SEED = [
  // 1. Обязательные
  ...['вознаграждение за продажу', 'возврат вознаграждения', 'логистика', 'доставка до места выдачи', 'обратная логистика',
    'эквайринг', 'обработка отправления drop-off', 'упаковка товара партнёрами', 'обработка возвратов', 'обработка отмен',
    'обработка невыкуп', 'выручка', 'баллы за скидки', 'программы партнёров', 'возврат выручки',
    'обеспечение материалами', 'размещение на склад', 'размещение товаров', 'хранение', 'утилизаци', 'утилизирован',
    'posting', 'корректировк', 'отмена начисл', 'отмены начисл'].map((name) => ({ kind: 'mandatory', name })),
  // 2. Платные, о которых Елена знает
  { kind: 'paid', name: 'premium lite', label: 'Premium Lite (AnalyticsLite)', note: PREMIUM_LITE },
  { kind: 'paid', name: 'analyticslite', label: 'Premium Lite (AnalyticsLite)', note: PREMIUM_LITE },
  { kind: 'paid', name: 'продвижение бренд', label: 'Продвижение бренда', note: 'Продвижение бренда (1% с продаж включённых брендов)' },
  { kind: 'paid', name: 'управление отзывами', label: 'Подписка «Управление отзывами»', note: 'Подписка «Управление отзывами» (только хвост)' },
];

// Всегда сообщаем (если Елена сама не внесла вид в список командой):
const ALWAYS = [
  /звезд|(^|[^a-z])star/, /оплата за клик/, /оплата за заказ/, /платное размещение/,
  /(premium|премиум)(?!\s*lite)/, /(premium|премиум|подписк).*(^|[^а-яa-z])(plus|pro|плюс|про)($|[^а-яa-z])/, /подписк/,
];

const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

function read() { try { return JSON.parse(fs.readFileSync(PATH, 'utf8')); } catch { return null; } }
function write(d) {
  fs.mkdirSync(path.dirname(PATH), { recursive: true });
  const tmp = `${PATH}.tmp`; fs.writeFileSync(tmp, JSON.stringify(d, null, 2)); fs.renameSync(tmp, PATH);
}
function load() {
  let d = read();
  if (!d || !Array.isArray(d.entries) || !d.seeded) {
    d = { seeded: true, entries: [...SEED.map((e) => ({ ...e })), ...((d && d.entries) || [])] };
    write(d);
  }
  return d;
}

// → { type: 'mandatory'|'paid'|'always'|'unknown', entry? }
function classify(name, d = load()) {
  const n = norm(name);
  const hit = (e) => n.includes(norm(e.name));
  const user = d.entries.filter((e) => e.user);
  const seed = d.entries.filter((e) => !e.user);
  let e = user.find(hit);
  if (e) return { type: e.kind, entry: e };
  e = seed.find((x) => x.kind === 'paid' && hit(x));
  if (e) return { type: 'paid', entry: e };
  if (ALWAYS.some((re) => re.test(n))) return { type: 'always' };
  e = seed.find((x) => x.kind === 'mandatory' && hit(x));
  if (e) return { type: 'mandatory', entry: e };
  return { type: 'unknown' };
}

function add(rawName, kind = 'mandatory') {
  const name = String(rawName || '').replace(/\s+/g, ' ').trim();
  if (name.length < 3) return null;
  const d = load();
  const ex = d.entries.find((e) => norm(e.name) === norm(name));
  if (ex) { ex.kind = kind; ex.user = true; } else d.entries.push({ kind, name, user: true });
  write(d); return { name, kind };
}
function remove(rawName) {
  const d = load(); const n = norm(rawName);
  const before = d.entries.length;
  d.entries = d.entries.filter((e) => norm(e.name) !== n);
  if (d.entries.length === before) return false;
  write(d); return true;
}
function list() {
  const d = load();
  const fmt = (k) => d.entries.filter((e) => e.kind === k).map((e) => e.name).join(', ');
  return `Обязательные (молчу): ${fmt('mandatory')}\n\nПлатные, о которых ты знаешь: ${fmt('paid')}\n\n` +
    'Добавить обязательное: /озон_знаю <название>\nДобавить платное: /озон_знаю платное <название>\nУбрать из списка: /озон_забыть <название>';
}

module.exports = { classify, add, remove, list, load, norm, SEED };
