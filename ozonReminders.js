// Напоминания Елене про проверки Ozon, которые делает Claude (ноутбук + Chrome).
// «Таблица» — /data/ozon_reminders.json: { items: [{id, date|weekday, time, title, text, sent, lastSent}], seeded: [] }.
// Разовое (date ГГГГ-ММ-ДД): уходит, когда время наступило; не отправленное из-за перезапуска — уходит при первом тике после (catch-up).
// Еженедельное (weekday 0–6, 1 = пн): раз в неделю, метка lastSent. Время — по Бали (UTC+8). Шлётся только Елене.
const fs = require('fs');
const path = require('path');

const PATH = process.env.OZON_REMINDERS_PATH || '/data/ozon_reminders.json';

// Стартовый набор (добавляется один раз). Ни цен, ни ключей.
const SEED = [
  { id: 'oz-1116-spory', date: '2026-11-16', time: '08:00', title: 'Ответы по спорам',
    text: 'Проверь ответы Ozon по спорам в чате поддержки: МОСКВА №2912054, №2912082, №2912092; бирки №2864069, №2864084, №2864099. Что одобрено, что в работе, что отказано? Ничего не подавай и не пиши, только коротко доложи.' },
  { id: 'oz-1119-itemcomp', date: '2026-11-19', time: '09:00', title: 'Списание ItemCompensation −183 ₽',
    text: 'Ozon должен был списать около −183 ₽ (ItemCompensation). Посмотри в Финансы → Начисления и документы, за какой товар списали и правильно ли. Коротко доложи, в поддержку не пиши.' },
  { id: 'oz-1124-fbo', date: '2026-11-24', time: '08:30', title: 'FBO-списания одним файлом',
    text: 'Собери FBO-списания без компенсации в одном файле (025ПЛАМЯ025СИНП1ШТ, срок 29.11). Файл не скачивай и в поддержку не отправляй, пока я не напишу «да».' },
  { id: 'oz-weekly-fbs', weekday: 1, time: '08:00', title: 'Проверка списаний FBS',
    text: 'Проверь FBS → Списанные товары за последние 30 дней: что списали без компенсации. Предложи споры, ничего не подавай без моего «да».' },
  // Разовое, 29.11.2026 08:40 по Бали: споры по пакетам Альянс Хим (10 900 ₽). `message` — первое сообщение
  // (начинается с «⏰ Ozon:», чтобы ozonMsg не добавлял 🛍️ и «Зачем»), `prompt` — второе, отдельное, в блоке кода.
  { id: 'oz-1129-spory-vozvraty', date: '2026-11-29', time: '08:40', title: 'Споры по пакетам Альянс Хим 10 900 ₽',
    message: '⏰ Ozon: Открой ноутбук и Chrome (Claude подключён, Ozon залогинен). Подать споры по пакетам Альянс Хим на 10 900 ₽. Скопируй текст ниже и вставь в чат с Claude.',
    prompt: 'Проект Ozon, кабинет Portretkina Beauty. Прочитай документ claude/Ozon_штрафы_претензии_проверка_23-11.md и навык ozon-spory-spisaniya-vozvraty. Задача: открыть споры по заявкам 1002019808, 1002019809, 1002019810 (отправление 72958848-0061-2, FBS, «Ожидает отправки» с 30.09, причина «Прошёл расчётный срок доставки возврата», в сумме 10 900 ₽). Подать по каждой заявке отдельный спор, потом записать дату в колонку F строк 176–178 листа «Елена (Ozon)» в таблице «Задания менеджерам» и поставить статус «подана претензия» и комментарий в «Портреткина – Озон» → «Штрафы Ozon» (строки могут сдвинуться, искать по номеру заявки). Заодно проверить: ответ Ozon по хне 1001808079 (спор подан 25.11) и по заявке 1002046457 (спор от 23.11). Я даю «да» на подачу.' },
  // Разовое, 21.12.2026 09:00 по Бали: спор по возврату хны (60 дней с 22.10). `message` — первое сообщение,
  // `prompt` — второе, отдельное, в блоке кода (копируется одним нажатием, см. send()).
  { id: 'oz-1221-hna-spor', date: '2026-12-21', time: '09:00', title: 'Спор по возврату хны 1001808079',
    message: '⏰ Ozon: Напоминание 21.12: открыть спор по возврату хны. Проект Ozon, кабинет Portretkina Beauty. Заявка 1001808079, отправление 50557929-0147-1, артикул 125ХнаБесцветнОтборная1ШТ, 300 ₽. Статус «Едет на склад Ozon» с 22.10, 60 дней проходит 21.12. Открой ветку проекта Ozon и отправь туда промпт ниже.',
    prompt: 'Проект Ozon, кабинет Portretkina Beauty. Прочитай документ claude/Ozon_штрафы_претензии_проверка_23-11.md и навык ozon-spory-spisaniya-vozvraty. Задача: проверить в FBS → «Возвраты и отмены» заявку 1001808079 (отправление 50557929-0147-1). Если статус всё ещё «Едет на склад Ozon» или «Ожидает отправки» и прошло больше 60 дней, открыть спор «Прошёл расчётный срок доставки возврата». Если товар уже вернулся или есть компенсация, спор не подавать. Результат записать в колонку F строки с артикулом 125ХнаБесцветнОтборная1ШТ в таблице «Задания менеджерам» и продублировать в «Портреткина – Озон» → «Штрафы Ozon» (O/P). Строки могут сдвинуться, искать по номеру заявки. Спор подавать после моего «да».' },
];

