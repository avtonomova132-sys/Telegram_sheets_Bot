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
];

function read() { try { return JSON.parse(fs.readFileSync(PATH, 'utf8')); } catch { return null; } }
function write(d) {
  fs.mkdirSync(path.dirname(PATH), { recursive: true });
  const tmp = `${PATH}.tmp`; fs.writeFileSync(tmp, JSON.stringify(d, null, 2)); fs.renameSync(tmp, PATH);
}
function load() {
  const d = read() || { items: [], seeded: [] };
  let changed = false;
  for (const s of SEED) if (!d.seeded.includes(s.id)) { d.items.push({ ...s, sent: false, lastSent: null }); d.seeded.push(s.id); changed = true; }
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
  return [`⏰ Ozon: ${r.title}`,
    '💻 Открой ноутбук и Chrome (расширение Claude подключено).',
    '📋 Куда: проект «Ozon» в Claude, новый чат.',
    '📝 Скопируй и отправь:',
    `«${r.text}»`].join('\n');
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

module.exports = { SEED, dueNow, markSent, format, add, list, load };
