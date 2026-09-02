// Отдельная, ПАРАЛЛЕЛЬНАЯ система отслеживания "Assistance" (ассистентов по
// языкам перевода) — намеренно НЕ смешана с логикой Host из report.js, по
// явной просьбе Elena. Единственное, что переиспользуется оттуда — чисто
// генерические утилиты (CSV-парсинг, поиск заголовочных сегментов, разбор
// даты/времени, форматирование дат/диапазонов, HTML-экранирование, "прошло
// ли уже начало по Arizona", тот же bold+conditional-link для названия
// события) — ничего специфичного для хостов (сравнение снимков, hasHost,
// диф-уведомления) сюда не попадает и это не трогает.
//
// Касается ТОЛЬКО вкладки ACI | V Houses — у остальных вкладок нет
// структуры "11-12 языков × Interpreter/Assistance/REC&BK" на каждое
// событие.

const {
  loadConfig,
  parseCsv,
  findHeaderSegments,
  parseDateFromText,
  parseTimeToMinutes,
  csvUrl,
  fetchWithTimeout,
  normalize,
  programLine,
  deriveMsk,
  mskDate,
  formatMonthDayEn,
  formatMonthDayRu,
  formatWeekRangeEn,
  formatWeekRangeRu,
  formatRange12h,
  formatRange24h,
  escapeHtml,
  isPastAzStart,
  formatProgramNameHtml,
  getCurrentWeekRange,
} = require('./report');

const V_HOUSES_GID = '1153396063';

function getVHousesTab() {
  const config = loadConfig();
  const tab = config.tabs.find((t) => t.gid === V_HOUSES_GID);
  if (!tab) throw new Error(`ACI | V Houses (gid ${V_HOUSES_GID}) не найдена в tabs-config.json`);
  return { spreadsheetId: config.spreadsheetId, tab };
}

// Каждая языковая группа на этой вкладке — 4 колонки подряд (ярлык вида
// "RUS (+3 UTC)", Interpreter, Assistance, REC & BK), повторяется по разу
// на язык сразу после фиксированных колонок Host-строки (Host/Co-Host/
// Check Mics/Admin INT/MC/...). Определяется заново на каждом сегменте, а
// не по жёстко заданному смещению колонок — у этой же вкладки два уже
// встреченных сегмента даже не совпадают по числу строк между строкой с
// названиями языков и строкой с колонками Assistance (см. report.js —
// findHeaderSegments не раз ловил именно такие расхождения между блоками
// одной вкладки).
function findAssistanceColumns(rows, headerRowIndex) {
  const hostRow = rows[headerRowIndex];
  const assistanceCols = [];
  for (let c = 0; c < hostRow.length; c++) {
    if (normalize(hostRow[c]).toLowerCase() === 'assistance') assistanceCols.push(c);
  }
  if (assistanceCols.length === 0) return [];

  // Строка с реальными кодами языков ("RUS (+3 UTC)", "CHN (+8 UTC)", ...)
  // лежит где-то выше Host-строки, но на разном расстоянии в разных
  // сегментах. Единственный устойчивый якорь, встреченный в обоих
  // сегментах этой вкладки — ячейка "ENG" прямо перед первой языковой
  // группой; ищем её, а не полагаемся на фиксированное смещение строк.
  // Начинаем поиск С САМОЙ Host-строки (включительно) — в одном из уже
  // встреченных сегментов ENG и Host оказались в одной и той же строке.
  let namesRow = null;
  for (let r = headerRowIndex; r >= Math.max(0, headerRowIndex - 6); r--) {
    if (rows[r].some((cell) => normalize(cell).toUpperCase() === 'ENG')) {
      namesRow = rows[r];
      break;
    }
  }
  if (!namesRow) return [];

  return assistanceCols
    .map((col) => {
      // Ярлык языка стоит в первой колонке своей группы из 4-х и пуст в
      // остальных трёх — идём влево до ближайшей непустой ячейки, затем
      // отрезаем хвост вида "(+N UTC)" для чистого короткого кода.
      let language = '';
      for (let c = col; c >= 0; c--) {
        const v = normalize(namesRow[c]);
        if (v) {
          language = v.replace(/\s*\([^)]*\)\s*$/, '').trim();
          break;
        }
      }
      return { col, language };
    })
    .filter((entry) => entry.language);
}

function parseAssistanceEvents(rows, tabName) {
  const segments = findHeaderSegments(rows, tabName);
  const events = [];

  for (const seg of segments) {
    const assistanceCols = findAssistanceColumns(rows, seg.headerRowIndex);
    if (assistanceCols.length === 0) continue;

    let lastKnownDate = null;
    for (let r = seg.headerRowIndex + 1; r < seg.endRowIndex; r++) {
      const row = rows[r];
      const title = normalize(row[seg.titleCol]);
      const azStartMin = parseTimeToMinutes(row[seg.azCol]);
      const azEndMin = parseTimeToMinutes(row[seg.azEndCol]);

      let date = parseDateFromText(title) || parseDateFromText(row[seg.dateCol]);
      if (date) {
        lastKnownDate = date;
      } else if (azStartMin !== null && azEndMin !== null && lastKnownDate) {
        date = lastKnownDate;
      }
      if (!date || azStartMin === null || azEndMin === null) continue;

      const mskStart = deriveMsk(azStartMin);
      const mskEnd = deriveMsk(azEndMin);

      const languages = assistanceCols.map(({ col, language }) => {
        const assistant = normalize(row[col]);
        return { language, hasAssistant: assistant.length > 0, assistant };
      });

      events.push({
        tabName: seg.programLabel,
        title,
        date,
        azStartMin,
        azEndMin,
        mskStartMin: mskStart.min,
        mskStartDayOffset: mskStart.dayOffset,
        mskEndMin: mskEnd.min,
        languages,
      });
    }
  }

  return events;
}

