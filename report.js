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

// Every program tab has its own quirky, hand-edited header block (column
// order shifts between tabs), but they all share one anchor: a row with a
// cell that's exactly "Host". AZ/MSK time columns and Co-Host sit on that
// same row, and the session-title column is reliably one cell to the left
// of Host, while the AZ end-time column is reliably two cells to the right
// of AZ start (start, "-", end are always three consecutive columns). We
// use the LAST such row in the sheet, since some tabs repeat a decorative
// header block before the real, data-aligned one.
function findHeaderRow(rows) {
  let headerRowIndex = -1;
  let hostCol = -1;
  let coHostCol = -1;
  let azCol = -1;
  let mskCol = -1;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    let localHostCol = -1;
    for (let c = 0; c < row.length; c++) {
      if (normalize(row[c]).toLowerCase() === 'host') {
        localHostCol = c;
        break;
      }
    }
    if (localHostCol === -1) continue;

    let localCoHostCol = -1;
    let localAzCol = -1;
    let localMskCol = -1;
    for (let c = 0; c < row.length; c++) {
      const v = normalize(row[c]).toLowerCase();
      if (localCoHostCol === -1 && (v === 'co-host' || v === 'cohost')) localCoHostCol = c;
      if (localAzCol === -1 && v.includes('az') && (v.includes('utc-7') || v.includes('mst'))) localAzCol = c;
      if (localMskCol === -1 && v.includes('msk')) localMskCol = c;
    }

    headerRowIndex = r;
    hostCol = localHostCol;
    coHostCol = localCoHostCol;
    azCol = localAzCol;
    mskCol = localMskCol;
  }

  if (headerRowIndex === -1) return null;

  const resolvedAzCol = azCol === -1 ? 2 : azCol;

  return {
    headerRowIndex,
    dateCol: 1,
    titleCol: hostCol - 1,
    hostCol,
    coHostCol,
    azCol: resolvedAzCol,
    azEndCol: resolvedAzCol + 2,
    mskCol: mskCol === -1 ? 5 : mskCol,
  };
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

