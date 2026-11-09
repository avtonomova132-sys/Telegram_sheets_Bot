// Еженедельное напоминание об обучении «Хочу быть хостом» (Елена, 2026-10-26).
// Встреча каждый вторник 07:00 утра МСК = 12:00 Бали = понедельник 21:00 Аризона
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
const MESSAGE = `🎓 Завтра состоится наша встреча-обучение «Хочу быть хостом»!

Шаг за шагом разберём, что нужно, чтобы провести эфир в роли хоста. Приходите, если хотите попробовать свои силы или освежить знания.

🕐 Вт 07:00 утра по Москве

{LINK_LINE}

Ждём вас! 🙏`;

// No link yet → this line stands in; the warning "link not set" is only for Elena above the preview.
const messageText = (link) => MESSAGE.replace('{LINK_LINE}', link ? `🔗 Zoom: ${link}` : '🔗 Ссылка на Zoom появится здесь завтра за 10 минут до начала, в 06:50 утра по Москве.');

// ---- tags of the newcomers («теги для обучения») ----
// Stored in /data/training.json (`tags`), changed with /training_tags_set; this is only the starting
// value. Order is kept, cut by 5 (Telegram notifies at most 5 mentions per message). Elena herself
// is never tagged.
const DEFAULT_TAGS = ['@kseniya8k', '@katie_nuanu', '@NStamen', '@Bilokur_Kouch', '@Victoria_Danilko_Chelly', '@elispavlenk0', '@maiakni', '@SvetPort', '@AlisaZotovaCoach', '@JanePe'];
const ELENA_TAG = '@elena_nangtong_bali';
const TAGS_PER_MESSAGE = 5;

function cleanTags(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const t = String(raw || '').trim();
    if (!/^@[A-Za-z0-9_]{3,}$/.test(t)) continue;
    const k = t.toLowerCase();
    if (k === ELENA_TAG || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}
const getTags = (s) => cleanTags(Array.isArray(s.tags) ? s.tags : DEFAULT_TAGS);
const chunk5 = (tags) => {
  const out = [];
  for (let i = 0; i < tags.length; i += TAGS_PER_MESSAGE) out.push(tags.slice(i, i + TAGS_PER_MESSAGE));
  return out;
};
// Message 1 = the text + (at the very end, one line) the first 5 tags; the others — messages with ONLY tags.
function groupMessages(link, tags) {
  const parts = chunk5(tags);
  const first = parts.length ? `${messageText(link)}\n\n${parts[0].join(' ')}` : messageText(link);
  return { first, rest: parts.slice(1).map((p) => p.join(' ')) };
}
const mask = (t) => t.replace(/@/g, '@​'); // test group: show the tags without mentioning anybody

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
  if (!link) lines.push('⚠️ Ссылка на Zoom не задана — в тексте для группы стоит строка «ссылка появится завтра в 06:50 утра по Москве». Задать ссылку: /training_link ссылка (пришлю новое превью).', '');
  if (!isBaliMonday(now)) lines.push('ℹ️ Сегодня не понедельник — в тексте написано «завтра».', '');
  const tags = getTags(s);
  const msgs = groupMessages(link, tags);
  const total = 1 + msgs.rest.length;
  if (lines.length) await tellElena(bot, lines.join('\n').trim());
  // the preview: every message exactly as it will go to the group (in this private chat the tags notify nobody)
  await tellElena(bot, `Сообщение 1 из ${total}\n\n${msgs.first}`);
  for (let i = 0; i < msgs.rest.length; i++) await tellElena(bot, `Сообщение ${i + 2} из ${total}\n\n${msgs.rest[i]}`);
  const sent = await tellElena(bot, `👆 Превью напоминания об обучении «Хочу быть хостом»: ${total === 1 ? 'одно сообщение' : `${total} сообщения подряд`} — так они уйдут в группу WorldView Productions (тема General); сообщение 2 и далее — ответом на сообщение 1.\n\n${HOW_TO_ANSWER}`, { reply_markup: { inline_keyboard: keyboard(id) } });
  update((st) => {
    st.pending = { id, weekKey, status: 'pending', link: link || null, tags, controlMessageId: sent.message_id, createdAt: now };
  });
  return { id, link: Boolean(link) };
}

