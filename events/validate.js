const { PROGRAMS, FORMATS } = require('./constants');

// program и format обязательны всегда; дата/время обязательны, если формат
// не "recording" (для записи дата не всегда известна/важна); город
// обязателен только для offline.
function validateEvent(e) {
  const missing = [];

  if (!PROGRAMS.includes(e.program)) {
    missing.push(`программа (одна из: ${PROGRAMS.join(', ')})`);
  }

  if (!FORMATS.includes(e.format)) {
    missing.push('формат (online / offline / recording)');
  }

  if (e.format && e.format !== 'recording') {
    const hasAz = e.date_az && e.time_az;
    const hasMsk = e.date_msk && e.time_msk;
    if (!hasAz && !hasMsk) missing.push('дата и время события');
  }

  if (e.format === 'offline' && !String(e.city || '').trim()) {
    missing.push('город (для офлайн-события)');
  }

  return { valid: missing.length === 0, missing };
}

module.exports = { validateEvent };
