const fs = require('fs');
const path = require('path');

// /data — тот же примонтированный Railway Volume, что уже используется для
// остальных хранилищ бота (verse/progress.js, proekty/store.js, zadachi/store.js).
const ENTRIES_PATH = process.env.DNEVNIK_PATH || '/data/dnevnik.json';
const PROGRESS_PATH = process.env.DNEVNIK_PROGRESS_PATH || '/data/dnevnik_progress.json';

function atomicWrite(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

// ===== Записи (одна запись = один слот, отправленный ботом) =====
// Массив объектов вида:
// {
//   id: "2026-08-27#3",           // dateBali + slotIndex, уникально
//   dateBali, slotIndex, principleNumber, sentAt (ISO),
//   answeredAt: null | ISO,
//   type: null | 'plus' | 'minus',
//   rawText: null | string,       // как есть, что написала/надиктовала Elena
//   text, posvyashenie,           // заполняются для type === 'plus'
//   opora, sozhalenie, antidot, reshenie, // заполняются для type === 'minus'
// }
function readEntries() {
  try {
    const data = JSON.parse(fs.readFileSync(ENTRIES_PATH, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[dnevnik] volume недоступен или файл повреждён, читаю как пустой список:', err.message);
    }
    return [];
  }
}

function writeEntries(entries) {
  atomicWrite(ENTRIES_PATH, entries);
}

function addSentSlot({ dateBali, slotIndex, principleNumber, sentAt }) {
  const entries = readEntries();
  const id = `${dateBali}#${slotIndex}`;
  if (entries.some((e) => e.id === id)) return entries.find((e) => e.id === id); // защита от повторной отправки
  const entry = {
    id,
    dateBali,
    slotIndex,
    principleNumber,
    sentAt,
    answeredAt: null,
    type: null,
    rawText: null,
    text: null,
    posvyashenie: null,
    opora: null,
    sozhalenie: null,
    antidot: null,
    reshenie: null,
  };
  entries.push(entry);
  writeEntries(entries);
  return entry;
}

// Самая старая неотвеченная запись — на неё и должен упасть следующий
// свободный текст/голос от Elena (FIFO: если пропустила несколько слотов
// подряд, первым разбираем самый ранний).
function getOldestPending() {
  const entries = readEntries().filter((e) => !e.answeredAt);
  if (entries.length === 0) return null;
  return entries.sort((a, b) => a.sentAt.localeCompare(b.sentAt))[0];
}

function countPending() {
  return readEntries().filter((e) => !e.answeredAt).length;
}

function saveAnswer(id, fields) {
  const entries = readEntries();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`[dnevnik] запись ${id} не найдена`);
  entries[idx] = {
    ...entries[idx],
    answeredAt: new Date().toISOString(),
    ...fields,
  };
  writeEntries(entries);
  return entries[idx];
}

function hasEntry(id) {
  return readEntries().some((e) => e.id === id);
}

function getRecent(limit = 10) {
  return readEntries()
    .slice()
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
    .slice(0, limit);
}

function getByDateRange(fromDateBali, toDateBali) {
  return readEntries().filter((e) => e.dateBali >= fromDateBali && e.dateBali <= toDateBali);
}

// ===== Прогресс ротации (какой принцип отправлять следующим) =====
function readProgress() {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
  } catch {
    return { lastPrincipleSent: 0 };
  }
}

function getLastPrincipleSent() {
  return readProgress().lastPrincipleSent || 0;
}

// Следующий принцип по кругу 1→10→1→10...
function getNextPrincipleNumber() {
  return (getLastPrincipleSent() % 10) + 1;
}

function setLastPrincipleSent(n) {
  atomicWrite(PROGRESS_PATH, { lastPrincipleSent: n });
}

module.exports = {
  addSentSlot,
  hasEntry,
  getOldestPending,
  countPending,
  saveAnswer,
  getRecent,
  getByDateRange,
  getNextPrincipleNumber,
  setLastPrincipleSent,
};
