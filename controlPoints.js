// «Контрольные точки»: бот сам напоминает Елене в нужный день, какой отчёт
// скачать и что проверить; присланный отчёт начислений закрывает точку сам.
// Состояние — /data/control_points.json (атомарная запись, дата — по Бали).
const fs = require('fs');
const path = require('path');
const ozonMsg = require('./ozonMsg');
const accrualsReport = require('./accrualsReport');

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
  { id: 'seed-promo-1021', due: '2026-10-21', title: 'Акции Озон: нет ли новых автодобавлений',
    what: '«Цены и акции» → «Акции от Ozon»: в списке ищи оранжевую строку «Добавим N товаров с …» и значок «Автодобавили». Если есть — открой акцию → вкладка «Участвуют с …» → выбрать всё → «Удалить» (повтори для каждой страницы). Озон предупреждает минимум за 5 рабочих дней.',
    support: 'Здравствуйте! ID компании 247027. Озон автоматически добавляет мои товары в акции «Максимальный бустинг» (значок «Автодобавили»). Автодобавление у меня не включено, я каждый раз удаляю товары вручную, но с новой акцией они добавляются снова, цена в акции в разы ниже обычной. Прошу отключить для моего аккаунта любое автоматическое добавление товаров в акции Озон и подтвердить, что товары не попадут в акции без моего согласия.' },
  { id: 'seed-promo-1106', due: '2026-11-06', title: 'Акции Озон перед «Чёрной пятницей» (с 13.11)',
    what: 'То же: «Цены и акции» → «Акции от Ozon», найди строки «Добавим N товаров с …» (Чёрная пятница начинается 13.11) и убери товары до даты добавления.',
    support: 'Здравствуйте! ID компании 247027. Озон автоматически добавляет мои товары в акции «Максимальный бустинг» (значок «Автодобавили»). Автодобавление у меня не включено, я каждый раз удаляю товары вручную, но с новой акцией они добавляются снова, цена в акции в разы ниже обычной. Прошу отключить для моего аккаунта любое автоматическое добавление товаров в акции Озон и подтвердить, что товары не попадут в акции без моего согласия.' },
  { id: 'seed-month', due: '2026-11-15', needsReport: true, title: 'Итог месяца по всем платным списаниям',
    what: 'Отчёт 01–14.11: сравним с октябрём, всё ли платное отключено и сколько сэкономили.' },
];

const BRAND_PROMO_PROMPT = `ЗАЧЕМ ЭТО. Решаем, оставлять ли платную услугу «Продвижение бренда» (Озон берёт 1% с продаж включённых брендов, около 6–7 тыс. ₽ в месяц) или отключить везде. 30.10.2026 по «да» Елены провели тест: выключили «Продвигать товары» у брендов Принцесса, Concept и Рот Фронт (раньше у Milv). Контроль с включённым продвижением: Бабаевский, Красный Октябрь (и Milk). Надо понять, просели ли отключённые бренды сильнее контрольных.
Проект Озон, магазин Portretkina Beauty, Елена, русский язык, коротко. Прочитай документы проекта «Ozon_зачем_напоминания_бота_и_итоги_начислений» и «Ozon_что_где_настроено_ЧИТАТЬ_ПЕРВЫМ». Нужен Chrome с расширением Claude на компьютере Елены. Только чтение.
ЧТО СДЕЛАТЬ: кабинет Озон → Аналитика → Продажи моих товаров → группировка «По брендам», период 14 дней 31.10–13.11 против предыдущих 14 дней 17–30.10, «Показать ещё» до конца. По каждому бренду сравнить заказы, выручку, показы, посещения.
ЗАМЕР «ДО» (на 29.10): Принцесса 28д 993 ₽ (−46%), 7д 0 ₽, показы в поиске 2195/457; Concept Fusion 28д 1094 ₽, 7д 1094 ₽, показы 701/182; Рот Фронт 28д 75 141 ₽ (+26%), 7д 15 963 ₽ (−15%), показы 136 019/38 578; Красный Октябрь 28д 389 959 ₽, 7д 53 071 ₽; Бабаевский 28д 65 656 ₽, 7д 21 308 ₽; Milv 28д 1 690 ₽; Milk 28д 0 ₽. Магазин 23–29.10: 636 заказов, 449 670 ₽.
ВЫВОД: сравнить Рот Фронт, Принцессу и Concept «до/после» с Бабаевским, Красным Октябрём и всем магазином (сезон Нового года влияет на всех, нужна разница). Посчитать, сколько сэкономили или потеряли (комиссия около 1% продаж). Оговорить малую выборку. Критерий: если отключённые просели заметно сильнее контрольных, вернуть продвижение (включить можно только через 24 ч после отключения); если нет, предложить отключить везде. Настройки менять только после «да» Елены. Итог одним коротким сообщением.`;

