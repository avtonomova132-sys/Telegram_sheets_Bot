// Отдельная, ПАРАЛЛЕЛЬНАЯ фича — суточный мониторинг вкладки "2026 Programs"
// (мастер-список всех программ проекта, ведёт Настя), gid 873833331. По
// явной просьбе Elena НЕ пересекается с host-tracking (report.js,
// tabs-config.json/daily-check-tabs.json, MONITORED_TABS и всё, что с ним
// связано) ни данными, ни кодом — переиспользует из report.js только
// чисто генерические утилиты (CSV-парсинг, HTML-экранирование, fetch),
// как уже сделано для assistance.js.

const fs = require('fs');
const path = require('path');
const { loadConfig, csvUrl, fetchWithTimeout, parseCsv, normalize, escapeHtml } = require('./report');

const PROGRAMS_TAB_GID = '873833331';
const STATE_PATH = process.env.PROGRAMS_WATCH_STATE_PATH || '/data/programs_watch_state.json';

// No `rows` key in the fallback (on purpose) — it's how checkForNewPrograms
// tells "never run before, seed silently" apart from "ran before and the
// tab genuinely had zero rows that time". Every real write below always
// includes `rows`, even an empty object, so this only ever fires once.
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { lastRunDate: null };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmpPath = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, STATE_PATH);
}

function getProgramsWatchLastRunDate() {
  return readState().lastRunDate;
}

function markProgramsWatchChecked(dateStr) {
  const state = readState();
  writeState({ ...state, lastRunDate: dateStr });
}

// Вкладка сама не подписывает колонку с аббревиатурой (DCC/BSF/ACI) —
// заголовочная ячейка "Program" сидит на 2 колонки правее, над колонкой с
// ПОЛНЫМ названием программы, а Dates/Teacher/Producer/Producer Contact/
// Info Page идут сразу подряд после неё. Сверено вручную по живым данным
// вкладки (56 заполненных строк на момент проверки): в каждой строке
// аббревиатура и полное название лежат ровно в этом относительном
// расположении друг к другу, поэтому колонки ищутся от заголовка "Program",
// а не хардкодятся по индексу — та же защита от съехавшей структуры
// вручную редактируемого листа, что и в report.js.
function findColumns(rows) {
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      if (normalize(row[c]) === 'Program') {
        return {
          abbrevCol: c - 2,
          nameCol: c,
          datesCol: c + 1,
          teacherCol: c + 2,
          producerCol: c + 3,
          producerContactCol: c + 4,
          infoPageCol: c + 5,
        };
      }
    }
  }
  return null;
}

function parseProgramRows(rows) {
  const cols = findColumns(rows);
  if (!cols) {
    throw new Error('Не нашла колонку "Program" на вкладке 2026 Programs — структура вкладки изменилась?');
  }

  const programs = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const name = normalize(row[cols.nameCol]);
    if (!name) continue; // разделительные пустые строки между блоками
    programs.push({
      sheetRow: r + 1, // 1-индексация — совпадает с реальным номером строки в Google Таблице
      abbrev: normalize(row[cols.abbrevCol]),
      name,
      dates: normalize(row[cols.datesCol]),
      teacher: normalize(row[cols.teacherCol]),
      producer: normalize(row[cols.producerCol]),
      producerContact: normalize(row[cols.producerContactCol]),
      infoPage: normalize(row[cols.infoPageCol]),
    });
  }
  return programs;
}

async function fetchProgramRows() {
  const config = loadConfig();
  const url = csvUrl(config.spreadsheetId, PROGRAMS_TAB_GID);
  const res = await fetchWithTimeout(url, 25000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);
  return { spreadsheetId: config.spreadsheetId, programs: parseProgramRows(rows) };
}

// "Info Page" в этой таблице почти всегда оформлена как гиперссылка на
// тексте ("INFO PAGE - ACI 2 Ven Utpala"), а не как голый URL — а
// CSV-экспорт Google Таблиц отдаёт только отображаемый текст ячейки,
// настоящий адрес rich-text-ссылки через него не виден вообще (это
// ограничение самого экспорта, не наш парсинг). Поэтому ссылка на Info
// Page работает только если кто-то вставил URL как обычный текст; иначе —
// ведём на саму строку вкладки через range=A<row>, тот же формат ссылки,
// который даёт "Получить ссылку на диапазон" в самих Google Таблицах
// (открывает вкладку с выделенной нужной строкой).
function programRowUrl(spreadsheetId, program) {
  if (/^https?:\/\//i.test(program.infoPage)) return program.infoPage;
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?gid=${PROGRAMS_TAB_GID}&range=A${program.sheetRow}#gid=${PROGRAMS_TAB_GID}`;
}

function buildProgramUpdateMessage(program, spreadsheetId) {
  const url = programRowUrl(spreadsheetId, program);
  const titleText = program.abbrev ? `${program.abbrev} — ${program.name}` : program.name;
  const producerLine = program.producer
    ? `Продюсер: ${escapeHtml(program.producer)}${program.producerContact ? ` (${escapeHtml(program.producerContact)})` : ''}`
    : 'Продюсер: —';

  return [
    '⚠️ Table update / Обновление таблицы',
    '',
    `<a href="${url}">${escapeHtml(titleText)}</a>`,
    `Даты: ${escapeHtml(program.dates) || '—'}`,
    `Преподаватель: ${escapeHtml(program.teacher) || '—'}`,
    producerLine,
  ].join('\n');
}

// Идентичность строки — её собственный номер в таблице (1-индексация),
// не содержимое: Elena описала фичу как "появилась ли НОВАЯ строка", а
// список программ пополняется построчно снизу, а не переписывается —
// так что новый номер строки, которого не было во вчерашнем снимке, и
// есть ровно то новое, что нужно заметить. Изменение текста в уже
// известной строке этой фичей не отслеживается (не просили).
async function checkForNewPrograms() {
  const { spreadsheetId, programs } = await fetchProgramRows();
  const state = readState();
  // First run ever (no `rows` on record yet) — every existing row would
  // otherwise look "new" and fire off one message per program already in
  // the sheet (56+ of them). Seed the baseline silently instead; only a
  // row that appears AFTER this point is a genuine update.
  const isFirstRun = state.rows === undefined;
  const prevRows = state.rows || {};

  const newPrograms = isFirstRun ? [] : programs.filter((p) => !prevRows[p.sheetRow]);

  const nextRows = {};
  for (const p of programs) nextRows[p.sheetRow] = { name: p.name, dates: p.dates };
  writeState({ ...state, rows: nextRows });

  return newPrograms.map((p) => buildProgramUpdateMessage(p, spreadsheetId));
}

module.exports = {
  fetchProgramRows,
  parseProgramRows,
  checkForNewPrograms,
  buildProgramUpdateMessage,
  programRowUrl,
  getProgramsWatchLastRunDate,
  markProgramsWatchChecked,
};
