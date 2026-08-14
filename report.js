const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'tabs-config.json');
const TAGS_PATH = path.join(__dirname, 'community-tags.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function loadCommunityTags() {
  try {
    return JSON.parse(fs.readFileSync(TAGS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function csvUrl(spreadsheetId, gid) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
}

// Minimal RFC4180 CSV parser — handles quoted fields with embedded commas,
// newlines and doubled "" escapes, which plain split(',') can't survive
// (session titles and header notes in this sheet contain both).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // skip, newline is handled below
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normalize(cell) {
  return (cell || '').replace(/\s+/g, ' ').trim();
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// A handful of tabs (e.g. the one Elena calls "DCC & GBOCS") aren't one
// program — they're several unrelated recurring programs stacked on the same
// physical sheet (Pramana, then a completely different Zoom series, then
// another), each introduced by its own single-cell title row followed by its
// own "ZOOM LINK'S:" / Host header block. Returns the row's text if it's
// exactly one non-empty cell AND looks like a real program title rather than
// a same-program divider like "January 2026" or "DAY 1" (both short, and
// neither introduces a genuinely different program).
function singleNonEmptyCellText(row) {
  let found = null;
  for (let c = 0; c < row.length; c++) {
    const v = normalize(row[c]);
    if (v) {
      if (found !== null) return null;
      found = v;
    }
  }
  return found;
}

function looksLikeProgramTitle(text) {
  if (!text || text.length < 15) return false;
  if (/^(day|group)\s*\d+/i.test(text)) return false;
  if (/^[A-Za-z]+\.?\s+\d{4}$/.test(text)) return false;
  if (/^(zoom link|recording folders?)/i.test(text)) return false;
  return true;
}

// Trailing "(Month DD[-DD], YYYY)"-style date range, already shown elsewhere
// in the message — trimmed off a detected title for a cleaner display name.
function cleanProgramLabel(text) {
  return normalize(text).replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// Each program tab has its own quirky, hand-edited header block, AND most
// tabs repeat that header block once per month as the sheet grows (a fresh
// "Data / AZ / MSK / Host / Co-Host / ..." row every ~50 rows). A version of
// this parser that only looked at the LAST such row — and started reading
// data right after it — silently dropped every earlier month's events,
// which is how a whole week of real August sessions went missing. So we
// find every row with an exact "Host" cell and treat each one as the start
// of its own segment, running until the next "Host" row (or EOF). Columns
// are re-detected per segment since a hand-edited sheet can't be trusted to
// keep the exact same layout in every monthly block.
//
// Segments also carry a `programLabel`: the configured tab name until (if
// ever) a second, genuinely different program title is detected further
// down the same sheet — from that point on, segments use the newly detected
// title instead, so multi-program tabs stop mislabeling every event under
// whichever program happened to be configured for that gid.
function findHeaderSegments(rows, fallbackLabel) {
  const headerRowIndices = [];
  const labelAtHeaderRow = [];
  let currentLabel = fallbackLabel;
  let firstTitleSeen = null;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];

    const titleText = singleNonEmptyCellText(row);
    if (titleText && looksLikeProgramTitle(titleText)) {
      const cleaned = cleanProgramLabel(titleText);
      if (firstTitleSeen === null) {
        firstTitleSeen = cleaned;
      } else if (cleaned !== firstTitleSeen) {
        currentLabel = cleaned;
      }
    }

    let localHostCol = -1;
    for (let c = 0; c < row.length; c++) {
      if (normalize(row[c]).toLowerCase() === 'host') {
        localHostCol = c;
        break;
      }
    }
    if (localHostCol === -1) continue;

    headerRowIndices.push(r);
    labelAtHeaderRow.push(currentLabel);
  }
  if (headerRowIndices.length === 0) return [];

  return headerRowIndices.map((headerRowIndex, i) => {
    const row = rows[headerRowIndex];
    let hostCol = -1;
    let coHostCol = -1;
    let azCol = -1;
    let mskCol = -1;
    for (let c = 0; c < row.length; c++) {
      const v = normalize(row[c]).toLowerCase();
      if (hostCol === -1 && v === 'host') hostCol = c;
      if (coHostCol === -1 && (v === 'co-host' || v === 'cohost')) coHostCol = c;
      if (azCol === -1 && v.includes('az') && (v.includes('utc-7') || v.includes('mst'))) azCol = c;
      if (mskCol === -1 && v.includes('msk')) mskCol = c;
    }
    const resolvedAzCol = azCol === -1 ? 2 : azCol;
    const endRowIndex = i + 1 < headerRowIndices.length ? headerRowIndices[i + 1] : rows.length;

    return {
      headerRowIndex,
      endRowIndex,
      dateCol: 1,
      titleCol: hostCol - 1,
      hostCol,
      coHostCol,
      azCol: resolvedAzCol,
      azEndCol: resolvedAzCol + 2,
      mskCol: mskCol === -1 ? 5 : mskCol,
      programLabel: labelAtHeaderRow[i],
    };
  });
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// The "Data" column's formatting is all over the place between tabs (day
// names, multi-line notes, missing years on continuation rows). Session
// titles almost always end with "(Mon DD, YYYY)" and are far more
// consistent, so we try that first and only fall back to the date cell.
function parseDateFromText(text) {
  if (!text) return null;
  const clean = text.replace(/\s+/g, ' ').trim();

  let m = clean.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(\d{4})/);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon !== undefined) return new Date(Date.UTC(Number(m[3]), mon, Number(m[2])));
  }

  m = clean.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?\s*,?\s*(\d{4})/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon !== undefined) return new Date(Date.UTC(Number(m[3]), mon, Number(m[1])));
  }

  return null;
}

