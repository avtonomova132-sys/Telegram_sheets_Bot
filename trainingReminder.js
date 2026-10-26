// Еженедельное напоминание о встрече-обучении «Хочу быть хостом» (вторник).
// Каждый понедельник в 14:00 по Бали — в группу WVP (тема General), двуязычно,
// без кнопок и без @-тегов. Время и ссылка на Zoom хранятся в настройках на
// Volume и меняются командами Елены в личке. Отдельная функция: с воскресным
// Анонсом, понедельничным напоминанием хостам, вторничной сводкой и правилом
// «за 24 часа» не связана. Паттерн тот же, что у остальных расписаний:
// проверка раз в 5 минут (catch-up), метка «уже отправили на этой неделе»
// ставится ДО отправки — рестарт после 14:00 повторов не даёт.

const fs = require('fs');
const path = require('path');
const { baliDateString, baliHour } = require('./verse/progress');

const STATE_PATH = process.env.TRAINING_REMINDER_PATH || '/data/training_reminder.json';
const GROUP_ID = Number(process.env.VOLUNTEER_GROUP_ID) || -1001757671785;
const SEND_HOUR = 14;
const MONDAY = 1;

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmpPath = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, STATE_PATH);
}

function updateState(patch) {
  const state = { ...readState(), ...patch };
  writeState(state);
  return state;
}

function baliWeekday(d = new Date()) {
  return new Date(d.getTime() + 8 * 60 * 60 * 1000).getUTCDay();
}

function isEnabled(state) {
  return state.enabled !== false;
}

function missingSettings(state) {
  const missing = [];
  if (!state.time) missing.push('время');
  if (!state.link) missing.push('ссылка');
  return missing;
}

function buildText(state) {
  return [
    '🎓 Tomorrow we have our training meeting "I want to be a host"!',
    "We'll go step by step through everything you need to host a broadcast. Come if you'd like to try, or just to refresh your knowledge.",
    `🕐 Time: ${state.time}`,
    `🔗 Zoom: ${state.link}`,
    'Welcome! 🙏',
    '',
    '🎓 Завтра состоится наша встреча-обучение «Хочу быть хостом»!',
    'Шаг за шагом разберём, что нужно, чтобы провести эфир в роли хоста. Приходите, если хотите попробовать свои силы или освежить знания.',
    `🕐 Время: ${state.time}`,
    `🔗 Zoom: ${state.link}`,
    'Ждём вас! 🙏',
  ].join('\n');
}

async function tick(bot, notifyElena, now = new Date()) {
  const state = readState();
  if (!isEnabled(state)) return;
  if (baliWeekday(now) !== MONDAY || baliHour(now) < SEND_HOUR) return;
  const today = baliDateString(now);
  if (state.lastSentDate === today) return;

  const missing = missingSettings(state);
  if (missing.length) {
    if (state.lastWarnedDate === today) return;
    updateState({ lastWarnedDate: today });
    notifyElena(`Напоминание об обучении не отправлено: не задано ${missing.join('/')}. Задай командами /training_time и /training_link`);
    return;
  }

  updateState({ lastSentDate: today });
  try {
    await bot.sendMessage(GROUP_ID, buildText(state), { disable_web_page_preview: true });
    notifyElena('Напоминание об обучении отправлено в группу');
  } catch (err) {
    console.error('[training] не удалось отправить в группу:', err.message);
    notifyElena(`⚠️ Напоминание об обучении НЕ отправлено в группу: ${err.message}`);
  }
}

function init(bot, { cron, ownerId }) {
  const isOwnerDm = (msg) => ownerId && msg.from && String(msg.from.id) === String(ownerId) && msg.chat.type === 'private';
  const notifyElena = (text) => {
    if (!ownerId) return;
    bot.sendMessage(ownerId, text).catch((err) => console.error('[training] не удалось написать Елене:', err.message));
  };
  const reply = (msg, text) => bot.sendMessage(msg.chat.id, text, { disable_web_page_preview: true });
  const onCmd = (name, withArg, handler) => {
    const re = new RegExp(`^\\/${name}(?:@\\S+)?${withArg ? '(?:\\s+([\\s\\S]+?))?' : ''}\\s*$`, 'i');
    bot.onText(re, (msg, match) => {
      if (!isOwnerDm(msg)) return;
      Promise.resolve(handler(msg, match && match[1] ? match[1].trim() : '')).catch((err) =>
        console.error(`[training] /${name}:`, err.message));
    });
  };

  onCmd('training_time', true, (msg, arg) => {
    if (!arg) return reply(msg, 'Напиши время после команды, например: /training_time Tue 19:00 Bali / 07:00 AZ / 14:00 MCK');
    updateState({ time: arg });
    return reply(msg, `Время обучения сохранено: ${arg}`);
  });
  onCmd('training_link', true, (msg, arg) => {
    if (!arg) return reply(msg, 'Напиши ссылку после команды: /training_link https://...');
    updateState({ link: arg });
    return reply(msg, `Ссылка на Zoom сохранена: ${arg}`);
  });
  onCmd('training_off', false, (msg) => {
    updateState({ enabled: false });
    return reply(msg, 'Еженедельное напоминание об обучении выключено. Включить: /training_on');
  });
  onCmd('training_on', false, (msg) => {
    updateState({ enabled: true });
    return reply(msg, 'Еженедельное напоминание об обучении включено (по понедельникам в 14:00 по Бали).');
  });
  const preview = (msg) => {
    const state = readState();
    const missing = missingSettings(state);
    if (missing.length) {
      return reply(msg, `Не задано: ${missing.join('/')}. Задай командами /training_time и /training_link`);
    }
    return reply(msg, buildText(state));
  };
  onCmd('training_text', false, preview);
  // Превью того, что уйдёт в группу; в группу ничего не отправляет.
  onCmd('training_now', false, async (msg) => {
    await reply(msg, 'Превью (в группу НЕ отправлено):');
    await preview(msg);
    const state = readState();
    await reply(msg, `Отправка: ${isEnabled(state) ? 'включена' : 'выключена'}, понедельник 14:00 по Бали.`);
  });

  cron.schedule('*/5 * * * *', () => {
    tick(bot, notifyElena).catch((err) => console.error('[training] ошибка тика:', err.message));
  });
  setTimeout(() => {
    tick(bot, notifyElena).catch((err) => console.error('[training] ошибка тика при старте:', err.message));
  }, 60 * 1000);
  console.log('[training] напоминание об обучении: понедельник 14:00 по Бали');
}

module.exports = { init, tick, buildText };
