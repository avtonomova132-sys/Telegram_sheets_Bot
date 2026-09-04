const Anthropic = require('@anthropic-ai/sdk');
const {
  LANGUAGES,
  LANGUAGE_NAMES,
  DEFAULT_TARGET_LANGUAGE,
  DEFAULT_FALLBACK_LANGUAGE,
  describeLanguages,
  languageCodesUnion,
} = require('./languages');

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const anthropic = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;

const MODEL = 'claude-sonnet-4-6';

function requireAnthropic() {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY не задан');
  return anthropic;
}

function parseJsonResponse(response) {
  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || !textBlock.text) throw new Error('пустой ответ от Anthropic API');
  try {
    return JSON.parse(textBlock.text.trim());
  } catch (err) {
    throw new Error('невалидный JSON в ответе Anthropic API');
  }
}

// Определяет язык сообщения среди поддерживаемых (en/es/ru), без перевода —
// нужно отдельно от translateMessage, например чтобы запомнить язык
// собеседника при нажатии "Ответить", ничего при этом не переводя.
async function detectLanguage(text) {
  const client = requireAnthropic();
  const system =
    `Определи, на каком из следующих языков написано сообщение: ${describeLanguages()}. ` +
    `Ответь СТРОГО JSON без markdown и пояснений: {"lang": ${languageCodesUnion()}}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 32,
    system,
    messages: [{ role: 'user', content: text }],
  });

  const parsed = parseJsonResponse(response);
  return LANGUAGES.includes(parsed.lang) ? parsed.lang : 'en';
}

// Переводит сообщение на конкретный targetLang (используется, когда язык
// получателя уже известен — например, при ответе собеседнику его же языком,
// см. translateReply). Возвращает { sourceLang, translated }.
async function translateMessage(text, targetLang) {
  const client = requireAnthropic();
  const targetName = LANGUAGE_NAMES[targetLang] || targetLang;
  const system =
    `Определи, на каком из следующих языков написано сообщение: ${describeLanguages()}. ` +
    `Переведи сообщение на язык ${targetName} (код ${targetLang}). Если сообщение уже на этом языке — верни его как есть, без изменений. ` +
    `Ответь СТРОГО JSON без markdown и пояснений: {"lang": ${languageCodesUnion()}, "translation": "переведённый текст"}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: text }],
  });

  const parsed = parseJsonResponse(response);
  return {
    sourceLang: LANGUAGES.includes(parsed.lang) ? parsed.lang : null,
    translated: parsed.translation || '',
  };
}

// Кнопка "🔄 Перевести" без выбранного собеседника (обычное сообщение) —
// переводит НЕ-домашние сообщения на домашний язык Elena (DEFAULT_TARGET_LANGUAGE),
// а домашние — на DEFAULT_FALLBACK_LANGUAGE (тот же принцип, что был у
// исходной пары ru<->en, просто теперь с учётом третьего языка). Одним
// вызовом определяет язык, решает целевой и переводит — дешевле, чем два
// отдельных запроса (detectLanguage + translateMessage).
async function translateToDefaultTarget(text) {
  const client = requireAnthropic();
  const homeLang = DEFAULT_TARGET_LANGUAGE;
  const homeName = LANGUAGE_NAMES[homeLang];
  const fallbackLang = DEFAULT_FALLBACK_LANGUAGE;
  const fallbackName = LANGUAGE_NAMES[fallbackLang];
  const system =
    `Определи, на каком из следующих языков написано сообщение: ${describeLanguages()}.\n` +
    `Если сообщение на языке ${homeName} (${homeLang}) — переведи его на ${fallbackName} (${fallbackLang}).\n` +
    `Если сообщение на любом другом из этих языков — переведи его на ${homeName} (${homeLang}).\n` +
    'Ответь СТРОГО JSON без markdown и пояснений: ' +
    `{"sourceLang": ${languageCodesUnion()}, "targetLang": "${homeLang}"|"${fallbackLang}", "translation": "переведённый текст"}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: text }],
  });

  return parseJsonResponse(response);
}

// Разбирает ответ Elena/организатора на сообщение собеседника (см. кнопку
// "💬 Ответить" в index.js): либо переводит ответ на язык собеседника
// (targetLang), либо — если смысл ответа непонятен — возвращает уточняющий
// вопрос НА ЯЗЫКЕ САМОГО ОТВЕЧАЮЩЕГО, чтобы задать его в группе, ничего не
// пересылая собеседнику, пока не прояснится.
async function translateReply(replyText, { originalText, targetLang }) {
  const client = requireAnthropic();
  const targetName = LANGUAGE_NAMES[targetLang] || targetLang;
  const system =
    'Собеседник написал сообщение (см. "Исходное сообщение" ниже), ему отвечает другой участник группы (см. "Ответ").\n' +
    `Твоя задача — подготовить перевод "Ответа" на язык ${targetName} (код ${targetLang}), чтобы переслать его собеседнику.\n\n` +
    'Если по "Ответу" понятно, что имел в виду отвечающий (даже если ответ короткий или неформальный) — переведи его ' +
    `на ${targetName} и верни как есть, по смыслу.\n\n` +
    'Если "Ответ" слишком неясен, оборван по смыслу или бессмыслен, чтобы его можно было уверенно перевести и переслать — ' +
    'не переводи, а сформулируй короткий уточняющий вопрос ДЛЯ ОТВЕЧАЮЩЕГО (не для собеседника), на языке, на котором ' +
    'написан сам "Ответ".\n\n' +
    `Исходное сообщение: ${originalText}\n\n` +
    'Ответь СТРОГО JSON без markdown и пояснений в одном из двух видов:\n' +
    `{"clear": true, "responderLang": ${languageCodesUnion()}, "translation": "..."}\n` +
    `{"clear": false, "responderLang": ${languageCodesUnion()}, "clarifyingQuestion": "..."}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: replyText }],
  });

  return parseJsonResponse(response);
}

module.exports = { detectLanguage, translateMessage, translateToDefaultTarget, translateReply };
