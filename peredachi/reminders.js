const { readAll, saveAll } = require('./store');
const { getNowMsk } = require('./query');

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000; // МСК = UTC+3 круглый год, без перехода на летнее/зимнее время

// BROADCAST_GROUP_IDS — chat_id групп через запятую, куда дублируется то же
// 20-минутное напоминание, что уже уходит на MY_CHAT_ID. Elena добавляет
// вручную через переменную окружения на Railway; пустой список по
// умолчанию — рассылка в группы не активна, личное напоминание не затрагивает.
function getBroadcastGroupIds() {
  return new Set(
    String(process.env.BROADCAST_GROUP_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

// Переводит dateISO+timeMSK (московское время) в момент UTC — так можно
// сравнивать с Date.now() напрямую, без ручной арифметики над строками
// (которая ломается на переходе через полночь).
function parseMskDateTimeToUtcMs(dateISO, timeMSK) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateISO || '').trim());
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(String(timeMSK || '').trim());
  if (!dateMatch || !timeMatch) return null;

  const [, y, mo, d] = dateMatch;
  const [, h, mi] = timeMatch;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0) - MSK_OFFSET_MS;
}

const MONTH_NAMES_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
// Порядок соответствует Date#getUTCDay(): 0 = воскресенье.
const WEEKDAY_NAMES = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

// День/месяц/день недели на русском из dateISO. Дата интерпретируется как
// календарная (без времени и часового пояса) — день недели у конкретного
// y-m-d один и тот же независимо от таймзоны, поэтому Date.UTC тут достаточно.
function formatMskDateRu(dateISO) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateISO || '').trim());
  if (!match) return { day: '', month: '', weekday: '' };

  const [, y, mo, d] = match;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));

  return {
    day: String(Number(d)),
    month: MONTH_NAMES_GENITIVE[Number(mo) - 1] || '',
    weekday: WEEKDAY_NAMES[dt.getUTCDay()] || '',
  };
}

function formatReminderMessage(record) {
  const { day, month, weekday } = formatMskDateRu(record.dateISO);
  const isMeditation = String(record.kurs || '').trim() === 'медитация';
  const header = isMeditation ? 'Медитация' : `${record.kurs} курс прямая передача`;
  const link = record.zoomLink || record.groupLink || '';

  const lines = [
    `❣️${header}❣️`,
    'Через 20 минут начнется',
    '',
    `Сегодня ${day} ${month} ${weekday}`,
    `Начало в ${record.timeMSK} по мск`,
    '',
    'Приглашаем вас 🪽',
    '',
    'Можно без камеры, без звука, как вам комфортнее',
    '',
    'Присоединяйтесь, наслаждайтесь 🧉',
    '',
    'Ссылка на зум в этом чате 🙏🌱',
    link,
  ];
  if (record.zoomCode) {
    lines.push(`Код: ${record.zoomCode}`);
  }

  return lines.join('\n');
}

// Находит записи, до начала которых осталось 19-20 минут, и ещё не получившие
// напоминание. Помечает их reminderSent: true и сохраняет на диск СРАЗУ (до
// фактической отправки в Telegram) — если crontick сработает снова в ту же
// минуту или в течение следующей, это же напоминание не уйдёт повторно.
// Возвращает список найденных записей — caller сам решает, как их отправить.
function checkReminders(now = Date.now()) {
  const all = readAll();
  const { dateISO: todayMsk } = getNowMsk();

  const due = [];
  let changed = false;

  for (const record of all) {
    if (record.reminderSent) continue;
    if (!record.dateISO || !record.timeMSK) continue;
    if (record.dateISO < todayMsk) continue; // явная защита от прошедших дат (сбой/перезапуск)

    const startMs = parseMskDateTimeToUtcMs(record.dateISO, record.timeMSK);
    if (startMs === null) continue;

    const minutesUntilStart = (startMs - now) / 60000;
    if (minutesUntilStart >= 19 && minutesUntilStart <= 20) {
      record.reminderSent = true;
      changed = true;
      due.push(record);
    }
  }

  if (changed) {
    try {
      saveAll(all);
    } catch (err) {
      console.error('[reminders] не удалось сохранить reminderSent (volume недоступен?):', err.message);
    }
  }

  return due;
}

module.exports = {
  parseMskDateTimeToUtcMs,
  formatMskDateRu,
  formatReminderMessage,
  checkReminders,
  getBroadcastGroupIds,
};
