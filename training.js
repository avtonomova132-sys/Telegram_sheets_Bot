// Еженедельное напоминание об обучении «Хочу быть хостом» (Елена, 2026-10-26).
// Встреча каждый вторник 07:00 МСК = 12:00 Бали = понедельник 21:00 Аризона
// (время зашито в тексте и командой не меняется). Бот без ИИ:
//   понедельник 14:00 Бали → превью Елене в личку с кнопками «Отправить в группу /
//   Не отправлять» (или «да»/«нет» ответом, /yes /no) → только после «да» — в группу
//   «WorldView Productions» (тема General: message_thread_id не задаём), без кнопок и
//   без @-тегов. Режим автомата (/training_auto_on) шлёт в группу сам, без вопроса.
// Отдельная функция: Анонс, напоминание хостам, вторничная сводка и «за 24 часа»
// (cardButtons.js) не затрагивает. Состояние — /data/training.json (TRAINING_PATH).
const fs = require('fs');
const path = require('path');

const STATE_PATH = process.env.TRAINING_PATH || '/data/training.json';
const WVP_GROUP_ID = Number(process.env.VOLUNTEER_GROUP_ID) || -1001757671785;
const TEST_GROUP_ID = Number(process.env.TEST_GROUP_CHAT_ID) || -5172293748;
const BALI_MS = 8 * 3600 * 1000;
const CATCHUP_MS = 3 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const NO_LINK = '⚠️ ссылка не задана';

const elenaChatId = () => (process.env.MY_CHAT_ID ? Number(process.env.MY_CHAT_ID) : null);

// ---- state ----
function readState() {
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    /* first run / unreadable → defaults */
  }
  return { enabled: true, auto: false, link: null, done: {}, pending: null, activatedAt: null, ...s };
}

function writeState(s) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

// Synchronous read-modify-write.
function update(fn) {
  const s = readState();
  const res = fn(s);
  writeState(s);
  return res;
}

// All async work (preview, confirm, tick) goes one after another.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// ---- time (Bali = UTC+8, fixed) ----
function baliMondayKey(now) {
  const d = new Date(now + BALI_MS);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10); // YYYY-MM-DD of the Bali Monday
}
// Monday 14:00 Bali = 06:00 UTC
const dueAtOf = (mondayKey) => Date.parse(`${mondayKey}T06:00:00Z`);
const isBaliMonday = (now) => new Date(now + BALI_MS).getUTCDay() === 1;

// ---- text ----
const MESSAGE = `🎓 Tomorrow we have our training meeting "I want to be a host"!
We'll go step by step through everything you need to host a broadcast. Come if you'd like to try, or just to refresh your knowledge.
🕐 Tue 07:00 Moscow · Tue 12:00 Bali · Mon 21:00 Arizona
🔗 Zoom: {LINK}
Welcome! 🙏

🎓 Завтра состоится наша встреча-обучение «Хочу быть хостом»!
Шаг за шагом разберём, что нужно, чтобы провести эфир в роли хоста. Приходите, если хотите попробовать свои силы или освежить знания.
🕐 Вт 07:00 по Москве · Вт 12:00 по Бали · Пн 21:00 по Аризоне
🔗 Zoom: {LINK}
Ждём вас! 🙏`;

const messageText = (link) => MESSAGE.split('{LINK}').join(link || NO_LINK);

function statusLine(s) {
  return [
    `Функция: ${s.enabled ? 'включена' : 'выключена (/training_on)'}`,
    `Режим: ${s.auto ? 'автомат — в понедельник 14:00 уходит в группу сама (/training_auto_off)' : 'с подтверждением (/training_auto_on — включить автомат)'}`,
    `Ссылка на Zoom: ${s.link || 'не задана — /training_link ссылка'}`,
  ].join('\n');
}

const keyboard = (id) => [[{ text: '✅ Отправить в группу / Send to group', callback_data: `tr:ok:${id}` }, { text: "❌ Не отправлять / Don't send", callback_data: `tr:no:${id}` }]];
const HOW_TO_ANSWER = 'Нажмите кнопку, ответьте на это сообщение словом «да» / «нет» или напишите /yes / /no.';

async function tellElena(bot, text, opts = {}) {
  const elena = elenaChatId();
  if (!elena) throw new Error('MY_CHAT_ID не задан');
  return bot.sendMessage(elena, text, { disable_web_page_preview: true, ...opts });
}

async function removeButtons(bot, p) {
  if (!p || !p.controlMessageId) return;
  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: elenaChatId(), message_id: p.controlMessageId });
  } catch {
    /* already gone / unchanged */
  }
}

