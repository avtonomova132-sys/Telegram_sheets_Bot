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

module.exports = { SLOTS, baliMinutesNow, slotMinutes, formatSlotTime };
