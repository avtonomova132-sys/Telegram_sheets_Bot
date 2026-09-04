// Централизованный список языков, которые понимает групповой перевод.
// Всё, что зависит от набора языков (кнопки, промпты, приоритет перевода по
// умолчанию), собирается отсюда, а не хардкодится по месту — добавить
// четвёртый язык впоследствии значит расширить эти списки, а не искать
// разбросанные if/else по index.js и translate/*.

const LANGUAGES = ['en', 'es', 'ru'];

const LANGUAGE_NAMES = {
  en: 'English',
  es: 'Español',
  ru: 'Русский',
};

// Порядок вывода языков во всех трёхязычных подписях (кнопки, статусы) —
// единый на все сообщения бота, см. translate/view.js.
const LANGUAGE_ORDER = ['en', 'es', 'ru'];

// "Домашний" язык Elena: кнопка "🔄 Перевести" без привязки к конкретному
// собеседнику (обычное сообщение без выбранного "Ответить") переводит любое
// НЕ-домашнее сообщение сюда. Если сообщение уже на домашнем языке —
// переводится на DEFAULT_FALLBACK_LANGUAGE (см. translate/translate.js).
const DEFAULT_TARGET_LANGUAGE = 'ru';
const DEFAULT_FALLBACK_LANGUAGE = 'en';

function isSupportedLanguage(lang) {
  return LANGUAGES.includes(lang);
}

// "en (English), es (Español), ru (Русский)" — для промптов Anthropic
// (translate/translate.js), чтобы список языков не был захардкожен текстом
// внутри каждого промпта отдельно.
function describeLanguages() {
  return LANGUAGES.map((code) => `${code} (${LANGUAGE_NAMES[code]})`).join(', ');
}

// '"en"|"es"|"ru"' — та же идея, но для JSON-схемы, которую мы просим модель
// вернуть.
function languageCodesUnion() {
  return LANGUAGES.map((code) => `"${code}"`).join('|');
}

module.exports = {
  LANGUAGES,
  LANGUAGE_NAMES,
  LANGUAGE_ORDER,
  DEFAULT_TARGET_LANGUAGE,
  DEFAULT_FALLBACK_LANGUAGE,
  isSupportedLanguage,
  describeLanguages,
  languageCodesUnion,
};
