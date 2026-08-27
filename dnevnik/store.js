const fs = require('fs');
const path = require('path');
const { PENDING_WINDOW_MINUTES } = require('./schedule');

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
//   dateBali, slotIndex, principleNumber, sentAt (ISO), expiresAt (ISO),
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
  const expiresAt = new Date(new Date(sentAt).getTime() + PENDING_WINDOW_MINUTES * 60 * 1000).toISOString();
  const entry = {
    id,
    dateBali,
    slotIndex,
    principleNumber,
    sentAt,
    expiresAt,
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

// Самая старая ЖИВАЯ (в пределах PENDING_WINDOW_MINUTES) неотвеченная
// запись — на неё падает следующий свободный текст/голос "в моменте".
// Как только окно истекло — запись сюда больше не попадает, она "тихо"
// становится пропущенной и ждёт вечернего разбора (см. getMissedToday),
// а очередь не держит следующие слоты.
function getOldestPending() {
  const now = new Date();
  const entries = readEntries().filter((e) => !e.answeredAt && new Date(e.expiresAt) > now);
  if (entries.length === 0) return null;
  return entries.sort((a, b) => a.sentAt.localeCompare(b.sentAt))[0];
}

// То же самое, но для отображения ("сколько сейчас ещё живых, не отвеченных").
function countPending() {
  const now = new Date();
  return readEntries().filter((e) => !e.answeredAt && new Date(e.expiresAt) > now).length;
}

// Пропущенные слоты именно СЕГОДНЯШНЕГО дня — окно истекло, ответа не было.
// Не тянутся из прошлых дней: если вчера что-то пропустила — оно просто
// осталось пропущенным, не будет всплывать бесконечно.
function getMissedToday(dateBali) {
  const now = new Date();
  return readEntries().filter(
    (e) => e.dateBali === dateBali && !e.answeredAt && new Date(e.expiresAt) <= now
  );
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

// ===== Прогресс (ротация принципов + флаг вечерней сводки) =====
// Один и тот же файл хранит оба поля — writeProgress всегда мёржит поверх
// текущего состояния, чтобы одна функция не затирала поле, записанное другой.
function readProgress() {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
  } catch {
    return { lastPrincipleSent: 0, eveningSummaryDate: null };
  }
}

function writeProgress(patch) {
  atomicWrite(PROGRESS_PATH, { ...readProgress(), ...patch });
}

function getLastPrincipleSent() {
  return readProgress().lastPrincipleSent || 0;
}

// Следующий принцип по кругу 1→10→1→10...
function getNextPrincipleNumber() {
  return (getLastPrincipleSent() % 10) + 1;
}

function setLastPrincipleSent(n) {
  writeProgress({ lastPrincipleSent: n });
}

function getEveningSummaryDate() {
  return readProgress().eveningSummaryDate || null;
}

function setEveningSummaryDate(dateBali) {
  writeProgress({ eveningSummaryDate: dateBali });
}

module.exports = {
  addSentSlot,
  hasEntry,
  getOldestPending,
  countPending,
  getMissedToday,
  saveAnswer,
  getRecent,
  getByDateRange,
  getNextPrincipleNumber,
  setLastPrincipleSent,
  getEveningSummaryDate,
  setEveningSummaryDate,
};
