// Решения Елены «нужны ли от нашей команды (WVP) хосты на программу» (2026-11-02).
// Файл на постоянном томе (/data/program_rules.json, PROGRAM_RULES_PATH):
//   excluded — программы БЕЗ хостов (по названию, без учёта регистра): они выпадают
//              из Анонса, напоминаний, сводок, «за 24 ч», «Новый эфир» и счётчиков
//              (report.js: isExcludedProgramEvent спрашивает isExcludedByRules);
//   needed   — программы, на которые хосты нужны (ждём вкладку / следим за эфирами);
//   pending  — присланные Елене сообщения «Table update» с кнопками (id = строка вкладки).
// Модуль ничего не знает ни о боте, ни о report.js (чтобы не было циклов): только
// чтение/запись JSON и сопоставление названий.

const fs = require('fs');
const path = require('path');

const FILE = () => process.env.PROGRAM_RULES_PATH || '/data/program_rules.json';

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[\s ]+/g, ' ')
    .trim();

// Названия короче этого не сопоставляются «по вхождению» (слишком много случайных совпадений).
const MIN_MATCH_LEN = 6;

// ---- Белый список вкладок (Елена, 2026-11-09, ПОСТОЯННОЕ правило) ----
// Хосты ищем ТОЛЬКО в этих вкладках таблицы (ключ — gid вкладки; названия — настоящие названия
// вкладок). Все остальные вкладки в Анонс, напоминания, сводки, «за 24 ч» и счётчик не входят.
// Список и ответы хранятся в этом файле на томе, не в коде (код лишь задаёт стартовое значение).
// known — вкладки, которые уже были в таблице на 2026-11-09 и в список не попали (про них не
// спрашиваем); asked — новые вкладки, по которым Елене уже ушёл вопрос; blocked = known с ответом «Нет».
function defaultTabs() {
  const wl = (name, gid) => ({ name, gid, at: Date.now() });
  return {
    whitelist: [
      wl("Xuanzang's Tower", '1411715457'),
      wl('ACI with Timothy Lowenhaupt (в т.ч. ACI 18)', '1540568700'),
      wl('Blue Sky Friends', '1388395363'),
      wl('ACI with Ven. Utpala', '1658984487'),
      wl('DCC & GBOCS', '104338179'),
      wl('ACI with V. Sumati', '1999892677'),
      wl('ACI | V Houses SERIES (в т.ч. ACI | V Houses)', '24119706'),
      wl('Sanskrit with Christina Kasica', '1460426350'),
      wl('Lam Rim with Timothy Lowenhaupt', '771008913'),
    ],
    known: {
      1271742444: 'Info',
      873833331: '2026 Programs',
      1263125290: '2026 Calendar',
      271942327: 'volunteers_database',
      1068508921: 'YSI',
      1370395210: 'ACI with Inna & Bill',
      967646074: 'Harmony for Health',
      1575241358: 'Prayers for The People',
      1153396063: 'Sarahni Stumpf',
      738844155: 'Prosperity Lab',
      675522741: 'Continuing Education',
      106994159: 'V Houses Live EVENTS',
      563159906: 'Ven. Gyelse',
      1081463745: 'PTWN',
      258885724: 'ACI Teacher Training',
      161127458: 'ACI with T.Sofia Arellano (SPA)',
      1109067689: 'ACI program',
      718166373: 'New UTC',
      181247: 'UTC',
    },
    asked: {},
  };
}

let cache = null;
let cacheStamp = 0;

function read() {
  let stamp = 0;
  try {
    stamp = fs.statSync(FILE()).mtimeMs;
  } catch {
    stamp = -1;
  }
  if (cache && stamp === cacheStamp) return cache;
  let s;
  try {
    s = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    s = {};
  }
  s.excluded = Array.isArray(s.excluded) ? s.excluded : [];
  s.needed = Array.isArray(s.needed) ? s.needed : [];
  s.pending = s.pending && typeof s.pending === 'object' ? s.pending : {};
  if (!s.tabs || !Array.isArray(s.tabs.whitelist)) s.tabs = defaultTabs();
  s.tabs.known = s.tabs.known && typeof s.tabs.known === 'object' ? s.tabs.known : {};
  s.tabs.asked = s.tabs.asked && typeof s.tabs.asked === 'object' ? s.tabs.asked : {};
  cache = s;
  cacheStamp = stamp;
  return s;
}

