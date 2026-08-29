const Anthropic = require('@anthropic-ai/sdk');

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const anthropic = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;
const isConfigured = Boolean(anthropic);

const MODEL = 'claude-sonnet-4-6';

// Инструкция по разбору ОДНОГО плюса и ОДНОГО минуса — переиспользуется в
// описании массивов pluses/minuses.
const MOMENT_INSTRUCTIONS = `Каждый элемент pluses — один добрый момент:
   - text: краткая (1-2 предложения) выжимка того, что произошло, ЕЁ словами (не выдумывай деталей, которых она не говорила)
   - radost (Радость): короткая фраза о том, ЧТО именно приятного/радостного она ощутила от этого поступка — не повтор text, а именно прожитое чувство ("Как приятно, что...", "Радуюсь, что..."). Это отдельный шаг — прежде чем посвящать, нужно сначала явно ощутить и назвать радость, чтобы усилить семя
   - posvyashenie: короткая фраза-посвящение заслуг в стиле "Пусть это семя [качества] станет причиной [конкретная благая цель]". Если Elena сама сформулировала посвящение — используй его (можно чуть причесать), если нет — предложи короткое, органично связанное с тем, что она рассказала

Каждый элемент minuses — один негативный момент, разложенный через четыре противосилы (заполняй по словам Elena, не выдумывай факты, но формулируй ясно и кратко, 1-2 предложения на каждую силу):
   - opora (Опора): на кого опирается, ради какой высшей цели — если явно не сказала, поставь "Ради блага всех существ" по умолчанию
   - sozhalenie (Сожаление) — самое важное поле, ВСЕГДА ретроспективное по логике причины и следствия (подтверждено с Дхарма ИИ), и одинаково — что для собственного импульса/действия ПРЯМО СЕЙЧАС (например захотелось съесть что-то в одиночку, не поделившись), что для того, что произошло С НЕЙ (её покритиковали, обвинили, задели). В обоих случаях формулируй не как констатацию "я сейчас делаю/чувствую плохое", а как вопрос-осознание: "Почему это чувство/импульс/ситуация всходит именно сейчас? Потому что в прошлом я, вероятно, [подобное действие], осознанно или неосознанно." Не нужно вспоминать конкретный случай — обобщённая формулировка нормальна: если есть плод, значит было семя, это логический вывод, а не точное воспоминание. Это НЕ вина (статичное, парализующее чувство), а сожаление (динамичная решимость) — как противоядие после яда, а не самобичевание за то, что его съела. Если реагировать на любой негативный момент (свой или чужой) гневом или сопротивлением — это сажает НОВОЕ семя и не останавливает "кармическое эхо"; именно спокойное сожаление его останавливает.
   - antidot (Антидот): конкретное противодействие прямо сейчас. Особенно для случаев самокритики/обесценивания себя после в целом доброго поступка — сильный вариант это САМО-СОРАДОВАНИЕ: прямо назвать, что именно в её порыве/действии было искренним и добрым, вспомнить это явно, чтобы восстановить семя. Другие варианты: чтение (древних текстов), медитация, передача/преподавание (в т.ч. проведение учебных курсов, передач), дебаты, служение/волонтёрство, понимание пустоты поступка и себя. Выбирай наиболее подходящий по ситуации, если не сказала явно
   - reshenie (Решение): конкретный, выполнимый срок — предпочтительно КОРОТКИЙ (от нескольких минут до пары часов), а не дни или недели: короткое, реально выполнимое обязательство побеждает привычку эффективнее долгого. Не абстрактно "больше не буду", а с конкретным сроком — если не сказала, предложи короткий срок исходя из ситуации

ВАЖНО про скрытые минусы внутри рассказа о хорошем: Elena часто рассказывает историю с хорошим концом, но упоминает мимоходом СТАРУЮ привычку или паттерн, контрастом ("раньше я постоянно X, а сегодня — нет/по-другому"). Даже если сегодняшний конкретный эпизод — явный плюс, сама эта старая привычка (тревожность, спешка, потребность контролировать и т.п.) — самостоятельный повод для отдельного minus-элемента с полным разбором через четыре силы, именно как ретроспективное осознание паттерна, который сегодня получилось не повторить. Не пропускай такие детали, даже если они звучат как случайное уточнение, а не как жалоба.`;