SEED.push({ id: 'brand-promo-1113', due: '2026-11-13', dueTime: '09:30', title: 'Продвижение бренда Озон',
  why: 'решить, оставляем ли платную услугу «Продвижение бренда» (1% с продаж включённых брендов, около 6–7 тыс. ₽ в месяц).',
  period: '31.10–13.11 против 17–30.10',
  what: 'Скопируй промпт ниже и отправь в новую ветку проекта Озон.\nКогда сделано: /контроль_готово brand-promo-1113',
  prompt: BRAND_PROMO_PROMPT });

// Добавлены Еленой командами /контроль_добавить (2026-11-09) — зашиты, чтобы появились без её ручного ввода.
const CHROME = ' Нужен компьютер и Chrome';
[
  ['ctl-1112-birki', '2026-11-12', 'Озон: ответ по спорам бирки 13162 ×4 (обращения 2864069, 2864084, 2864099, 2864111, 21 000 ₽).' + CHROME, 'получить деньги за 4 бирки 13162 (21 000 ₽) или подать спор дальше.', false],
  ['ctl-1116-moskva', '2026-11-16', 'Озон: ответ по спорам МОСКВА1ШТ ×3 (обращения 2912054, 2912082, 2912092, 3 492 ₽), «Ищем товар» 1002046457, обращение 94936385, уведомление Озона о страховке Ингосстрах.' + CHROME, 'получить деньги за МОСКВА1ШТ (3 492 ₽), закрыть «Ищем товар» и обращение 94936385 и разобраться со страховкой Ингосстрах.', false],
  ['ctl-1130-ozhid', '2026-11-30', 'Озон: подать споры по возвратам «Ожидает отправки» с 30.09 (1002019808–10, 10 900 ₽).' + CHROME, 'не потерять 10 900 ₽ за возвраты, которые зависли с 30.09 (срок 60 дней).', false],
  ['ctl-1207-penal', '2026-12-07', 'Озон: выплата по ПеналЧерный1 (250 ₽) в отчёте за ноябрь', 'убедиться, что одобренная выплата 250 ₽ по ПеналЧерный1 дошла.', true],
  ['ctl-1212-dolgie', '2026-12-12', 'Озон: долгие возвраты от 13.10–17.10 (1002089638, 1002111453), 60 дней', 'на 60-й день подать спор по долгим возвратам, пока не истёк срок.', false],
].forEach(([id, due, title, why, needsReport]) => SEED.push({ id, due, title, why, what: title, needsReport }));

// «Зачем:» для точек, уже лежащих в /data без этого поля (SEED добавляется один раз).
const SEED_WHY = {
  'seed-stars': 'убедиться, что после отключения «Звёздных товаров» списания прекратились.',
  'seed-ticket': 'получить от поддержки возврат за «Управление отзывами» и запрет автоподключения.',
  'seed-reviews': 'проверить, что подписка «Управление отзывами» не переподключилась.',
  'seed-premium': 'проверить, что Озон не включил Premium заново.',
  'seed-decomp': 'найти декомпенсацию 237 ₽ (POSTING, 12–14.10) и вернуть деньги.',
  'seed-promo-1021': 'убрать товары, которые Озон добавил в акции без нашего согласия, пока цена не упала.',
  'seed-promo-1106': 'убрать товары, которые Озон добавил в акции без нашего согласия, пока цена не упала.',
  'seed-month': 'сравнить с октябрём: всё ли платное отключено и сколько сэкономили.',
};
const whyOf = (p) => p.why || SEED_WHY[p.id] || String(p.what || p.title).split('\n')[0].replace(/\.$/, '') + '.';
const seedOf = (p) => SEED.find((s) => s.id === p.id) || {};
const periodOf = (p, today) => p.period || seedOf(p).period || (p.needsReport ? ozonMsg.periodLine(today, accrualsReport.lastReportTo()) : null);
const promptOf = (p) => p.prompt || seedOf(p).prompt || null;

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
  for (const p of d.points) { // правки текста зашитых точек Елены доезжают и до уже сохранённых
    const sd = SEED.find((x) => x.id === p.id && x.id.startsWith('ctl-'));
    if (sd && !p.done && (p.title !== sd.title || p.what !== sd.what || p.why !== sd.why)) { p.title = sd.title; p.what = sd.what; p.why = sd.why; changed = true; }
  }
  if (changed) write(d);
  return d;
}

