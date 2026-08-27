const Anthropic = require('@anthropic-ai/sdk');

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const anthropic = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;
const isConfigured = Boolean(anthropic);

const MODEL = 'claude-sonnet-4-6';

// Четыре противосилы (Опора/Сожаление/Антидот/Решение) — по традиции ACI,
// уточнено с Elena в диалоге. Для плюса — сорадование + посвящение заслуг,
// без структуры четырёх сил (она предназначена именно для очищения).
function buildSystemPrompt(principle) {
  return `Elena ведёт "шестиразовый дневник" — буддийскую практику осознанности по традиции Гэше Майкла Роуча (Алмазный путь/ACI). Несколько раз в день ей приходит принцип, и она голосом или текстом (часто сбивчиво, через голосовой ввод на телефоне) рассказывает, что происходит по этому принципу прямо сейчас.

Текущий принцип №${principle.number} (${principle.category}):
❌ ${principle.negative}
✅ ${principle.positive}

Твоя задача — разобрать её свободный рассказ и превратить в структурированную запись.

1. Определи type: "plus" (в основном хорошее, добродетельное — семя посажено) или "minus" (был негативный момент, который она осознала и хочет проработать). Если в рассказе есть и то, и другое — определяй по тому, что важнее/на чём она сама делает акцент.

2. Если type === "plus":
   - text: краткая (1-2 предложения) выжимка того, что произошло, ЕЁ словами (не выдумывай деталей, которых она не говорила)
   - posvyashenie: короткая фраза-посвящение заслуг в стиле "Пусть это семя [качества] станет причиной [конкретная благая цель]". Если Elena сама сформулировала посвящение — используй его (можно чуть причесать), если нет — предложи короткое, органично связанное с тем, что она рассказала

3. Если type === "minus" — разложи через четыре противосилы (заполняй по словам Elena, не выдумывай факты, но формулируй ясно и кратко, 1 предложение на каждую силу):
   - opora (Опора): на кого опирается, ради какой высшей цели — если явно не сказала, поставь "Ради блага всех существ" по умолчанию
   - sozhalenie (Сожаление): что именно посеяла и почему это вредно — самое важное поле, конкретно, без размытости
   - antidot (Антидот): что делает или сделает прямо сейчас как противодействие (чтение, медитация, передача/преподавание, дебаты, служение/волонтёрство, или понимание пустоты поступка и себя) — если не сказала явно, предложи наиболее подходящий по ситуации
   - reshenie (Решение): конкретный, выполнимый срок воздержания (не абстрактно "больше не буду", а с конкретным сроком) — если не сказала, предложи разумный короткий срок исходя из ситуации

Ответь СТРОГО валидным JSON-объектом, без markdown, без пояснений:
{
  "type": "plus" | "minus",
  "text": "строка (только для plus, иначе пустая строка)",
  "posvyashenie": "строка (только для plus, иначе пустая строка)",
  "opora": "строка (только для minus, иначе пустая строка)",
  "sozhalenie": "строка (только для minus, иначе пустая строка)",
  "antidot": "строка (только для minus, иначе пустая строка)",
  "reshenie": "строка (только для minus, иначе пустая строка)"
}`;
}

async function parseDnevnikAnswer(principle, rawText) {
  if (!anthropic) {
    throw new Error('ANTHROPIC_API_KEY не задан');
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: buildSystemPrompt(principle),
    messages: [{ role: 'user', content: rawText }],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || !textBlock.text) {
    throw new Error('пустой ответ от Anthropic API');
  }

  const parsed = extractJson(textBlock.text);
  if (!parsed) {
    console.error('[dnevnik] не удалось найти JSON в ответе модели, сырой текст:', textBlock.text);
    throw new Error('невалидный JSON в ответе Anthropic API');
  }

  if (parsed.type !== 'plus' && parsed.type !== 'minus') {
    throw new Error(`неожиданный type в ответе: ${parsed.type}`);
  }

  return parsed;
}

// Модель иногда оборачивает JSON в ```json ... ``` несмотря на явную
// просьбу этого не делать, или добавляет пояснение до/после объекта.
// Пробуем напрямую, затем вырезаем блок между первой { и последней }.
function extractJson(rawText) {
  const trimmed = rawText.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // падаем дальше на regex-попытку
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;

  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

module.exports = { parseDnevnikAnswer, isConfigured };
