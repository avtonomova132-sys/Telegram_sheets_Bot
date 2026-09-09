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
  loadCommunityTags,
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

      // Elena: each date in this block actually spans TWO physical rows —
      // the "light" row read above (date/time/host) and a "gray" row
      // directly below it that can ALSO carry an Assistance name for any
      // of the 7 languages (found for UKR and CHN on 9 & 16 Sep — the
      // light row's cell was blank but the assistant was really there,
      // just recorded one row down). Only treated as THIS event's
      // continuation when it has no date/time of its own — otherwise
      // it's simply the next real event row, not a continuation.
      const nextRow = rows[r + 1];
      const nextIsContinuation =
        Boolean(nextRow) &&
        !parseDateFromText(nextRow[seg.dateCol]) &&
        parseTimeToMinutes(nextRow[seg.azCol]) === null;

      const mskStart = deriveMsk(azStartMin);
      const mskEnd = deriveMsk(azEndMin);

      const languages = assistanceCols.map(({ col, language }) => {
        const primary = normalize(row[col]);
        const secondary = nextIsContinuation ? normalize(nextRow[col]) : '';
        const assistant = primary || secondary;
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

// Elena: рядом с именем ассистента — @tag, если он известен. Два
// источника, в порядке доверия:
// 1) та же ячейка формата "Имя @хендл" ГДЕ-ТО ЕЩЁ в этой же вкладке —
//    волонтёры и так иногда подписываются так в других сегментах того же
//    документа (напр. "My Lan @MyLan0608", "An Le @lethanhan" — оба
//    реально встречаются на этой вкладке, просто не в нашем блоке).
// 2) общий список тегов сообщества (community-tags.json, тот же, что и
//    для тегов хостов в /check) — только если И имя, И фамилия из ячейки
//    ассистента целиком совпадают со словами внутри тега, не частично —
//    чтобы не подставить чужой тег по ошибке.
// Если нигде не нашли — просто имя без тега, как записано в таблице
// ассистентов (явный fallback, как и просила Elena).
const NAME_TAG_PATTERN = /^(.+?)\s+(@[A-Za-z0-9_.]+)$/;

function buildNameTagMap(rows) {
  const map = new Map();
  for (const row of rows) {
    for (const cell of row) {
      const m = normalize(cell).match(NAME_TAG_PATTERN);
      if (m) {
        const key = normalize(m[1]).toLowerCase();
        if (key && !map.has(key)) map.set(key, m[2]);
      }
    }
  }
  return map;
}

function findCommunityTag(name, communityTags) {
  const nameWords = normalize(name).toLowerCase().split(/\s+/).filter(Boolean);
  if (nameWords.length < 2) return null;
  for (const tag of communityTags) {
    const tagWords = tag
      .replace(/^@/, '')
      .split(/[_\d]+/)
      .map((w) => w.toLowerCase())
      .filter(Boolean);
    if (nameWords.every((w) => tagWords.includes(w))) return tag;
  }
  return null;
}

function findTagForName(name, nameTagMap, communityTags) {
  const key = normalize(name).toLowerCase();
  return nameTagMap.get(key) || findCommunityTag(name, communityTags) || null;
}

async function fetchSeriesAssistanceEvents() {
  const { spreadsheetId, gid } = getSeriesTab();
  const url = csvUrl(spreadsheetId, gid);
  const res = await fetchWithTimeout(url, 25000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);
  const events = parseSeriesAssistanceEvents(rows, SERIES_TAB_NAME);

  const nameTagMap = buildNameTagMap(rows);
  const communityTags = loadCommunityTags();
  for (const e of events) {
    for (const lang of e.languages) {
      lang.tag = lang.hasAssistant ? findTagForName(lang.assistant, nameTagMap, communityTags) : null;
    }
  }

  const tabUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?gid=${gid}#gid=${gid}`;
  return events.map((e) => ({ ...e, tabUrl }));
}

function inRange(date, start, end) {
  return date >= start && date <= end;
}

function languageLineEn(entry) {
  const lang = escapeHtml(entry.language);
  if (!entry.hasAssistant) return `‼️ ${lang}: assistant needed`;
  const tagPart = entry.tag ? ` [${escapeHtml(entry.tag)}]` : '';
  return `✅ ${lang}: ${escapeHtml(entry.assistant)}${tagPart}`;
}

function languageLineRu(entry) {
  const lang = escapeHtml(entry.language);
  if (!entry.hasAssistant) return `‼️ ${lang}: нужен ассистент`;
  const tagPart = entry.tag ? ` [${escapeHtml(entry.tag)}]` : '';
  return `✅ ${lang}: ${escapeHtml(entry.assistant)}${tagPart}`;
}

// Elena: ВСЕГДА показывать полный список — имя каждого назначенного
// ассистента по каждому языку с ✅ (и тегом, если нашёлся), а не
// сворачивать в короткое "Hooray" при полном покрытии — люди могли
// записаться неделю назад и забыть, важно увидеть своё имя рядом с
// датой. Hooray/Ура остаётся, но ИДЁТ ПОСЛЕ полного списка, как
// заключительная фраза-подтверждение, а не вместо списка.
function eventBlockEn(e) {
  const allCovered = e.languages.every((l) => l.hasAssistant);
  const lines = [
    formatProgramNameHtml(programLine(e.tabName, e.title), e.tabUrl, allCovered),
    `🕒 Arizona: ${formatMonthDayEn(e.date)}, ${formatRange12h(e.azStartMin, e.azEndMin)}`,
    `🕒 Moscow: ${formatMonthDayEn(mskDate(e))}, ${formatRange12h(e.mskStartMin, e.mskEndMin)}`,
    '',
    ...e.languages.map(languageLineEn),
  ];
  if (allCovered) {
    lines.push(
      '',
      '🙏 Please everyone double-check — if your plans changed, let us know in advance.',
      '🎉 Hooray! All assistant roles for this session are covered.'
    );
  }
  return lines.join('\n');
}

function eventBlockRu(e) {
  const allCovered = e.languages.every((l) => l.hasAssistant);
  const lines = [
    formatProgramNameHtml(programLine(e.tabName, e.title), e.tabUrl, allCovered),
    `🕒 Аризона: ${formatMonthDayRu(e.date)}, ${formatRange24h(e.azStartMin, e.azEndMin)}`,
    `🕒 Москва: ${formatMonthDayRu(mskDate(e))}, ${formatRange24h(e.mskStartMin, e.mskEndMin)}`,
    '',
    ...e.languages.map(languageLineRu),
  ];
  if (allCovered) {
    lines.push(
      '',
      '🙏 Пожалуйста, каждый проверьте — если планы изменились, дайте знать заранее.',
      '🎉 Ура! Все роли ассистентов на этот эфир назначены.'
    );
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
