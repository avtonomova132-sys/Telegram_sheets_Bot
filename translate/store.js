const fs = require('fs');
const path = require('path');

// /data — тот же примонтированный Railway Volume, что и для передач
// (см. peredachi/store.js), переживает передеплои.
const TRANSLATE_CHATS_PATH = process.env.TRANSLATE_CHATS_PATH || '/data/translate_chats.json';

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(TRANSLATE_CHATS_PATH, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[translate] volume недоступен или файл повреждён, читаю как пустой список:', err.message);
    }
    return [];
  }
}

function writeAll(chatIds) {
  fs.mkdirSync(path.dirname(TRANSLATE_CHATS_PATH), { recursive: true });
  // Атомарная запись (tmp + rename), как в peredachi/store.js.
  const tmpPath = `${TRANSLATE_CHATS_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(chatIds, null, 2));
  fs.renameSync(tmpPath, TRANSLATE_CHATS_PATH);
}

function isEnabled(chatId) {
  return readAll().includes(String(chatId));
}

function enable(chatId) {
  const all = readAll();
  const id = String(chatId);
  if (!all.includes(id)) {
    all.push(id);
    writeAll(all);
  }
}

function disable(chatId) {
  const all = readAll();
  const id = String(chatId);
  const filtered = all.filter((existing) => existing !== id);
  if (filtered.length !== all.length) {
    writeAll(filtered);
  }
}

module.exports = { isEnabled, enable, disable };