function formatPrincipleForPrompt(p) {
  return `№${p.number} (${p.category}): ${p.title}\n  ❌ ${p.negative} — например: ${p.negativeExamples.slice(0, 6).join('; ')}\n  ✅ ${p.positive} — например: ${p.positiveExamples.slice(0, 6).join('; ')}`;
}

const RESULT_SCHEMA = `[
  {
    "principleNumber": число,
    "pluses": [ { "text": "строка", "radost": "строка", "posvyashenie": "строка" } ],
    "minuses": [ { "opora": "строка", "sozhalenie": "строка", "antidot": "строка", "reshenie": "строка" } ]
  }
]`;

// ===== Основной разбор (пакетный, с опциональным "гарантированным" принципом) =====
// Elena часто в одном сообщении описывает НЕСКОЛЬКО отдельных ситуаций —
// иногда про разные принципы сразу, иногда несколько ситуаций ВНУТРИ
// ОДНОГО И ТОГО ЖЕ принципа (например по десятому — сразу два эпизода, один
// плюс и один минус). Раньше схема допускала только один type на принцип и
// всё лишнее молча терялось. Теперь pluses и minuses — МАССИВЫ: сколько
// отдельных ситуаций она реально описала под принципом, столько элементов
// и должно быть, ничего не сжимается в один.
//
// primaryNumber (если задан) — принцип, на который это прямо ответ (кнопка
// или живой слот): модель ОБЯЗАНА включить его в результат хотя бы с одним
// элементом в pluses или minuses. Остальные принципы, если она их тоже явно
// затронула, — бонусом.
function buildBatchSystemPrompt(candidatePrinciples, primaryNumber) {
  const list = candidatePrinciples.map(formatPrincipleForPrompt).join('\n\n');
  const numbers = candidatePrinciples.map((p) => p.number).join(', ');

  const primaryInstruction = primaryNumber
    ? `\n\nВАЖНО: это сообщение пришло как прямой ответ на принцип №${primaryNumber} — ОБЯЗАТЕЛЬНО включи объект с principleNumber ${primaryNumber} и хотя бы одним элементом в pluses или minuses, даже если основная часть текста звучит как что-то другое (в таком случае возьми под этот принцип ту часть рассказа, которая к нему всё же относится). Если Elena рассказывает НЕСКОЛЬКО отдельных ситуаций именно по этому принципу (например два разных эпизода за день — один хороший, один нет) — это НЕСКОЛЬКО элементов в pluses/minuses этого же принципа, не сжимай в один. Если она, кроме этого, ЯВНО и отдельно рассказывает ещё и про другие принципы из списка ниже — включи и их отдельными объектами тоже, не игнорируй.`
    : `\n\nЕсли Elena явно называет номер принципа своими словами ("принцип два", "по второму принципу" и т.п.) — доверяй этому и относи кусок текста именно к этому принципу, даже если содержание не дословно совпадает с формальной формулировкой. Она сама интерпретирует, как её ситуация связана с принципом духовно — это нормальная часть практики, а не ошибка.`;

  return `Elena ведёт "шестиразовый дневник" — буддийскую практику осознанности по традиции Гэше Майкла Роуча (Алмазный путь/ACI). Она голосом или текстом (часто сбивчиво, через голосовой ввод на телефоне) рассказывает, что с ней происходит — часто НЕСКОЛЬКО отдельных ситуаций подряд в одном сообщении, даже в рамках одного и того же принципа.

Принципы, которые сейчас можно связать с этим ответом:
${list}${primaryInstruction}

Раздели её рассказ по принципам, которых он реально касается (может быть один, может быть несколько). Принципы из списка, которых она вообще не касалась, — не включай, ничего не выдумывай.

Внутри каждого принципа — pluses и minuses ОБА массивы (могут быть пустыми, если она рассказывала только хорошее или только плохое по этому принципу). ${MOMENT_INSTRUCTIONS}

Ответь СТРОГО валидным JSON-массивом, без markdown, без пояснений. principleNumber — обязательно одно из: ${numbers}.
${RESULT_SCHEMA}${primaryNumber ? '' : '\nЕсли она вообще ничего не сказала по существу ни про один из перечисленных принципов — верни пустой массив [].'}`;
}