const fmtDate = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

function dueNow(today, hour, minute = 0) {
  const now = hour * 60 + minute;
  return load().points.filter((p) => {
    if (p.done || p.lastRemind === today || p.reminded >= MAX_REMINDS || p.due > today) return false;
    const [h, m] = (p.dueTime || seedOf(p).dueTime || '').split(':').map(Number);
    const at = Number.isFinite(h) ? h * 60 + (m || 0) : REMIND_HOUR * 60;
    return now >= at;
  });
}
function markReminded(ids, today) {
  const d = load();
  for (const p of d.points) if (ids.includes(p.id)) { p.reminded += 1; p.lastRemind = today; }
  write(d);
}
function format(p, today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)) {
  const body = p.what +
    (p.needsReport ? `\n\n${DETAIL_HOW}` : '') +
    (p.support ? '\n\nМожно проверить и через Chrome с расширением Claude: если ты у компьютера — открой Chrome, и Claude посмотрит сам. Если нет — через 2 часа пришлю готовый текст для техподдержки.' : '') +
    (String(p.what).includes('/контроль_готово') ? '' : `\n\nСделала — напиши /контроль_готово ${p.id}`);
  return ozonMsg.build({ title: `Контрольная точка — ${p.title}`, why: whyOf(p), period: periodOf(p, today), body });
}
// Полный набор сообщений точки: текст (по частям <4096) + промпт для Claude отдельным блоком кода.
async function send(bot, chatId, p, today) {
  await ozonMsg.sendParts(bot, chatId, format(p, today));
  const pr = promptOf(p);
  if (pr) await ozonMsg.sendCode(bot, chatId, pr);
}
const SUPPORT_DELAY_HOURS = 2;
// Второй шаг: если точка не закрыта, через 2 часа после напоминания — готовый текст для поддержки (один раз).
function supportDue(today, hour) {
  return load().points.filter((p) => !p.done && p.support && !p.supportSent && p.lastRemind === today && hour >= REMIND_HOUR + SUPPORT_DELAY_HOURS);
}
function markSupportSent(ids) {
  const d = load(); for (const p of d.points) if (ids.includes(p.id)) p.supportSent = true; write(d);
}
function formatSupport(p, today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)) {
  return ozonMsg.build({ title: `Ответа по точке «${p.title}» ещё нет`,
    why: 'без ответа поддержки списания не вернут и не остановят.',
    period: p.needsReport ? periodOf(p, today) : null,
    body: `Скорее всего, Chrome был закрыт. Отправь в техподдержку (Помощь → чат, при ответе-шаблоне «Ответ мне не помог» → оператор):\n\n${p.support}\n\nОтправила — напиши /контроль_готово ${p.id}` });
}
function list(today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)) {
  const pts = load().points.filter((p) => !p.done).sort((a, b) => a.due.localeCompare(b.due));
  const head = (body) => ozonMsg.build({ title: 'Контрольные точки', why: 'не забыть проверить платные списания и акции Озона вовремя.',
    period: ozonMsg.periodLine(today, accrualsReport.lastReportTo()), body });
  if (!pts.length) return head('Открытых контрольных точек нет.');
  return head(pts.map((p) => `• ${fmtDate(p.due)} — ${p.title}  [${p.id}]\n   Зачем: ${whyOf(p)}`).join('\n') +
    '\n\nДобавить: /контроль_добавить 25.10 что проверить\nЗакрыть: /контроль_готово <номер из скобок>');
}
function formatDone(p) {
  return ozonMsg.build({ title: `Закрыл: ${p.title}`, why: whyOf(p) });
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

module.exports = { send, formatDone, whyOf, supportDue, markSupportSent, formatSupport, dueNow, markReminded, format, list, done, add, closeByReport, load };
