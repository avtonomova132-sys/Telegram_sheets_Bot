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

// Tabs found for "needed" programs - merged into the tab list of report.js: loadConfig.
const dynamicTabs = () => read().needed.filter((p) => p.tab && p.tab.gid).map((p) => ({ name: p.tab.name || p.name, gid: String(p.tab.gid) }));

module.exports = { norm, read, update, sameProgram, isExcludedByRules, findExcluded, findNeeded, setExcluded, setNeeded, dynamicTabs, MIN_MATCH_LEN };
