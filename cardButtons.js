// "Одна карточка — одно сообщение" кнопки "✅ Беру" / "❌ Не могу" для
// воскресного анонса и /next_week (см. index.js/report.js — пока живьём
// проверяется в тестовой группе, в реальную рассылку ещё не подключено).
//
// Почему "Беру" — callback-кнопка, а не URL-кнопка, хотя ссылку на вкладку
// таблицы всё равно нужно открыть: Telegram НЕ шлёт боту никакого события,
// когда нажимают URL-кнопку — про такое нажатие узнать невозможно в
// принципе, это ограничение платформы, не наше. Поэтому "Беру" — обычная
// callback-кнопка: по нажатию бот узнаёт, кто нажал, сразу убирает кнопки с
// ЭТОЙ карточки и показывает "✅ Взял(а): @имя", а ссылка на саму вкладку
// остаётся в названии программы (оно кликабельно, как обычно у открытых
// слотов) — так что попасть в таблицу и правда вписать себя туда всё равно
// можно, просто через название, а не через кнопку.
//
// Подтверждение "хост реально появился в таблице" СЮДА НЕ подключено —
// это отдельная, более крупная задача (связать с ежедневной diff-проверкой
// хостов), намеренно отложена по слову Elena. Вместо этого — простой
// откат по времени: если после "Беру" прошло больше TAKEN_EXPIRE_MS, а
// карточка с тех пор не была вручную подтверждена/сброшена, кнопки
// возвращаются сами (см. checkCardExpiry), чтобы слот не завис "как бы
// занятым" навсегда.

const fs = require('fs');
const path = require('path');
const { escapeHtml, formatCommunityTag } = require('./report');

const STATE_PATH = process.env.CARD_BUTTONS_STATE_PATH || '/data/card_buttons.json';
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const TAKEN_EXPIRE_MS = Number(process.env.CARD_TAKEN_EXPIRE_MS) || 3 * 60 * 60 * 1000;

const TAKE_CALLBACK = 'card:take';
const PASS_CALLBACK = 'card:pass';

function readJson(fallback) {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(data) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmpPath = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, STATE_PATH);
}

function displayName(user) {
  return user.username ? `@${user.username}` : [user.first_name, user.last_name].filter(Boolean).join(' ') || 'участник';
}

// "❌ Не могут (N из M): ..." / "Ещё не отметились: ..." — знаменатель это
// список кандидатов-хостов (candidateTags), не все участники чата.
function refusalCounterBlock(refusers, candidateTags) {
  if (!refusers || refusers.length === 0) return null;
  const norm = (s) => String(s).replace(/^@/, '').toLowerCase();
  const tagNorms = candidateTags.map(norm);
  const matched = refusers.filter((r) => r.username && tagNorms.includes(norm(r.username)));
  const rest = candidateTags.filter((t) => !matched.some((r) => norm(r.username) === norm(t)));
  const others = refusers.filter((r) => !r.username || !tagNorms.includes(norm(r.username)));
  const lines = [
    `❌ Не могут (${matched.length + others.length} из ${candidateTags.length}): ${[...matched.map((r) => `@${r.username}`), ...others.map((r) => escapeHtml(displayName(r)))].join(', ') || '—'}`,
  ];
  if (rest.length > 0) lines.push(`Ещё не отметились: ${rest.map((t) => escapeHtml(formatCommunityTag(t))).join(', ')}`);
  return lines.join('\n');
}

function cardText(record) {
  const lines = [record.titleLine, record.dateLine];
  if (record.takenBy) {
    lines.push(`✅ Взял(а): ${escapeHtml(displayName(record.takenBy))} (только что)`);
  } else {
    const counter = refusalCounterBlock(record.refusers, record.candidateTags);
    if (counter) lines.push(counter);
  }
  return lines.join('\n');
}

function cardKeyboard(record) {
  if (record.takenBy) return [];
  return [[{ text: '✅ Беру', callback_data: TAKE_CALLBACK }], [{ text: '❌ Не могу', callback_data: PASS_CALLBACK }]];
}

// titleLine/dateLine приходят уже готовыми HTML-строками (жирные даты,
// ссылка на вкладку в названии и т.д. собираются в вызывающем коде — этот
// модуль только хранит состояние и отрисовывает статус/кнопки под ними).
async function sendCard(bot, chatId, { titleLine, dateLine, candidateTags }) {
  const record = { titleLine, dateLine, candidateTags, refusers: [], takenBy: null };
  const sent = await bot.sendMessage(chatId, cardText(record), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: cardKeyboard(record) },
  });

  const store = readJson({ messages: {} });
  const cutoff = Date.now() - KEEP_MS;
  for (const [key, rec] of Object.entries(store.messages)) {
    if ((rec.createdAt || 0) < cutoff) delete store.messages[key];
  }
  store.messages[`${chatId}:${sent.message_id}`] = { ...record, createdAt: Date.now() };
  writeJsonAtomic(store);
  return sent;
}

