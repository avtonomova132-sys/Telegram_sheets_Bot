const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'tabs-config.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
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
// of Host. We use the LAST such row in the sheet, since some tabs repeat
// a decorative header block before the real, data-aligned one.
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

  return {
    headerRowIndex,
    dateCol: 1,
    titleCol: hostCol - 1,
    hostCol,
    coHostCol,
    azCol: azCol === -1 ? 2 : azCol,
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

function extractTime(text) {
  if (!text) return '';
  const m = text.match(/(\d{1,2}:\d{2}\s*(?:[AaPp][Mm])?)/);
  return m ? m[1].trim() : '';
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
    const azTime = extractTime(row[header.azCol]);
    const mskTime = extractTime(row[header.mskCol]);

    events.push({ tabName, title, host, hasHost: host.length > 0, date, azTime, mskTime });
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

function getNextWeekRange(now = new Date()) {
  const day = now.getUTCDay(); // 0=Sun..6=Sat
  const daysUntilNextMonday = ((1 - day + 7) % 7) || 7;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilNextMonday));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 6));
  return { start, end };
}

function inRange(date, start, end) {
  return date >= start && date <= end;
}

const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS_RU = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function formatDateEn(date) {
  return `${WEEKDAYS_EN[date.getUTCDay()]}, ${MONTHS_EN[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function formatDateRu(date) {
  return `${date.getUTCDate()} ${MONTHS_RU[date.getUTCMonth()]} (${WEEKDAYS_RU[date.getUTCDay()]})`;
}

const ACADEMIC_KEYWORDS = ['aci', 'pramana', 'teacher training', 'yogic studies', 'ysi'];

function programEmoji(tabName) {
  const lower = tabName.toLowerCase();
  return ACADEMIC_KEYWORDS.some((k) => lower.includes(k)) ? '🎓' : '💙';
}

function buildMessage(events, range, hostSignupUrl) {
  const withoutHost = events
    .filter((e) => !e.hasHost)
    .sort((a, b) => a.date - b.date || a.azTime.localeCompare(b.azTime));
  const withHostCount = events.length - withoutHost.length;

  const rangeEn = `${formatDateEn(range.start)} – ${formatDateEn(range.end)}`;
  const rangeRu = `${formatDateRu(range.start)} – ${formatDateRu(range.end)}`;

  const lines = [];

  lines.push('Dear beautiful community, 🙏');
  lines.push('');
  lines.push(`Here are the sessions for ${rangeEn} that are still looking for a host — would you like to hold space for one of these? 💙`);
  lines.push('');

  if (withoutHost.length === 0) {
    lines.push('✨ Wonderful news — every session next week already has a host!');
  } else {
    for (const e of withoutHost) {
      lines.push(`🗓️ ${formatDateEn(e.date)}`);
      lines.push(`${programEmoji(e.tabName)} ${e.tabName}: ${e.title}`);
      lines.push(`🕒 ${e.azTime || '—'} AZ / ${e.mskTime || '—'} MSK`);
      lines.push('👤 Host: — still needed —');
      lines.push('');
    }
  }

  lines.push(`✍️ Sign up here: ${hostSignupUrl}`);
  lines.push('');
  lines.push(`${withHostCount} session(s) already have a host this week — thank you all for your dedication! With so much gratitude for this community. ✨`);

  lines.push('');
  lines.push('📝');
  lines.push('');

  lines.push('Дорогое прекрасное сообщество, 🙏');
  lines.push('');
  lines.push(`Вот сессии на ${rangeRu}, которым всё ещё нужен ведущий — не хотели бы вы подержать пространство для одной из них? 💙`);
  lines.push('');

  if (withoutHost.length === 0) {
    lines.push('✨ Прекрасная новость — на следующей неделе все сессии уже с ведущими!');
  } else {
    for (const e of withoutHost) {
      lines.push(`🗓️ ${formatDateRu(e.date)}`);
      lines.push(`${programEmoji(e.tabName)} ${e.tabName}: ${e.title}`);
      lines.push(`🕒 ${e.azTime || '—'} по Аризоне / ${e.mskTime || '—'} по Москве`);
      lines.push('👤 Ведущий: — пока не назначен —');
      lines.push('');
    }
  }

  lines.push(`✍️ Записаться здесь: ${hostSignupUrl}`);
  lines.push('');
  lines.push(`${withHostCount} сессия(й) на этой неделе уже с ведущими — спасибо вам всем за вашу самоотдачу! С огромной благодарностью этому сообществу. ✨`);

  return lines.join('\n');
}

async function generateWeeklyReport(now = new Date()) {
  const config = loadConfig();
  const range = getNextWeekRange(now);
  const hostSignupUrl = `https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/edit#gid=${config.hostSignupGid}`;

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

  const eventsInRange = allEvents.filter((e) => inRange(e.date, range.start, range.end));
  const text = buildMessage(eventsInRange, range, hostSignupUrl);

  return { text, range, totalEvents: eventsInRange.length, failedTabs };
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
  parseCsv,
  findHeaderRow,
  parseDateFromText,
  extractTime,
  parseTabEvents,
  getNextWeekRange,
  buildMessage,
  generateWeeklyReport,
  chunkMessage,
};
