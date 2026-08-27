// Шесть времён напоминаний по Бали — подтверждено Elena. Если расписание
// понадобится поменять, достаточно поправить только этот массив: остальной
// код обращается только к SLOTS, hardcoded времён больше нигде нет.
const SLOTS = [
  { index: 1, hour: 7, minute: 0 },
  { index: 2, hour: 9, minute: 30 },
  { index: 3, hour: 12, minute: 0 },
  { index: 4, hour: 14, minute: 30 },
  { index: 5, hour: 17, minute: 0 },
  { index: 6, hour: 19, minute: 30 },
];

// Сколько времени слот "живой" и ждёт ответа сразу (момент осознанности).
// После этого — тихо становится "пропущенным", не держит очередь, и
// попадает в вечерний список вместо того, чтобы висеть в ожидании весь день.
const PENDING_WINDOW_MINUTES = 30;

// Когда вечером прилетает список пропущенных за день слотов — уже после
// последнего слота (19:30), с запасом.
const EVENING_SUMMARY = { hour: 21, minute: 45 };

// "Сейчас" в минутах от полуночи по Бали (Asia/Makassar, UTC+8, без DST) —
// тот же фиксированный сдвиг, что и в verse/progress.js (baliHour), только
// сразу с минутами, чтобы сравнивать с получасовыми слотами.
function baliMinutesNow(d = new Date()) {
  const bali = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return bali.getUTCHours() * 60 + bali.getUTCMinutes();
}

function slotMinutes(slot) {
  return slot.hour * 60 + slot.minute;
}

function formatSlotTime(slot) {
  return `${String(slot.hour).padStart(2, '0')}:${String(slot.minute).padStart(2, '0')}`;
}

module.exports = {
  SLOTS,
  PENDING_WINDOW_MINUTES,
  EVENING_SUMMARY,
  baliMinutesNow,
  slotMinutes,
  formatSlotTime,
};