function parseTabEvents(tabName, rows) {
  const header = findHeaderRow(rows);
  if (!header) return [];

  const events = [];
  for (let r = header.headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    const title = normalize(row[header.titleCol]);
    if (!title) continue; // section dividers / continuation rows have no title

    const date = parseDateFromText(title) || parseDateFromText(row[header.dateCol]);
    if (!date) continue;

    const host = normalize(row[header.hostCol]);
    const azStartMin = parseTimeToMinutes(row[header.azCol]);
    const azEndMin = parseTimeToMinutes(row[header.azEndCol]);
    const mskStartMin = parseTimeToMinutes(row[header.mskCol]);

    // The sheet only gives one Moscow time column (aligned to AZ start), not
    // a Moscow end time — so we derive it from the AZ session length.
    let durationMin = 0;
    if (azStartMin !== null && azEndMin !== null) {
      durationMin = ((azEndMin - azStartMin) % 1440 + 1440) % 1440;
    }
    const mskEndMin = mskStartMin !== null && durationMin > 0 ? (mskStartMin + durationMin) % 1440 : null;

    events.push({
      tabName,
      title,
      host,
      hasHost: host.length > 0,
      date,
      azStartMin,
      azEndMin,
      mskStartMin,
      mskEndMin,
    });
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

  await Promise.all(
    config.tabs.map(async (tab) => {
      try {
        const events = await fetchTabEvents(config.spreadsheetId, tab);
        allEvents.push(...events);
      } catch (err) {
        failedTabs.push(`${tab.name}: ${err.message}`);
      }
    })
  );

  const events = allEvents
    .filter((e) => inRange(e.date, range.start, range.end))
    .sort((a, b) => a.date - b.date || (a.azStartMin ?? 0) - (b.azStartMin ?? 0));

  const hostSignupUrl = `https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/edit?gid=${config.hostSignupGid}#gid=${config.hostSignupGid}`;

  return { events, failedTabs, hostSignupUrl };
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

function ruIsOneForm(n) {
  return n % 10 === 1 && n % 100 !== 11;
}

function ruHostPhrase(n) {
  if (ruIsOneForm(n)) return `НУЖЕН ${n} ХОСТ`;
  const n10 = n % 10;
  const n100 = n % 100;
  const few = n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14);
  return `НУЖНЫ ${n} ${few ? 'ХОСТА' : 'ХОСТОВ'}`;
}

function enHostPhrase(n) {
  return `NEEDED ${n} HOST${n === 1 ? '' : 'S'}`;
}

function eventBlockEn(e, hostLine) {
  return [
    `🗓️ ${formatEventDateEn(e.date)}`,
    `${programEmoji(e.tabName)} ${e.tabName}`,
    `🕒 Arizona: ${formatRange12h(e.azStartMin, e.azEndMin)}`,
    `🕒 Moscow: ${formatRange12h(e.mskStartMin, e.mskEndMin)}`,
    hostLine,
  ].join('\n');
}

function eventBlockRu(e, hostLine) {
  return [
    `🗓️ ${formatEventDateRu(e.date)}`,
    `${programEmoji(e.tabName)} ${e.tabName}`,
    `🕒 Аризона: ${formatRange24h(e.azStartMin, e.azEndMin)}`,
    `🕒 Москва: ${formatRange24h(e.mskStartMin, e.mskEndMin)}`,
    hostLine,
  ].join('\n');
}

// /weekly — full listing of every event in the range, host or not.
function buildWeeklyMessage(events, range, hostSignupUrl) {
  const rangeEn = formatWeekRangeEn(range.start, range.end);
  const rangeRu = formatWeekRangeRu(range.start, range.end);

  const enBody =
    events.length === 0
      ? 'No sessions scheduled this week.'
      : events
          .map((e) => eventBlockEn(e, e.hasHost ? `👤 Host: ${e.host}` : '👤 🔥 Host needed'))
          .join('\n\n');

  const ruBody =
    events.length === 0
      ? 'На этой неделе нет запланированных сессий.'
      : events
          .map((e) => eventBlockRu(e, e.hasHost ? `👤 Хост: ${e.host}` : '👤 🔥 Хост не назначен'))
          .join('\n\n');

  const enBlock = [`📝 🗓️ Full schedule for the week, ${rangeEn}`, '', enBody, '', '🙏 Thank you', '🌿'].join('\n');
  const ruBlock = [`📝 🗓️ Полное расписание на неделю, ${rangeRu}`, '', ruBody, '', '🙏 Спасибо', '🌿'].join('\n');

  return [enBlock, ruBlock, hostSignupUrl].join('\n\n');
}

// /check — only the events still missing a host; a short all-clear message
// if everything is covered.
function buildCheckMessage(events, range, hostSignupUrl, tags) {
  const missing = events.filter((e) => !e.hasHost);

  if (missing.length === 0) {
    return [
      '📝🎉 Hooray! All Zoom sessions for this week are fully covered with hosts. ✅ The schedule has been updated. 🙏 Thank you, everyone, for your generous service and support! 💙',
      '📝🎉 Ура! На эту неделю все Zoom-эфиры с хостами. ✅ В табличке всё отмечено. 🙏 Благодарим каждого за ваше щедрое служение и поддержку! 💙',
    ].join('\n');
  }

  const rangeEn = formatWeekRangeEn(range.start, range.end);
  const rangeRu = formatWeekRangeRu(range.start, range.end);

  const enBody = missing.map((e) => eventBlockEn(e, '👤 Host: needed')).join('\n\n');
  const ruBody = missing.map((e) => eventBlockRu(e, '👤 Хост: нужен')).join('\n\n');

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

async function generateWeeklyReport(now = new Date()) {
  const range = getNextWeekRange(now);
  const { events, failedTabs, hostSignupUrl } = await collectWeekEvents(range);
  const text = buildWeeklyMessage(events, range, hostSignupUrl);
  return { text, range, totalEvents: events.length, failedTabs };
}

async function generateCheckReport(now = new Date()) {
  const range = getCurrentWeekRange(now);
  const { events, failedTabs, hostSignupUrl } = await collectWeekEvents(range);
  const tags = loadCommunityTags();
  const text = buildCheckMessage(events, range, hostSignupUrl, tags);
  return { text, range, totalEvents: events.length, failedTabs };
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
  findHeaderRow,
  parseDateFromText,
  parseTimeToMinutes,
  parseTabEvents,
  getCurrentWeekRange,
  getNextWeekRange,
  collectWeekEvents,
  buildWeeklyMessage,
  buildCheckMessage,
  generateWeeklyReport,
  generateCheckReport,
  chunkMessage,
};
