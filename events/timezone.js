// Аризона (MST, UTC-7) не переходит на летнее время, Москва (MSK, UTC+3) —
// тоже, поэтому разница круглый год ровно 10 часов: MSK = AZ + 10.
// Пересчёт делается здесь в коде, а не запросом к модели — арифметика с
// переносом даты через полночь должна быть детерминированной, не угаданной.
function shiftTime(dateISO, timeHHMM, hoursDelta) {
  if (!dateISO || !timeHHMM) return { date: '', time: '' };
  const [y, m, d] = dateISO.split('-').map(Number);
  const [hh, mm] = timeHHMM.split(':').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, hh, mm));
  dt.setUTCHours(dt.getUTCHours() + hoursDelta);
  return { date: dt.toISOString().slice(0, 10), time: dt.toISOString().slice(11, 16) };
}

// Если модель распознала время только в одном поясе — досчитывает второй.
// Если оба уже есть (или оба отсутствуют, например для "recording") —
// не трогает ничего.
function fillTimezones(e) {
  const out = { ...e };
  const hasAz = out.date_az && out.time_az;
  const hasMsk = out.date_msk && out.time_msk;

  if (hasAz && !hasMsk) {
    const r = shiftTime(out.date_az, out.time_az, 10);
    out.date_msk = r.date;
    out.time_msk = r.time;
  } else if (hasMsk && !hasAz) {
    const r = shiftTime(out.date_msk, out.time_msk, -10);
    out.date_az = r.date;
    out.time_az = r.time;
  }

  return out;
}

module.exports = { shiftTime, fillTimezones };
