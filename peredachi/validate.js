const { formatDateRu } = require('./query');
const { extractInternalGroupId } = require('./groupLinks');

// Ссылка вида https://t.me/c/<id>/<номер> не открывается у тех, кто не
// состоит в группе — если для неё не нашлось соответствия в /группы (см.
// index.js), она остаётся такой же нерабочей внутренней ссылкой и не
// считается "рабочей" ссылкой для целей валидации.
function isUsableLink(link) {
  const trimmed = String(link || '').trim();
  if (!trimmed) return false;
  return !extractInternalGroupId(trimmed);
}

// Обязательные поля передачи: дата, время (МСК) и хотя бы одна рабочая ссылка
// (zoom или телеграм-группа) — без них некуда/непонятно когда идти.
// kurs и teacher намеренно не обязательны.
function validateEntry(entry) {
  const missing = [];

  if (!String(entry.dateISO || '').trim()) missing.push('дата');
  if (!String(entry.timeMSK || '').trim()) missing.push('время');

  const hasLink = isUsableLink(entry.zoomLink) || isUsableLink(entry.groupLink);
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