// Returns minutes-since-midnight, tolerant of "06:30", "7:30 AM" and
// "14 May, 16:30" (date prefix is simply ignored by the regex).
function parseTimeToMinutes(text) {
  if (!text) return null;
  const m = text.match(/(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const ampm = m[3] ? m[3].toUpperCase() : null;
  if (ampm === 'AM') {
    if (hour === 12) hour = 0;
  } else if (ampm === 'PM') {
    if (hour !== 12) hour += 12;
  }
  return hour * 60 + minute;
}

// Arizona is fixed UTC-7 (no DST) and Moscow is fixed UTC+3 (no DST), so the
// gap between them is always exactly 10 hours. Deriving Moscow time from the
// Arizona column arithmetically is both simpler and more reliable than
// reading the sheet's own MSK column, which is sometimes just blank for a
// given month's block — and it also tells us for free whether the Moscow
// clock has rolled over to the next calendar day.
const AZ_TO_MSK_OFFSET_MIN = 600;

function deriveMsk(azMin) {
  if (azMin === null || azMin === undefined) return { min: null, dayOffset: 0 };
  const raw = azMin + AZ_TO_MSK_OFFSET_MIN;
  return { min: ((raw % 1440) + 1440) % 1440, dayOffset: Math.floor(raw / 1440) };
}

function parseTabEvents(tabName, rows) {
  const segments = findHeaderSegments(rows, tabName);
  const events = [];

  for (const seg of segments) {
    for (let r = seg.headerRowIndex + 1; r < seg.endRowIndex; r++) {
      const row = rows[r];
      const title = normalize(row[seg.titleCol]);
      if (!title) continue; // section dividers / continuation rows have no title

      const date = parseDateFromText(title) || parseDateFromText(row[seg.dateCol]);
      if (!date) continue;

      const host = normalize(row[seg.hostCol]);
      const coHost = seg.coHostCol !== -1 ? normalize(row[seg.coHostCol]) : '';
      const azStartMin = parseTimeToMinutes(row[seg.azCol]);
      const azEndMin = parseTimeToMinutes(row[seg.azEndCol]);

      const mskStart = deriveMsk(azStartMin);
      const mskEnd = azEndMin !== null ? deriveMsk(azEndMin) : { min: null, dayOffset: mskStart.dayOffset };

      events.push({
        tabName: seg.programLabel,
        title,
        host,
        coHost,
        hasHost: host.length > 0,
        date,
        azStartMin,
        azEndMin,
        mskStartMin: mskStart.min,
        mskStartDayOffset: mskStart.dayOffset,
        mskEndMin: mskEnd.min,
        mskEndDayOffset: mskEnd.dayOffset,
      });
    }
  }
  return events;
}

async function fetchTabEvents(spreadsheetId, tab) {
  const url = csvUrl(spreadsheetId, tab.gid);
  const res = await fetchWithTimeout(url, 25000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);
  return parseTabEvents(tab.name, rows);
}

// The week containing `now`, Monday to Sunday. Used by /check, which is
// meant to be run any day during the week that was already announced.
function getCurrentWeekRange(now = new Date()) {
  const day = now.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (day + 6) % 7;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 6));
  return { start, end };
}

