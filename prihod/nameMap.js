// Словарь «название в накладной → основа семьи артикулов Озона».
// Хранится в /data/ozon_name_map.json (переживает передеплой). Начальные
// записи зашиты в SEED. Елена нажала кнопку → соответствие запоминается
// сразу (в том числе «Нет в Озоне» — с пометкой, что можно переспросить,
// когда в каталоге появятся новые карточки).

const fs = require('fs');
const path = require('path');
const { norm, dense } = require('./text');
const { articleBase, baseNoWeight } = require('./family');

const MAP_PATH = process.env.PRIHOD_NAME_MAP_PATH || '/data/ozon_name_map.json';

// pattern — регулярка по нормализованному названию накладной (norm()),
// family — основа семьи (часть артикула, dense-сравнение), not — запрещённые.
const SEED = [
  { pattern: "крем для депиляции ladys? для чувствительной кожи|крем для депиляции lady s для чувствительной кожи", family: 'ЗонаБикини' },
  { pattern: 'вдохновение 1 180', family: 'ВдохновеньеДробФунд' },
  { pattern: 'карамель лимончики', family: '250КАРАМЕЛЬ_Лимончики', not: ['250ЛимоннаяКарамель'] },
  { pattern: 'прозрачные? крафт', family: 'КомбиКрафт' },
  { pattern: 'прозрачные? бел', family: 'КомбиБелые' },
];

// В словаре хранится только «название в накладной → ОСНОВА семьи» (артикул без
// числа штук). Семья (все числа штук) каждый раз собирается из каталога заново.
// Версия 2: старые записи могли хранить конкретный артикул («…Ментол1») —
// приводим к основе, дубли по названию схлопываем (последняя запись главнее).
const VERSION = 2;

function migrate(data) {
  const byPattern = new Map();
  let changed = 0;
  for (const e of data.entries) {
    let entry = e;
    if (!e.seed && !e.none && e.family) {
      const base = articleBase(e.family);
      if (base !== e.family || 'article' in e) changed += 1;
      entry = { ...e, family: base };
      delete entry.article;
    }
    if (byPattern.has(e.pattern)) changed += 1;
    byPattern.delete(e.pattern);
    byPattern.set(e.pattern, entry);
  }
  if (changed) console.log(`[prihod] словарь названий приведён к основам семей (изменено записей: ${changed})`);
  return { version: VERSION, entries: [...byPattern.values()] };
}

function read() {
  try {
    const d = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
    if (Array.isArray(d.entries)) {
      if ((d.version || 1) >= VERSION) return d;
      const migrated = migrate(d);
      try { write(migrated); } catch (err) { console.error('[prihod] не удалось записать мигрированный словарь:', err.message); }
      return migrated;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[prihod] ozon_name_map.json повреждён, читаю seed:', err.message);
  }
  return { version: VERSION, entries: SEED.map((e) => ({ ...e, seed: true })) };
}

function write(data) {
  fs.mkdirSync(path.dirname(MAP_PATH), { recursive: true });
  const tmp = `${MAP_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, MAP_PATH);
}

// Находит запись для названия строки накладной; позднее добавленное
// (решение Елены) важнее начальных записей.
function lookup(invoiceName) {
  const n = norm(invoiceName);
  const entries = read().entries;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    try {
      if (new RegExp(e.pattern, 'i').test(n)) return e;
    } catch { /* битая регулярка — пропускаем */ }
  }
  return null;
}

function familyMatches(entry, family) {
  const want = dense(entry.family);
  const wantKey = dense(baseNoWeight(String(entry.family)));
  const ok = entry.exact ? family.stems.includes(want) || family.key === wantKey : family.stems.some((s) => s.includes(want));
  return ok && !(entry.not || []).some((x) => family.stems.some((s) => s.includes(dense(x))));
}

function save(entry) {
  const data = read();
  const rest = data.entries.filter((e) => e.pattern !== entry.pattern);
  rest.push({ ...entry, added: new Date().toISOString() });
  write({ version: VERSION, entries: rest });
}

const exactPattern = (name) => `^${norm(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

function remember(invoiceName, family) {
  save({ pattern: exactPattern(invoiceName), family: family.base, exact: true, weightG: family.weightG ?? null });
}

// «Нет в Озоне»: familyCount — сколько семей было в каталоге; если их
// станет больше, строку можно переспросить.
function rememberNone(invoiceName, familyCount) {
  save({ pattern: exactPattern(invoiceName), none: true, recheck: true, familyCount });
}

module.exports = { lookup, familyMatches, remember, rememberNone, SEED };
