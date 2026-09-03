const fs = require('fs');
const path = require('path');

// /data — тот же примонтированный Railway Volume, что уже используется для
// прогресса стихов и передач (см. verse/progress.js, peredachi/store.js),
// переживает передеплои.
const EVENTS_PATH = process.env.EVENTS_PATH || '/data/events.json';

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[events] volume недоступен или файл повреждён, читаю как пустой список:', err.message);
    }
    return [];
  }
}

function writeAll(records) {
  fs.mkdirSync(path.dirname(EVENTS_PATH), { recursive: true });
  // Атомарная запись (tmp + rename), как в остальных хранилищах на volume —
  // обрыв процесса на полпути записи не должен оставить битый/пустой JSON.
  const tmpPath = `${EVENTS_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2));
  fs.renameSync(tmpPath, EVENTS_PATH);
}

// entry — уже провалидированный и дополненный объект (program/format/...
// /date_az.../link), addedBy — telegram-юзернейм или имя того, кто подтвердил.
function addEvent(entry, addedBy) {
  const all = readAll();
  const record = {
    id: String(Date.now()),
    ...entry,
    addedBy: addedBy || '',
    addedAt: new Date().toISOString(),
  };
  all.push(record);

  try {
    writeAll(all);
  } catch (err) {
    console.error('[events] не удалось записать файл данных (volume недоступен?):', err.message);
    throw new Error('не получилось сохранить на диск — проверь, подключён ли volume');
  }

  return record;
}

module.exports = { readAll, addEvent, saveAll: writeAll };