// ---- preview ----
// Cancels the preview that is waiting (if any) and sends a new one. Without a link the
// text is shown with a warning and NO buttons (nothing can be sent until /training_link).
async function createPreview(bot, { now = Date.now(), weekKey = baliMondayKey(now), note = null } = {}) {
  const s = readState();
  const old = s.pending && (s.pending.status === 'pending' || s.pending.status === 'nolink') ? s.pending : null;
  if (old) await removeButtons(bot, old);
  const link = s.link;
  const seq = update((st) => (st.seq = (st.seq || 0) + 1)); // each preview gets its own id (old buttons stop working)
  const id = `t${weekKey.replace(/-/g, '')}n${seq}`;
  const lines = [];
  if (note) lines.push(note, '');
  if (!link) lines.push('⚠️ Ссылка на Zoom не задана — задайте командой /training_link ссылка. Кнопка «Отправить» появится в новом превью, которое я пришлю сразу после этого.', '');
  if (!isBaliMonday(now)) lines.push('ℹ️ Сегодня не понедельник — в тексте написано «завтра».', '');
  lines.push(link ? '👆 Превью напоминания об обучении «Хочу быть хостом» — вот что уйдёт в группу WorldView Productions (тема General), без кнопок и тегов:' : 'Так выглядит напоминание об обучении (в группу не уйдёт, пока нет ссылки):', '', '───────────', messageText(link), '───────────');
  if (link) lines.push('', HOW_TO_ANSWER);
  const sent = await tellElena(bot, lines.join('\n'), link ? { reply_markup: { inline_keyboard: keyboard(id) } } : {});
  update((st) => {
    st.pending = { id, weekKey, status: link ? 'pending' : 'nolink', link: link || null, controlMessageId: sent.message_id, createdAt: now };
  });
  return { id, link: Boolean(link) };
}

async function postToGroup(bot, chatId, link, prefix = '') {
  return bot.sendMessage(chatId, `${prefix}${messageText(link)}`, { disable_web_page_preview: true });
}

// Elena's decision on the waiting preview.
async function confirm(bot, id, approve) {
  const s = readState();
  const p = s.pending;
  if (!p || p.id !== id || p.status !== 'pending') {
    return tellElena(bot, 'Это превью уже обработано или заменено новым.');
  }
  await removeButtons(bot, p);
  if (!approve) {
    update((st) => {
      st.pending.status = 'declined';
    });
    return tellElena(bot, 'Хорошо, напоминание об обучении в группу не отправляю.');
  }
  if (!s.link) {
    update((st) => {
      st.pending.status = 'nolink';
    });
    return tellElena(bot, '⚠️ Ссылка на Zoom не задана — не отправляю. Задайте /training_link ссылка, пришлю новое превью.');
  }
  if (p.link !== s.link) {
    // the link changed after the preview was made → show the actual text again
    await createPreview(bot, { weekKey: p.weekKey, note: '🔄 Ссылка изменилась с момента превью — вот обновлённый текст.' });
    return;
  }
  update((st) => {
    st.pending.status = 'sending'; // marked BEFORE the send: a double tap cannot post twice
  });
  try {
    await postToGroup(bot, WVP_GROUP_ID, s.link);
  } catch (err) {
    update((st) => {
      st.pending.status = 'pending';
    });
    throw err;
  }
  update((st) => {
    st.pending.status = 'sent';
    st.pending.sentAt = Date.now();
  });
  await tellElena(bot, '✅ Напоминание об обучении отправлено в группу.');
}

// ---- scheduler tick (every 5 minutes and once after a start) ----
async function tick(bot, now = Date.now()) {
  const start = readState();
  if (!start.activatedAt) update((st) => { st.activatedAt = now; });
  if (!start.enabled) return;
  const weekKey = baliMondayKey(now);
  const due = dueAtOf(weekKey);
  if (start.done[weekKey] || now < due) return;
  const activatedAt = readState().activatedAt || now;
  if (now > due + CATCHUP_MS) {
    // missed by more than 3 hours: not run (and said out loud unless it predates the feature)
    update((st) => {
      st.done[weekKey] = { at: now, outcome: 'missed' };
    });
    if (due >= activatedAt) await tellElena(bot, '⚠️ Превью напоминания об обучении не удалось подготовить вовремя (бот был недоступен больше 3 часов). Прислать сейчас: /training_now');
    return;
  }
  if (start.auto && start.link) {
    update((st) => {
      st.done[weekKey] = { at: now, outcome: 'auto-sent' };
    });
    await postToGroup(bot, WVP_GROUP_ID, start.link);
    await tellElena(bot, 'Напоминание об обучении отправлено в группу');
    return;
  }
  update((st) => {
    st.done[weekKey] = { at: now, outcome: start.link ? 'preview' : 'preview-nolink' };
  });
  await createPreview(bot, { now, weekKey, note: start.auto ? '⚠️ Автомат включён, но ссылки на Zoom нет — отправить сам не могу.' : null });
}

// ---- Elena's commands (private chat, her only) ----
const isElena = (msg) => Boolean(msg.from) && msg.from.id === elenaChatId() && msg.chat && msg.chat.type === 'private';

