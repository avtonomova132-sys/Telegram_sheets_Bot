const { readAll, saveAll } = require('./store');
const { getNowMsk } = require('./query');

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000; // МСК = UTC+3 круглый год, без перехода на летнее/зимнее время

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

function kursLabel(kurs) {
  return String(kurs || '').trim() === 'медитация' ? 'Медитация' : `Курс ${kurs}`;
}

function formatReminderMessage(record) {
  const title = record.zanyatie ? `${kursLabel(record.kurs)} — ${record.zanyatie}` : kursLabel(record.kurs);
  const lines = [`🔔 Через 15 минут: ${title}`, `🕒 ${record.timeMSK} МСК`];
  if (record.zoomLink) lines.push(`🔗 ${record.zoomLink}`);
  if (record.groupLink) lines.push(`👥 ${record.groupLink}`);
  return lines.join('\n');
}

// Находит записи, до начала которых осталось 14-15 минут, и ещё не получившие
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
    if (minutesUntilStart >= 14 && minutesUntilStart <= 15) {
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

module.exports = { parseMskDateTimeToUtcMs, formatReminderMessage, checkReminders };
