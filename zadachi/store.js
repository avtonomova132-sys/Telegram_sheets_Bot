const fs = require('fs');
const path = require('path');

// /data — тот же примонтированный Railway Volume, что уже используется для
// остальных хранилищ бота (verse/progress.js, peredachi/store.js,
// proekty/store.js), переживает передеплои.
const ZADACHI_PATH = process.env.ZADACHI_PATH || '/data/zadachi.json';

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(ZADACHI_PATH, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[zadachi] volume недоступен или файл повреждён, читаю как пустой список:', err.message);
    }
    return [];
  }
}

function writeAll(records) {
  fs.mkdirSync(path.dirname(ZADACHI_PATH), { recursive: true });
  // Атомарная запись (tmp + rename), как в остальных хранилищах на volume —
  // обрыв процесса на полпути записи не должен оставить битый/пустой JSON.
  const tmpPath = `${ZADACHI_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2));
  fs.renameSync(tmpPath, ZADACHI_PATH);
}

// dateISO/timeMSK — уже распознанные items-parser'ом поля (МСК, могут быть
// пустыми). datetime в самой записи хранится одной строкой: полный ISO с
// offset +03:00, если известны и дата, и время; просто "YYYY-MM-DD", если
// известна только дата; null, если не упомянуты вовсе.
function buildDatetime(dateISO, timeMSK) {
  if (!dateISO) return null;
  return timeMSK ? `${dateISO}T${timeMSK}:00+03:00` : dateISO;
}

// Одного Date.now() недостаточно — две задачи, добавленные почти
// одновременно (например, обе распознаны и сохранены в пределах одного
// тика event loop), могут получить одинаковый timestamp. Случайный суффикс
// убирает коллизию без внешних зависимостей.
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function addTask({ project, text, dateISO, timeMSK }) {
  const all = readAll();
  const record = {
    id: generateId(),
    project,
    text,
    datetime: buildDatetime(dateISO, timeMSK),
    createdAt: new Date().toISOString(),
    done: false,
  };
  all.push(record);

  try {
    writeAll(all);
  } catch (err) {
    console.error('[zadachi] не удалось записать файл данных (volume недоступен?):', err.message);
    throw new Error('не получилось сохранить на диск — проверь, подключён ли volume');
  }

  return record;
}

// Отмечает задачу выполненной по id, не удаляя из файла (done: true).
// Возвращает обновлённую запись, либо null, если такой задачи нет —
// например, её уже отметили выполненной из другого чата/раньше.
function markDone(id) {
  const all = readAll();
  const record = all.find((r) => r.id === id);
  if (!record) return null;

  record.done = true;

  try {
    writeAll(all);
  } catch (err) {
    console.error('[zadachi] не удалось записать файл данных (volume недоступен?):', err.message);
    throw new Error('не получилось сохранить на диск — проверь, подключён ли volume');
  }

  return record;
}

function getOpenTasks() {
  return readAll().filter((r) => !r.done);
}

module.exports = { readAll, addTask, markDone, getOpenTasks };