// The week AFTER the one containing `now`, Monday to Sunday. Used by
// /weekly, meant to be run Sunday morning to announce the upcoming week.
function getNextWeekRange(now = new Date()) {
  const day = now.getUTCDay();
  const daysUntilNextMonday = ((1 - day + 7) % 7) || 7;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilNextMonday));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 6));
  return { start, end };
}

function inRange(date, start, end) {
  return date >= start && date <= end;
}

async function collectWeekEvents(range) {
  const config = loadConfig();
  const allEvents = [];
  const failedTabs = [];
  const debugCounts = [];

  await Promise.all(
    config.tabs.map(async (tab) => {
      try {
        const events = await fetchTabEvents(config.spreadsheetId, tab);
        const inRangeCount = events.filter((e) => inRange(e.date, range.start, range.end)).length;
        debugCounts.push({ name: tab.name, total: events.length, inRange: inRangeCount });
        allEvents.push(...events);
      } catch (err) {
        debugCounts.push({ name: tab.name, total: 0, inRange: 0, error: err.message });
        failedTabs.push(`${tab.name}: ${err.message}`);
      }
    })
  );

  const events = allEvents
    .filter((e) => inRange(e.date, range.start, range.end))
    .sort((a, b) => a.date - b.date || (a.azStartMin ?? 0) - (b.azStartMin ?? 0));

  const hostSignupUrl = `https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/edit?gid=${config.hostSignupGid}#gid=${config.hostSignupGid}`;

  return { events, failedTabs, hostSignupUrl, debugCounts };
}

function formatDebugCounts(debugCounts, range) {
  const lines = debugCounts.map((d) => {
    if (d.error) return `${d.name}: ошибка (${d.error})`;
    return `${d.name}: ${d.inRange} в диапазоне (всего в таблице: ${d.total})`;
  });
  return `🔍 Debug (${formatWeekRangeEn(range.start, range.end)}):\n${lines.join('\n')}`;
}

