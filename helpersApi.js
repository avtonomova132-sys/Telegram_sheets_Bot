// «Календарь помощников» (страница /helpers, public/helpers.html): эфиры дня и места помощников
// (MC, Assistance, REC & BK). ТОЛЬКО чтение: таблицу не меняет, в Telegram ничего не пишет,
// ИИ не использует. Эфиры читает тот же код, что и бот (report.js: collectWeekEvents —
// дата и время только из Data + AZ, «off» и исключённые программы пропускаются), роли —
// helperRoles.js. Данные всей таблицы кэшируются на 5 минут; страница сама выбирает день.
const path = require('path');
const report = require('./report');

// ---- WHITELIST of tabs for the /helpers page (Elena, 2026-11-11) ----
// ONE array, edit it here. Only sessions of these tabs / programs are shown on the page. It is NOT applied to
// the Announce or any other bot logic (those use programRules.js: tabs.whitelist).
// Names are compared without case, spaces and punctuation; «&» = «and»; «Ven.» = «Venerable» = «V.» are the same
// word; a small difference in spelling is allowed (edit distance <= 2).
const HELPERS_TABS = [
  "Xuanzang's Tower",
  'ACI with Timothy Lowenhaupt',
  'Blue Sky Friends',
  'ACI with Ven. Utpala',
  'DCC & GBOCS',
  'ACI with V. Sumati',
  'ACI | V Houses',
  'ACI | V Houses SERIES',
  'ACI 18',
  'Sanskrit with Christina Kasica',
  'Lam Rim with Timothy Lowenhaupt',
];
// Programs that never need helpers (kept as a safety net; report.js already skips them): not reported as «new tab».
const EXCLUDED_NAME_RE = /pramana|breakfast club|ivanina|mcmichael|inna\b.*\bbill/i;

const wnorm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9а-яё]+/g, ' ')
    .replace(/\b(venerable|ven|v)\b/g, 'ven')
    .replace(/\s+/g, ' ')
    .trim();
const NORM_TABS = HELPERS_TABS.map((n) => ({ name: n, norm: wnorm(n), tokens: wnorm(n).split(' ') }));

function lev(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}
// real tab name of the sheet: equal, or a small spelling difference
function matchStrict(name) {
  const n = wnorm(name);
  if (!n) return null;
  return NORM_TABS.find((t) => t.norm === n || (t.norm.length >= 12 && Math.abs(t.norm.length - n.length) <= 2 && lev(t.norm, n) <= 2)) || null;
}
// configured tab name / program label (may be longer or differ from the real name): strict match, or the label starts
// with the entry («ACI 18 …»), or it contains all words of an entry that has at least 3 words
function matchLenient(label) {
  const hit = matchStrict(label);
  if (hit) return hit;
  const n = wnorm(label);
  if (!n) return null;
  const words = new Set(n.split(' '));
  return NORM_TABS.find((t) => n.startsWith(t.norm + ' ') || (t.tokens.length >= 3 && t.tokens.every((w) => words.has(w)))) || null;
}

let tabsCache = null; // { at, list } real tabs of the sheet (name + gid); [] when the list cannot be read
async function realTabs() {
  if (tabsCache && Date.now() - tabsCache.at < 10 * 60 * 1000) return tabsCache.list;
  let list = [];
  try {
    list = (await require('./programNeeds').listSheetTabs()).map((t) => ({ name: String(t.name || '').trim(), gid: String(t.gid) }));
  } catch (err) {
    console.error('[helpers] список вкладок таблицы:', err.message);
    if (tabsCache) return tabsCache.list;
  }
  tabsCache = { at: Date.now(), list };
  return list;
}

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
    tab: e.realTab || e.configTab || '', // sheet tab name: the program filter on the page groups by it (tabs starting with «ACI» → one)
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
  const real = await realTabs();
  const realByGid = new Map(real.map((t) => [t.gid, t.name]));
  const configTabs = report.loadConfig().tabs;
  const configGids = new Set(configTabs.map((t) => String(t.gid)));
  // whitelisted tabs of the sheet that the bot does not read by itself (e.g. a tab it has no config for) are read too
  const extraTabs = real.filter((t) => !configGids.has(t.gid) && matchStrict(t.name)).map((t) => ({ name: t.name, gid: t.gid }));
  const { events, failedTabs } = await report.collectWeekEvents(ALL_TIME, { withRoles: true, extraTabs });

  const allowed = (e) => {
    const realName = realByGid.get(e.tabGid);
    return Boolean((realName && matchStrict(realName)) || matchLenient(e.sheetTab) || matchLenient(e.tabName));
  };
  const shown = events
    .filter((e) => e.title && allowed(e)) // rows without a title are not shown
    .map((e) => ({ ...e, realTab: realByGid.get(e.tabGid) || '' }));
  const list = shown.map(toJson);
  const countries = [...new Set(list.flatMap((e) => Object.keys(e.countries)))].sort();

  // tabs that failed to read: only those of the whitelist matter to the page
  const failedOk = (failedTabs || []).filter((f) => {
    const name = String(f).split(':')[0];
    const cfg = configTabs.find((t) => t.name === name);
    const realName = cfg && realByGid.get(String(cfg.gid));
    return Boolean(matchLenient(name) || (realName && matchStrict(realName)));
  });

  // info only: tabs of the sheet that are neither in the whitelist nor in the exclusions nor already known to the bot
  let newTabs = [];
  try {
    const rules = require('./programRules');
    newTabs = real.filter((t) => !matchStrict(t.name) && !EXCLUDED_NAME_RE.test(t.name) && !rules.isTabKnown(t.gid)).map((t) => t.name);
  } catch {
    /* no info */
  }
  // for the person who maintains the list: which list items found a tab of the sheet
  const matched = [];
  const missing = [];
  NORM_TABS.forEach((t) => {
    const tabs = real.filter((r) => matchStrict(r.name) && matchStrict(r.name).name === t.name).map((r) => r.name);
    if (tabs.length) matched.push({ entry: t.name, tab: tabs.join(' / ') });
    else missing.push(t.name);
  });
  return { events: list, failedTabs: failedOk, countries, newTabs, whitelist: { realTabsRead: real.length > 0, matched, missing } };
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
        newTabs: data.newTabs || [],
        whitelist: data.whitelist,
      });
    } catch (err) {
      console.error('[helpers] не удалось прочитать таблицу:', err.message);
      res.status(502).json({ error: 'sheet-unavailable' });
    }
  });
}

module.exports = { registerHelpers, getData, toJson, HELPERS_TABS };
