// Список хостов WVP — в хранилище бота, а не в коде (Елена, 2026-10-21).
//
// Живёт в файле на постоянном томе Railway (по умолчанию /data/hosts.json,
// переопределяется HOSTS_PATH), поэтому переживает перезапуск и новый деплой.
// При самом первом запуске файла ещё нет — тогда он создаётся из
// host-candidates.json (стартовый список, лежит в репозитории); после этого
// файл на томе — единственный источник правды, а host-candidates.json больше
// не читается. Менять список можно командами бота (/host_add, /host_remove) и
// кнопками при уходе/вступлении в группу — правок кода не нужно.
//
// Для каждого хоста храним @username (тег), Telegram-ID (когда узнали: человек
// нажал кнопку под карточкой, написал боту или написал в группе), имя из
// профиля и признак "писал боту / нажимал Start". Людей сопоставляем по ID, а
// если ID ещё не известен — по @username; если ID известен, а @username
// сменился, запись обновляется сама.
//
// Никакого ИИ и сети — только чтение/запись JSON. Запись атомарная (tmp +
// rename), чтение-изменение-запись выполняются синхронно.

const fs = require('fs');
const path = require('path');

const SEED_PATH = path.join(__dirname, 'host-candidates.json');
// Эти двое больше не хосты: их теги не должны попадать ни в какие списки,
// даже в старый список тегов /check (см. report.js: loadCommunityTags).
const SEED_REMOVED = ['@lp129eric1', '@svet75afan'];

const normUser = (s) => String(s || '').replace(/^@/, '').toLowerCase();
const tagOf = (username) => `@${String(username).replace(/^@/, '')}`;
const nameOf = (user) => [user && user.first_name, user && user.last_name].filter(Boolean).join(' ');

function createHostsStore({ filePath, seedFrom = null, initial = null } = {}) {
  const FILE = filePath || process.env.HOSTS_PATH || '/data/hosts.json';

  function emptyState() {
    return { hosts: [], removed: [], watch: { joinBuffer: [], joinAsked: {}, joinIgnored: {}, leaveAsked: {}, leaveKept: {}, inGroup: {} } };
  }

  function seed() {
    let tags = [];
    try {
      tags = JSON.parse(fs.readFileSync(seedFrom || SEED_PATH, 'utf8'));
    } catch {
      tags = [];
    }
    const state = emptyState();
    state.hosts = tags.map((t) => ({ tag: tagOf(t), username: normUserKeepCase(t), id: null, name: '', started: false, addedAt: Date.now(), source: 'seed' }));
    state.removed = [...SEED_REMOVED];
    return state;
  }

  function normUserKeepCase(t) {
    return String(t).replace(/^@/, '');
  }

  function write(state) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  }

  function read() {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
      state = null;
    }
    if (!state || !Array.isArray(state.hosts)) {
      state = (typeof initial === 'function' ? initial() : null) || seed();
      write(state);
    }
    state.removed = state.removed || [];
    const w = (state.watch = state.watch || {});
    w.joinBuffer = w.joinBuffer || [];
    w.joinAsked = w.joinAsked || {};
    w.joinIgnored = w.joinIgnored || {};
    w.leaveAsked = w.leaveAsked || {};
    w.leaveKept = w.leaveKept || {};
    w.inGroup = w.inGroup || {};
    return state;
  }

  // Synchronous read–change–write.
  function update(fn) {
    const state = read();
    const result = fn(state);
    write(state);
    return result;
  }

  const entries = () => read().hosts.map((h) => ({ ...h }));
  const tags = () => read().hosts.map((h) => h.tag);
  const removedTags = () => read().removed.slice();
  const entryForTag = (tag) => read().hosts.find((h) => normUser(h.tag) === normUser(tag)) || null;

  // Does this Telegram user ({id, username}) correspond to this host entry?
  function matches(entry, user) {
    if (!entry || !user) return false;
    if (entry.id && user.id && Number(entry.id) === Number(user.id)) return true;
    return Boolean(user.username) && normUser(user.username) === normUser(entry.username);
  }

  const findByUser = (user) => read().hosts.find((h) => matches(h, user)) || null;

  // A person was seen (pressed a button, wrote to the bot, wrote in the group).
  // If it is a host: remember the Telegram id and profile name, mark "started"
  // when it was a private message, and follow a changed @username (when the
  // id is already known). Returns { entry, renamedFrom } or null.
  function learn(user, { privateChat = false } = {}) {
    if (!user || !user.id) return null;
    const state = read();
    let host = state.hosts.find((h) => h.id && Number(h.id) === Number(user.id));
    if (!host && user.username) host = state.hosts.find((h) => !h.id && normUser(h.username) === normUser(user.username));
    if (!host) return null;
    const before = JSON.stringify(host);
    let renamedFrom = null;
    if (!host.id) host.id = user.id;
    const name = nameOf(user);
    if (name) host.name = name;
    if (privateChat) host.started = true;
    if (user.language_code) host.lang = user.language_code;
    if (user.username && normUser(user.username) !== normUser(host.username)) {
      renamedFrom = host.tag;
      host.username = user.username;
      host.tag = tagOf(user.username);
    }
    if (JSON.stringify(host) !== before) write(state); // only when something actually changed
    return { entry: { ...host }, renamedFrom };
  }

  // Returns { ok, entry, reason }.
  function add(username, extra = {}) {
    const clean = String(username || '').replace(/^@/, '').trim();
    if (!/^[A-Za-z0-9_]{4,32}$/.test(clean)) return { ok: false, reason: 'bad-name' };
    return update((state) => {
      if (state.hosts.some((h) => normUser(h.username) === normUser(clean) || (extra.id && h.id && Number(h.id) === Number(extra.id)))) return { ok: false, reason: 'exists' };
      const entry = { tag: tagOf(clean), username: clean, id: extra.id || null, name: extra.name || '', started: false, addedAt: Date.now(), source: extra.source || 'manual' };
      state.hosts.push(entry);
      state.removed = state.removed.filter((t) => normUser(t) !== normUser(clean));
      return { ok: true, entry: { ...entry } };
    });
  }

  // identifier: "@name" or a numeric id.
  function remove(identifier) {
    return update((state) => {
      const key = String(identifier || '').trim();
      const idx = state.hosts.findIndex((h) => normUser(h.username) === normUser(key) || (/^\d+$/.test(key) && h.id && Number(h.id) === Number(key)));
      if (idx < 0) return { ok: false, reason: 'not-found' };
      const [gone] = state.hosts.splice(idx, 1);
      if (!state.removed.some((t) => normUser(t) === normUser(gone.tag))) state.removed.push(gone.tag);
      return { ok: true, entry: gone };
    });
  }

  return { FILE, read, write, update, entries, tags, removedTags, entryForTag, matches, findByUser, learn, add, remove, normUser };
}

// The real list (the bot's one source of truth) and a throw-away copy used to
// try the join/leave flow in the test group "Дебаты" without touching it.
const hosts = createHostsStore();

module.exports = { createHostsStore, hosts, normUser, tagOf, nameOf };
