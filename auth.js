// Доверенные пользователи для owner-only команд (/добавить, /дубли,
// /разделить, /группы, /обновитьссылки). MY_CHAT_ID всегда доверенный, даже
// если его забыли продублировать в TRUSTED_USER_IDS. Остальных Elena
// добавляет через переменную окружения TRUSTED_USER_IDS на Railway —
// список chat_id через запятую.
const myChatId = process.env.MY_CHAT_ID;

const trustedUserIds = new Set(
  [
    ...(myChatId ? [String(myChatId)] : []),
    ...String(process.env.TRUSTED_USER_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  ]
);

// Если список пуст (ни MY_CHAT_ID, ни TRUSTED_USER_IDS не заданы) — по
// умолчанию отказываем всем, а не пускаем всех подряд: команды в этом списке
// либо тратят деньги (Anthropic API), либо меняют данные на volume.
function isTrustedUser(chatId) {
  return trustedUserIds.has(String(chatId));
}

module.exports = { isTrustedUser };