const WEEKDAYS_EN_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_EN_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS_RU_FULL = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const MONTHS_RU_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function formatEventDateEn(date) {
  return `${WEEKDAYS_EN_FULL[date.getUTCDay()]}, ${MONTHS_EN_FULL[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function formatEventDateRu(date) {
  return `${WEEKDAYS_RU_FULL[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS_RU_GENITIVE[date.getUTCMonth()]}`;
}

function formatWeeklyDateEn(date) {
  return `${MONTHS_EN_FULL[date.getUTCMonth()]} ${date.getUTCDate()} (${WEEKDAYS_EN_FULL[date.getUTCDay()]})`;
}

function formatWeeklyDateRu(date) {
  return `${date.getUTCDate()} ${MONTHS_RU_GENITIVE[date.getUTCMonth()]} (${WEEKDAYS_RU_FULL[date.getUTCDay()].toLowerCase()})`;
}

function formatMonthDayEn(date) {
  return `${MONTHS_EN_FULL[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function formatMonthDayShortEn(date) {
  return `${MONTHS_EN_FULL[date.getUTCMonth()].slice(0, 3)} ${date.getUTCDate()}`;
}

function formatMonthDayRu(date) {
  return `${date.getUTCDate()} ${MONTHS_RU_GENITIVE[date.getUTCMonth()]}`;
}

function formatWeekRangeEn(start, end) {
  const sameMonth = start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear();
  if (sameMonth) return `${MONTHS_EN_FULL[start.getUTCMonth()]} ${start.getUTCDate()}–${end.getUTCDate()}`;
  return `${MONTHS_EN_FULL[start.getUTCMonth()]} ${start.getUTCDate()} – ${MONTHS_EN_FULL[end.getUTCMonth()]} ${end.getUTCDate()}`;
}

function formatWeekRangeRu(start, end) {
  const sameMonth = start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear();
  if (sameMonth) return `${start.getUTCDate()}–${end.getUTCDate()} ${MONTHS_RU_GENITIVE[end.getUTCMonth()]}`;
  return `${start.getUTCDate()} ${MONTHS_RU_GENITIVE[start.getUTCMonth()]} – ${end.getUTCDate()} ${MONTHS_RU_GENITIVE[end.getUTCMonth()]}`;
}

function addDays(date, n) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + n));
}

function mskSuffixEn(e) {
  if (!e.mskStartDayOffset) return '';
  const d = addDays(e.date, e.mskStartDayOffset);
  return ` (${formatMonthDayShortEn(d)})`;
}

function mskSuffixRu(e) {
  if (!e.mskStartDayOffset) return '';
  const d = addDays(e.date, e.mskStartDayOffset);
  return ` (${formatMonthDayRu(d)})`;
}

function pad2(n) {
  return n.toString().padStart(2, '0');
}

function to12h(min) {
  const norm = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(norm / 60);
  const m = norm % 60;
  const period = h < 12 ? 'AM' : 'PM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return { h: h12, m, period };
}

function formatPoint12h(min) {
  if (min === null || min === undefined) return '—';
  const t = to12h(min);
  return `${t.h}:${pad2(t.m)} ${t.period}`;
}

function formatPoint24h(min) {
  if (min === null || min === undefined) return '—';
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

function formatRange12h(startMin, endMin) {
  if (startMin === null || startMin === undefined) return '—';
  const s = to12h(startMin);
  if (endMin === null || endMin === undefined) {
    return `${s.h}:${pad2(s.m)} ${s.period}`;
  }
  const e = to12h(endMin);
  const samePeriod = s.period === e.period;
  const sPart = samePeriod ? `${s.h}:${pad2(s.m)}` : `${s.h}:${pad2(s.m)} ${s.period}`;
  return `${sPart}–${e.h}:${pad2(e.m)} ${e.period}`;
}

function formatRange24h(startMin, endMin) {
  if (startMin === null || startMin === undefined) return '—';
  const sh = Math.floor(startMin / 60);
  const sm = startMin % 60;
  if (endMin === null || endMin === undefined) return `${pad2(sh)}:${pad2(sm)}`;
  const norm = ((endMin % 1440) + 1440) % 1440;
  const eh = Math.floor(norm / 60);
  const em = norm % 60;
  return `${pad2(sh)}:${pad2(sm)}–${pad2(eh)}:${pad2(em)}`;
}

const ACADEMIC_KEYWORDS = ['aci', 'pramana', 'teacher training', 'yoga studies', 'ysi'];

function programEmoji(tabName) {
  const lower = tabName.toLowerCase();
  return ACADEMIC_KEYWORDS.some((k) => lower.includes(k)) ? '🎓' : '💙';
}

// Strips the trailing "(Mon DD, YYYY)" (and anything after it, like
// "no translation") that almost every session title ends with, since the
// date is already shown on its own line.
function sessionLabel(title) {
  const m = title.match(/\([A-Za-z]{3,9}\.?\s+\d{1,2},?\s*\d{4}\)/);
  const cut = m ? title.slice(0, m.index) : title;
  return cut.trim().replace(/[-–—]\s*$/, '').trim();
}

function ruIsOneForm(n) {
  return n % 10 === 1 && n % 100 !== 11;
}

function ruFewForm(n) {
  const n10 = n % 10;
  const n100 = n % 100;
  return n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14);
}

function ruHostPhrase(n) {
  if (ruIsOneForm(n)) return `НУЖЕН ${n} ХОСТ`;
  return `НУЖНЫ ${n} ${ruFewForm(n) ? 'ХОСТА' : 'ХОСТОВ'}`;
}

function enHostPhrase(n) {
  return `NEEDED ${n} HOST${n === 1 ? '' : 'S'}`;
}

function ruBroadcastWord(n) {
  if (ruIsOneForm(n)) return 'эфир';
  return ruFewForm(n) ? 'эфира' : 'эфиров';
}

function ruMissingHeader(n) {
  if (ruIsOneForm(n)) return `${n} хост ещё не назначен — пожалуйста, откликнитесь!`;
  return `${n} ${ruFewForm(n) ? 'хоста' : 'хостов'} ещё не назначены — пожалуйста, откликнитесь!`;
}

function enMissingHeader(n) {
  return n === 1
    ? 'One host is still not assigned — please respond!'
    : `${n} hosts are still not assigned — please respond!`;
}

// ---- /check event blocks (only used for the "missing host" listing) ----

function checkEventBlockEn(e) {
  return [
    `🗓️ ${formatEventDateEn(e.date)}`,
    `${programEmoji(e.tabName)} ${e.tabName}`,
    `🕒 Arizona: ${formatRange12h(e.azStartMin, e.azEndMin)}`,
    `🕒 Moscow: ${formatRange12h(e.mskStartMin, e.mskEndMin)}`,
    '👤 Host: needed',
  ].join('\n');
}

function checkEventBlockRu(e) {
  return [
    `🗓️ ${formatEventDateRu(e.date)}`,
    `${programEmoji(e.tabName)} ${e.tabName}`,
    `🕒 Аризона: ${formatRange24h(e.azStartMin, e.azEndMin)}`,
    `🕒 Москва: ${formatRange24h(e.mskStartMin, e.mskEndMin)}`,
    '👤 Хост: нужен',
  ].join('\n');
}

// /check — only the events still missing a host; a short all-clear message
// if everything is covered.
function buildCheckMessage(events, range, hostSignupUrl, tags) {
  const missing = events.filter((e) => !e.hasHost);
  const rangeEn = formatWeekRangeEn(range.start, range.end);
  const rangeRu = formatWeekRangeRu(range.start, range.end);

  if (missing.length === 0) {
    const enBlock = [
      `📝🎉 Hooray! All Zoom sessions for ${rangeEn} are fully covered with hosts. ✅`,
      'The schedule has been updated. 🙏',
      'Thank you, everyone, for your generous service and support! 💙',
    ].join('\n\n');
    const ruBlock = [
      `📝🎉 Ура! На неделю ${rangeRu} все Zoom-эфиры с хостами. ✅`,
      'В табличке всё отмечено. 🙏',
      'Благодарим каждого за ваше щедрое служение и поддержку! 💙',
    ].join('\n\n');
    return [enBlock, ruBlock].join('\n\n');
  }

  const enBody = missing.map(checkEventBlockEn).join('\n\n');
  const ruBody = missing.map(checkEventBlockRu).join('\n\n');

  const enBlock = [
    `📝 🔥${enHostPhrase(missing.length)} for this week, ${rangeEn}`,
    '',
    enBody,
    '',
    '🙏 Thank you',
    '🌿',
  ].join('\n');

  const ruBlock = [
    `📝 🔥${ruHostPhrase(missing.length)} на эту неделю с ${rangeRu}.`,
    '',
    ruBody,
    '',
    '🙏 Спасибо',
    '🌿',
  ].join('\n');

  const parts = [enBlock, ruBlock];
  if (tags && tags.length > 0) parts.push(tags.join(' '));
  parts.push(hostSignupUrl);

  return parts.join('\n\n');
}

// ---- /weekly event blocks (every event, host or not) ----

function weeklyHostLineEn(e) {
  if (e.hasHost) {
    const co = e.coHost ? `, Co-Host: ${e.coHost}` : '';
    return `🌱👤 Host: ${e.host}${co}`;
  }
  return '🔥👤 Host: volunteer needed 🙏';
}

function weeklyHostLineRu(e) {
  if (e.hasHost) {
    const co = e.coHost ? `, Ко-хост: ${e.coHost}` : '';
    return `🌱👤 Хост: ${e.host}${co}`;
  }
  return '🔥👤 Хост: нужен волонтёр 🙏';
}

function weeklyEventBlockEn(e) {
  return [
    `📅 ${formatWeeklyDateEn(e.date)}`,
    `${programEmoji(e.tabName)} ${e.tabName} — ${sessionLabel(e.title)}`,
    `🕒 Arizona: ${formatRange12h(e.azStartMin, e.azEndMin)}`,
    `🕒 Moscow: ${formatRange24h(e.mskStartMin, e.mskEndMin)}${mskSuffixEn(e)}`,
    weeklyHostLineEn(e),
  ].join('\n');
}

function weeklyEventBlockRu(e) {
  return [
    `📅 ${formatWeeklyDateRu(e.date)}`,
    `${programEmoji(e.tabName)} ${e.tabName} — ${sessionLabel(e.title)}`,
    `🕒 Аризона: ${formatRange24h(e.azStartMin, e.azEndMin)}`,
    `🕒 Москва: ${formatRange24h(e.mskStartMin, e.mskEndMin)}${mskSuffixRu(e)}`,
    weeklyHostLineRu(e),
  ].join('\n');
}

function tabBreakdownEn(events) {
  const order = [];
  const counts = new Map();
  const missing = new Map();
  for (const e of events) {
    if (!counts.has(e.tabName)) {
      counts.set(e.tabName, 0);
      missing.set(e.tabName, false);
      order.push(e.tabName);
    }
    counts.set(e.tabName, counts.get(e.tabName) + 1);
    if (!e.hasHost) missing.set(e.tabName, true);
  }
  return order
    .map((name, i) => {
      const isLast = i === order.length - 1;
      const fire = missing.get(name) ? ' 🔥' : '';
      return `${counts.get(name)} from ${name}${fire}${isLast ? '.' : ','}`;
    })
    .join('\n');
}

function tabBreakdownRu(events) {
  const order = [];
  const counts = new Map();
  const missing = new Map();
  for (const e of events) {
    if (!counts.has(e.tabName)) {
      counts.set(e.tabName, 0);
      missing.set(e.tabName, false);
      order.push(e.tabName);
    }
    counts.set(e.tabName, counts.get(e.tabName) + 1);
    if (!e.hasHost) missing.set(e.tabName, true);
  }
  return order
    .map((name, i) => {
      const isLast = i === order.length - 1;
      const fire = missing.get(name) ? ' 🔥' : '';
      return `${counts.get(name)} — ${name}${fire}${isLast ? '.' : ','}`;
    })
    .join('\n');
}

function warningBlockEn(missing) {
  if (missing.length === 0) return '';
  const items = missing
    .map(
      (e) =>
        `${e.tabName},\n${formatMonthDayEn(e.date)}\nArizona: ${formatPoint12h(e.azStartMin)},\nMoscow: ${formatPoint24h(e.mskStartMin)}.`
    )
    .join('\n\n');
  return `⚠️ ${enMissingHeader(missing.length)}\n${items}`;
}

function warningBlockRu(missing) {
  if (missing.length === 0) return '';
  const items = missing
    .map(
      (e) =>
        `${e.tabName},\n${formatMonthDayRu(e.date)}\nАризона: ${formatPoint24h(e.azStartMin)},\nМосква: ${formatPoint24h(e.mskStartMin)}.`
    )
    .join('\n\n');
  return `⚠️ ${ruMissingHeader(missing.length)}\n${items}`;
}

function ctaLineEn(missing) {
  if (missing.length === 0) return '';
  if (missing.length === 1) {
    const e = missing[0];
    return `If anyone can host ${sessionLabel(e.title)} (${formatMonthDayShortEn(e.date)}) — please sign up via the link below 🙏`;
  }
  return 'If anyone can host one of the sessions above — please sign up via the link below 🙏';
}

function ctaLineRu(missing) {
  if (missing.length === 0) return '';
  if (missing.length === 1) {
    const e = missing[0];
    return `Если кто-то может провести «${sessionLabel(e.title)}» (${formatMonthDayRu(e.date)}) — пожалуйста, запишитесь по ссылке ниже 🙏`;
  }
  return 'Если вы можете провести одну из сессий выше — пожалуйста, запишитесь по ссылке ниже 🙏';
}

// /weekly — full listing of every event in the range, host or not.
function buildWeeklyMessage(events, range, hostSignupUrl) {
  const missing = events.filter((e) => !e.hasHost);
  const rangeEn = formatWeekRangeEn(range.start, range.end);
  const rangeRu = formatWeekRangeRu(range.start, range.end);

  const enSectionParts = ['📝', 'Precious Angels 🪽', '', 'Wishing everyone kindness and enlightenment in this life 💎', ''];
  const ruSectionParts = ['📝', 'Дорогие Ангелы 🪽', '', 'Желаем всем доброты и просветления в этой жизни 💎', ''];

  if (events.length === 0) {
    enSectionParts.push('Zoom broadcast schedule for the upcoming week', rangeEn, '', 'No sessions scheduled this week.');
    ruSectionParts.push('Расписание Zoom-эфиров на предстоящую неделю', rangeRu, '', 'На этой неделе нет запланированных сессий.');
  } else {
    enSectionParts.push(
      'Zoom broadcast schedule for the upcoming week',
      rangeEn,
      '',
      `In total, ${events.length} broadcast${events.length === 1 ? '' : 's'} this week:`,
      '',
      tabBreakdownEn(events)
    );
    ruSectionParts.push(
      'Расписание Zoom-эфиров на предстоящую неделю',
      rangeRu,
      '',
      `Всего на этой неделе ${events.length} ${ruBroadcastWord(events.length)}:`,
      '',
      tabBreakdownRu(events)
    );

    if (missing.length > 0) {
      enSectionParts.push('', warningBlockEn(missing));
      ruSectionParts.push('', warningBlockRu(missing));
    }

    enSectionParts.push('', events.map(weeklyEventBlockEn).join('\n\n'));
    ruSectionParts.push('', events.map(weeklyEventBlockRu).join('\n\n'));

    if (missing.length > 0) {
      enSectionParts.push('', ctaLineEn(missing));
      ruSectionParts.push('', ctaLineRu(missing));
    }
  }

  enSectionParts.push('', 'If anyone has any changes or needs help, please let us know in advance. 💛');
  ruSectionParts.push('', 'Если у кого-то есть изменения или нужна помощь — пожалуйста, сообщите заранее. 💛');

  const enSection = enSectionParts.join('\n');
  const ruSection = ruSectionParts.join('\n');

  return [enSection, '---', ruSection, hostSignupUrl].join('\n\n');
}

async function generateWeeklyReport(now = new Date()) {
  const range = getNextWeekRange(now);
  const { events, failedTabs, hostSignupUrl, debugCounts } = await collectWeekEvents(range);
  const text = buildWeeklyMessage(events, range, hostSignupUrl);
  return { text, range, totalEvents: events.length, failedTabs, debug: formatDebugCounts(debugCounts, range) };
}

async function generateCheckReport(now = new Date()) {
  const range = getCurrentWeekRange(now);
  const { events, failedTabs, hostSignupUrl, debugCounts } = await collectWeekEvents(range);
  const tags = loadCommunityTags();
  const text = buildCheckMessage(events, range, hostSignupUrl, tags);
  return { text, range, totalEvents: events.length, failedTabs, debug: formatDebugCounts(debugCounts, range) };
}

// Bali (Asia/Makassar) is a fixed UTC+8 zone, no DST — same shift-the-clock
// trick used for the verse schedule in verse/progress.js, kept independent
// here so the periodic host check reads "this week" the way a person in
// Bali would, regardless of what the container's own clock/timezone is.
const BALI_OFFSET_MS = 8 * 60 * 60 * 1000;

function baliNow(now = new Date()) {
  return new Date(now.getTime() + BALI_OFFSET_MS);
}

// The week containing `now`, Monday to Sunday, using the Bali calendar date
// rather than the server's/UTC's — used by the periodic auto-check so the
// day boundary matches Elena's own "today".
function getCurrentWeekRangeBali(now = new Date()) {
  const bali = baliNow(now);
  const day = bali.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const start = new Date(Date.UTC(bali.getUTCFullYear(), bali.getUTCMonth(), bali.getUTCDate() - daysSinceMonday));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 6));
  return { start, end };
}

