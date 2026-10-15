// «Контрольные точки»: бот сам напоминает Елене в нужный день, какой отчёт
// скачать и что проверить; присланный отчёт начислений закрывает точку сам.
// Состояние — /data/control_points.json (атомарная запись, дата — по Бали).
const fs = require('fs');
const path = require('path');

const PATH = process.env.CONTROL_POINTS_PATH || '/data/control_points.json';
const REMIND_HOUR = Number(process.env.CONTROL_REMIND_HOUR) || 10;
const MAX_REMINDS = 3; // напомнить, затем ещё до двух раз по одному в день

const DETAIL_HOW = [
  'Как скачать отчёт:',
  '1) «Финансы» → «Начисления и документы» → справа сверху «Детализация начислений»',
  '2) период: с дня после прошлого отчёта по сегодня',
  '3) «Скачать» (xlsx) и отправь файл сюда, мне в чат.',
].join('\n');

// Стартовый набор (даты по Бали). Добавляется один раз.
const SEED = [
  { id: 'seed-stars', due: '2026-10-18', needsReport: true, title: 'Хвост «Звёздных товаров» и страхования',
    what: 'Ты отключила «Звёздные товары», но 12–14.10 ещё шли списания. Нужен отчёт 15–18.10: если строка осталась — найду, какие товары ещё в программе.',
    support: 'Здравствуйте! ID компании 247027. Программа «Звёздные товары» у меня отключена, но в начислениях после отключения по-прежнему есть списания «Звёздные товары». Подскажите, по каким товарам они идут и как полностью выйти из программы? Прошу вернуть списания, сделанные после отключения.' },
  { id: 'seed-ticket', due: '2026-10-22', title: 'Ответ техподдержки по обращению №94936385',
    what: 'Посмотри ответ про возврат за «Управление отзывами» и запрет автоподключения. Перешли мне ответ — разберу.' },
  { id: 'seed-reviews', due: '2026-11-08', needsReport: true, title: 'Подписка «Управление отзывами» закончилась (07.11)',
    what: 'Нужен отчёт 08–10.11: строки «Подписка Управление отзывами» быть уже не должно. Если есть — подписка переподключилась.',
    support: 'Здравствуйте! ID компании 247027. Подписку «Управление отзывами» я отключила, срок закончился 07.11, но в начислениях за 08–10.11 снова есть списания по ней. Прошу отключить подписку, запретить автоматическое подключение и вернуть списанные суммы.' },
  { id: 'seed-premium', due: '2026-11-01', needsReport: true, title: 'Premium закончился (31.10) — не переподключился ли',
    what: 'Озон 1 октября уже переподключал подписки сам. Нужен отчёт 01–02.11 и взгляд в «Витрину услуг» → «Premium».',
    support: 'Здравствуйте! ID компании 247027. Подписку Premium я отключила, она закончилась 31.10, но после этого есть новое списание за Premium / подписка переподключена. Прошу отключить её, запретить автоподключение и вернуть деньги.' },
  { id: 'seed-decomp', due: '2026-11-01', title: 'Отчёт о компенсациях за октябрь',
    what: '«Финансы» → «Документы» → «Компенсации и прочие начисления» → «Отчёт о компенсациях» от 31.10.2026. Найти декомпенсацию на 237 ₽ (POSTING, 12–14.10) и прислать мне файл.' },
  { id: 'seed-month', due: '2026-11-15', needsReport: true, title: 'Итог месяца по всем платным списаниям',
    what: 'Отчёт 01–14.11: сравним с октябрём, всё ли платное отключено и сколько сэкономили.' },
];

function read() { try { return JSON.parse(fs.readFileSync(PATH, 'utf8')); } catch { return null; } }
function write(d) {
  fs.mkdirSync(path.dirname(PATH), { recursive: true });
  const tmp = `${PATH}.tmp`; fs.writeFileSync(tmp, JSON.stringify(d, null, 2)); fs.renameSync(tmp, PATH);
}
function load() {
  let d = read();
  if (!d) d = { points: [], seeded: [] };
  let changed = false;
  for (const s of SEED) {
    if (!d.seeded.includes(s.id)) { d.points.push({ ...s, done: false, reminded: 0, lastRemind: null }); d.seeded.push(s.id); changed = true; }
  }
  if (changed) write(d);
  return d;
}

const fmtDate = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

function dueNow(today, hour) {
  if (hour < REMIND_HOUR) return [];
  return load().points.filter((p) => !p.done && p.due <= today && p.lastRemind !== today && p.reminded < MAX_REMINDS);
}
function markReminded(ids, today) {
  const d = load();
  for (const p of d.points) if (ids.includes(p.id)) { p.reminded += 1; p.lastRemind = today; }
  write(d);
}
function format(p) {
  return `🔔 Контрольная точка — ${p.title}\n\n${p.what}` +
    (p.needsReport ? `\n\n${DETAIL_HOW}` : '') +
    (p.support ? '\n\nМожно проверить и через Chrome с расширением Claude: если ты у компьютера — открой Chrome, и Claude посмотрит сам. Если нет — через 2 часа пришлю готовый текст для техподдержки.' : '') +
    `\n\nСделала — напиши /контроль_готово ${p.id}`;
}
const SUPPORT_DELAY_HOURS = 2;
// Второй шаг: если точка не закрыта, через 2 часа после напоминания — готовый текст для поддержки (один раз).
function supportDue(today, hour) {
  return load().points.filter((p) => !p.done && p.support && !p.supportSent && p.lastRemind === today && hour >= REMIND_HOUR + SUPPORT_DELAY_HOURS);
}
function markSupportSent(ids) {
  const d = load(); for (const p of d.points) if (ids.includes(p.id)) p.supportSent = true; write(d);
}
function formatSupport(p) {
  return `📨 По точке «${p.title}» ответа ещё нет. Скорее всего, Chrome был закрыт. Отправь в техподдержку (Помощь → чат, при ответе-шаблоне «Ответ мне не помог» → оператор):\n\n${p.support}\n\nОтправила — напиши /контроль_готово ${p.id}`;
}
function list() {
  const pts = load().points.filter((p) => !p.done).sort((a, b) => a.due.localeCompare(b.due));
  if (!pts.length) return 'Открытых контрольных точек нет.';
  return 'Контрольные точки:\n' + pts.map((p) => `• ${fmtDate(p.due)} — ${p.title}  [${p.id}]`).join('\n') +
    '\n\nДобавить: /контроль_добавить 25.10 что проверить\nЗакрыть: /контроль_готово <номер из скобок>';
}
function done(id) {
  const d = load(); const p = d.points.find((x) => x.id === id);
  if (!p) return false; p.done = true; write(d); return p;
}
function add(dateStr, text, year) {
  const m = /^(\d{1,2})\.(\d{1,2})$/.exec(dateStr);
  if (!m || !text) return null;
  const d = load();
  const id = String(d.points.filter((p) => !p.id.startsWith('seed-')).length + 1);
  const p = { id, due: `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`, title: text, what: text, needsReport: /отчёт|отчет|начислен/i.test(text), done: false, reminded: 0, lastRemind: null };
  d.points.push(p); write(d); return p;
}
// Присланный отчёт начислений (период по дату `to`) закрывает точки, которые его ждали.
function closeByReport(to) {
  const d = load(); const closed = [];
  for (const p of d.points) if (!p.done && p.needsReport && p.due <= to) { p.done = true; closed.push(p); }
  if (closed.length) write(d);
  return closed;
}

module.exports = { supportDue, markSupportSent, formatSupport, dueNow, markReminded, format, list, done, add, closeByReport, load };
