const Anthropic = require('@anthropic-ai/sdk');
const { SECTIONS } = require('../proekty/items');

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const anthropic = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;
const isConfigured = Boolean(anthropic);

const MODEL = 'claude-sonnet-4-6';

// Те же ключи и подписи, что в proekty/items.js, секция "Мои проекты" — без
// практик (sh_utro/sh_den/sh_vecher), для них задачи не заводятся. Единый
// источник правды: если Elena добавит новый проект в proekty/items.js, он
// сам появится и здесь.
const PROJECTS = SECTIONS.find((s) => s.title === 'Мои проекты').items;
const PROJECT_KEYS = new Set(PROJECTS.map((p) => p.key));

function isKnownProject(key) {
  return PROJECT_KEYS.has(key);
}

// Дешёвая проверка формы "Название: текст" ДО обращения к Anthropic — чтобы
// не звать API на сообщения, вообще не похожие на задачу (в духе
// looksLikeAnnouncement из peredachi/watch.js). Настоящее сопоставление
// проекта и уверенность делает уже сам Claude в parseTaskMessage.
function looksLikeTaskMessage(text) {
  const trimmed = (text || '').trim();
  if (trimmed.length < 3) return false;

  const idx = trimmed.indexOf(':');
  if (idx <= 0 || idx > 40) return false;

  const before = trimmed.slice(0, idx).trim();
  const after = trimmed.slice(idx + 1).trim();
  if (!before || !after) return false;
  if (/^https?$/i.test(before)) return false; // "http://..." — ссылка, не проект
  if (/\d/.test(before)) return false; // "15:00" и подобное время — не название проекта
  if (before.split(/\s+/).length > 6) return false; // название проекта короткое, это не то

  return true;
}

function buildSystemPrompt() {
  // Тот же фиксированный сдвиг Бали (WITA, без DST), что и baliDateString в
  // verse/progress.js — "сегодня" для относительных дат ("завтра", "в
  // четверг") считаем по дню Elena, а не по UTC контейнера.
  const nowBali = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const todayISO = nowBali.toISOString().slice(0, 10);
  const weekdayNames = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const weekday = weekdayNames[nowBali.getUTCDay()];

  const projectsList = PROJECTS.map((p) => `- ${p.key} — ${p.label}`).join('\n');

  return `Елена надиктовывает голосом через клавиатуру телефона короткие задачи и встречи по своим проектам одной строкой в формате "Название проекта: текст задачи". Твоя задача — понять, к какому проекту это относится, и извлечь саму задачу и дату/время, если они есть.

Список проектов (используй ТОЛЬКО эти ключи, ничего не выдумывай):
${projectsList}

Разбери присланное сообщение целиком:
1. Определи проект — сопоставляй НЕЧЁТКО по смыслу и по частичному названию: "афиша", "озон", "хосты", "wvp", "передачи", "прямые передачи", "обучение", "хост-обучение", "курс", "финсвобода", "финансовая свобода", "миллион" и подобные варианты (в любом падеже, с опечатками, сокращённо) должны попадать в соответствующий ключ.
2. Если сообщение НЕ в формате "Название: текст", ИЛИ ты не уверен, к какому именно проекту оно относится (совсем не похоже ни на один из списка, или одинаково похоже сразу на несколько) — верни matched: false и не заполняй остальные поля (пустые строки). Лучше вернуть matched: false, чем угадать неправильный проект.
3. Если уверен — верни matched: true, project (ключ из списка выше), text (сама задача/встреча, без названия проекта и двоеточия, без лишних слов), dateISO и timeMSK.

Правила даты и времени:
- Сегодня ${todayISO} (${weekday}). Слова "сегодня", "завтра", "послезавтра", "в четверг", "на следующей неделе" и т.п. переводи в конкретную дату YYYY-MM-DD, отталкиваясь от этого.
- Время переводи в московское (МСК, Россия не переходит на летнее/зимнее время). Если часовой пояс назван явно (например, "по Бали" = МСК+5, вычесть 5 часов; другие места — оцени смещение по своим знаниям) — пересчитай. Если явно не назван — считай, что время уже в МСК.
- Если дата не упомянута — оставь dateISO пустой строкой. Если время не упомянуто — оставь timeMSK пустой строкой. Никогда не выдумывай дату/время, которых нет в тексте.

Ответ — СТРОГО валидный JSON-объект, без markdown-разметки (без \`\`\`), без пояснений — только сам JSON, готовый к JSON.parse():
{
  "matched": true/false,
  "project": "ключ из списка или пустая строка",
  "text": "текст задачи/встречи или пустая строка",
  "dateISO": "YYYY-MM-DD или пустая строка",
  "timeMSK": "HH:MM или пустая строка"
}`;
}

async function parseTaskMessage(rawText) {
  if (!anthropic) {
    throw new Error('ANTHROPIC_API_KEY не задан');
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: rawText }],
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

  // При сомнении не реагируем — как и при явно неизвестном/невалидном
  // проекте (защита от галлюцинации ключа) или пустом тексте задачи.
  if (!parsed.matched || !isKnownProject(parsed.project) || !parsed.text) {
    return { matched: false };
  }

  return {
    matched: true,
    project: parsed.project,
    text: parsed.text,
    dateISO: parsed.dateISO || '',
    timeMSK: parsed.timeMSK || '',
  };
}

module.exports = { PROJECTS, isKnownProject, looksLikeTaskMessage, parseTaskMessage, isConfigured };
