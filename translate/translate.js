const Anthropic = require('@anthropic-ai/sdk');

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const anthropic = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;

const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT =
  'Переведи сообщение. Если на русском — переведи на английский. Если на английском — переведи на русский. Ответь только переводом, без пояснений.';

async function translateMessage(text) {
  if (!anthropic) {
    throw new Error('ANTHROPIC_API_KEY не задан');
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: text }],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || !textBlock.text) {
    throw new Error('пустой ответ от Anthropic API');
  }

  return textBlock.text.trim();
}

module.exports = { translateMessage };