async function fetchAssistanceEvents() {
  const { spreadsheetId, tab } = getVHousesTab();
  const url = csvUrl(spreadsheetId, tab.gid);
  const res = await fetchWithTimeout(url, 25000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);
  const events = parseAssistanceEvents(rows, tab.name);
  const tabUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?gid=${tab.gid}#gid=${tab.gid}`;
  return events.map((e) => ({ ...e, tabUrl }));
}

function inRange(date, start, end) {
  return date >= start && date <= end;
}

// ---- сборка сообщения ----

function languageLineEn(entry) {
  const lang = escapeHtml(entry.language);
  return entry.hasAssistant ? `✅ ${lang}: ${escapeHtml(entry.assistant)}` : `‼️ ${lang}: assistant needed`;
}

function languageLineRu(entry) {
  const lang = escapeHtml(entry.language);
  return entry.hasAssistant ? `✅ ${lang}: ${escapeHtml(entry.assistant)}` : `‼️ ${lang}: нужен ассистент`;
}

// Вызывается только для событий, где хотя бы один язык без ассистента (см.
// needsAssistant в buildAssistanceMessage) — поэтому название события
// всегда со ссылкой (formatProgramNameHtml(..., false)), никогда не
// "полностью закрыто" здесь.
function assistanceEventBlockEn(e) {
  return [
    formatProgramNameHtml(programLine(e.tabName, e.title), e.tabUrl, false),
    `🕒 Arizona: ${formatMonthDayEn(e.date)}, ${formatRange12h(e.azStartMin, e.azEndMin)}`,
    `🕒 Moscow: ${formatMonthDayEn(mskDate(e))}, ${formatRange12h(e.mskStartMin, e.mskEndMin)}`,
    ...e.languages.map(languageLineEn),
  ].join('\n');
}

function assistanceEventBlockRu(e) {
  return [
    formatProgramNameHtml(programLine(e.tabName, e.title), e.tabUrl, false),
    `🕒 Аризона: ${formatMonthDayRu(e.date)}, ${formatRange24h(e.azStartMin, e.azEndMin)}`,
    `🕒 Москва: ${formatMonthDayRu(mskDate(e))}, ${formatRange24h(e.mskStartMin, e.mskEndMin)}`,
    ...e.languages.map(languageLineRu),
  ].join('\n');
}

// /ассистенты — с пометкой RETRANSLATION/РЕТРАНСЛЯЦИЯ в начале (чтобы не
// путать с host-уведомлениями), двуязычно, по текущей Bali-неделе.
// Полностью укомплектованные события не показываются вовсе — та же
// философия "показывать только то, что требует внимания", что у /check —
// но, в отличие от /check, у каждого показанного события выводятся ВСЕ
// языки с их статусом (✅ имя или ‼️ нужен), а не только пробелы, чтобы
// сразу было видно, кто уже закрывает язык, а кого ещё искать.
function buildAssistanceMessage(events, range, now) {
  const rangeEn = formatWeekRangeEn(range.start, range.end);
  const rangeRu = formatWeekRangeRu(range.start, range.end);

  const inRangeEvents = events.filter((e) => inRange(e.date, range.start, range.end) && !isPastAzStart(e, now));
  const needsAssistant = inRangeEvents.filter((e) => e.languages.some((l) => !l.hasAssistant));

  if (needsAssistant.length === 0) {
    const enBlock = `📝 RETRANSLATION — All assistant slots for ${rangeEn} are covered! ✅`;
    const ruBlock = `📝 РЕТРАНСЛЯЦИЯ — Все места ассистентов на неделю ${rangeRu} закрыты! ✅`;
    return [enBlock, ruBlock].join('\n\n');
  }

  const enBody = needsAssistant.map(assistanceEventBlockEn).join('\n\n');
  const ruBody = needsAssistant.map(assistanceEventBlockRu).join('\n\n');

  const enBlock = [`📝 RETRANSLATION — ‼️NEEDED ASSISTANTS for this week, ${rangeEn}`, '', enBody].join('\n');
  const ruBlock = [`📝 РЕТРАНСЛЯЦИЯ — ‼️НУЖНЫ АССИСТЕНТЫ на эту неделю, ${rangeRu}`, '', ruBody].join('\n');

  return [enBlock, ruBlock].join('\n\n');
}

// Ручной /ассистенты — всегда текущая Bali-неделя, та же логика "текущая
// неделя = неделя с сегодняшней датой", что у /check.
async function generateAssistanceReport(now = new Date()) {
  const range = getCurrentWeekRange(now);
  const events = await fetchAssistanceEvents();
  const text = buildAssistanceMessage(events, range, now);
  return { text, range };
}

module.exports = {
  fetchAssistanceEvents,
  parseAssistanceEvents,
  buildAssistanceMessage,
  generateAssistanceReport,
};