function write(state) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  const tmp = `${FILE()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE());
  cache = state;
  try {
    cacheStamp = fs.statSync(FILE()).mtimeMs;
  } catch {
    cacheStamp = 0;
  }
}

function update(fn) {
  const s = read();
  const r = fn(s);
  write(s);
  return r;
}

// Does text `a` name the same program as `b`? (one contains the other, both long enough)
function sameProgram(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (x.length < MIN_MATCH_LEN || y.length < MIN_MATCH_LEN) return x === y && x.length > 0;
  return x.includes(y) || y.includes(x);
}

// For report.js: is this event (title / program label) of a program Elena said needs no hosts?
function isExcludedByRules(title, label = '') {
  const list = read().excluded;
  if (list.length === 0) return false;
  const t = norm(title);
  const l = norm(label);
  // ACI with Ven. Utpala is never excluded by a short «ACI N» decision made for Inna & Bill's
  // program (Elena, 2026-11-09: «ACI 9 - Class 5 with Ven Utpala» must stay in the Announce).
  if (t.includes('utpala') || l.includes('utpala')) return false;
  return list.some((p) => (t.length > 0 && t.includes(p.norm)) || (l.length > 0 && (l.includes(p.norm) || (l.length >= MIN_MATCH_LEN && p.norm.includes(l)))));
}

const findExcluded = (name) => read().excluded.find((p) => sameProgram(p.name, name)) || null;
const findNeeded = (name) => read().needed.find((p) => sameProgram(p.name, name)) || null;

function setExcluded(name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (norm(clean).length < 3) return { ok: false };
  return update((s) => {
    s.needed = s.needed.filter((p) => !sameProgram(p.name, clean));
    if (!s.excluded.some((p) => p.norm === norm(clean))) s.excluded.push({ name: clean, norm: norm(clean), at: Date.now() });
    return { ok: true, name: clean };
  });
}

function setNeeded(name, extra = {}) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (norm(clean).length < 3) return { ok: false };
  return update((s) => {
    const hadExcluded = s.excluded.some((p) => sameProgram(p.name, clean));
    s.excluded = s.excluded.filter((p) => !sameProgram(p.name, clean));
    let rec = s.needed.find((p) => sameProgram(p.name, clean));
    if (!rec) {
      rec = { name: clean, norm: norm(clean), at: Date.now(), tab: null, lastNoTabAt: 0, previewed: {}, ...extra };
      s.needed.push(rec);
    }
    return { ok: true, name: clean, hadExcluded };
  });
}

// ---- белый список вкладок: API для report.js / бота ----
const tabs = () => read().tabs;
// Вкладка с этим gid в белом списке? Без gid (старые вызовы) — пропускаем, чтобы ничего не терять.
const isTabAllowed = (gid) => gid === undefined || gid === null || tabs().whitelist.some((t) => String(t.gid) === String(gid));
const isTabKnown = (gid) => isTabAllowed(gid) || Object.prototype.hasOwnProperty.call(tabs().known, String(gid)) || Object.prototype.hasOwnProperty.call(tabs().asked, String(gid));

function addWhitelistTab(gid, name) {
  return update((s) => {
    const id = String(gid);
    if (!s.tabs.whitelist.some((t) => String(t.gid) === id)) s.tabs.whitelist.push({ name: String(name || id), gid: id, at: Date.now() });
    delete s.tabs.known[id];
    s.tabs.asked[id] = { name: String(name || id), answer: 'yes', at: Date.now() };
    return { ok: true };
  });
}

function blockTab(gid, name) {
  return update((s) => {
    const id = String(gid);
    s.tabs.whitelist = s.tabs.whitelist.filter((t) => String(t.gid) !== id);
    s.tabs.known[id] = String(name || id);
    s.tabs.asked[id] = { name: String(name || id), answer: 'no', at: Date.now() };
    return { ok: true };
  });
}

function markTabAsked(gid, name) {
  return update((s) => {
    s.tabs.asked[String(gid)] = { name: String(name || gid), answer: null, at: Date.now() };
  });
}

// Tabs found for "needed" programs - merged into the tab list of report.js: loadConfig.
const dynamicTabs = () => read().needed.filter((p) => p.tab && p.tab.gid).map((p) => ({ name: p.tab.name || p.name, gid: String(p.tab.gid) }));

module.exports = { tabs, isTabAllowed, isTabKnown, addWhitelistTab, blockTab, markTabAsked, norm, read, update, sameProgram, isExcludedByRules, findExcluded, findNeeded, setExcluded, setNeeded, dynamicTabs, MIN_MATCH_LEN };
