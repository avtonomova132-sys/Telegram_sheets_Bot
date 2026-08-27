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

Текущий принцип №${principle.number}: ${principle.title}
❌ ${principle.negative} — например: ${principle.negativeExamples.join('; ')}
✅ ${principle.positive} — например: ${principle.positiveExamples.join('; ')}

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

// То же самое, но для массива (вечерний пакетный разбор — сразу несколько
// принципов в одном ответе).
function extractJsonArray(rawText) {
  const trimmed = rawText.trim();
  try {
    const direct = JSON.parse(trimmed);
    return Array.isArray(direct) ? direct : null;
  } catch {
    // падаем дальше на regex-попытку
  }

  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;

  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ===== Вечерний пакетный разбор =====
// Список принципов, которые сегодня остались без ответа в момент слота
// (окно PENDING_WINDOW_MINUTES истекло). Elena вечером разбирает их одним
// сообщением, обычно называя номер принципа перед тем, что расскажет.
function buildEveningSystemPrompt(missedPrinciples) {
  const list = missedPrinciples
    .map(
      (p) =>
        `№${p.number}: ${p.title}\n  ❌ ${p.negative} — например: ${p.negativeExamples.join('; ')}\n  ✅ ${p.positive} — например: ${p.positiveExamples.join('; ')}`
    )
    .join('\n\n');
  const numbers = missedPrinciples.map((p) => p.number).join(', ');

  return `Elena вечером разбирает пропущенные за день слоты "шестиразового дневника" (буддийская практика осознанности, традиция Гэше Майкла Роуча/ACI). Вот принципы, которые сегодня остались без ответа в момент напоминания:
${list}

Она одним сообщением (часто через голосовой ввод — сбивчиво, разговорно) рассказывает про один или несколько из них, обычно называя номер принципа перед тем, что расскажет ("принцип такой-то..."), но может и не называть явно — тогда определяй по смыслу, к какому из перечисленных принципов ближе всего относится кусок текста.

ВАЖНО: если Elena явно называет номер принципа своими словами ("принцип два", "по второму принципу" и т.п.) — доверяй этому и относи кусок текста именно к этому принципу, даже если содержание не дословно совпадает с формальной формулировкой принципа. Она сама интерпретирует, как её жизненная ситуация связана с принципом духовно — это нормальная часть практики, а не ошибка. Твоя формулировка принципа — ориентир для понимания категории (тело/речь/ум), а не строгий фильтр для того, что "засчитывается".

Раздели её рассказ на части — по одной на каждый принцип, который она реально затронула. Принципы из списка, которые она НЕ упомянула вообще, — просто не включай в ответ, ничего не выдумывай.

Для каждого затронутого принципа — та же логика, что и для обычной записи:
- type "plus": text (кратко её словами) + posvyashenie (посвящение заслуг, в её стиле "Пусть это семя... станет причиной...")
- type "minus" — через четыре противосилы: opora (по умолчанию "Ради блага всех существ"), sozhalenie (что именно и почему вредно — самое важное), antidot (конкретное противодействие), reshenie (конкретный срок воздержания, не абстрактный)

Ответь СТРОГО валидным JSON-массивом, без markdown, без пояснений. principleNumber — обязательно одно из: ${numbers}.
[
  {
    "principleNumber": число,
    "type": "plus" | "minus",
    "text": "строка (только для plus)",
    "posvyashenie": "строка (только для plus)",
    "opora": "строка (только для minus)",
    "sozhalenie": "строка (только для minus)",
    "antidot": "строка (только для minus)",
    "reshenie": "строка (только для minus)"
  }
]
Если она вообще ничего не сказала по существу ни про один из перечисленных принципов — верни пустой массив [].`;
}

async function parseEveningBatch(missedPrinciples, rawText) {
  if (!anthropic) {
    throw new Error('ANTHROPIC_API_KEY не задан');
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: buildEveningSystemPrompt(missedPrinciples),
    messages: [{ role: 'user', content: rawText }],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || !textBlock.text) {
    throw new Error('пустой ответ от Anthropic API');
  }

  const parsed = extractJsonArray(textBlock.text);
  if (!parsed) {
    console.error('[dnevnik] не удалось найти JSON-массив в вечернем ответе модели, сырой текст:', textBlock.text);
    throw new Error('невалидный JSON-массив в ответе Anthropic API');
  }

  const validNumbers = new Set(missedPrinciples.map((p) => p.number));
  return parsed.filter(
    (item) => validNumbers.has(item.principleNumber) && (item.type === 'plus' || item.type === 'minus')
  );
}

module.exports = { parseDnevnikAnswer, parseEveningBatch, isConfigured };
