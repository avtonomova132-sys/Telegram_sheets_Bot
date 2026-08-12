const fs = require('fs');
const path = require('path');

const VERSES_PATH = path.join(__dirname, 'verses.json');
// /data — примонтированный Railway Volume, переживает передеплои (обычный
// диск сервиса эфемерный и обнулялся при каждой пересборке).
const PROGRESS_PATH = process.env.VERSE_PROGRESS_PATH || '/data/sent_verses_progress.json';

function getVerseCount() {
  const verses = JSON.parse(fs.readFileSync(VERSES_PATH, 'utf8'));
  return verses.length;
}

function getLastSent() {
  try {
    const data = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
    return data.lastSent || 0;
  } catch {
    return 0;
  }
}

function setLastSent(n) {
  fs.mkdirSync(path.dirname(PROGRESS_PATH), { recursive: true });
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify({ lastSent: n }, null, 2));
}

// Разовая инициализация: если файла прогресса на volume ещё нет (новый volume
// или первый запуск), создаёт его со значением из VERSE_SEED_LAST_SENT вместо
// умолчания 0 — нужно было один раз выставить lastSent=1 (уже отправляли
// изречение №1), чтобы дальше не отправлять его повторно после сброса диска.
function ensureProgressSeeded() {
  if (fs.existsSync(PROGRESS_PATH)) return;
  const seed = Number(process.env.VERSE_SEED_LAST_SENT || 0);
  setLastSent(seed);
}

// Номер следующего неотправленного изречения, или null, если в verses.json
// больше нечего отправлять.
function getNextVerseNumber() {
  const next = getLastSent() + 1;
  return next <= getVerseCount() ? next : null;
}

module.exports = { getVerseCount, getLastSent, setLastSent, getNextVerseNumber, ensureProgressSeeded };
