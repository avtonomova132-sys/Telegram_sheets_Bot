const fs = require('fs');
const path = require('path');

// /data — тот же примонтированный Railway Volume, что уже используется для
// прогресса стихов (см. verse/progress.js), переживает передеплои.
const PEREDACHI_PATH = process.env.PEREDACHI_PATH || '/data/peredachi.json';

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(PEREDACHI_PATH, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[peredachi] volume недоступен или файл повреждён, читаю как пустой список:', err.message);
    }
    return [];
  }
}

function writeAll(records) {
  fs.mkdirSync(path.dirname(PEREDACHI_PATH), { recursive: true });
  // Атомарная запись (tmp + rename), как в verse/progress.js — обрыв процесса
  // на полпути записи не должен оставить битый/пустой JSON.
  const tmpPath = `${PEREDACHI_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2));
  fs.renameSync(tmpPath, PEREDACHI_PATH);
}

// entries — объекты от extractPeredachi (без id/addedAt/rawText), rawText —
// исходный текст сообщения учителя, для отладки.
function addRecords(entries, rawText) {
  const all = readAll();
  const addedAt = new Date().toISOString();

  const saved = entries.map((entry, i) => ({
    id: String(Date.now() + i),
    kurs: entry.kurs || '',
    postfix: entry.postfix || '',
    teacher: entry.teacher || '',
    dateISO: entry.dateISO || '',
    timeMSK: entry.timeMSK || '',
    zanyatie: entry.zanyatie || '',
    zoomLink: entry.zoomLink || '',
    groupLink: entry.groupLink || '',
    addedAt,
    rawText,
  }));

  all.push(...saved);

  try {
    writeAll(all);
  } catch (err) {
    console.error('[peredachi] не удалось записать файл данных (volume недоступен?):', err.message);
    throw new Error('не получилось сохранить на диск — проверь, подключён ли volume');
  }

  return saved;
}

module.exports = { readAll, addRecords };
