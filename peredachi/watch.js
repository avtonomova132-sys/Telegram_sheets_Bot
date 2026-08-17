// Пассивный мониторинг Telegram-групп на анонсы передач (см. index.js,
// обработчик bot.on('message', ...) для групп из WATCHED_GROUP_IDS).

// WATCHED_GROUP_IDS — chat_id групп через запятую, которые Elena добавляет
// вручную через переменную окружения на Railway. Пустой список по
// умолчанию — мониторинг не активен, пока она сама не подключит группу.
function getWatchedGroupIds() {
  return new Set(
    String(process.env.WATCHED_GROUP_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

const KEYWORD_RE = /передач|курс|занят|медитац|мост\s*(?:в|к)?\s*алмазн|прямой эфир/i;
const TIME_RE = /\b\d{1,2}[:.]\d{2}\b/;
const DATE_RE =
  /\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b|\b\d{1,2}\s+(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)/i;

// Дешёвая эвристика без вызова Anthropic API — только чтобы отсеять
// заведомо нерелевантные сообщения (болтовню, стикеры, вопросы без даты) и
// не тратить API-вызов на каждое сообщение в группе. Не пытается быть
// точной: ложные срабатывания — это нормально, извлечение (extractPeredachi)
// разберётся точнее; ложные пропуски — то, чего эвристика должна избегать,
// поэтому проверка широкая (дата ИЛИ время + одно из ключевых слов).
function looksLikeAnnouncement(text) {
  if (!text) return false;
  if (!KEYWORD_RE.test(text)) return false;
  return TIME_RE.test(text) || DATE_RE.test(text);
}

module.exports = { getWatchedGroupIds, looksLikeAnnouncement };
