// Напоминание за 2 дня до эфира, у которого всё ещё нет хоста, + счётчик
// "❌ Не могу" под каждым таким эфиром. Отдельная проверка — не связана ни с
// воскресным анонсом, ни с /next_week. Формат сообщения и кнопок — в
// report.js (buildHostReminderMessage / buildHostReminderKeyboard), здесь
// только расписание проверки, хранилище отказов и обработка нажатий.

const fs = require('fs');
const path = require('path');
const {
  buildHostReminderMessage,
  buildHostReminderKeyboard,
  snapshotEvent,
  reviveEvent,
  findHostReminderEvents,
  loadCommunityTags,
} = require('./report');
const { baliDateString, baliHour } = require('./verse/progress');

const STATE_PATH = process.env.HOST_REMINDER_STATE_PATH || '/data/host_reminder_state.json';
const REFUSALS_PATH = process.env.HOST_REFUSALS_PATH || '/data/host_refusals.json';
const REMINDER_HOUR = Number(process.env.HOST_REMINDER_HOUR) || 10;
const RETRY_AFTER_MS = 60 * 60 * 1000;
const KEEP_MESSAGES_MS = 30 * 24 * 60 * 60 * 1000;
const CALLBACK_PREFIX = 'hr:';

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function saveMessageRecord(chatId, messageId, events, tags, test) {
  const store = readJson(REFUSALS_PATH, { messages: {} });
  const cutoff = Date.now() - KEEP_MESSAGES_MS;
  for (const [key, rec] of Object.entries(store.messages)) {
    if ((rec.createdAt || 0) < cutoff) delete store.messages[key];
  }
  store.messages[`${chatId}:${messageId}`] = {
    createdAt: Date.now(),
    test: Boolean(test),
    tags,
    events: events.map(snapshotEvent),
    refusals: events.map(() => []),
  };
  writeJsonAtomic(REFUSALS_PATH, store);
}

async function sendHostReminder(bot, { chatId, events, tags, test = false }) {
  const text = buildHostReminderMessage(events, { tags, test });
  const sent = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buildHostReminderKeyboard(events) },
  });
  saveMessageRecord(chatId, sent.message_id, events, tags, test);
  return sent;
}

// Once per Bali day at/after REMINDER_HOUR (catch-up poll, like the other
// daily jobs). A day counts as done only after a clean check (nothing found,
// or the reminder actually sent); a failed tab fetch or send is retried at
// most once an hour so a broken tab can't hammer Google Sheets every 5 min.
async function checkAndSendHostReminder(bot, chatId) {
  const today = baliDateString();
  if (baliHour() < REMINDER_HOUR) return;

  const state = readJson(STATE_PATH, {});
  if (state.lastCheckedDate === today) return;
  if (state.lastAttemptAt && Date.now() - state.lastAttemptAt < RETRY_AFTER_MS) return;
  writeJsonAtomic(STATE_PATH, { ...state, lastAttemptAt: Date.now() });

  const { events, failedTabs, target } = await findHostReminderEvents();

  if (events.length > 0) {
    await sendHostReminder(bot, { chatId, events, tags: loadCommunityTags() });
    writeJsonAtomic(STATE_PATH, { lastCheckedDate: today, lastAttemptAt: Date.now() });
    console.log(`[host-reminder] отправлено: эфиров без хоста на ${target.toISOString().slice(0, 10)}: ${events.length}`);
    return;
  }

  if (failedTabs.length > 0) {
    console.warn(`[host-reminder] часть вкладок не загрузилась, повтор позже: ${failedTabs.join('; ')}`);
    return;
  }

  writeJsonAtomic(STATE_PATH, { lastCheckedDate: today, lastAttemptAt: Date.now() });
}

async function processRefusal(bot, query, key) {
  const message = query.message;
  const idx = Number(query.data.slice(CALLBACK_PREFIX.length));
  const store = readJson(REFUSALS_PATH, { messages: {} });
  const rec = store.messages[key];

  if (!rec || !Number.isInteger(idx) || !rec.events[idx]) {
    await bot.answerCallbackQuery(query.id, { text: 'Это сообщение уже неактуально' });
    return;
  }

  const user = query.from;
  const refusers = rec.refusals[idx];
  const at = refusers.findIndex((r) => r.id === user.id);
  let added;
  if (at >= 0) {
    refusers.splice(at, 1);
    added = false;
  } else {
    refusers.push({
      id: user.id,
      username: user.username || null,
      name: [user.first_name, user.last_name].filter(Boolean).join(' ') || 'участник',
    });
    added = true;
  }
  writeJsonAtomic(REFUSALS_PATH, store);

  const events = rec.events.map(reviveEvent);
  try {
    await bot.editMessageText(buildHostReminderMessage(events, { tags: rec.tags, refusals: rec.refusals, test: rec.test }), {
      chat_id: message.chat.id,
      message_id: message.message_id,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buildHostReminderKeyboard(events) },
    });
  } catch (err) {
    if (!/message is not modified/i.test(err.message)) console.error('[host-reminder] не удалось обновить сообщение:', err.message);
  }

  await bot.answerCallbackQuery(query.id, { text: added ? 'Записано: не можешь 🙏' : 'Отметка снята' });
}

// Нажатия на одно и то же сообщение обрабатываем строго по очереди, иначе
// две правки подряд могут дойти до Telegram в обратном порядке и показать
// устаревший счётчик.
const queues = new Map();

function handleReminderCallback(bot, query) {
  const message = query.message;
  if (!message) {
    return bot.answerCallbackQuery(query.id, { text: 'Сообщение недоступно' }).catch(() => {});
  }

  const key = `${message.chat.id}:${message.message_id}`;
  const next = (queues.get(key) || Promise.resolve())
    .then(() => processRefusal(bot, query, key))
    .catch((err) => console.error('[host-reminder] ошибка обработки нажатия:', err.message));
  queues.set(key, next);
  next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}

module.exports = { checkAndSendHostReminder, sendHostReminder, handleReminderCallback, CALLBACK_PREFIX };