async function callModelForArray(systemPrompt, rawText, maxTokens) {
  if (!anthropic) {
    throw new Error('ANTHROPIC_API_KEY не задан');
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: rawText }],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || !textBlock.text) {
    throw new Error('пустой ответ от Anthropic API');
  }

  const parsed = extractJsonArray(textBlock.text);
  if (!parsed) {
    console.error('[dnevnik] не удалось найти JSON-массив в ответе модели, сырой текст:', textBlock.text);
    throw new Error('невалидный JSON-массив в ответе Anthropic API');
  }

  return parsed;
}

// Нормализует один элемент результата: гарантирует наличие массивов
// pluses/minuses (модель иногда может прислать не массив/undefined).
function normalizeItem(item) {
  return {
    principleNumber: item.principleNumber,
    pluses: Array.isArray(item.pluses) ? item.pluses : [],
    minuses: Array.isArray(item.minuses) ? item.minuses : [],
  };
}

function hasContent(item) {
  return item.pluses.length > 0 || item.minuses.length > 0;
}

// candidatePrinciples — массив объектов принципов (getPrinciple(...)), все
// сейчас открытые/актуальные. primaryNumber — принцип-гарант (см. выше) или
// null для чисто вечернего пакетного разбора без конкретной привязки.
async function parseDnevnikBatch(candidatePrinciples, primaryNumber, rawText) {
  const systemPrompt = buildBatchSystemPrompt(candidatePrinciples, primaryNumber);
  const parsed = await callModelForArray(systemPrompt, rawText, 3072);

  const validNumbers = new Set(candidatePrinciples.map((p) => p.number));
  return parsed
    .filter((item) => validNumbers.has(item.principleNumber))
    .map(normalizeItem)
    .filter(hasContent);
}

// Простой одиночный разбор ПОД ОДИН принцип — используется как аварийный
// fallback, если parseDnevnikBatch почему-то не включил гарантированный
// primaryNumber в результат (модель проигнорировала инструкцию). Берёт весь
// rawText целиком под этот принцип, без попытки распределить по нескольким
// принципам — но так же ищет НЕСКОЛЬКО ситуаций внутри него (pluses/minuses
// как массивы).
async function parseSinglePrincipleFallback(principle, rawText) {
  const systemPrompt = `Elena ведёт "шестиразовый дневник" (буддийская практика, традиция ACI). Разбери её рассказ под принцип №${principle.number}: ${principle.title}
❌ ${principle.negative} — например: ${principle.negativeExamples.slice(0, 6).join('; ')}
✅ ${principle.positive} — например: ${principle.positiveExamples.slice(0, 6).join('; ')}

В рассказе может быть НЕСКОЛЬКО отдельных ситуаций по этому принципу — не сжимай их в одну, заполни pluses и minuses как массивы, по одному элементу на каждую реально описанную ситуацию.

${MOMENT_INSTRUCTIONS}

Ответь СТРОГО валидным JSON-объектом, без markdown:
{
  "pluses": [ { "text": "строка", "radost": "строка", "posvyashenie": "строка" } ],
  "minuses": [ { "opora": "строка", "sozhalenie": "строка", "antidot": "строка", "reshenie": "строка" } ]
}`;

  if (!anthropic) {
    throw new Error('ANTHROPIC_API_KEY не задан');
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1536,
    system: systemPrompt,
    messages: [{ role: 'user', content: rawText }],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || !textBlock.text) {
    throw new Error('пустой ответ от Anthropic API');
  }

  const parsed = extractJson(textBlock.text);
  if (!parsed) {
    throw new Error('невалидный ответ в fallback-разборе');
  }

  return normalizeItem({ ...parsed, principleNumber: principle.number });
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

// То же самое, но для массива.
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

module.exports = { parseDnevnikBatch, parseSinglePrincipleFallback, isConfigured };