async function redrawCard(bot, chatId, messageId, record) {
  try {
    await bot.editMessageText(cardText(record), {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: cardKeyboard(record) },
    });
  } catch (err) {
    if (!/message is not modified/i.test(err.message)) throw err;
  }
}

async function processCardCallback(bot, query) {
  const message = query.message;
  const key = `${message.chat.id}:${message.message_id}`;
  const store = readJson({ messages: {} });
  const record = store.messages[key];

  if (!record) {
    await bot.answerCallbackQuery(query.id, { text: 'Эта карточка уже неактуальна' });
    return;
  }

  const user = query.from;

  if (query.data === TAKE_CALLBACK) {
    if (record.takenBy && record.takenBy.id !== user.id) {
      await bot.answerCallbackQuery(query.id, { text: `Уже взял(а): ${displayName(record.takenBy)}` });
      return;
    }
    record.takenBy = { id: user.id, username: user.username || null, first_name: user.first_name, last_name: user.last_name, at: Date.now() };
    record.refusers = (record.refusers || []).filter((r) => r.id !== user.id);
    store.messages[key] = record;
    writeJsonAtomic(store);
    await redrawCard(bot, message.chat.id, message.message_id, record);
    await bot.answerCallbackQuery(query.id, { text: 'Записано, ты хост! Не забудь вписать себя в таблицу по ссылке в названии 🙏' });
    return;
  }

  if (query.data === PASS_CALLBACK) {
    if (record.takenBy) {
      await bot.answerCallbackQuery(query.id, { text: `Эфир уже взял(а) ${displayName(record.takenBy)}` });
      return;
    }
    record.refusers = record.refusers || [];
    const at = record.refusers.findIndex((r) => r.id === user.id);
    let added;
    if (at >= 0) {
      record.refusers.splice(at, 1);
      added = false;
    } else {
      record.refusers.push({ id: user.id, username: user.username || null, first_name: user.first_name, last_name: user.last_name });
      added = true;
    }
    store.messages[key] = record;
    writeJsonAtomic(store);
    await redrawCard(bot, message.chat.id, message.message_id, record);
    await bot.answerCallbackQuery(query.id, { text: added ? 'Записано: не можешь 🙏' : 'Отметка снята' });
    return;
  }
}

// Нажатия на одну и ту же карточку — строго по очереди, иначе два быстрых
// клика могут дойти до Telegram в обратном порядке и показать устаревший
// счётчик (тот же приём, что в hostReminder.js).
const queues = new Map();

function handleCardCallback(bot, query) {
  const message = query.message;
  if (!message) return bot.answerCallbackQuery(query.id, { text: 'Сообщение недоступно' }).catch(() => {});
  const key = `${message.chat.id}:${message.message_id}`;
  const next = (queues.get(key) || Promise.resolve())
    .then(() => processCardCallback(bot, query))
    .catch((err) => console.error('[card-buttons] ошибка обработки нажатия:', err.message));
  queues.set(key, next);
  next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}

// Раз в 5 минут (вызывается из того же cron-тика, что и остальные
// периодические проверки) — если "Беру" нажали больше TAKEN_EXPIRE_MS назад
// и карточку с тех пор никто не тронул, возвращает кнопки: см. комментарий
// в шапке файла, почему здесь нет проверки реальной таблицы.
async function checkCardExpiry(bot) {
  const store = readJson({ messages: {} });
  const cutoff = Date.now() - TAKEN_EXPIRE_MS;
  let changed = false;
  for (const [key, record] of Object.entries(store.messages)) {
    if (!record.takenBy || record.takenBy.at > cutoff) continue;
    const [chatId, messageId] = key.split(':');
    record.takenBy = null;
    changed = true;
    try {
      await redrawCard(bot, Number(chatId), Number(messageId), record);
    } catch (err) {
      console.error(`[card-buttons] не удалось вернуть кнопки на ${key}:`, err.message);
    }
  }
  if (changed) writeJsonAtomic(store);
}

module.exports = { sendCard, handleCardCallback, checkCardExpiry, TAKE_CALLBACK, PASS_CALLBACK };
