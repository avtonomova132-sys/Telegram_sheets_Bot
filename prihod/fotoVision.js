// Текст этикетки с фото самой дешёвой подходящей моделью (Haiku 5.5): «Арт: …»,
// название, бренд, вес и — только если штрихкод не читается программно — цифры
// под штрихкодом. Вызывается ТОЛЬКО когда штрихкод не нашёл товар: в обычном
// случае фото вообще не уходит в модель. Фото не сохраняется.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.FOTO_MODEL || 'claude-haiku-5-5';
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 60000 }) : null;

// Цены за 1M токенов (input/output) для оценки в логе; $0.10/$0.50 — Haiku 5.5.
const PRICE = { 'claude-haiku-5-5': [0.1, 0.5], 'claude-haiku-4-5': [1, 5], 'claude-sonnet-5-5': [2, 10] };

const SYSTEM = `Ты читаешь фото этикетки/упаковки товара на складе. Верни СТРОГО JSON без markdown:
{"article":"текст после «Арт:» / «Артикул:» дословно, иначе \\"\\"","name":"название товара","brand":"бренд","weight_g":число|null,"barcode_digits":"цифры под штрихкодом, если читаются уверенно, иначе \\"\\"","legible":true|false}
Не выдумывай: нечитаемое — пустая строка или null. Рукописные пометки, даты срока годности и числа остатка игнорируй — их не надо вносить ни в одно поле.`;

function costOf(model, usage) {
  const p = PRICE[model];
  if (!p || !usage) return null;
  return ((usage.input_tokens || 0) * p[0] + (usage.output_tokens || 0) * p[1]) / 1e6;
}

async function call(buffer, mediaType, extra) {
  const base = {
    model: MODEL,
    max_tokens: 400,
    system: SYSTEM,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
      { type: 'text', text: 'Прочитай этикетку.' },
    ] }],
  };
  try {
    return await anthropic.messages.create({ ...base, ...extra });
  } catch (err) {
    // модель не принимает thinking/output_config — повторяем без них
    if (extra && /thinking|output_config|effort/i.test(String(err.message))) return anthropic.messages.create(base);
    throw err;
  }
}

async function readLabel(buffer, mediaType = 'image/jpeg') {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY не задан');
  const res = await call(buffer, mediaType, { thinking: { type: 'disabled' }, output_config: { effort: 'low' } });
  const text = res.content.find((b) => b.type === 'text')?.text || '';
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error('модель вернула не JSON');
  const data = JSON.parse(m[0]);
  const usd = costOf(MODEL, res.usage);
  console.log(`[foto] vision ${MODEL}: in ${res.usage?.input_tokens} out ${res.usage?.output_tokens}${usd !== null ? ` ≈ $${usd.toFixed(5)}` : ''}`);
  return {
    article: String(data.article || '').trim(),
    name: String(data.name || '').trim(),
    brand: String(data.brand || '').trim(),
    weightG: Number.isFinite(Number(data.weight_g)) && Number(data.weight_g) > 0 ? Number(data.weight_g) : null,
    barcodeDigits: String(data.barcode_digits || '').replace(/\s+/g, ''),
    legible: data.legible !== false,
    usd,
  };
}

module.exports = { readLabel, MODEL, costOf };
