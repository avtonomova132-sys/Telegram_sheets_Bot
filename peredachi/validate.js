const { formatDateRu } = require('./query');

// Обязательные поля передачи: дата, время (МСК) и хотя бы одна ссылка
// (zoom или телеграм-группа) — без них некуда/непонятно когда идти.
// kurs и teacher намеренно не обязательны.
function validateEntry(entry) {
  const missing = [];

  if (!String(entry.dateISO || '').trim()) missing.push('дата');
  if (!String(entry.timeMSK || '').trim()) missing.push('время');

  const hasLink = String(entry.zoomLink || '').trim() || String(entry.groupLink || '').trim();
  if (!hasLink) missing.push('ссылка на zoom или группу');

  return { valid: missing.length === 0, missing };
}

// Короткая подпись для невалидной записи в отчёте пользователю —
// использует то, что удалось распознать, даже если запись неполная.
function describeEntry(entry) {
  if (entry.dateISO) return `передача ${formatDateRu(entry.dateISO)}`;
  if (entry.teacher) return entry.teacher;
  if (entry.zanyatie) return entry.zanyatie.slice(0, 40);
  if (entry.kurs) return `курс ${entry.kurs}`;
  return 'запись без даты';
}

module.exports = { validateEntry, describeEntry };