// Which tabs the DAILY diff-check watches — deliberately a separate,
// short-listed file from tabs-config.json (used by /weekly and /check),
// since Elena is still confirming with her team whether a couple of tabs
// that do have dated events should ever be host-monitored at all. Only she
// adds to this list.
const DAILY_CHECK_TABS_PATH = path.join(__dirname, 'daily-check-tabs.json');

function loadDailyCheckTabs() {
  try {
    return JSON.parse(fs.readFileSync(DAILY_CHECK_TABS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

// Snapshot of the monitored tabs' current-week events (just host name +
// whether one's assigned, keyed by tab+date+start-time) — persisted on the
// Railway Volume so day N's run can be compared against day N-1's, the same
// pattern verse/progress.js uses for its own state.
const HOST_DIFF_STATE_PATH = process.env.HOST_DIFF_STATE_PATH || '/data/host_diff_state.json';

function readDiffState() {
  try {
    return JSON.parse(fs.readFileSync(HOST_DIFF_STATE_PATH, 'utf8'));
  } catch {
    return { lastRunDate: null, events: {} };
  }
}

function writeDiffState(state) {
  fs.mkdirSync(path.dirname(HOST_DIFF_STATE_PATH), { recursive: true });
  const tmpPath = `${HOST_DIFF_STATE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, HOST_DIFF_STATE_PATH);
}

function getHostDiffLastRunDate() {
  return readDiffState().lastRunDate;
}

// Date + start time alone (not the host) — stable identity for the same
// physical session across two different days' snapshots.
function eventKey(e) {
  return `${e.tabName}::${e.date.toISOString().slice(0, 10)}::${e.azStartMin}`;
}

function diffStamp(e) {
  return `${formatMonthDayRu(e.date)}, Аризона ${formatPoint24h(e.azStartMin)}, Москва ${formatPoint24h(e.mskStartMin)}`;
}

// Daily background diff-check (see index.js for the 9:00-Bali schedule) —
// only looks at the tabs in daily-check-tabs.json, only the current (Bali)
// week, and only ever DMs Elena when something actually changed since the
// last run: a previously-assigned host went missing, or a session that
// wasn't in yesterday's snapshot showed up. No news, no message — unlike
// /check, which always answers because she's the one asking.
async function runDailyHostDiffCheck(now = new Date(), { updateLastRunDate = false } = {}) {
  const config = loadConfig();
  const monitoredGids = new Set(loadDailyCheckTabs().map((t) => t.gid));
  const monitoredTabs = config.tabs.filter((t) => monitoredGids.has(t.gid));
  const range = getCurrentWeekRangeBali(now);

  const allEvents = [];
  const failedTabs = [];

  await Promise.all(
    monitoredTabs.map(async (tab) => {
      try {
        const events = await fetchTabEvents(config.spreadsheetId, tab);
        allEvents.push(...events.filter((e) => inRange(e.date, range.start, range.end)));
      } catch (err) {
        failedTabs.push(`${tab.name}: ${err.message}`);
      }
    })
  );

  const currentByKey = new Map(allEvents.map((e) => [eventKey(e), e]));
  const prevState = readDiffState();
  const prevEvents = prevState.events || {};

  const hostRemoved = [];
  const newEvents = [];
  for (const [key, e] of currentByKey) {
    const prev = prevEvents[key];
    if (!prev) {
      newEvents.push(e);
    } else if (prev.hasHost && !e.hasHost) {
      hostRemoved.push({ event: e, previousHost: prev.host });
    }
  }

  const snapshot = {};
  for (const [key, e] of currentByKey) {
    snapshot[key] = { host: e.host, hasHost: e.hasHost };
  }
  writeDiffState({
    lastRunDate: updateLastRunDate ? baliNow(now).toISOString().slice(0, 10) : prevState.lastRunDate,
    events: snapshot,
  });

  if (hostRemoved.length === 0 && newEvents.length === 0) {
    return { text: null, hostRemoved: 0, newEvents: 0, failedTabs };
  }

  const lines = [];
  for (const { event: e, previousHost } of hostRemoved) {
    lines.push(
      `⚠️ Хост убрал себя с эфира: ${e.tabName} — ${sessionLabel(e.title)}, ${diffStamp(e)}. Был назначен: ${previousHost}. Сейчас хост не назначен.`
    );
  }
  for (const e of newEvents) {
    const hostLabel = e.hasHost ? e.host : 'не назначен';
    lines.push(`🆕 Новый эфир в расписании: ${e.tabName} — ${sessionLabel(e.title)}, ${diffStamp(e)}, хост: ${hostLabel}.`);
  }

  if (allEvents.some((e) => !e.hasHost)) {
    const tags = loadCommunityTags();
    const hostSignupUrl = `https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/edit?gid=${config.hostSignupGid}#gid=${config.hostSignupGid}`;
    lines.push(buildCheckMessage(allEvents, range, hostSignupUrl, tags));
  }

  return { text: lines.join('\n\n'), hostRemoved: hostRemoved.length, newEvents: newEvents.length, failedTabs };
}

function chunkMessage(text, maxLen = 3500) {
  const paragraphs = text.split('\n\n');
  const chunks = [];
  let current = '';
  for (const p of paragraphs) {
    const candidate = current ? `${current}\n\n${p}` : p;
    if (candidate.length > maxLen && current) {
      chunks.push(current);
      current = p;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

module.exports = {
  loadConfig,
  loadCommunityTags,
  parseCsv,
  findHeaderSegments,
  parseDateFromText,
  parseTimeToMinutes,
  parseTabEvents,
  getCurrentWeekRange,
  getCurrentWeekRangeBali,
  getNextWeekRange,
  collectWeekEvents,
  runDailyHostDiffCheck,
  getHostDiffLastRunDate,
  buildWeeklyMessage,
  buildCheckMessage,
  generateWeeklyReport,
  generateCheckReport,
  chunkMessage,
};