function read() { try { return JSON.parse(fs.readFileSync(PATH, 'utf8')); } catch { return null; } }
function write(d) {
  fs.mkdirSync(path.dirname(PATH), { recursive: true });
  const tmp = `${PATH}.tmp`; fs.writeFileSync(tmp, JSON.stringify(d, null, 2)); fs.renameSync(tmp, PATH);
}
function load() {
  const d = read() || { items: [], seeded: [] };
  let changed = false;
  for (const s of SEED) {
    if (!d.seeded.includes(s.id)) { d.items.push({ ...s, sent: false, lastSent: null }); d.seeded.push(s.id); changed = true; continue; }
    // правка текста/времени зашитого напоминания доезжает и до уже сохранённого, если оно ещё не отправлено
    const it = d.items.find((x) => x.id === s.id);
    if (it && !it.sent && s.date && JSON.stringify([it.date, it.time, it.title, it.message, it.prompt, it.text]) !== JSON.stringify([s.date, s.time, s.title, s.message, s.prompt, s.text])) {
      Object.assign(it, { date: s.date, time: s.time, title: s.title, message: s.message, prompt: s.prompt, text: s.text }); changed = true;
    }
  }
  if (changed) write(d);
  return d;
}

const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };

// today: ГГГГ-ММ-ДД по Бали, nowMin: минуты от полуночи по Бали, weekday: 0–6 по Бали.
function dueNow(today, nowMin, weekday) {
  return load().items.filter((r) => {
    if (nowMin < toMin(r.time) && !(r.date && r.date < today)) return false;
    if (r.weekday !== undefined) return r.weekday === weekday && r.lastSent !== today;
    return !r.sent && r.date <= today;
  });
}
function markSent(id, today) {
  const d = load(); const r = d.items.find((x) => x.id === id);
  if (!r) return; r.lastSent = today; if (r.date) r.sent = true; write(d);
}
function format(r) {
  if (r.message) return r.message;
  return [`⏰ Ozon: ${r.title}`,
    '💻 Открой ноутбук и Chrome (расширение Claude подключено).',
    '📋 Куда: проект «Ozon» в Claude, новый чат.',
    '📝 Скопируй и отправь:',
    `«${r.text}»`].join('\n');
}

// Отправка одного напоминания: текст, затем (если есть) промпт отдельным сообщением в блоке кода.
async function send(bot, chatId, r) {
  await bot.sendMessage(chatId, format(r));
  if (r.prompt) await require('./ozonMsg').sendCode(bot, chatId, r.prompt);
}

// /напомнить_озон дата время | название | текст  (дата ДД.ММ или ДД.ММ.ГГГГ, время ЧЧ:ММ)
function add(args, today) {
  const parts = String(args || '').split('|').map((s) => s.trim());
  const m = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2}):(\d{2})$/.exec(parts[0] || '');
  if (!m || !parts[1] || !parts[2]) return null;
  const year = m[3] || today.slice(0, 4);
  const date = `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const time = `${m[4].padStart(2, '0')}:${m[5]}`;
  if (Number.isNaN(Date.parse(date)) || Number(m[4]) > 23 || Number(m[5]) > 59) return null;
  const d = load();
  const r = { id: `u${Date.now()}`, date, time, title: parts[1], text: parts.slice(2).join(' | '), sent: false, lastSent: null };
  d.items.push(r); write(d); return r;
}
function list() {
  const names = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const items = load().items.filter((r) => r.weekday !== undefined || !r.sent);
  if (!items.length) return 'Напоминаний Ozon нет.';
  return 'Напоминания Ozon:\n' + items.map((r) => `• ${r.weekday !== undefined ? `каждый ${names[r.weekday]}` : `${r.date.slice(8)}.${r.date.slice(5, 7)}`} ${r.time} — ${r.title}`).join('\n') +
    '\n\nДобавить: /напомнить_озон 20.11 09:00 | название | текст';
}

module.exports = { SEED, dueNow, markSent, format, send, add, list, load };
