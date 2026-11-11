// «Календарь помощников» (страница /helpers, public/helpers.html): эфиры дня и места помощников
// (MC, Assistance, REC & BK). ТОЛЬКО чтение: таблицу не меняет, в Telegram ничего не пишет,
// ИИ не использует. Эфиры читает тот же код, что и бот (report.js: collectWeekEvents —
// дата и время только из Data + AZ, «off» и исключённые программы пропускаются), роли —
// helperRoles.js. Данные всей таблицы кэшируются на 5 минут; страница сама выбирает день.
const path = require('path');
const report = require('./report');

const CACHE_MS = 5 * 60 * 1000;
const ALL_TIME = { start: new Date(Date.UTC(2020, 0, 1)), end: new Date(Date.UTC(2100, 0, 1)) };

let cache = null; // { at, data }
let inflight = null;

const minutesBetween = (a, b) => (a === null || b === null ? null : (((b - a) % 1440) + 1440) % 1440);

// A program label that is really a note («Please note that only volunteers…») or the label of another
// program inherited on a shared tab (see report.js: Pramana) is replaced by the tab's name, or left out.
function programName(e) {
  const bad = (s) => !s || s.length > 90 || /^please note/i.test(s) || /pramana/i.test(s);
  if (!bad(e.tabName)) return e.tabName;
  return bad(e.configTab) ? '' : e.configTab;
}

// Link to the free place of a role (🔴 → the top / white row, 🟠 → the free one of the two), built by the
// same function as the Tuesday summary (cardButtons.eventLink / cellLink). A covered role (🟢) gets no link;
// when the cell is unknown the link points at the session row; a failure gives '' (no button).
function roleLink(e, places, refs) {
  try {
    const filled = (places || []).map(Boolean);
    if (filled.length && filled.every(Boolean)) return '';
    const idx = !filled[0] ? 0 : 1;
    const ref = (refs || [])[idx] || '';
    const cards = require('./cardButtons');
    return (ref ? cards.cellLink(e, ref) : cards.eventLink(e)) || '';
  } catch {
    return '';
  }
}

function linksOf(e, roles) {
  const refs = roles.refs || { class: {}, countries: {} };
  const links = { mc: '', countries: {} };
  if (roles.class && roles.class.mc) links.mc = roleLink(e, roles.class.mc, refs.class && refs.class.mc);
  Object.keys(roles.countries || {}).forEach((code) => {
    const c = roles.countries[code];
    const rc = (refs.countries && refs.countries[code]) || {};
    links.countries[code] = {
      assistance: c.assistance ? roleLink(e, c.assistance, rc.assistance) : '',
      rec: c.rec ? roleLink(e, c.rec, rc.rec) : '',
    };
  });
  return links;
}

function toJson(e) {
  const roles = e.roles || { class: {}, countries: {} };
  let links = { mc: '', countries: {} };
  try {
    links = linksOf(e, roles);
  } catch {
    /* no links — the page then shows no buttons */
  }
  return {
    row: e.row,
    links,
    day: e.date.toISOString().slice(0, 10),
    title: e.title,
    program: programName(e),
    tab: e.configTab || '', // sheet tab name: the program filter on the page groups by it (tabs starting with «ACI» → one)
    azStartMin: e.azStartMin,
    azEndMin: e.azEndMin,
    mskStartMin: e.mskStartMin,
    mskEndMin: e.mskEndMin,
    mskDayOffset: e.mskStartDayOffset || 0,
    durationMin: minutesBetween(e.azStartMin, e.azEndMin),
    host: e.hasHost ? e.host : '',
    class: roles.class,
    countries: roles.countries,
  };
}

async function load() {
  const { events, failedTabs } = await report.collectWeekEvents(ALL_TIME, { withRoles: true });
  const list = events.filter((e) => e.title).map(toJson); // rows without a title are not shown
  const countries = [...new Set(list.flatMap((e) => Object.keys(e.countries)))].sort();
  return { events: list, failedTabs, countries };
}

async function getData(now = Date.now()) {
  if (cache && now - cache.at < CACHE_MS) return cache.data;
  if (!inflight) {
    inflight = load()
      .then((data) => {
        cache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        inflight = null;
      });
  }
  try {
    return await inflight;
  } catch (err) {
    if (cache) return cache.data; // the sheet is unreachable right now: show what we had
    throw err;
  }
}

function registerHelpers(app) {
  app.get('/helpers', (req, res) => res.sendFile(path.join(__dirname, 'public', 'helpers.html')));
  // /api/helpers/day?date=YYYY-MM-DD → events of that day (the "Data" column date, Arizona calendar)
  app.get('/api/helpers/day', async (req, res) => {
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date=YYYY-MM-DD' });
    try {
      const data = await getData();
      res.set('Cache-Control', 'no-store');
      res.json({
        date,
        events: data.events.filter((e) => e.day === date),
        failedTabs: data.failedTabs,
        countries: data.countries,
      });
    } catch (err) {
      console.error('[helpers] не удалось прочитать таблицу:', err.message);
      res.status(502).json({ error: 'sheet-unavailable' });
    }
  });
}

module.exports = { registerHelpers, getData, toJson };
