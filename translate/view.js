// Шаг 1 из трёх задуманных режимов группового перевода (дальше — построчный
// режим и коррекция английского Elena, см. index.js). Префикс "_full" — чтобы
// последующие режимы (построчный, коррекция) могли использовать свои
// callback_data-префиксы в том же обработчике 'callback_query', не пересекаясь
// с этим.
const TRANSLATE_FULL_PREFIX = 'translate_full:';
const TRANSLATE_BUTTON_LABEL = '🔄 Перевести';
const TRANSLATED_LABEL = '✅ Переведено';

// Кнопка кладётся под отдельное сообщение-реплай на оригинал (а не под сам
// оригинал) — Telegram не позволяет боту добавить inline-клавиатуру к чужому
// сообщению.
function buildTranslatePrompt(messageId) {
  return {
    text: TRANSLATE_BUTTON_LABEL,
    reply_markup: {
      inline_keyboard: [[{ text: TRANSLATE_BUTTON_LABEL, callback_data: `${TRANSLATE_FULL_PREFIX}${messageId}` }]],
    },
  };
}

module.exports = {
  TRANSLATE_FULL_PREFIX,
  TRANSLATE_BUTTON_LABEL,
  TRANSLATED_LABEL,
  buildTranslatePrompt,
};
