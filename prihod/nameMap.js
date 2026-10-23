// Подтверждённые Еленой соответствия «название в накладной → семья в Озоне».
// Хранится в /data/ozon_name_map.json (переживает передеплой). Начальные
// записи зашиты в SEED и добавляются при первом чтении.

const fs = require('fs');
const path = require('path');
const { norm, dense } = require('./text');

const MAP_PATH = process.env.PRIHOD_NAME_MAP_PATH || '/data/ozon_name_map.json';

// pattern — регулярка по нормализованному названию накладной (norm()),
// family — часть артикула/основы семьи (dense), not — запрещённые семьи.
const SEED = [
  { pattern: "крем для депиляции ladys? для чувствительной кожи|крем для депиляции lady s для чувствительной кожи", family: 'ЗонаБикини' },
  { pattern: 'вдохновение 1 180', family: 'ВдохновеньеДробФунд' },
  { pattern: 'карамель лимончики', family: '250КАРАМЕЛЬ_Лимончики', not: ['250ЛимоннаяКарамель'] },
  { pattern: 'прозрачные? крафт', family: 'КомбиКрафт' },
  { pattern: 'прозрачные? бел', family: 'КомбиБелые' },
];

function read() {
  try {
    const d = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
    if (Array.isArray(d.entries)) return d;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[prihod] ozon_name_map.json повреждён, читаю seed:', err.message);
  }
  return { entries: SEED.map((e) => ({ ...e, seed: true })) };
}

function write(data) {
  fs.mkdirSync(path.dirname(MAP_PATH), { recursive: true });
  const tmp = `${MAP_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, MAP_PATH);
}

// Находит запись для названия строки накладной.
function lookup(invoiceName) {
  const n = norm(invoiceName);
  for (const e of read().entries) {
    try {
      if (new RegExp(e.pattern, 'i').test(n)) return e;
    } catch { /* битая регулярка в файле — пропускаем */ }
  }
  return null;
}

function familyMatches(entry, family) {
  const d = family.stem;
  if (!d.includes(dense(entry.family))) return false;
  return !(entry.not || []).some((x) => d.includes(dense(x)));
}

// Добавляет подтверждённое соответствие (точное нормализованное название).
function remember(invoiceName, family) {
  const data = read();
  const pattern = `^${norm(invoiceName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  if (data.entries.some((e) => e.pattern === pattern)) return false;
  data.entries.push({ pattern, family: family.stem, weightG: family.weightG ?? null, added: new Date().toISOString() });
  write(data);
  return true;
}

module.exports = { lookup, familyMatches, remember, SEED };
