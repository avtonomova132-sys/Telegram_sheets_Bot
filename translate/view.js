const { LANGUAGE_ORDER } = require('./languages');

// "_full" — переводит целиком, целое сообщение, без привязки к конкретному
// собеседнику. Отдельный префикс оставляет место для будущих режимов
// (построчный перевод, коррекция английского Elena) в том же обработчике
// 'callback_query', без пересечения callback_data между режимами.
const TRANSLATE_FULL_PREFIX = 'translate_full:';
// Переводит бота в режим ожидания ответа собеседнику — см.
// handleTranslateReplyText в index.js.
const TRANSLATE_REPLY_PREFIX = 'translate_reply:';

const TRANSLATE_LABELS = { en: 'Translate', es: 'Traducir', ru: 'Перевести' };
const TRANSLATED_LABELS = { en: 'Translated', es: 'Traducido', ru: 'Переведено' };
const REPLY_LABELS = { en: 'Reply', es: 'Responder', ru: 'Ответить' };

// en → es → ru везде — единый порядок языков во всех трёхязычных подписях
// (LANGUAGE_ORDER в languages.js), независимо от того, что 'ru' — "домашний"
// язык для перевода по умолчанию (DEFAULT_TARGET_LANGUAGE) — это разные,
// не связанные друг с другом настройки.
function trilingual(labels) {
  return LANGUAGE_ORDER.map((lang) => labels[lang]).join(' / ');
}

const TRANSLATE_BUTTON_LABEL = `🔄 ${trilingual(TRANSLATE_LABELS)}`;
const TRANSLATED_LABEL = `✅ ${trilingual(TRANSLATED_LABELS)}`;
const REPLY_BUTTON_LABEL = `💬 ${trilingual(REPLY_LABELS)}`;

// Кнопки кладутся под отдельное сообщение-реплай на оригинал (а не под сам
// оригинал) — Telegram не позволяет боту добавить inline-клавиатуру к чужому
// сообщению. Обе кнопки несут messageId оригинала в своём callback_data —
// у каждого сообщения собеседника (даже если их несколько подряд) свой
// независимый набор кнопок, переводить/отвечать можно выборочно.
function buildTranslatePrompt(messageId) {
  return {
    text: `${TRANSLATE_BUTTON_LABEL}\n${REPLY_BUTTON_LABEL}`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: TRANSLATE_BUTTON_LABEL, callback_data: `${TRANSLATE_FULL_PREFIX}${messageId}` },
          { text: REPLY_BUTTON_LABEL, callback_data: `${TRANSLATE_REPLY_PREFIX}${messageId}` },
        ],
      ],
    },
  };
}

module.exports = {
  TRANSLATE_FULL_PREFIX,
  TRANSLATE_REPLY_PREFIX,
  TRANSLATE_BUTTON_LABEL,
  TRANSLATED_LABEL,
  REPLY_BUTTON_LABEL,
  buildTranslatePrompt,
};
