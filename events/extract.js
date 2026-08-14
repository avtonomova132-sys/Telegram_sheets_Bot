const Anthropic = require('@anthropic-ai/sdk');
const { PROGRAMS } = require('./constants');

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const anthropic = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;

const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `Ты помогаешь заполнять карточки событий для страницы "Афиша Алмазного пути" (расписание буддийских программ) по свободному описанию, которое человек присылает в Telegram-боте. Диалог может занимать несколько сообщений подряд — сначала общее описание, потом уточнения по недостающим полям.

Разрешённые программы (используй значение ТОЧНО как в списке ниже; если не уверен, к какой программе относится событие — оставь поле program пустой строкой, не угадывай):
${PROGRAMS.map((p) => `- "${p}"`).join('\n')}

Формат события — одно из: "online", "offline", "recording" (запись прошедшего события).

Верни СТРОГО валидный JSON-ОБЪЕКТ (не массив!), без markdown-разметки (без \`\`\`), без пояснений — только сам JSON, готовый к JSON.parse(). Поля:
{
  "program": "...", // точное значение из списка выше, или "" если неясно
  "format": "online" | "offline" | "recording" | "",
  "title_ru": "...", // тема/название занятия, если оно явно упомянуто; иначе ""
  "title_en": "...", // перевод title_ru на английский, если title_ru заполнен; иначе ""
  "teacher": "...", // кто ведёт, иначе ""
  "date_az": "YYYY-MM-DD", // дата по времени Аризоны (MST, UTC-7) — см. правило про пояса ниже
  "time_az": "HH:MM", // 24-часовой формат
  "date_msk": "YYYY-MM-DD", // дата по московскому времени (MSK, UTC+3) — см. правило про пояса ниже
  "time_msk": "HH:MM",
  "city": "...", // только для offline — город проведения; иначе ""
  "lang": "...", // языки перевода, если указаны (например "RU · EN"), иначе ""
  "link": "..." // ссылка на Zoom/трансляцию/запись, если есть, иначе ""
}

КРИТИЧЕСКИ ВАЖНО про часовые пояса:
- Заполняй ТОЛЬКО ту пару полей (date_az+time_az ИЛИ date_msk+time_msk), чей часовой пояс явно назван в тексте или однозначно следует из контекста ("по Москве", "МСК", "по Аризоне", "AZ", "MST").
- Если пояс вообще не указан (просто "в 15:00" без уточнения) — считай это временем по Москве (МСК), это самый частый случай в текстах.
- НЕ пересчитывай второй пояс самостоятельно — это делает отдельный код после тебя. Оставляй вторую пару полей пустыми строками "".
- Если год в дате не указан — используй текущий год ({{YEAR}}). Если получившаяся дата уже прошла (более чем на день) относительно сегодня ({{TODAY}}) — используй следующий год.

Работа с диалогом:
- Если это не первое сообщение в диалоге (есть предыдущие сообщения и твои же предыдущие ответы) — верни СНОВА весь объект целиком, объединив всё, что уже было известно раньше, с новой информацией из последнего сообщения. Не теряй то, что уже было распознано, если новое сообщение это не опровергает.

Другие правила:
- Никогда не выдумывай данные, которых нет в тексте (учителей, ссылки, даты, темы). Пустая строка лучше, чем угаданное значение.
- Ответ — только JSON-объект, ничего кроме него.`;

// history — массив сообщений в формате Anthropic messages API ([{role, content}]),
// накапливается в сессии диалога (см. index.js), чтобы модель видела весь
// контекст уточнений, а не только последнее сообщение.
async function extractEvent(history) {
  if (!anthropic) {
    throw new Error('ANTHROPIC_API_KEY не задан');
  }

  const today = new Date().toISOString().slice(0, 10);
  const year = new Date().getFullYear();
  const system = SYSTEM_PROMPT.replace('{{YEAR}}', String(year)).replace('{{TODAY}}', today);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: history,
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

  return { parsed, assistantText: textBlock.text };
}

module.exports = { extractEvent };
