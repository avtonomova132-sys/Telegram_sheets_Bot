// Тривиальные реплики (приветствия/прощания/благодарности/односложные
// ответы) на любом из трёх языков группы (en/es/ru) — под такими бот не
// ставит кнопки перевода: незачем гонять Anthropic API на "hi"/"ok"/"👍", и
// не нужно засорять чат лишними кнопками под очевидным.
const TRIVIAL_PHRASES = [
  // en
  'hi', 'hello', 'hey', 'hiya', 'yo',
  'good morning', 'good afternoon', 'good evening', 'good night',
  'ok', 'okay', 'k', 'thanks', 'thank you', 'thanks a lot', 'thank you so much',
  'thank you very much', 'thx', 'ty', 'no problem', "you're welcome", 'welcome',
  'bye', 'goodbye', 'see you', 'see you later', 'cya',
  'yes', 'yep', 'yeah', 'no', 'nope', 'sure', 'please',

  // es
  'hola', 'buenos días', 'buenos dias', 'buenas tardes', 'buenas noches',
  'vale', 'ok', 'okey', 'gracias', 'muchas gracias', 'de nada',
  'adiós', 'adios', 'chao', 'chau', 'nos vemos',
  'sí', 'si', 'no', 'por favor', 'bien',

  // ru
  'привет', 'здравствуйте', 'здравствуй', 'доброе утро', 'добрый день', 'добрый вечер',
  'спокойной ночи', 'пока', 'до свидания', 'увидимся',
  'спасибо', 'большое спасибо', 'пожалуйста', 'да', 'нет', 'ладно', 'хорошо', 'ок', 'окей',
];

// Убирает эмодзи и лёгкую пунктуацию, схлопывает пробелы — чтобы "Ok! 👍",
// "  THANKS  " и "gracias." совпадали с одной и той же записью в TRIVIAL_SET.
// \p{Extended_Pictographic} ловит эмодзи включая многосоставные
// (например, флаги/ZWJ-последовательности) без отдельного списка символов.
function normalize(text) {
  return text
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\p{Emoji_Modifier}/gu, '') // тон кожи (Fitzpatrick) — отдельный codepoint после базового эмодзи
    .replace(/[\u200d\ufe0f]/g, '') // zero-width joiner / variation selector, остаются после составных эмодзи
    .replace(/[.,!?;:()"'«»…\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const TRIVIAL_SET = new Set(TRIVIAL_PHRASES.map(normalize));

// true — если сообщение целиком состоит из тривиальной фразы (плюс, может
// быть, эмодзи), либо вообще только из эмодзи/пунктуации без текста —
// кнопки перевода под таким не нужны. Сообщение вида "hi Juan" НЕ считается
// тривиальным — только точное совпадение целиком, не фраза-внутри-фразы.
function isTrivialMessage(text) {
  const normalized = normalize(text);
  if (normalized === '') return true;
  return TRIVIAL_SET.has(normalized);
}

module.exports = { isTrivialMessage };
