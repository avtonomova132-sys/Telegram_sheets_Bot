const fs = require('fs');
const path = require('path');

const VERSES_PATH = path.join(__dirname, 'verses.json');
// /data — примонтированный Railway Volume, переживает передеплои (обычный
// диск сервиса эфемерный и обнулялся при каждой пересборке).
const PROGRESS_PATH = process.env.VERSE_PROGRESS_PATH || '/data/sent_verses_progress.json';

// "Сегодня" по Бали (Asia/Makassar, фиксированный UTC+8, без DST) в виде
// YYYY-MM-DD — считается прямым сдвигом времени, без завязки на часовой
// пояс контейнера/node-cron.
function baliDateString(d = new Date()) {
  return new Date(d.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function baliHour(d = new Date()) {
  return new Date(d.getTime() + 8 * 60 * 60 * 1000).getUTCHours();
}

function getVerseCount() {
  const verses = JSON.parse(fs.readFileSync(VERSES_PATH, 'utf8'));
  return verses.length;
}

function readProgress() {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
  } catch {
    return { lastSent: 0, lastSentDate: null };
  }
}

function getLastSent() {
  return readProgress().lastSent || 0;
}

// Дата (по Бали) последней реальной отправки — используется, чтобы отличать
// "сегодняшнее изречение ещё не уходило" от "уже уходило сегодня", независимо
// от точного момента, когда сработала проверка.
function getLastSentDate() {
  return readProgress().lastSentDate || null;
}

function setLastSent(n, sentDate) {
  fs.mkdirSync(path.dirname(PROGRESS_PATH), { recursive: true });
  const payload = { lastSent: n, lastSentDate: sentDate !== undefined ? sentDate : getLastSentDate() };
  // Атомарная запись (tmp + rename), чтобы обрыв процесса на полпути записи
  // (например, при рестарте контейнера) не оставил битый/пустой JSON.
  const tmpPath = `${PROGRESS_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, PROGRESS_PATH);
  console.log(`[verse] прогресс сохранён: lastSent=${n}, lastSentDate=${payload.lastSentDate} (${PROGRESS_PATH})`);
}

// Разовая инициализация: если файла прогресса на volume ещё нет (новый volume
// или первый запуск), создаёт его со значением из VERSE_SEED_LAST_SENT вместо
// умолчания 0. Если файл уже существует — значит прогресс уже персистентный,
// переменная окружения полностью игнорируется (иначе прогресс откатывался бы
// назад при каждом передеплое).
function ensureProgressSeeded() {
  if (fs.existsSync(PROGRESS_PATH)) {
    console.log(`[verse] файл прогресса уже существует, lastSent=${getLastSent()} (посев из VERSE_SEED_LAST_SENT пропущен)`);
    return;
  }
  const seed = Number(process.env.VERSE_SEED_LAST_SENT || 0);
  console.log(`[verse] файла прогресса нет — первичный посев из VERSE_SEED_LAST_SENT=${seed}`);
  setLastSent(seed, null);
}

// Разовая РУЧНАЯ коррекция прогресса, если он уже сбился. В отличие от
// ensureProgressSeeded — эта функция срабатывает, даже если файл уже
// существует, но только один раз на каждое НОВОЕ значение
// VERSE_FORCE_LAST_SENT (отслеживается через соседний .force-applied файл),
// поэтому не откатывает прогресс назад при обычных последующих передеплоях,
// если переменную забыли убрать. Дата последней отправки при этом ставится
// на сегодня (по Бали) — чтобы catch-up проверка не восприняла ручную
// коррекцию как "сегодня ещё не отправляли" и не отправила изречение
// повторно в тот же день.
function applyForceOverride() {
  const raw = process.env.VERSE_FORCE_LAST_SENT;
  if (raw === undefined) return;

  const markerPath = `${PROGRESS_PATH}.force-applied`;
  const alreadyApplied = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : null;
  if (alreadyApplied === raw) return;

  setLastSent(Number(raw), baliDateString());
  fs.writeFileSync(markerPath, raw);
  console.log(`[verse] VERSE_FORCE_LAST_SENT=${raw} применён — прогресс принудительно исправлен на lastSent=${raw}`);
}

// Номер следующего неотправленного изречения, или null, если в verses.json
// больше нечего отправлять.
function getNextVerseNumber() {
  const next = getLastSent() + 1;
  return next <= getVerseCount() ? next : null;
}

module.exports = {
  getVerseCount,
  getLastSent,
  getLastSentDate,
  setLastSent,
  getNextVerseNumber,
  ensureProgressSeeded,
  applyForceOverride,
  baliDateString,
  baliHour,
};
