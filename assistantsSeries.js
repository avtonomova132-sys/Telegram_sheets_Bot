// Отдельная, самостоятельная команда — проверка ассистентов по языкам на
// вкладке "ACI | V Houses SERIES" (gid 24119706), блок "V Houses Weekly
// Community Meditation Watch Party" (еженедельные события по средам).
//
// НЕ путать с /ассистенты (assistance.js) — та команда смотрит на ДРУГУЮ,
// отдельную физическую вкладку (gid 1153396063, "ACI | V Houses"), у
// которой сейчас там же (в том же документе) совсем другое содержимое
// ("Six Flavors of Emptiness... with Sarahni Stumpf", не еженедельные
// V Houses-эфиры) и свой набор из 6 языков без GER (решение Elena от
// 5 сентября). Здесь источник данных — именно gid 24119706, который Elena
// подтвердила как актуальный для этой конкретной еженедельной серии, и
// набор языков — 7, включая GER.
//
// Как и assistance.js, переиспользует из report.js только чисто
// генерические утилиты (CSV-парсинг, поиск заголовочных сегментов,
// даты/время, HTML-экранирование, тот же bold+conditional-link для
// названия) — ничего host-специфичного сюда не попадает.

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

const SERIES_TAB_GID = '24119706';
const SERIES_TAB_NAME = 'ACI | V Houses SERIES';

// Elena: 7 языков для этой вкладки — RUS, CHN, SPA, UKR, GER, VIE, ROM.
// Осознанно ВКЛЮЧАЕТ GER, в отличие от /ассистенты (6 языков, без GER) —
// это два разных, независимых решения для двух разных вкладок.
const ALLOWED_LANGUAGES = new Set(['RUS', 'CHN', 'SPA', 'UKR', 'GER', 'VIE', 'ROM']);

function getSeriesTab() {
  const config = loadConfig();
  return { spreadsheetId: config.spreadsheetId, gid: SERIES_TAB_GID };
}

// Идентично findAssistanceColumns в assistance.js (тот же шаблон колонок
// на этой вкладке: 4 колонки на язык — время/MSK, Interpreter, Assistance,
// REC & BK — а имя языка лежит в отдельной "names row" выше, с "ENG" как
// якорем), только с собственным ALLOWED_LANGUAGES этой команды.
function findAssistanceColumns(rows, headerRowIndex) {
  const hostRow = rows[headerRowIndex];
  const assistanceCols = [];
  for (let c = 0; c < hostRow.length; c++) {
    if (normalize(hostRow[c]).toLowerCase() === 'assistance') assistanceCols.push(c);
  }
  if (assistanceCols.length === 0) return [];

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
    .filter((entry) => entry.language && ALLOWED_LANGUAGES.has(entry.language.toUpperCase()));
}

function parseSeriesAssistanceEvents(rows, tabName) {
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

async function fetchSeriesAssistanceEvents() {
  const { spreadsheetId, gid } = getSeriesTab();
  const url = csvUrl(spreadsheetId, gid);
  const res = await fetchWithTimeout(url, 25000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);
  const events = parseSeriesAssistanceEvents(rows, SERIES_TAB_NAME);
  const tabUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?gid=${gid}#gid=${gid}`;
  return events.map((e) => ({ ...e, tabUrl }));
}

function inRange(date, start, end) {
  return date >= start && date <= end;
}

function languageLineEn(entry) {
  const lang = escapeHtml(entry.language);
  return entry.hasAssistant ? `✅ ${lang}: ${escapeHtml(entry.assistant)}` : `‼️ ${lang}: assistant needed`;
}

function languageLineRu(entry) {
  const lang = escapeHtml(entry.language);
  return entry.hasAssistant ? `✅ ${lang}: ${escapeHtml(entry.assistant)}` : `‼️ ${lang}: нужен ассистент`;
}

// Elena: если у СОБЫТИЯ назначены ассистенты по ВСЕМ языкам — вместо
// построчного списка показываем короткое "Hooray/Ура" для этого события;
// если чего-то не хватает — обычный построчный список с ✅/‼️ по каждому
// языку, чтобы было видно, чего именно недостаёт.
function eventBlockEn(e) {
  const allCovered = e.languages.every((l) => l.hasAssistant);
  const lines = [
    formatProgramNameHtml(programLine(e.tabName, e.title), e.tabUrl, allCovered),
    `🕒 Arizona: ${formatMonthDayEn(e.date)}, ${formatRange12h(e.azStartMin, e.azEndMin)}`,
    `🕒 Moscow: ${formatMonthDayEn(mskDate(e))}, ${formatRange12h(e.mskStartMin, e.mskEndMin)}`,
  ];
  if (allCovered) {
    lines.push('🎉 Hooray! All assistant roles for this session are covered.');
  } else {
    lines.push(...e.languages.map(languageLineEn));
  }
  return lines.join('\n');
}

function eventBlockRu(e) {
  const allCovered = e.languages.every((l) => l.hasAssistant);
  const lines = [
    formatProgramNameHtml(programLine(e.tabName, e.title), e.tabUrl, allCovered),
    `🕒 Аризона: ${formatMonthDayRu(e.date)}, ${formatRange24h(e.azStartMin, e.azEndMin)}`,
    `🕒 Москва: ${formatMonthDayRu(mskDate(e))}, ${formatRange24h(e.mskStartMin, e.mskEndMin)}`,
  ];
  if (allCovered) {
    lines.push('🎉 Ура! Все роли ассистентов на этот эфир назначены.');
  } else {
    lines.push(...e.languages.map(languageLineRu));
  }
  return lines.join('\n');
}

// /check_assistants — та же общая структура, что у /check по хостам
// (двуязычно, EN затем RU, текущая Bali-неделя), но гранулярность —
// per-событие, а не единый список "кому нужен ассистент": у каждого
// события всегда показан либо полный чек-лист по языкам, либо Hooray,
// если по этому событию всё закрыто (см. eventBlockEn/Ru).
function buildSeriesCheckMessage(events, range, now) {
  const rangeEn = formatWeekRangeEn(range.start, range.end);
  const rangeRu = formatWeekRangeRu(range.start, range.end);

  const inRangeEvents = events
    .filter((e) => inRange(e.date, range.start, range.end) && !isPastAzStart(e, now))
    .sort((a, b) => a.date - b.date || a.azStartMin - b.azStartMin);

  if (inRangeEvents.length === 0) {
    const enBlock = `📝 Assistants — no V Houses Weekly sessions scheduled for this week, ${rangeEn}.`;
    const ruBlock = `📝 Ассистенты — на эту неделю (${rangeRu}) эфиров V Houses Weekly не запланировано.`;
    return [enBlock, ruBlock].join('\n\n');
  }

  const enBody = inRangeEvents.map(eventBlockEn).join('\n\n');
  const ruBody = inRangeEvents.map(eventBlockRu).join('\n\n');

  const enBlock = [`📝 Assistants for this week, ${rangeEn}`, '', enBody].join('\n');
  const ruBlock = [`📝 Ассистенты на эту неделю, ${rangeRu}`, '', ruBody].join('\n');

  return [enBlock, ruBlock].join('\n\n');
}

async function generateSeriesCheckReport(now = new Date()) {
  const range = getCurrentWeekRange(now);
  const events = await fetchSeriesAssistanceEvents();
  const text = buildSeriesCheckMessage(events, range, now);
  return { text, range };
}

module.exports = {
  fetchSeriesAssistanceEvents,
  parseSeriesAssistanceEvents,
  buildSeriesCheckMessage,
  generateSeriesCheckReport,
};