async function handleCommand(bot, msg, command, arg = '') {
  if (!isElena(msg)) return;
  const text = String(arg || '').trim();
  switch (command) {
    case 'on':
    case 'off':
      update((st) => {
        st.enabled = command === 'on';
      });
      return tellElena(bot, command === 'on' ? '✅ Еженедельное напоминание об обучении включено.' : '⏸ Еженедельное напоминание об обучении выключено (вернуть: /training_on).');
    case 'auto_on':
    case 'auto_off':
      update((st) => {
        st.auto = command === 'auto_on';
      });
      return tellElena(bot, command === 'auto_on' ? '🤖 Автомат включён: по понедельникам в 14:00 по Бали напоминание уйдёт в группу само, без вопроса (мне придёт одна строка). Вернуть подтверждение: /training_auto_off.' : '✅ Режим подтверждения: по понедельникам в 14:00 по Бали пришлю превью с кнопками.');
    case 'link': {
      if (!/^https?:\/\/\S+$/i.test(text)) return tellElena(bot, 'Формат: /training_link https://… (ссылка на Zoom).');
      const awaiting = update((st) => {
        st.link = text;
        // a preview of the last 3 days is waiting (e.g. without a link) → show it again with the new link
        return Boolean(st.pending) && (st.pending.status === 'nolink' || st.pending.status === 'pending') && Date.now() - st.pending.createdAt < 3 * DAY_MS;
      });
      await tellElena(bot, `🔗 Ссылка на Zoom сохранена: ${text}`);
      if (awaiting) await serial(() => createPreview(bot, { weekKey: readState().pending.weekKey }));
      return;
    }
    case 'text': {
      const s = readState();
      return tellElena(bot, `${statusLine(s)}\n\n───────────\n${messageText(s.link)}\n───────────`);
    }
    case 'now':
      return serial(() => createPreview(bot));
    case 'test': {
      // The same text, right away into the test group «Дебаты» (never the big group).
      const s = readState();
      await postToGroup(bot, TEST_GROUP_ID, s.link, '🧪 [Дебаты, тест]\n\n');
      return tellElena(bot, '🧪 Тест отправлен в «Дебаты».');
    }
    default:
  }
}

// Button on the preview.
function handleCallback(bot, query) {
  const answer = (text) => bot.answerCallbackQuery(query.id, text ? { text } : {}).catch(() => {});
  if (!query.from || query.from.id !== elenaChatId()) return answer();
  const m = String(query.data || '').match(/^tr:(ok|no):(.+)$/);
  if (!m) return answer();
  answer(m[1] === 'ok' ? 'Отправляю…' : 'Не отправляю');
  return serial(() => confirm(bot, m[2], m[1] === 'ok'));
}

// «да»/«нет» as a REPLY to the preview. Returns true if it was one.
async function handleTextReply(bot, msg) {
  if (!isElena(msg) || !msg.reply_to_message || !msg.text) return false;
  const p = readState().pending;
  if (!p || p.status !== 'pending' || p.controlMessageId !== msg.reply_to_message.message_id) return false;
  const word = msg.text.trim().toLowerCase().replace(/[.!\s]+$/g, '');
  const approve = ['да', 'yes', 'ага', 'отправляй'].includes(word);
  const decline = ['нет', 'no', 'не надо'].includes(word);
  if (!approve && !decline) return false;
  await serial(() => confirm(bot, p.id, approve));
  return true;
}

// /yes, /no: go to this preview if it is the newest one waiting (newer than the
// week previews of cardButtons.js, `otherNewestAt`). Returns true if taken.
function handleYesNo(bot, msg, command, otherNewestAt = 0) {
  if (!isElena(msg)) return false;
  const p = readState().pending;
  if (!p || p.status !== 'pending' || p.createdAt <= otherNewestAt) return false;
  serial(() => confirm(bot, p.id, command === 'yes')).catch((err) => console.error('[training] ошибка /yes /no:', err.message));
  return true;
}

// One-off (26.10.2026): the weekly slot of this week is already past → preview now and a test into «Дебаты».
async function runOneShot(bot, now = Date.now()) {
  const weekKey = baliMondayKey(now);
  update((st) => {
    st.done[weekKey] = { at: now, outcome: 'one-shot' }; // the regular tick must not repeat it this week
    if (!st.activatedAt) st.activatedAt = now;
  });
  const s = readState();
  await postToGroup(bot, TEST_GROUP_ID, s.link, '🧪 [Дебаты, тест]\n\n');
  await serial(() => createPreview(bot, { now, weekKey, note: '🎓 Разовое превью на завтрашнюю встречу (вт 27.10). Тест такого же текста я отправила в «Дебаты».' }));
}

module.exports = { tick, handleCommand, handleCallback, handleTextReply, handleYesNo, runOneShot, createPreview, messageText, baliMondayKey, dueAtOf, STATE_PATH };