// Sends message 1 (text + first 5 tags), then — each as a REPLY to message 1 — the messages with only
// the remaining tags (5 per message), in order. Returns { sent, failed } — `failed` lists follow-ups
// that did not go out (message 1 is already in the group then, so nothing is retried automatically).
async function postToGroup(bot, chatId, link, prefix = '', { test = false } = {}) {
  const tags = getTags(readState());
  const msgs = groupMessages(link, tags);
  const fmt = (t) => (test ? mask(t) : t);
  const sent = await bot.sendMessage(chatId, `${prefix}${fmt(msgs.first)}`, { disable_web_page_preview: true });
  // the id is kept so the post can be found and deleted later
  update((st) => {
    st.lastPost = { chatId, messageId: sent.message_id, at: Date.now() };
  });
  const failed = [];
  for (const text of msgs.rest) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      await bot.sendMessage(chatId, fmt(text), { reply_to_message_id: sent.message_id, allow_sending_without_reply: true, disable_web_page_preview: true });
    } catch (err) {
      failed.push(errText(err));
    }
  }
  return { sent, failed };
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
  if ((p.link || null) !== (s.link || null)) {
    // the link changed after the preview was made → show the actual text again
    await createPreview(bot, { weekKey: p.weekKey, note: '🔄 Ссылка изменилась с момента превью — вот обновлённый текст.' });
    return;
  }
  if (JSON.stringify(p.tags || []) !== JSON.stringify(getTags(s))) {
    await createPreview(bot, { weekKey: p.weekKey, note: '🔄 Список тегов изменился с момента превью — вот обновлённые сообщения.' });
    return;
  }
  update((st) => {
    st.pending.status = 'sending'; // marked BEFORE the send: a double tap cannot post twice
  });
  let result;
  try {
    result = await postToGroup(bot, WVP_GROUP_ID, s.link);
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
  if (result.failed.length) await tellElena(bot, `⚠️ Сообщение 1 ушло в группу, но не все сообщения с тегами отправились (${result.failed.length}): ${result.failed.join('; ')}. Повторно сама ничего не отправляю.`);
  else await tellElena(bot, '✅ Напоминание об обучении отправлено в группу.');
}

// ---- scheduler tick (every 5 minutes and once after a start) ----
// Serialised (cron and the start-up timer can overlap) and the weekly flag is set only AFTER the
// preview really went out — a failed send is retried at the next tick (within the 3 h window).
function tick(bot, now = Date.now()) {
  return serial(() => tickInner(bot, now));
}
async function tickInner(bot, now = Date.now()) {
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
  if (start.auto) {
    update((st) => {
      st.done[weekKey] = { at: now, outcome: 'auto-sent' }; // before the send: never twice in the group
    });
    const r = await postToGroup(bot, WVP_GROUP_ID, start.link);
    await tellElena(bot, r.failed.length ? `Напоминание об обучении отправлено в группу, но сообщения с тегами отправились не все (${r.failed.length}): ${r.failed.join('; ')}` : 'Напоминание об обучении отправлено в группу');
    return;
  }
  await createPreview(bot, { now, weekKey });
  update((st) => {
    st.done[weekKey] = { at: Date.now(), outcome: 'preview' };
  });
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
      const m = groupMessages(s.link, getTags(s));
      return tellElena(bot, `${statusLine(s)}\n\n───────────\n${[m.first, ...m.rest].join('\n───────────\n')}\n───────────`);
    }
    case 'tags': {
      const tags = getTags(readState());
      return tellElena(bot, tags.length ? `🏷 Теги для обучения (${tags.length}), порядок как в списке, по 5 в сообщении:\n${chunk5(tags).map((c, i) => `${i === 0 ? 'Сообщение 1 (в конце текста)' : `Сообщение ${i + 1} (reply)`}: ${c.join(' ')}`).join('\n')}\n\nЗаменить: /training_tags_set @имя1 @имя2 …` : 'Список тегов пуст. Задать: /training_tags_set @имя1 @имя2 …');
    }
    case 'tags_set': {
      const tags = cleanTags(text.split(/[\s,;]+/));
      if (tags.length === 0) return tellElena(bot, 'Формат: /training_tags_set @имя1 @имя2 … (через пробел, порядок сохраняется; себя не тегаю).');
      update((st) => {
        st.tags = tags;
      });
      await tellElena(bot, `🏷 Список «теги для обучения» заменён (${tags.length}).`);
      // a preview is waiting -> show it again with the new tags
      const p = readState().pending;
      if (p && p.status === 'pending' && Date.now() - p.createdAt < 3 * DAY_MS) await serial(() => createPreview(bot, { weekKey: p.weekKey }));
      return;
    }
    case 'now':
      return serial(() => createPreview(bot));
    case 'test': {
      // The same text, right away into the test group «Дебаты» (never the big group).
      const s = readState();
      await postToGroup(bot, TEST_GROUP_ID, s.link, '🧪 [Дебаты, тест]\n\n', { test: true });
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

// ---- One-off (2.11.2026): delete the earlier post (its message_id was not saved) and re-issue ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (err) => String((err && err.response && err.response.body && err.response.body.description) || (err && err.message) || err);
const POST_START = '🎓 Завтра состоится наша встреча-обучение';
const CARD_STATE_PATH = process.env.CARD_BUTTONS_STATE_PATH || '/data/card_buttons.json';

// What kind of message is this id? Non-destructive: editing a caption of a TEXT message of
// the bot itself fails with "no caption"; someone else's message "can't be edited"; an id
// that does not exist "not found". (The bot posts no media into the groups.)
async function probeKind(bot, chatId, messageId) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await bot.editMessageCaption('.', { chat_id: chatId, message_id: messageId });
      return { kind: 'edited' };
    } catch (err) {
      const t = errText(err);
      const retry = err && err.response && err.response.body && err.response.body.parameters && err.response.body.parameters.retry_after;
      if (retry || /429|too many requests/i.test(t)) {
        await sleep(((retry || 5) + 1) * 1000);
        continue;
      }
      if (/no caption/i.test(t)) return { kind: 'bot-text' };
      if (/not found|MESSAGE_ID_INVALID/i.test(t)) return { kind: 'missing' };
      if (/can't be edited/i.test(t)) return { kind: 'other' };
      return { kind: 'unknown', text: t };
    }
  }
  return { kind: 'unknown', text: 'лимит Telegram' };
}

