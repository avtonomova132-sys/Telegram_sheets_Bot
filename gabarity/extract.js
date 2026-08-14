const Anthropic = require('@anthropic-ai/sdk');

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const anthropic = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;

const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `Ты помогаешь распознавать данные с фото товаров для исправления габаритов на Ozon. На фото может быть:
1) этикетка/бирка с белым фоном, на которой написан артикул товара — обычно строкой вида "Арт.: ..." или просто "Артикул ..."; рядом может быть приложена линейка/рулетка к товару, показывающая одно или несколько измерений в сантиметрах;
2) электронные весы с товаром, показывающие массу в килограммах.

Твоя задача — извлечь то, что реально видно на ЭТОМ ОДНОМ фото (не выдумывай и не додумывай), и вернуть СТРОГО валидный JSON-объект, без markdown-разметки (без \`\`\`), без пояснений — только сам JSON:
{
  "articleId": "артикул точно как написан на этикетке, или null если артикул на фото не виден или текст нечитаем",
  "measurements": [
    { "axis": "width" | "length" | "height" | "unknown", "valueCm": число }
  ],
  "weightKg": число или null, если весов на фото нет или показания нечитаемы
}

Правила для measurements:
- Если рядом с числом на линейке/рулетке есть подпись, явно указывающая сторону (например "Шир-", "Ширина", "Ш:", "Дл-", "Длина", "Д:", "Выс-", "Высота", "В:", "width", "length", "height") — используй её, чтобы задать axis: "width", "length" или "height".
- Если измерение видно, но подписи стороны нет и по фото однозначно не определить, какая это сторона — верни его с axis: "unknown". НЕ угадывай сторону, если это явно не следует из подписи на фото.
- Если на фото видно несколько измерений с разными подписями — верни несколько объектов.
- Если на фото вообще нет видимой линейки/рулетки с числом — верни пустой массив [].
- Числа — в сантиметрах, с десятыми, если видна дробная часть.
- Если число на линейке нечитаемо или смазано настолько, что нельзя быть уверенным в значении — не включай его в measurements вообще, вместо того чтобы гадать.

Правила для articleId и weightKg:
- Никогда не выдумывай артикул или вес, если их не видно на фото или текст нечитаем — верни null.
- Не путай артикул с другими числами на этикетке (штрихкод, цена, дата) — бери именно то, что явно подписано как артикул/"Арт.:".

Ответ — только JSON-объект, ничего кроме него.`;

// Фото из Telegram после сжатия сервером почти всегда JPEG — на всякий
// случай проверяем сигнатуру PNG по первым байтам.
function guessMediaType(buffer) {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  return 'image/jpeg';
}

const KNOWN_AXES = new Set(['width', 'length', 'height', 'unknown']);

// Анализирует одно фото и возвращает распознанные данные. Каждый вызов
// независим — накопление данных по нескольким фото одного товара делает
// index.js (см. gabaritySessions).
async function analyzePhoto(buffer) {
  if (!anthropic) {
    throw new Error('ANTHROPIC_API_KEY не задан');
  }

  const mediaType = guessMediaType(buffer);
  const base64 = buffer.toString('base64');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: 'Распознай это фото по инструкции и верни JSON.' },
        ],
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || !textBlock.text) {
    throw new Error('пустой ответ от Anthropic API');
  }

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text.trim());
  } catch (err) {
    throw new Error('невалидный JSON в ответе Anthropic API');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('ответ Anthropic API не является объектом');
  }

  return {
    articleId: parsed.articleId ? String(parsed.articleId).trim() : null,
    measurements: Array.isArray(parsed.measurements)
      ? parsed.measurements
          .filter((m) => m && KNOWN_AXES.has(m.axis) && typeof m.valueCm === 'number' && Number.isFinite(m.valueCm))
          .map((m) => ({ axis: m.axis, valueCm: m.valueCm }))
      : [],
    weightKg: typeof parsed.weightKg === 'number' && Number.isFinite(parsed.weightKg) ? parsed.weightKg : null,
  };
}

module.exports = { analyzePhoto, isConfigured: Boolean(anthropic) };
