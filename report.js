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

// Most entries in community-tags.json are a real "@username" (clickable,
// notifies the person), but some volunteers only have a display name on
// file (no Telegram username) — "@" still goes in front of those for a
// visually consistent list, even though a name with a space in it can
// never actually be a clickable Telegram mention.
function formatCommunityTag(tag) {
  return tag.startsWith('@') ? tag : `@${tag}`;
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

// A length/pattern check alone isn't enough: rows that hold just one
// language track's "Recorder & BK" name (e.g. "My Lan @MyLan0608", "Rocio
// Diaz @LaChioDiaz") also end up as the sole non-empty cell whenever every
// other language column is blank for that session — and those names, and
// even decorative one-off remarks ("Yeiii Evgeny speaks German!!"), are
// often 15+ characters too. A loose "zoom link somewhere in the next N
// rows" check still caught these on live data, because tabs that repeat
// their header block monthly also reprint the SAME "ZOOM LINK'S:" every
// month — so a stray name dozens of rows before an unrelated month's
// reprint would coincidentally satisfy "nearby". What genuinely
// distinguishes a new program's title is that the very next non-blank
// row after it (skipping only blank rows — month dividers like "January
// 2026" don't count as blank, so a title followed by one of those before
// reaching the actual link correctly fails this) IS "ZOOM LINK'S:";
// nothing else legitimately sits between a real title and its own link.
function hasNearbyZoomLink(rows, fromIndex, window = 15) {
  const end = Math.min(rows.length, fromIndex + window);
  for (let r = fromIndex; r < end; r++) {
    const row = rows[r];
    const isBlank = !row.some((cell) => normalize(cell).length > 0);
    if (isBlank) continue;
    return row.some((cell) => /zoom link/i.test(normalize(cell)));
  }
  return false;
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
// Every program tab we've checked ends its real schedule with an archive
// table — "Materials" / "YT Links" / "Playlist" followed by "Class 1", "Class
// 2", ... rows of past-recording links — reusing the exact same columns as
// the live schedule above it. Those "Class N" rows have no time of their own
// (so they'd normally be filtered out anyway), but the language-link cell
// that happens to land in the Host column position ends up looking like a
// non-empty "host" — a plain YouTube URL. Once flagged, nothing from this
// row to the end of the segment is treated as schedule data.
function isMaterialsBoundaryRow(row) {
  return row.some((cell) => normalize(cell).toLowerCase() === 'materials');
}

function findHeaderSegments(rows, fallbackLabel) {
  const headerRowIndices = [];
  const labelAtHeaderRow = [];
  let currentLabel = fallbackLabel;
  let firstTitleSeen = null;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];

    // No materials-block gating here (on purpose): a legitimate new
    // program's title routinely appears right after the PREVIOUS program's
    // trailing Materials archive, before any new "Host" row — gating this
    // on "have we crossed a Materials row" suppressed real titles (Armenia
    // Retreat, several ACI parts) that immediately follow one. The strict
    // hasNearbyZoomLink check above is what actually keeps this safe: a
    // Materials-block row is either multi-cell or too short to ever pass
    // it, materials-boundary exclusion for event ROWS is handled entirely
    // separately below (per-segment endRowIndex clamping).
    const titleText = singleNonEmptyCellText(row);
    if (titleText && looksLikeProgramTitle(titleText) && hasNearbyZoomLink(rows, r + 1)) {
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
    let endRowIndex = i + 1 < headerRowIndices.length ? headerRowIndices[i + 1] : rows.length;
    for (let r = headerRowIndex + 1; r < endRowIndex; r++) {
      if (isMaterialsBoundaryRow(rows[r])) {
        endRowIndex = r;
        break;
      }
    }

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

// Arizona is fixed UTC-7 — turns an event's AZ-local start (e.date, the
// AZ calendar day at UTC midnight, plus e.azStartMin AZ-local minutes)
// back into an absolute instant, so it can be compared against "now".
const AZ_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

function azStartInstant(e) {
  return e.date.getTime() + e.azStartMin * 60000 + AZ_UTC_OFFSET_MS;
}

// A "host needed" solicitation for a slot whose Arizona start time has
// already passed is actively misleading — asking people to sign up for
// something that already happened. Every "missing host" listing (/check,
// /weekly's warning block + CTA, the daily diff-check's recap) filters
// on this, but NOT /weekly's full per-event listing, which deliberately
// keeps past events visible as a historical record regardless of host
// status — see buildWeeklyMessage.
function isPastAzStart(e, now) {
  return azStartInstant(e) <= now.getTime();
}

function parseTabEvents(tabName, rows) {
  const segments = findHeaderSegments(rows, tabName);
  const events = [];

  for (const seg of segments) {
    let lastKnownDate = null;

    for (let r = seg.headerRowIndex + 1; r < seg.endRowIndex; r++) {
      const row = rows[r];
      const title = normalize(row[seg.titleCol]);
      const host = normalize(row[seg.hostCol]);
      const azStartMin = parseTimeToMinutes(row[seg.azCol]);
      const azEndMin = parseTimeToMinutes(row[seg.azEndCol]);

      // A real, already-scheduled slot can have its topic/host cells blank
      // (topic not decided yet, or nobody's signed up as host — it should
      // still show up asking for one) — so we can't gate on title or host.
      // What every real slot DOES have is a full start–end time, which is
      // exactly what a stray non-schedule row (a leftover archive/materials
      // row, an unused duplicate template row) lacks — so that's the actual
      // gate. A second class on the same day (e.g. a same-morning Q&A right
      // after the main class) often doesn't repeat the date, only the time,
      // so a dateless-but-timed row still falls back to whatever date the
      // segment most recently saw.
      let date = parseDateFromText(title) || parseDateFromText(row[seg.dateCol]);
      if (date) {
        lastKnownDate = date;
      } else if (azStartMin !== null && azEndMin !== null && lastKnownDate) {
        date = lastKnownDate;
      }
      if (!date || azStartMin === null || azEndMin === null) continue;

      const coHost = seg.coHostCol !== -1 ? normalize(row[seg.coHostCol]) : '';

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
  const events = parseTabEvents(tab.name, rows);
  // Deep link to the PHYSICAL tab this event was read from — attached here,
  // not looked up later from e.tabName, because a multi-program tab (e.g.
  // "DCC & GBOCS") reports several different programLabel values off one
  // gid; matching by name later could point at the wrong tab or no tab at
  // all. /check's per-event listing uses this so each open slot links
  // straight to where its host would actually sign up, not the general
  // host-signup sheet.
  const tabUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?gid=${tab.gid}#gid=${tab.gid}`;
  return events.map((e) => ({ ...e, tabUrl }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Google's CSV-export endpoint answers a burst of simultaneous requests
// against the SAME spreadsheet with intermittent HTTP 409s and aborted
// connections — firing all tabs at once via Promise.all (12, now 13, tabs)
// reproduced this reliably. staggerMs offsets each tab's first attempt so
// they don't all land in the same instant, and up to 2 retries with a
// short backoff absorb whatever's still transient after that.
async function fetchTabEventsResilient(spreadsheetId, tab, staggerMs = 0) {
  if (staggerMs) await sleep(staggerMs);
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetchTabEvents(spreadsheetId, tab);
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(attempt * 800);
    }
  }
  throw lastErr;
}

// Fetches every tab's events, staggered and retried — shared by
// collectWeekEvents (/check, /weekly, Sunday auto-announce) and
// runDailyHostDiffCheck so both get the same resilience against Google's
// rate limiting. Returns one entry per tab; `error` is set instead of
// `events` for a tab that never succeeded after retries.
async function fetchAllTabEvents(spreadsheetId, tabs) {
  const results = [];
  await Promise.all(
    tabs.map(async (tab, i) => {
      try {
        const events = await fetchTabEventsResilient(spreadsheetId, tab, i * 150);
        results.push({ tab, events });
      } catch (err) {
        results.push({ tab, error: err });
      }
    })
  );
  return results;
}

// Bali (Asia/Makassar) is a fixed UTC+8 zone, no DST — same shift-the-clock
// trick used for the verse schedule in verse/progress.js, kept independent
// here. Every week-range calculation below keys off the Bali calendar date
// of `now`, not the server's/UTC's — otherwise, during the ~8h/day window
// where the UTC date still lags a day behind Bali's, "today" would resolve
// to yesterday and the whole week would silently shift back by one (this is
// exactly what made /check show last week's range on a Monday morning).
const BALI_OFFSET_MS = 8 * 60 * 60 * 1000;

function baliNow(now = new Date()) {
  return new Date(now.getTime() + BALI_OFFSET_MS);
}

// The week containing the Bali calendar date of `now`, Monday to Sunday.
// Used by /check and by /weekly (manual), both of which should always show
// the week that contains "today" in Bali, regardless of which day of the
// week they're run on.
function getCurrentWeekRange(now = new Date()) {
  const bali = baliNow(now);
  const day = bali.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (day + 6) % 7;
  const start = new Date(Date.UTC(bali.getUTCFullYear(), bali.getUTCMonth(), bali.getUTCDate() - daysSinceMonday));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 6));
  return { start, end };
}

// The week AFTER the one containing the Bali calendar date of `now`, Monday
// to Sunday. Used ONLY by the Sunday 10:00-Bali auto-announce — the one
// deliberate exception to "current week = week containing today", since on
// Sunday the week containing today is the one that's already almost over.
function getNextWeekRange(now = new Date()) {
  const { start: currentStart } = getCurrentWeekRange(now);
  const start = new Date(Date.UTC(currentStart.getUTCFullYear(), currentStart.getUTCMonth(), currentStart.getUTCDate() + 7));
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

  const results = await fetchAllTabEvents(config.spreadsheetId, config.tabs);
  for (const { tab, events, error } of results) {
    if (error) {
      debugCounts.push({ name: tab.name, total: 0, inRange: 0, error: error.message });
      failedTabs.push(`${tab.name}: ${error.message}`);
      continue;
    }
    const inRangeCount = events.filter((e) => inRange(e.date, range.start, range.end)).length;
    debugCounts.push({ name: tab.name, total: events.length, inRange: inRangeCount });
    allEvents.push(...events);
  }

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

const MONTHS_EN_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_RU_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

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

// The Moscow calendar date for an event's start — same as e.date whenever
// the AZ→MSK shift doesn't cross midnight, one day later when it does.
// Every place that prints a Moscow time prints this alongside it (never
// just the Arizona date, even when the two happen to match) so a
// wrong/missing day-rollover is visible at a glance instead of requiring
// mental math — see the /check Aug 17→18 bug this was built to catch.
function mskDate(e) {
  return addDays(e.date, e.mskStartDayOffset);
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

// Strips the trailing "(Mon DD, YYYY)" (and anything after it, like
// "no translation") that almost every session title ends with, since the
// date is already shown on its own line.
function sessionLabel(title) {
  const m = title.match(/\([A-Za-z]{3,9}\.?\s+\d{1,2},?\s*\d{4}\)/);
  const cut = m ? title.slice(0, m.index) : title;
  return cut.trim().replace(/[-–—]\s*$/, '').trim();
}

// "{tabName} — {session label}", but some already-scheduled events have no
// title yet (topic not decided, host signed up anyway) — don't show a bare
// trailing dash for those, just the program name on its own.
function programLine(tabName, title) {
  const label = sessionLabel(title);
  return label ? `${tabName} — ${label}` : tabName;
}

// All /check and /weekly messages are sent with parse_mode: 'HTML' (see
// index.js) so the program-name link/bold treatment below works — which
// means every piece of free text from the spreadsheet (tab names, session
// titles, host names) flowing into that message MUST go through this
// first, or a stray & < > breaks Telegram's parser and the whole message
// fails to send (the exact class of bug /курсы hit with unescaped
// zoomCode/zoomLink).
function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Program name: a ✅/📛 marker for THIS event's own host status (assigned
// vs still needed — recomputed per event, never a fixed program-type
// icon), then the name itself, always bold. Linked to its tab ONLY while
// a host is still needed — the link itself (blue, underlined) is a
// second copy of the same "needs a host" signal, not decoration, so it
// must disappear the moment someone hosts. `text` may be a raw tab name
// (/check) or a full "{tab} — {session}" programLine (/weekly); either
// way it's escaped here, once, right before formatting — callers must
// pass the RAW value, never pre-escaped.
function formatProgramNameHtml(text, url, hasHost) {
  const marker = hasHost ? '✅' : '📛';
  const escaped = escapeHtml(text);
  const bold = hasHost || !url ? `<b>${escaped}</b>` : `<b><a href="${url}">${escaped}</a></b>`;
  return `${marker} ${bold}`;
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
    formatProgramNameHtml(e.tabName, e.tabUrl, e.hasHost),
    `🕒 Arizona: ${formatMonthDayEn(e.date)}, ${formatRange12h(e.azStartMin, e.azEndMin)}`,
    `🕒 Moscow: ${formatMonthDayEn(mskDate(e))}, ${formatRange12h(e.mskStartMin, e.mskEndMin)}`,
    '👤 Host: needed',
  ].join('\n');
}

function checkEventBlockRu(e) {
  return [
    formatProgramNameHtml(e.tabName, e.tabUrl, e.hasHost),
    `🕒 Аризона: ${formatMonthDayRu(e.date)}, ${formatRange24h(e.azStartMin, e.azEndMin)}`,
    `🕒 Москва: ${formatMonthDayRu(mskDate(e))}, ${formatRange24h(e.mskStartMin, e.mskEndMin)}`,
    '👤 Хост: нужен',
  ].join('\n');
}

// A tab that failed to load (Google Sheets rate-limiting/timeout, see
// fetchAllTabEvents) means the schedule picture below is incomplete — the
// host status for whatever's on THAT tab is simply unknown, not "fine".
// This must never be silently dropped: without it, a burst of transient
// fetch failures reads as "0 events found" and both buildCheckMessage and
// buildWeeklyMessage would otherwise report a confident all-clear over
// data that's actually missing most of the schedule.
function partialDataWarningEn(failedTabs) {
  if (failedTabs.length === 0) return '';
  return [
    `⚠️ Could not fully check the schedule — ${failedTabs.length} tab${failedTabs.length === 1 ? '' : 's'} failed to load:`,
    failedTabs.map(escapeHtml).join('\n'),
    'This result may be incomplete — please try again in a minute.',
  ].join('\n');
}

function partialDataWarningRu(failedTabs) {
  if (failedTabs.length === 0) return '';
  return [
    `⚠️ Не удалось полностью проверить расписание — часть вкладок не загрузилась (${failedTabs.length}):`,
    failedTabs.map(escapeHtml).join('\n'),
    'Результат может быть неполным, попробуйте ещё раз через минуту.',
  ].join('\n');
}

// /check — only the events still missing a host; a short all-clear message
// if everything is covered. When some tabs failed to load, a confirmed
// all-clear is never possible — the warning replaces the "Hooray"/"Ура"
// claim instead of just decorating it, since "no open slots found" over
// partial data isn't the same fact as "no open slots exist". Also excludes
// any slot whose Arizona start time has already passed relative to `now`
// — asking for a host for something that already happened is misleading,
// even though it's technically still "this week".
function buildCheckMessage(events, range, tags, failedTabs = [], now = new Date()) {
  const missing = events.filter((e) => !e.hasHost && !isPastAzStart(e, now));
  const rangeEn = formatWeekRangeEn(range.start, range.end);
  const rangeRu = formatWeekRangeRu(range.start, range.end);
  const partial = failedTabs.length > 0;

  if (missing.length === 0) {
    const enBlock = partial
      ? [
          partialDataWarningEn(failedTabs),
          `No open slots found among the tabs that DID load for ${rangeEn} — but this is incomplete, not a confirmed all-clear.`,
        ].join('\n\n')
      : [
          `📝🎉 Hooray! All Zoom sessions for ${rangeEn} are fully covered with hosts. ✅`,
          'The schedule has been updated. 🙏',
          'Thank you, everyone, for your generous service and support! 💙',
        ].join('\n\n');
    const ruBlock = partial
      ? [
          partialDataWarningRu(failedTabs),
          `Среди загрузившихся вкладок открытых слотов на ${rangeRu} не найдено — но это неполные данные, а не подтверждённое "всё закрыто".`,
        ].join('\n\n')
      : [
          `📝🎉 Ура! На неделю ${rangeRu} все Zoom-эфиры с хостами. ✅`,
          'В табличке всё отмечено. 🙏',
          'Благодарим каждого за ваше щедрое служение и поддержку! 💙',
        ].join('\n\n');
    return [enBlock, ruBlock].join('\n\n');
  }

  const enBody = missing.map(checkEventBlockEn).join('\n\n');
  const ruBody = missing.map(checkEventBlockRu).join('\n\n');

  const enBlock = [
    partial ? partialDataWarningEn(failedTabs) : null,
    `📝 ‼️${enHostPhrase(missing.length)} for this week, ${rangeEn}`,
    '',
    enBody,
    '',
    '🙏 Thank you',
    '🌿',
  ]
    .filter((line) => line !== null)
    .join('\n');

  const ruBlock = [
    partial ? partialDataWarningRu(failedTabs) : null,
    `📝 ‼️${ruHostPhrase(missing.length)} на эту неделю с ${rangeRu}.`,
    '',
    ruBody,
    '',
    '🙏 Спасибо',
    '🌿',
  ]
    .filter((line) => line !== null)
    .join('\n');

  // No general host-signup link here on purpose — every open slot above
  // already has its own tab link baked into the bolded program name (see
  // checkEventBlockEn/Ru → formatProgramNameHtml), which is more useful
  // than one shared link to the whole spreadsheet.
  const parts = [enBlock, ruBlock];
  if (tags && tags.length > 0) parts.push(tags.map((t) => escapeHtml(formatCommunityTag(t))).join(' '));

  return parts.join('\n\n');
}

// ---- /weekly event blocks (every event, host or not) ----

function weeklyHostLineEn(e) {
  if (e.hasHost) {
    const co = e.coHost ? `, Co-Host: ${escapeHtml(e.coHost)}` : '';
    return `👤 Host: ${escapeHtml(e.host)}${co}`;
  }
  return '👤 Host: volunteer needed 🙏';
}

function weeklyHostLineRu(e) {
  if (e.hasHost) {
    const co = e.coHost ? `, Ко-хост: ${escapeHtml(e.coHost)}` : '';
    return `👤 Хост: ${escapeHtml(e.host)}${co}`;
  }
  return '👤 Хост: нужен волонтёр 🙏';
}

function weeklyEventBlockEn(e) {
  return [
    formatProgramNameHtml(programLine(e.tabName, e.title), e.tabUrl, e.hasHost),
    `🕒 Arizona: ${formatMonthDayEn(e.date)}, ${formatRange12h(e.azStartMin, e.azEndMin)}`,
    `🕒 Moscow: ${formatMonthDayEn(mskDate(e))}, ${formatRange24h(e.mskStartMin, e.mskEndMin)}`,
    weeklyHostLineEn(e),
  ].join('\n');
}

function weeklyEventBlockRu(e) {
  return [
    formatProgramNameHtml(programLine(e.tabName, e.title), e.tabUrl, e.hasHost),
    `🕒 Аризона: ${formatMonthDayRu(e.date)}, ${formatRange24h(e.azStartMin, e.azEndMin)}`,
    `🕒 Москва: ${formatMonthDayRu(mskDate(e))}, ${formatRange24h(e.mskStartMin, e.mskEndMin)}`,
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
      const alert = missing.get(name) ? ' ‼️' : '';
      return `${counts.get(name)} from ${escapeHtml(name)}${alert}${isLast ? '.' : ','}`;
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
      const alert = missing.get(name) ? ' ‼️' : '';
      return `${counts.get(name)} — ${escapeHtml(name)}${alert}${isLast ? '.' : ','}`;
    })
    .join('\n');
}

function warningBlockEn(missing) {
  if (missing.length === 0) return '';
  const items = missing
    .map(
      (e) =>
        `${escapeHtml(e.tabName)},\nArizona: ${formatMonthDayEn(e.date)}, ${formatPoint12h(e.azStartMin)},\nMoscow: ${formatMonthDayEn(mskDate(e))}, ${formatPoint24h(e.mskStartMin)}.`
    )
    .join('\n\n');
  return `⚠️ ${enMissingHeader(missing.length)}\n${items}`;
}

function warningBlockRu(missing) {
  if (missing.length === 0) return '';
  const items = missing
    .map(
      (e) =>
        `${escapeHtml(e.tabName)},\nАризона: ${formatMonthDayRu(e.date)}, ${formatPoint24h(e.azStartMin)},\nМосква: ${formatMonthDayRu(mskDate(e))}, ${formatPoint24h(e.mskStartMin)}.`
    )
    .join('\n\n');
  return `⚠️ ${ruMissingHeader(missing.length)}\n${items}`;
}

function ctaLineEn(missing) {
  if (missing.length === 0) return '';
  if (missing.length === 1) {
    const e = missing[0];
    const label = escapeHtml(sessionLabel(e.title) || e.tabName);
    return `If anyone can host ${label} (${formatMonthDayShortEn(e.date)}) — please sign up via the link below 🙏`;
  }
  return 'If anyone can host one of the sessions above — please sign up via the link below 🙏';
}

function ctaLineRu(missing) {
  if (missing.length === 0) return '';
  if (missing.length === 1) {
    const e = missing[0];
    const label = escapeHtml(sessionLabel(e.title) || e.tabName);
    return `Если кто-то может провести «${label}» (${formatMonthDayRu(e.date)}) — пожалуйста, запишитесь по ссылке ниже 🙏`;
  }
  return 'Если вы можете провести одну из сессий выше — пожалуйста, запишитесь по ссылке ниже 🙏';
}

// /weekly — full listing of every event in the range, host or not.
// `upcoming` picks the header wording: true for the Sunday auto-announce
// (range is genuinely next week), false for the manual command (range is
// the week already in progress) — see generateWeeklyReport vs
// generateWeeklyAnnounceReport.
function buildWeeklyMessage(events, range, hostSignupUrl, { upcoming = false, failedTabs = [], now = new Date() } = {}) {
  // Excludes slots whose Arizona start has already passed — only from the
  // "still needs a host" set used by the warning block + CTA below. The
  // full per-event listing further down uses `events` directly, not
  // `missing`, so past sessions still show up there as a historical
  // record regardless of host status, on purpose.
  const missing = events.filter((e) => !e.hasHost && !isPastAzStart(e, now));
  const rangeEn = formatWeekRangeEn(range.start, range.end);
  const rangeRu = formatWeekRangeRu(range.start, range.end);
  const scheduleLabelEn = upcoming ? 'Zoom broadcast schedule for the upcoming week' : 'Zoom broadcast schedule for this week';
  const scheduleLabelRu = upcoming ? 'Расписание Zoom-эфиров на предстоящую неделю' : 'Расписание Zoom-эфиров на эту неделю';

  const enSectionParts = ['📝', 'Precious Angels 🪽', '', 'Wishing everyone kindness and enlightenment in this life 💎', ''];
  const ruSectionParts = ['📝', 'Дорогие Ангелы 🪽', '', 'Желаем всем доброты и просветления в этой жизни 💎', ''];

  // Some tabs failing to load means the counts/listing below are built from
  // whatever DID load, not the full schedule — "no sessions this week"
  // would otherwise be indistinguishable from "couldn't read most tabs".
  // The warning goes up front regardless of whether events.length is 0,
  // since a nonzero count can undercount just as easily as a zero count
  // can be flat wrong.
  if (failedTabs.length > 0) {
    enSectionParts.push('', partialDataWarningEn(failedTabs));
    ruSectionParts.push('', partialDataWarningRu(failedTabs));
  }

  if (events.length === 0) {
    enSectionParts.push(scheduleLabelEn, rangeEn, '', 'No sessions scheduled this week.');
    ruSectionParts.push(scheduleLabelRu, rangeRu, '', 'На этой неделе нет запланированных сессий.');
  } else {
    enSectionParts.push(
      scheduleLabelEn,
      rangeEn,
      '',
      `In total, ${events.length} broadcast${events.length === 1 ? '' : 's'} this week:`,
      '',
      tabBreakdownEn(events)
    );
    ruSectionParts.push(
      scheduleLabelRu,
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

// Manual /weekly — same "current week" range as /check, always the week
// containing today's Bali date, regardless of what day it's run on.
async function generateWeeklyReport(now = new Date()) {
  const range = getCurrentWeekRange(now);
  const { events, failedTabs, hostSignupUrl, debugCounts } = await collectWeekEvents(range);
  const text = buildWeeklyMessage(events, range, hostSignupUrl, { upcoming: false, failedTabs, now });
  return { text, range, totalEvents: events.length, failedTabs, debug: formatDebugCounts(debugCounts, range) };
}

// Sunday 10:00-Bali auto-announce ONLY (see checkAndSendWeeklyAnnounce in
// index.js) — the one deliberate place that wants next week instead of the
// current one, since on Sunday "this week" is the one already wrapping up.
async function generateWeeklyAnnounceReport(now = new Date()) {
  const range = getNextWeekRange(now);
  const { events, failedTabs, hostSignupUrl, debugCounts } = await collectWeekEvents(range);
  const text = buildWeeklyMessage(events, range, hostSignupUrl, { upcoming: true, failedTabs, now });
  return { text, range, totalEvents: events.length, failedTabs, debug: formatDebugCounts(debugCounts, range) };
}

// Tracks the Bali calendar date /weekly was last auto-sent on Sunday
// morning, so the every-5-minutes cron tick (see index.js) only fires once
// per Sunday even though it checks well past WEEKLY_ANNOUNCE_HOUR all day.
const WEEKLY_ANNOUNCE_STATE_PATH = process.env.WEEKLY_ANNOUNCE_STATE_PATH || '/data/weekly_announce_state.json';

function getWeeklyAnnounceLastSentDate() {
  try {
    return JSON.parse(fs.readFileSync(WEEKLY_ANNOUNCE_STATE_PATH, 'utf8')).lastSentDate || null;
  } catch {
    return null;
  }
}

function markWeeklyAnnounceSent(dateStr) {
  fs.mkdirSync(path.dirname(WEEKLY_ANNOUNCE_STATE_PATH), { recursive: true });
  const tmpPath = `${WEEKLY_ANNOUNCE_STATE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify({ lastSentDate: dateStr }, null, 2));
  fs.renameSync(tmpPath, WEEKLY_ANNOUNCE_STATE_PATH);
}

async function generateCheckReport(now = new Date()) {
  const range = getCurrentWeekRange(now);
  const { events, failedTabs, debugCounts } = await collectWeekEvents(range);
  const tags = loadCommunityTags();
  const text = buildCheckMessage(events, range, tags, failedTabs, now);
  return { text, range, totalEvents: events.length, failedTabs, debug: formatDebugCounts(debugCounts, range) };
}

// Same Bali-week logic as /check and /weekly (see getCurrentWeekRange
// above) — kept as a named alias so the periodic auto-check's intent ("this
// week, Bali-relative") stays self-documenting at the call site.
const getCurrentWeekRangeBali = getCurrentWeekRange;

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
// physical SLOT across two different days' snapshots. Deliberately changes
// when a session is rescheduled (that's how a reschedule gets noticed at
// all — see stableIdentity below for the identity that survives it).
function eventKey(e) {
  return `${e.tabName}::${e.date.toISOString().slice(0, 10)}::${e.azStartMin}`;
}

// Identity for the same CLASS across a reschedule — tab + session label
// (title with its trailing "(Mon DD, YYYY)" stripped, same helper /check's
// programLine uses), deliberately excluding date/time so it survives a
// date or time change. Returns null for a blank title (an unnamed slot):
// matching those on title alone would be a coin flip if more than one
// exists on the same tab in the same week, so a blank-titled slot's
// reschedule is just seen as one vanishing and a new one appearing,
// same as before this feature.
function stableIdentity(tabName, title) {
  const label = sessionLabel(title);
  return label ? `${tabName}::${label}` : null;
}

// Reconstructs a diffStamp-compatible pseudo-event from a snapshot entry's
// stored dateISO/azStartMin, so the "was" side of a reschedule notice can
// reuse the exact same AZ/MSK formatting as the "now" side.
function pseudoEventFromSnapshot(dateISO, azStartMin) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const msk = deriveMsk(azStartMin);
  return { date, azStartMin, mskStartMin: msk.min, mskStartDayOffset: msk.dayOffset };
}

function diffStampRu(e) {
  return `Аризона: ${formatMonthDayRu(e.date)}, ${formatPoint24h(e.azStartMin)}, Москва: ${formatMonthDayRu(mskDate(e))}, ${formatPoint24h(e.mskStartMin)}`;
}

function diffStampEn(e) {
  return `Arizona: ${formatMonthDayEn(e.date)}, ${formatPoint12h(e.azStartMin)}, Moscow: ${formatMonthDayEn(mskDate(e))}, ${formatPoint12h(e.mskStartMin)}`;
}

function timeChangeHostNoticeEn(e, prevPseudo) {
  return [
    `👤 ${escapeHtml(e.host)}, the time for this broadcast has changed.`,
    `Was: ${diffStampEn(prevPseudo)}`,
    `Now: ${diffStampEn(e)}`,
    'Please confirm you can still host at the new time, or let us know if we need to find a replacement 🙏',
  ].join('\n');
}

function timeChangeHostNoticeRu(e, prevPseudo) {
  return [
    `👤 ${escapeHtml(e.host)}, время этого эфира изменилось.`,
    `Было: ${diffStampRu(prevPseudo)}`,
    `Стало: ${diffStampRu(e)}`,
    'Пожалуйста, подтвердите, что сможете вести в новое время, или дайте знать, если нужно найти замену 🙏',
  ].join('\n');
}

// Group-facing text for a rescheduled event that already has a host —
// same EN-then-RU convention as /check's buildCheckMessage.
function buildTimeChangeHostNotice(e, prevPseudo) {
  return [timeChangeHostNoticeEn(e, prevPseudo), timeChangeHostNoticeRu(e, prevPseudo)].join('\n\n');
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
  const failedTabNames = new Set();

  const results = await fetchAllTabEvents(config.spreadsheetId, monitoredTabs);
  for (const { tab, events, error } of results) {
    if (error) {
      failedTabs.push(`${tab.name}: ${error.message}`);
      failedTabNames.add(tab.name);
      continue;
    }
    allEvents.push(...events.filter((e) => inRange(e.date, range.start, range.end)));
  }

  const currentByKey = new Map(allEvents.map((e) => [eventKey(e), e]));
  const prevState = readDiffState();
  const prevEvents = prevState.events || {};

  // Vanished-by-identity: yesterday's snapshot entries whose exact key
  // (tab+date+start-time) no longer exists today, indexed by their
  // reschedule-proof identity (tab+session-label) so a "new" key below can
  // be matched back to the slot it moved from, rather than reported as an
  // unrelated brand-new event with no explanation for the one that vanished.
  // Entries belonging to a tab that failed to load THIS run are excluded
  // entirely — an absence caused by a fetch failure is not evidence the
  // class disappeared or the host removed themselves, and must never be
  // read as either.
  const vanishedByIdentity = new Map();
  for (const [key, prev] of Object.entries(prevEvents)) {
    if (failedTabNames.has(prev.tabName)) continue;
    if (currentByKey.has(key)) continue;
    const id = stableIdentity(prev.tabName, prev.title || '');
    if (id) vanishedByIdentity.set(id, prev);
  }

  const hostRemoved = [];
  const newEvents = [];
  const timeChanged = [];
  for (const [key, e] of currentByKey) {
    const prev = prevEvents[key];
    if (prev) {
      if (prev.hasHost && !e.hasHost) {
        hostRemoved.push({ event: e, previousHost: prev.host });
      }
      continue;
    }

    const id = stableIdentity(e.tabName, e.title);
    const moved = id && vanishedByIdentity.get(id);
    if (moved) {
      timeChanged.push({ event: e, prev: moved });
      vanishedByIdentity.delete(id);
    } else {
      newEvents.push(e);
    }
  }

  const snapshot = {};
  // Carry forward every entry belonging to a tab that failed to load this
  // run, exactly as it was — see the vanishedByIdentity comment above. This
  // keeps tomorrow's comparison accurate once that tab loads successfully
  // again, instead of the failed tab's whole prior state being dropped.
  for (const [key, prev] of Object.entries(prevEvents)) {
    if (failedTabNames.has(prev.tabName)) snapshot[key] = prev;
  }
  for (const [key, e] of currentByKey) {
    snapshot[key] = {
      host: e.host,
      hasHost: e.hasHost,
      title: e.title,
      tabName: e.tabName,
      dateISO: e.date.toISOString().slice(0, 10),
      azStartMin: e.azStartMin,
    };
  }
  // Only the real scheduled run (updateLastRunDate: true, see
  // checkAndRunDailyHostDiff in index.js) is allowed to move the comparison
  // baseline forward. A manual preview (/автопроверка, updateLastRunDate:
  // false) must NOT persist `snapshot` here even though it already computed
  // one above to diff against — writing it would silently replace
  // yesterday's real baseline with "whatever the schedule looks like right
  // now", so if a change (e.g. a host disappearing) happened between the
  // last scheduled run and a same-day manual check, that manual write erases
  // the evidence and the next scheduled run finds nothing to report. This
  // is exactly how a real reschedule/host-removal went undetected before.
  if (updateLastRunDate) {
    writeDiffState({
      lastRunDate: baliNow(now).toISOString().slice(0, 10),
      events: snapshot,
    });
  }

  // "Silence if nothing changed" applies ONLY when there's neither a host
  // removal, nor a new event, nor a reschedule, AND every tab actually
  // loaded — as soon as any one of the three shows up, Elena gets a message
  // no matter what, even if e.g. a new event already has a host assigned
  // (in that case it's purely informational: the 🆕 line below, nothing
  // more). Do not add an `e.hasHost` check here. Partial data is the fourth
  // reason to break silence: silence normally means "confirmed no
  // changes", and staying quiet over a tab that simply failed to load would
  // mean the same silence, which she'd read the same way, even though
  // nothing was actually confirmed that day.
  const hasPartialData = failedTabs.length > 0;
  if (hostRemoved.length === 0 && newEvents.length === 0 && timeChanged.length === 0 && !hasPartialData) {
    return { text: null, hostRemoved: 0, newEvents: 0, timeChanged: 0, failedTabs };
  }

  const lines = [];
  if (hasPartialData) {
    lines.push(partialDataWarningRu(failedTabs));
  }
  for (const { event: e, previousHost } of hostRemoved) {
    lines.push(
      `⚠️ Хост убрал себя с эфира: ${escapeHtml(programLine(e.tabName, e.title))}, ${diffStampRu(e)}. Был назначен: ${escapeHtml(previousHost)}. Сейчас хост не назначен.`
    );
  }
  for (const e of newEvents) {
    const hostLabel = e.hasHost ? escapeHtml(e.host) : 'не назначен';
    lines.push(`🆕 Новый эфир в расписании: ${escapeHtml(programLine(e.tabName, e.title))}, ${diffStampRu(e)}, хост: ${hostLabel}.`);
  }
  for (const { event: e, prev } of timeChanged) {
    const prevPseudo = pseudoEventFromSnapshot(prev.dateISO, prev.azStartMin);
    lines.push(
      `⏰ Изменилось время эфира: ${escapeHtml(programLine(e.tabName, e.title))}.\nБыло: ${diffStampRu(prevPseudo)}\nСтало: ${diffStampRu(e)}`
    );
    // Host assigned → also give Elena a ready-to-paste group message
    // addressed to that host by name, asking them to reconfirm. No host →
    // nothing more here; the still-open slot already surfaces below via
    // the same "any event missing a host" catch-all /check-style listing.
    if (e.hasHost) {
      lines.push(buildTimeChangeHostNotice(e, prevPseudo));
    }
  }

  // A brand-new or rescheduled event with no host must additionally get
  // Elena the ready-to-paste group announcement — same /check format (EN
  // then RU, "host needed" / "нужен волонтёр"). Gating on "does ANY event
  // this week still lack a host AND hasn't already started" (rather than
  // "is the new/moved event itself unhosted") is deliberate, not an
  // approximation: such an event is always a member of allEvents, so this
  // condition fires for it every time, and it also naturally folds in any
  // other already-open slot so the pasted text reflects the whole week,
  // not just the one session — the past-start exclusion keeps a slot that
  // already happened from both triggering this block pointlessly and (via
  // buildCheckMessage's own identical filter) showing up inside it.
  if (allEvents.some((e) => !e.hasHost && !isPastAzStart(e, now))) {
    const tags = loadCommunityTags();
    lines.push(buildCheckMessage(allEvents, range, tags, [], now));
  }

  return {
    text: lines.join('\n\n'),
    hostRemoved: hostRemoved.length,
    newEvents: newEvents.length,
    timeChanged: timeChanged.length,
    failedTabs,
  };
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
  getWeeklyAnnounceLastSentDate,
  markWeeklyAnnounceSent,
  buildWeeklyMessage,
  buildCheckMessage,
  generateWeeklyReport,
  generateWeeklyAnnounceReport,
  generateCheckReport,
  chunkMessage,
};