// The newest message id the bot recorded in the big group BEFORE `cutoff` (cards, headers,
// reminders) — the post we look for was sent later, so its id is higher.
function lowerBoundId(cutoff) {
  let st;
  try {
    st = JSON.parse(fs.readFileSync(CARD_STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
  let best = null;
  const take = (id) => {
    if (Number.isFinite(id) && (best === null || id > best)) best = id;
  };
  for (const [key, r] of Object.entries(st.messages || {})) {
    const [chat, id] = key.split(':');
    if (Number(chat) === WVP_GROUP_ID && (r.createdAt || 0) <= cutoff) take(Number(id));
  }
  for (const b of st.batches || []) {
    if (b.chatId !== WVP_GROUP_ID) continue;
    if ((b.sentAt || 0) <= cutoff) take(Number(b.headerMessageId));
    for (const r of b.reminders || []) if ((r.sentAt || 0) <= cutoff) take(Number(r.messageId));
  }
  return best;
}

// Resumable (progress in the state file; a restart continues from `nextId`).
async function findAndDeleteEarlierPost(bot, cutoff) {
  const elena = elenaChatId();
  let job = readState().cleanup;
  if (job && job.status === 'done') return job;
  if (!job) {
    // calibration in the TEST group: the error texts must be the ones we rely on
    const temp = await bot.sendMessage(TEST_GROUP_ID, '🧪 служебная проверка, сейчас удалю');
    const mine = await probeKind(bot, TEST_GROUP_ID, temp.message_id);
    const gone = await probeKind(bot, TEST_GROUP_ID, temp.message_id + 100000);
    await bot.deleteMessage(TEST_GROUP_ID, temp.message_id).catch(() => {});
    if (mine.kind !== 'bot-text' || gone.kind !== 'missing') {
      job = { status: 'done', outcome: 'calibration-failed', detail: `${mine.kind} ${mine.text || ''} / ${gone.kind} ${gone.text || ''}` };
      update((st) => { st.cleanup = job; });
      return job;
    }
    const low = lowerBoundId(cutoff);
    if (low === null) {
      job = { status: 'done', outcome: 'no-anchor' };
      update((st) => { st.cleanup = job; });
      return job;
    }
    job = { status: 'scanning', lowerBound: low, nextId: low + 1, emptyRun: 0, found: [], scanned: 0 };
    update((st) => { st.cleanup = job; });
    await tellElena(bot, '🔎 Ищу в группе своё сообщение с напоминанием об обучении, чтобы удалить (это займёт несколько минут). Потом пришлю новое превью.');
  }
  while (job.emptyRun < 60 && job.scanned < 4000) {
    const id = job.nextId;
    const p = await probeKind(bot, WVP_GROUP_ID, id);
    if (p.kind === 'missing') job.emptyRun += 1;
    else job.emptyRun = 0;
    if (p.kind === 'bot-text') {
      try {
        const fwd = await bot.forwardMessage(elena, WVP_GROUP_ID, id);
        if (fwd && String(fwd.text || '').startsWith(POST_START)) job.found.push(id);
        if (fwd && fwd.message_id) await bot.deleteMessage(elena, fwd.message_id).catch(() => {});
      } catch (err) {
        job.errors = [...(job.errors || []), `${id}: ${errText(err)}`].slice(-5);
      }
    } else if (p.kind === 'edited' || p.kind === 'unknown') {
      job.errors = [...(job.errors || []), `${id}: ${p.kind} ${p.text || ''}`].slice(-5);
    }
    job.nextId = id + 1;
    job.scanned += 1;
    if (job.scanned % 10 === 0) update((st) => { st.cleanup = job; });
    await sleep(700);
  }
  job.status = 'done';
  job.outcome = job.found.length ? 'found' : 'not-found';
  if (job.found.length) {
    const target = job.found[job.found.length - 1];
    try {
      await bot.deleteMessage(WVP_GROUP_ID, target);
      job.deleted = target;
    } catch (err) {
      job.deleteError = errText(err);
    }
  }
  update((st) => { st.cleanup = job; });
  return job;
}

// Elena replies «удалить» to the bot's training post IN THE GROUP → the bot deletes exactly that
// message (the reply carries its message_id). Only her, only the training text, only the two groups.
async function handleGroupReply(bot, msg) {
  const elena = elenaChatId();
  const r = msg.reply_to_message;
  if (!elena || !msg.from || msg.from.id !== elena || !r || !msg.text) return false;
  if (msg.chat.id !== WVP_GROUP_ID && msg.chat.id !== TEST_GROUP_ID) return false;
  if (!/^\/?(удали(ть)?|del(ete)?)(@\S+)?[.!\s]*$/i.test(msg.text.trim())) return false;
  if (!r.from || !r.from.is_bot || !String(r.text || '').startsWith(POST_START)) return false;
  try {
    await bot.deleteMessage(msg.chat.id, r.message_id);
  } catch (err) {
    await tellElena(bot, `⚠️ Telegram не дал удалить сообщение: ${errText(err)}. Удалите, пожалуйста, сами.`);
    return true;
  }
  await bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {}); // her own «удалить» (works only if the bot is an admin)
  await tellElena(bot, '🗑 Удалила из группы сообщение с напоминанием об обучении.');
  return true;
}

// Delete the earlier post, then send a fresh preview (the weekly "once" flag is not touched).
async function runReissue(bot, now = Date.now()) {
  const elena = elenaChatId();
  if (!elena) return;
  if (readState().reissueDone) return;
  const weekKey = baliMondayKey(now);
  let job;
  try {
    job = await findAndDeleteEarlierPost(bot, dueAtOf(weekKey));
  } catch (err) {
    job = { outcome: 'error', detail: errText(err) };
  }
  let report;
  if (job.deleted) report = `🗑 Удалила из группы своё сообщение с напоминанием об обучении (найдено ${job.found.length}, удалено последнее).`;
  else if (job.outcome === 'not-found') report = '⚠️ Не нашла в группе своё сообщение с напоминанием об обучении — удалите, пожалуйста, сами (последнее сообщение бота «🎓 Завтра состоится наша встреча-обучение…»).';
  else if (job.deleteError) report = `⚠️ Нашла сообщение (id ${job.found[job.found.length - 1]}), но Telegram отказал в удалении: ${job.deleteError}. Удалите, пожалуйста, сами.`;
  else report = `⚠️ Не смогла найти сообщение автоматически (${job.outcome}${job.detail ? ': ' + job.detail : ''}) — удалите, пожалуйста, сами.`;
  update((st) => { st.reissueDone = true; });
  await tellElena(bot, report);
  await serial(() => createPreview(bot, { now, weekKey, note: '🔄 Новое превью с исправленным текстом (время «утра по Москве»). В группу ничего не уйдёт, пока вы не нажмёте «Отправить в группу».' }));
}

// One-off (26.10.2026): the weekly slot of this week is already past → a new preview now (new text).
async function runOneShot(bot, now = Date.now()) {
  const weekKey = baliMondayKey(now);
  update((st) => {
    st.done[weekKey] = { at: now, outcome: 'one-shot' }; // the regular tick must not repeat it this week
    if (!st.activatedAt) st.activatedAt = now;
  });
  await serial(() => createPreview(bot, { now, weekKey, note: '🔄 Новое превью на завтрашнюю встречу (вт 27.10) с исправленным временем (только по Москве) — предыдущее заменено.' }));
}

const BOOT_AT = Date.now();

// One-off on a deploy: a fresh preview right now (the 14:00 Bali preview of 9.11.2026 never came, the new
// format has the tag messages). `key` makes it run once; if this process already sent today's preview
// by itself (regular tick), nothing more is sent.
async function runNowOnce(bot, key, note) {
  if ((readState().oneShots || {})[key]) return;
  const now = Date.now();
  const weekKey = baliMondayKey(now);
  await serial(async () => {
    const s = readState();
    const regular = s.done[weekKey] && s.done[weekKey].outcome === 'preview' && s.pending && s.pending.createdAt >= BOOT_AT;
    if (!regular) await createPreview(bot, { now, weekKey, note });
    update((st) => {
      st.oneShots = { ...(st.oneShots || {}), [key]: now };
      st.done[weekKey] = st.done[weekKey] || { at: now, outcome: 'one-shot' };
    });
  });
}

module.exports = { runNowOnce, tick, handleCommand, handleCallback, handleTextReply, handleYesNo, handleGroupReply, runOneShot, runReissue, createPreview, messageText, baliMondayKey, dueAtOf, STATE_PATH };
