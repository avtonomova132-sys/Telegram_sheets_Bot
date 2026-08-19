const fs = require('fs');
const path = require('path');

// /data — тот же примонтированный Railway Volume, что уже используется для
// прогресса стихов и передач (см. verse/progress.js, peredachi/store.js),
// переживает передеплои.
const PROEKTY_PATH = process.env.PROEKTY_PATH || '/data/proekty.json';

// Файл — объект вида { "YYYY-MM-DD": { itemKey: true/false, ... }, ... },
// один день = один трекер-чеклист, который сбрасывается сам по себе, т.к.
// каждый новый день начинается с пустой записи.
function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(PROEKTY_PATH, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[proekty] volume недоступен или файл повреждён, читаю как пустой объект:', err.message);
    }
    return {};
  }
}

function writeAll(data) {
  fs.mkdirSync(path.dirname(PROEKTY_PATH), { recursive: true });
  // Атомарная запись (tmp + rename), как в остальных хранилищах на volume —
  // обрыв процесса на полпути записи не должен оставить битый/пустой JSON.
  const tmpPath = `${PROEKTY_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, PROEKTY_PATH);
}

// Запись за dateKey, либо пустой объект, если за этот день ещё ничего не
// отмечали (новый день — новый чек-лист).
function getDay(dateKey) {
  return readAll()[dateKey] || {};
}

// Переключает один пункт за dateKey и сохраняет. Возвращает обновлённую
// запись дня.
function toggleItem(dateKey, itemKey) {
  const all = readAll();
  const day = { ...(all[dateKey] || {}) };
  day[itemKey] = !day[itemKey];
  all[dateKey] = day;

  try {
    writeAll(all);
  } catch (err) {
    console.error('[proekty] не удалось записать файл данных (volume недоступен?):', err.message);
    throw new Error('не получилось сохранить на диск — проверь, подключён ли volume');
  }

  return day;
}

module.exports = { readAll, getDay, toggleItem };
