const fs = require('fs');
const path = require('path');

const VERSES_PATH = path.join(__dirname, 'verses.json');
const PROGRESS_PATH = path.join(__dirname, 'sent_verses_progress.json');

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
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify({ lastSent: n }, null, 2));
}

// Номер следующего неотправленного изречения, или null, если в verses.json
// больше нечего отправлять.
function getNextVerseNumber() {
  const next = getLastSent() + 1;
  return next <= getVerseCount() ? next : null;
}

module.exports = { getVerseCount, getLastSent, setLastSent, getNextVerseNumber };
