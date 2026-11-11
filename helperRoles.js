// «Календарь помощников» (/helpers): роли помощников одного эфира из строк таблицы WVP.
// Чистые функции без зависимостей — report.js вызывает extractRoles из parseTabEvents
// (только когда его просят: opts.withRoles), поэтому остальной бот этих данных не видит.
//
// Как устроена таблица (вкладка программы): строка-шапка с «Host» (seg.headerRowIndex),
// над ней строка с названиями блоков стран («ENG», «RUS (+3 UTC)», «CH 12:00 (+8 UTC)»…).
// Блок «Class» — Host, Co-Host, Admin INT, MC; блок страны — Interpreter, Contact,
// Assistance, REC & BK (у ENG — только REC & BK). Роли находим по ТЕКСТУ заголовков, не по
// номерам столбцов. У каждого эфира два места на роль: строка эфира (основное) и строка
// сразу под ней без даты/времени/названия (запасное, жёлтая) — берём имена из обеих.

const clean = (cell) => String(cell || '').replace(/\s+/g, ' ').trim();
const norm = (cell) => clean(cell).toLowerCase();

// «#REF!», «#N/A», «-» — не имя.
function nameOf(cell) {
  const v = clean(cell);
  if (!v || /^#(ref|n\/a|value|name|div\/0)/i.test(v) || /^[-–—]+$/.test(v)) return '';
  return v;
}

// «RUS (+3 UTC)» → RUS; «CH 12:00 (+8 UTC)» → CHN; «IDN Central (+7 UTC )» → IDN; «ENG» → ENG.
// Block name = 3 capital letters (or «CH») at the start, and either nothing else or a UTC offset —
// so a person's name in a stray cell («Eric», «ANH Dao») or a time column («MSK (UTC+3)») is not a country.
const NOT_COUNTRY = new Set(['MSK', 'UTC', 'MST', 'CET', 'CEST', 'EST', 'PST', 'AZ']);
function countryCode(label) {
  const text = clean(label);
  const m = text.match(/^([A-Z]{3}|CH)(?![A-Za-z])/);
  if (!m || NOT_COUNTRY.has(m[1])) return null;
  if (text.length > 3 && !/utc/i.test(text)) return null;
  return m[1] === 'CH' ? 'CHN' : m[1];
}

function isRecHeader(h) {
  return (h.startsWith('rec') || h.startsWith('recorder')) && h.includes('bk');
}

// The row above the header that carries the country block names (≥2 country-like cells).
function findLabelRow(rows, headerRowIndex) {
  for (let k = 1; k <= 3 && headerRowIndex - k >= 0; k++) {
    const row = rows[headerRowIndex - k] || [];
    const codes = row.map(countryCode).filter(Boolean);
    if (codes.length >= 2) return row;
  }
  return null;
}

// Is the row under a session a continuation (backup places), not another session?
function isContinuation(row, seg) {
  if (!row) return false;
  return !clean(row[seg.dateCol]) && !clean(row[seg.azCol]) && !clean(row[seg.titleCol]);
}

function extractRoles(rows, seg, r) {
  const header = rows[seg.headerRowIndex] || [];
  const labels = findLabelRow(rows, seg.headerRowIndex);
  const main = rows[r] || [];
  const next = r + 1 < seg.endRowIndex && isContinuation(rows[r + 1], seg) ? rows[r + 1] : null;
  const places = (c) => [nameOf(main[c]), next ? nameOf(next[c]) : ''];
  // Cell of each place in A1 notation (sheet row = index + 1): the session row and, when there is one,
  // the continuation row under it — for the «sign up» links of the /helpers page.
  const letter = (c) => {
    let n = c + 1;
    let s = '';
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };
  const refs = (c) => [`${letter(c)}${r + 1}`, next ? `${letter(c)}${r + 2}` : ''];

  const roles = { class: {}, countries: {}, refs: { class: {}, countries: {} } };
  let classEnd = -1;
  header.forEach((cell, c) => {
    const h = norm(cell);
    if (h === 'co-host' || h === 'cohost') roles.class.coHost = places(c);
    else if (h.startsWith('admin')) roles.class.adminInt = places(c);
    else if (h === 'mc') {
      roles.class.mc = places(c);
      roles.refs.class.mc = refs(c);
      classEnd = c;
    }
  });

  if (!labels) return roles;
  // Nearest block name at or before the column.
  const blockOf = (c) => {
    for (let k = c; k >= 0; k--) {
      const code = countryCode(labels[k]);
      if (code) return code;
      if (k <= classEnd) return null;
    }
    return null;
  };
  header.forEach((cell, c) => {
    if (c <= classEnd) return;
    const h = norm(cell);
    const kind = h === 'assistance' ? 'assistance' : isRecHeader(h) ? 'rec' : null;
    if (!kind) return;
    const code = blockOf(c);
    if (!code) return;
    roles.countries[code] = roles.countries[code] || {};
    roles.countries[code][kind] = places(c);
    roles.refs.countries[code] = roles.refs.countries[code] || {};
    roles.refs.countries[code][kind] = refs(c);
  });
  return roles;
}

module.exports = { extractRoles, countryCode, nameOf };
