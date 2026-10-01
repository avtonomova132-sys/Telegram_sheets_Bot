// "Одна карточка — одно сообщение": кнопки ✅ / ❌ под каждым эфиром без
// хоста (воскресный анонс и /next_week). Правила, которыми Elena определила
// поведение:
//
// 1. Нажимать могут ТОЛЬКО хосты (host-candidates.json, сверка по username).
//    Любое нажатие не-хоста молча игнорируется: карточка не меняется, ничего
//    не пишется, никакой всплывашки. (Telegram требует ответить на нажатие,
//    чтобы у кнопки не крутился индикатор — отвечаем пустым answerCallbackQuery,
//    он ничего не показывает.)
// 2. ✅ ("I'll take it") — резерв за этим хостом: обе кнопки заменяются на
//    "🔗 Open the sheet" (прямая ссылка на вкладку) и "↩️ Undo". Пока резерв
//    висит, другие хосты взять эфир не могут (кнопок для них нет). Undo может
//    нажать только тот же хост — карточка возвращается в исходный вид.
// 3. ❌ ("Can't do it") — считается в счётчике; если тот же хост потом нажмёт
//    ✅ — снимается из "не могут".
// 4. syncCardsWithSheet (по расписанию периодической проверки хостов): как
//    только хост реально вписан в таблицу, резерв/кнопки заменяются постоянной
//    строкой "👤 Host / Хост: Имя".
// 5. Резерв, который долго висит без записи в таблице, пока НЕ трогаем (решение
//    Elena — вернёмся позже): никакого автоматического отката по времени.
// 6. Напоминание через 24 часа после Анонса (внизу файла) — "живое": со
//    списком ещё свободных эфиров и теми же кнопками ✅/❌. Оно и карточки —
//    одно целое: нажатие в любом из них меняет запись карточки и перерисовывает
//    и карточку, и напоминание.
//
// Почему "I'll take it" — callback-кнопка, а не ссылка: Telegram не сообщает
// боту о нажатии на URL-кнопку, поэтому иначе невозможно узнать, кто именно
// нажал. Ссылку на таблицу показывает уже вторая кнопка после резерва —
// технически её видят все, кто видит сообщение (URL-кнопку нельзя показать
// избранным), защита в том, что запустить резерв может только хост.
//
// Все тексты карточки и всплывающие подсказки — на английском и русском вместе.

const fs = require('fs');
const path = require('path');
const { escapeHtml, formatCommunityTag, getNextWeekRange, collectWeekEvents, buildWeekCardParts } = require('./report');

// Telegram allows roughly 20 messages/minute into one group — a week is
// ~25 cards, so group sends are paced ~3.2s apart (a burst gets HTTP 429).
const GROUP_GAP_MS = 3200;
const PRIVATE_GAP_MS = 350;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One retry after Telegram's own "retry_after" hint on a 429; anything else
// (bot not in the group, chat not found, ...) is thrown to the caller.
async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    const retryAfter = err && err.response && err.response.body && err.response.body.parameters && err.response.body.parameters.retry_after;
    if (!retryAfter) throw err;
    await sleep((retryAfter + 1) * 1000);
    return fn();
  }
}

const STATE_PATH = process.env.CARD_BUTTONS_STATE_PATH || '/data/card_buttons.json';
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const TAKE_CALLBACK = 'card:take';
const PASS_CALLBACK = 'card:pass';
const UNDO_CALLBACK = 'card:undo';

// The 10 real hosts: both the people allowed to press the buttons and the
// denominator of the "N of M" counter. Deliberately separate from
// community-tags.json (the 5 @mentions closing /check, /weekly).
const CANDIDATES_PATH = path.join(__dirname, 'host-candidates.json');

function loadHostCandidates() {
  return JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));
}

// TEMPORARY test mode, per Elena: in the test group "Дебаты" ONLY, she is
// treated as a host (can press the buttons, is counted in "N of M" and tagged
// in the reminder) — the group has just one real host, Mikhail. Applies only
// to cards sent after this was added; to switch it off, empty this object
// (cards already sent keep the list they were created with).
const TEMP_EXTRA_HOSTS = { '-5172293748': ['@Elena_NangTong_Bali'] };

function candidatesFor(chatId) {
  const base = loadHostCandidates();
  const extra = (TEMP_EXTRA_HOSTS[String(chatId)] || []).filter((t) => !base.some((b) => normUser(b) === normUser(t)));
  return [...base, ...extra];
}

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

const normUser = (s) => String(s).replace(/^@/, '').toLowerCase();

function isHost(user, candidateTags) {
  return Boolean(user && user.username) && candidateTags.some((t) => normUser(t) === normUser(user.username));
}

function displayName(user) {
  return user.username ? `@${user.username}` : [user.first_name, user.last_name].filter(Boolean).join(' ') || 'участник';
}

// Older cards (before the reserve flow) stored the taker as `takenBy`.
function normalizeRecord(record) {
  if (record.takenBy && !record.reservedBy) record.reservedBy = record.takenBy;
  delete record.takenBy;
  return record;
}

// "❌ Can't do it / Не могут (N of M / из M): ..." and "Haven't responded yet
// / Ещё не отметились: ..." — only hosts count, M is the size of the host list.
function refusalCounterBlock(refusers, candidateTags) {
  const hostRefusers = (refusers || []).filter((r) => isHost(r, candidateTags));
  if (hostRefusers.length === 0) return null;
  const refusedNames = new Set(hostRefusers.map((r) => normUser(r.username)));
  const rest = candidateTags.filter((t) => !refusedNames.has(normUser(t)));
  const m = candidateTags.length;
  const lines = [
    `❌ <b>Can't do it / Не могут (${hostRefusers.length} of ${m} / из ${m}):</b> ${hostRefusers.map((r) => `@${r.username}`).join(', ')}`,
  ];
  if (rest.length > 0) {
    lines.push(`<b>Haven't responded yet / Ещё не отметились:</b> ${rest.map((t) => escapeHtml(formatCommunityTag(t))).join(', ')}`);
  }
  return lines.join('\n');
}

function cardText(record) {
  const lines = [record.titleLine, record.dateLine];
  if (record.hosted) {
    lines.push(`👤 <b>Host / Хост:</b> ${escapeHtml(record.hosted.name)}`);
  } else if (record.reservedBy) {
    lines.push(`⏳ <b>Reserved by / Зарезервировал(а):</b> ${escapeHtml(displayName(record.reservedBy))}`);
  } else {
    const counter = refusalCounterBlock(record.refusers, record.candidateTags);
    // Blank line + a small bold header separates the volunteer-response
    // status from the date/title above it.
    if (counter) lines.push('', '📊 <b>Response status / Статус ответов:</b>', counter);
  }
  return lines.join('\n');
}

// Buttons stay English; the AZ/MCK date+time in their labels keeps each one
// unambiguous on its own.
function cardKeyboard(record) {
  if (record.hosted) return [];
  if (record.reservedBy) {
    const rows = [];
    if (record.tabUrl) rows.push([{ text: '🔗 Open the sheet / Открыть таблицу', url: record.tabUrl }]);
    rows.push([{ text: '↩️ Undo / Отменить', callback_data: UNDO_CALLBACK }]);
    return rows;
  }
  const suffix = record.when ? ` · ${record.when}` : '';
  return [
    [{ text: `✅ I'll take it${suffix}`, callback_data: TAKE_CALLBACK }],
    [{ text: `❌ Can't do it${suffix}`, callback_data: PASS_CALLBACK }],
  ];
}

// titleLine/dateLine arrive as ready HTML strings; `event` identifies the
// sheet row (tab + date + AZ start) so the periodic sync can find it again.
async function sendCard(bot, chatId, { titleLine, dateLine, tabUrl = null, when = null, event = null, candidateTags = candidatesFor(chatId) }) {
  const record = { titleLine, dateLine, tabUrl, when, event, candidateTags, refusers: [], reservedBy: null, hosted: null };
  const sent = await withRetry(() =>
    bot.sendMessage(chatId, cardText(record), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: cardKeyboard(record) },
    })
  );

  const store = readJson({ messages: {} });
  const cutoff = Date.now() - KEEP_MS;
  for (const [key, rec] of Object.entries(store.messages)) {
    if ((rec.createdAt || 0) < cutoff) delete store.messages[key];
  }
  store.messages[`${chatId}:${sent.message_id}`] = { ...record, createdAt: Date.now() };
  writeJsonAtomic(store);
  return sent;
}

// Next week's schedule as a header + one card per event (see report.js:
// buildWeekCardParts). Used by the Sunday auto-announce and /next_week.
// requireComplete: when a spreadsheet tab failed to load, post NOTHING
// (returns aborted:'failedTabs') instead of publishing a partial schedule
// to a group. On a send error midway the thrown error carries `sentSoFar`.
async function sendWeekCards(bot, chatId, { now = new Date(), requireComplete = false } = {}) {
  const range = getNextWeekRange(now);
  const { events, failedTabs } = await collectWeekEvents(range);

  if (events.length === 0) return { aborted: 'empty', failedTabs, events: 0, sent: 0 };
  if (requireComplete && failedTabs.length > 0) return { aborted: 'failedTabs', failedTabs, events: events.length, sent: 0 };

  return postWeekCards(bot, chatId, events, range, failedTabs);
}

// The sending half of sendWeekCards, on an already-collected event list
// (split out so a test can post a hand-adjusted list through the exact same
// code path).
async function postWeekCards(bot, chatId, events, range, failedTabs = []) {
  const { header, cards, closing, openCount } = buildWeekCardParts(events, range);
  // Every event of the week already has a host — nothing to ask for.
  if (openCount === 0) return { aborted: 'allCovered', failedTabs, events: events.length, sent: 0 };

  const gapMs = chatId < 0 ? GROUP_GAP_MS : PRIVATE_GAP_MS;
  let sent = 0;
  let headerMessage = null;
  const cardKeys = [];

  try {
    // No message_thread_id is ever set, so in a forum group everything lands
    // in the default "General" topic; the header's reply is kept so callers
    // can report which topic it actually landed in.
    headerMessage = await withRetry(() => bot.sendMessage(chatId, header));
    const headerSentAt = Date.now();
    sent++;
    for (const card of cards) {
      await sleep(gapMs);
      const cardMessage = await sendCard(bot, chatId, {
        titleLine: card.titleLine,
        dateLine: card.dateLine,
        tabUrl: card.tabUrl,
        when: card.when,
        event: card.event,
      });
      cardKeys.push(`${chatId}:${cardMessage.message_id}`);
      sent++;
    }
    // Remember this announce so the 24h reminder can find it — groups only
    // (in a private preview there is nobody to remind), whoever triggered it
    // (Sunday auto-send or a manual command).
    if (chatId < 0) recordBatch(chatId, headerMessage.message_id, cardKeys, headerSentAt);
    await sleep(gapMs);
    await withRetry(() => bot.sendMessage(chatId, closing));
    sent++;
    await sleep(gapMs);
    const tagLine = candidatesFor(chatId)
      .map((t) => escapeHtml(formatCommunityTag(t)))
      .join(' ');
    await withRetry(() => bot.sendMessage(chatId, tagLine, { parse_mode: 'HTML' }));
    sent++;
  } catch (err) {
    err.sentSoFar = sent;
    throw err;
  }

  return {
    aborted: null,
    failedTabs,
    events: events.length,
    open: openCount,
    sent,
    threadId: headerMessage && headerMessage.message_thread_id != null ? headerMessage.message_thread_id : null,
  };
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

const GONE_TOAST = 'This card is no longer active / Эта карточка уже неактуальна';

// The shared rules for what a host's press does to a card, used both by the
// card's own buttons and by the buttons in the reminder (so the two stay one
// whole). Mutates `record`; returns the toast to show and whether the card
// changed. `source` only changes the wording of the "reserved" toast: from the
// reminder the sheet button lives on the session's card, not on the reminder.
function applyHostAction(record, user, action, source) {
  if (record.hosted) return { toast: 'This session already has a host / У этого эфира уже есть хост', changed: false };

  const reserver = record.reservedBy;
  const reservedByOther = reserver ? `Already reserved by ${displayName(reserver)} / Уже зарезервировал(а): ${displayName(reserver)}` : null;

  if (action === 'take') {
    if (reserver) {
      return {
        toast: reserver.id === user.id ? 'You already reserved this session / Вы уже зарезервировали этот эфир' : reservedByOther,
        changed: false,
      };
    }
    record.reservedBy = { id: user.id, username: user.username, first_name: user.first_name, last_name: user.last_name, at: Date.now() };
    record.refusers = (record.refusers || []).filter((r) => r.id !== user.id);
    return {
      toast:
        source === 'reminder'
          ? 'Reserved for you. Open the sheet with the button on that session\'s card above / Зарезервировано за вами. Откройте таблицу кнопкой на карточке этого эфира выше 🙏'
          : 'Reserved for you. Tap "Open the sheet" and add yourself / Зарезервировано за вами. Нажмите «Открыть таблицу» и впишите себя 🙏',
      changed: true,
    };
  }

  if (action === 'pass') {
    if (reserver) return { toast: reservedByOther, changed: false };
    record.refusers = record.refusers || [];
    const at = record.refusers.findIndex((r) => r.id === user.id);
    if (at >= 0) {
      record.refusers.splice(at, 1);
      return { toast: 'Mark removed / Отметка снята', changed: true };
    }
    record.refusers.push({ id: user.id, username: user.username, first_name: user.first_name, last_name: user.last_name });
    return { toast: "Noted: you can't do it / Записано: вы не можете 🙏", changed: true };
  }

  if (action === 'undo') {
    if (!reserver) return { toast: 'Nothing to cancel / Нечего отменять', changed: false };
    if (reserver.id !== user.id) {
      return { toast: `Only ${displayName(reserver)} can cancel this reservation / Отменить резерв может только ${displayName(reserver)}`, changed: false };
    }
    record.reservedBy = null;
    return { toast: 'Reservation cancelled / Резерв отменён', changed: true };
  }

  return { toast: null, changed: false };
}

// Answering never blocks the follow-up edits: a stale/expired query must not
// leave the card un-redrawn.
async function safeAck(bot, query, text) {
  try {
    await bot.answerCallbackQuery(query.id, text ? { text } : {});
  } catch (err) {
    console.error('[card-buttons] не удалось ответить на нажатие:', err.message);
  }
}

async function processCardCallback(bot, query) {
  const message = query.message;
  const key = `${message.chat.id}:${message.message_id}`;
  const store = readJson({ messages: {} });
  const record = store.messages[key];
  const user = query.from;

  // Only hosts may act. Anyone else: no toast, no edit, nothing.
  const candidates = record ? record.candidateTags : loadHostCandidates();
  if (!isHost(user, candidates)) {
    await safeAck(bot, query);
    return;
  }

  if (!record) {
    await safeAck(bot, query, GONE_TOAST);
    return;
  }
  normalizeRecord(record);

  const action = { [TAKE_CALLBACK]: 'take', [PASS_CALLBACK]: 'pass', [UNDO_CALLBACK]: 'undo' }[query.data];
  const result = action ? applyHostAction(record, user, action, 'card') : { toast: null, changed: false };

  if (result.changed) {
    store.messages[key] = record;
    writeJsonAtomic(store);
  }
  await safeAck(bot, query, result.toast);

  if (result.changed) {
    await redrawCard(bot, message.chat.id, message.message_id, record);
    await refreshRemindersForCard(bot, store, key);
  }
}

// Presses on the reminder's buttons: same host rule and same state change as
// on the card itself (applyHostAction), then BOTH the card and the reminder
// are redrawn so they always agree.
async function processReminderCallback(bot, query) {
  const message = query.message;
  const key = `${message.chat.id}:${message.message_id}`;
  const store = readJson({ messages: {} });
  const batch = findBatchByReminder(store, key);
  const user = query.from;

  const [, action, idxText] = String(query.data).split(':');
  const cardKey = batch ? batch.cardKeys[Number(idxText)] : null;
  const record = cardKey ? store.messages[cardKey] : null;

  const candidates = record ? record.candidateTags : loadHostCandidates();
  if (!isHost(user, candidates)) {
    await safeAck(bot, query);
    return;
  }

  if (!record || (action !== 'take' && action !== 'pass')) {
    await safeAck(bot, query, GONE_TOAST);
    return;
  }
  normalizeRecord(record);

  const result = applyHostAction(record, user, action, 'reminder');
  if (result.changed) {
    store.messages[cardKey] = record;
    writeJsonAtomic(store);
  }
  await safeAck(bot, query, result.toast);

  if (result.changed) {
    const [cardChatId, cardMessageId] = cardKey.split(':');
    await redrawCard(bot, Number(cardChatId), Number(cardMessageId), record);
  }
  // Even when nothing changed (e.g. someone else already reserved it) the
  // reminder is redrawn, so a stale row disappears.
  await refreshReminders(bot, store, batch);
}

// ALL card/reminder work (presses, sheet sync) runs strictly one after
// another: each is a read-modify-write of one state file plus Telegram edits,
// and two quick taps could otherwise leave a card or a reminder showing stale
// state. Volume is tiny, so one queue is plenty.
let serialChain = Promise.resolve();

function runSerial(fn) {
  const next = serialChain.then(fn).catch((err) => console.error('[card-buttons] ошибка:', err.message));
  serialChain = next;
  return next;
}

// Same queue, but the caller gets the result — or the error — back.
function runSerialStrict(fn) {
  const run = serialChain.then(fn);
  serialChain = run.catch((err) => console.error('[card-buttons] ошибка:', err.message));
  return run;
}

function handleCardCallback(bot, query) {
  const message = query.message;
  // Message no longer accessible — nothing to act on; just stop the spinner.
  if (!message) return bot.answerCallbackQuery(query.id).catch(() => {});
  return runSerial(async () => {
    try {
      await processCardCallback(bot, query);
    } catch (err) {
      console.error('[card-buttons] ошибка обработки нажатия:', err.message);
      bot.answerCallbackQuery(query.id).catch(() => {});
    }
  });
}

function handleReminderCallback(bot, query) {
  const message = query.message;
  if (!message) return bot.answerCallbackQuery(query.id).catch(() => {});
  return runSerial(async () => {
    try {
      await processReminderCallback(bot, query);
    } catch (err) {
      console.error('[card-buttons] ошибка обработки нажатия в напоминании:', err.message);
      bot.answerCallbackQuery(query.id).catch(() => {});
    }
  });
}

// Periodic check (same cadence as the host diff check): any card not yet
// showing a host is matched to its sheet row; if the sheet now has a host
// there — whether typed in after a reservation or directly — the card becomes
// the permanent "👤 Host / Хост: Name" line without buttons. Does nothing (and
// makes no Sheets requests) when there are no such cards. If any tab fails to
// load the run is skipped, since "no host found" would be unreliable.
async function syncCardsWithSheet(bot) {
  const store = readJson({ messages: {} });
  const pending = Object.entries(store.messages).filter(([, r]) => r.event && !r.hosted);
  if (pending.length === 0) return { checked: 0, updated: 0 };

  const times = pending.map(([, r]) => new Date(r.event.dateIso).getTime());
  const { events, failedTabs } = await collectWeekEvents({ start: new Date(Math.min(...times)), end: new Date(Math.max(...times)) });
  if (failedTabs.length > 0) {
    console.warn(`[card-buttons] синхронизация с таблицей пропущена, вкладки не загрузились: ${failedTabs.join('; ')}`);
    return { checked: pending.length, updated: 0, skipped: 'failedTabs' };
  }

  let updated = 0;
  for (const [key, record] of pending) {
    const match = events.find(
      (e) => e.tabUrl === record.event.tabUrl && e.date.toISOString() === record.event.dateIso && e.azStartMin === record.event.azStartMin
    );
    if (!match || !match.hasHost) continue;

    await runSerial(async () => {
      const fresh = readJson({ messages: {} });
      const rec = fresh.messages[key];
      if (!rec || rec.hosted) return;
      normalizeRecord(rec);
      rec.hosted = { name: match.host, at: Date.now() };
      rec.reservedBy = null;
      fresh.messages[key] = rec;
      writeJsonAtomic(fresh);
      updated++;
      const [chatId, messageId] = key.split(':');
      try {
        await redrawCard(bot, Number(chatId), Number(messageId), rec);
      } catch (err) {
        console.error(`[card-buttons] не удалось обновить карточку ${key}:`, err.message);
      }
      await refreshRemindersForCard(bot, fresh, key);
    });
  }

  console.log(`[card-buttons] синхронизация с таблицей: карточек проверено ${pending.length}, стало "хост назначен" ${updated}`);
  return { checked: pending.length, updated };
}

// ---- One reminder, 24h after an announce, to hosts who haven't responded ----
//
// Every announce posted to a group (Sunday auto-send or a manual command) is
// remembered as a "batch" (header message + its cards). REMINDER_DELAY_MS
// after it went out, a single reply to the header tags the hosts who still
// haven't tapped ✅ or ❌ under at least one still-free session. Sessions
// that are reserved, already hosted, or already started don't count; if none
// are left or every host has responded, nothing is sent. A batch is marked
// done BEFORE sending, so a failure never turns into a second reminder.
// If a newer announce went to the same chat first, the older batch is
// skipped (its cards are superseded).
//
// The reminder is a live view of the cards, not a separate state: it lists
// the still-free sessions with their own ✅/❌ buttons (rem:<action>:<card
// index in the batch>), and is re-rendered from the card records after every
// change to any card — a press on a card, a press on the reminder, or the
// sheet sync — while a press on the reminder redraws the card too. A session
// that gets reserved or hosted drops out of the reminder, an Undo brings it
// back, and when none are free the reminder turns into a thank-you line.

const REMINDER_DELAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_CALLBACK_PREFIX = 'rem:';
const COVERED_TEXT = '✅ All sessions are covered, thank you! / Все эфиры разобраны, спасибо! 🙏';
const MAX_MESSAGE_CHARS = 3900; // Telegram's limit is 4096

function recordBatch(chatId, headerMessageId, cardKeys, sentAt) {
  const store = readJson({ messages: {} });
  store.batches = (store.batches || []).filter((b) => (b.sentAt || 0) > Date.now() - KEEP_MS);
  store.batches.push({ chatId, headerMessageId, sentAt, cardKeys, remindedAt: null, outcome: null, reminders: [] });
  writeJsonAtomic(store);
}

// Event start = AZ date (UTC-7, no DST) + AZ start minute.
function eventStartMs(event) {
  return Date.parse(event.dateIso) + event.azStartMin * 60000 + 7 * 3600000;
}

const refusedBy = (record, tag) => (record.refusers || []).some((r) => r.username && normUser(r.username) === normUser(tag));

const batchId = (b) => `${b.chatId}:${b.headerMessageId}`;

function findBatchByReminder(store, key) {
  return (store.batches || []).find((b) => (b.reminders || []).some((r) => `${b.chatId}:${r.messageId}` === key));
}

// Sessions of the batch that can still be asked for: not hosted, not
// reserved, not started yet. `idx` is the card's position in the batch.
function freeSessions(store, batch, now) {
  const free = [];
  batch.cardKeys.forEach((key, idx) => {
    const record = store.messages[key];
    if (!record) return;
    normalizeRecord(record);
    if (record.hosted || record.reservedBy) return;
    if (record.event && eventStartMs(record.event) <= now) return;
    free.push({ idx, key, record });
  });
  return free;
}

// After "Для" the count takes the genitive: 1 эфира, 2/5/… эфиров, 21 эфира.
function reminderText(n, blocks, names, hiddenCount = 0) {
  const en = n === 1 ? '<b>1</b> session still needs a host.' : `<b>${n}</b> sessions still need a host.`;
  const ruOne = n % 10 === 1 && n % 100 !== 11;
  const ru = `Для <b>${n}</b> ${ruOne ? 'эфира' : 'эфиров'} всё ещё нужен хост.`;
  const namesText = names.length > 0 ? names.map((t) => escapeHtml(formatCommunityTag(t))).join(', ') : '—';
  const parts = [
    '🔔 <b>Reminder</b>',
    `${en} Please tap ✅ or ❌ below — it takes just a few seconds and helps us plan. 🙏`,
    '',
    '🔔 <b>Напоминание</b>',
    `${ru} Пожалуйста, нажмите ✅ или ❌ ниже — это займёт пару секунд и очень поможет с планированием. 🙏`,
    '',
    blocks.join('\n\n'),
  ];
  if (hiddenCount > 0) parts.push(`… and ${hiddenCount} more / … и ещё ${hiddenCount}`);
  parts.push('', `<b>Haven't responded yet / Ещё не отметились:</b> ${namesText}`);
  return parts.join('\n');
}

// The reminder as it should look RIGHT NOW for this batch.
function buildReminderView(store, batch, now = Date.now()) {
  const free = freeSessions(store, batch, now);
  if (free.length === 0) return { covered: true, text: COVERED_TEXT, keyboard: [], n: 0, unresponded: [] };

  const hosts = free[0].record.candidateTags;
  const unresponded = hosts.filter((t) => free.some((f) => !refusedBy(f.record, t)));

  const keyboard = [];
  for (const f of free) {
    const suffix = f.record.when ? ` · ${f.record.when}` : '';
    keyboard.push([{ text: `✅ I'll take it${suffix}`, callback_data: `${REMINDER_CALLBACK_PREFIX}take:${f.idx}` }]);
    keyboard.push([{ text: `❌ Can't do it${suffix}`, callback_data: `${REMINDER_CALLBACK_PREFIX}pass:${f.idx}` }]);
  }

  // Full two-line blocks (title + date/time) first; if the message would be
  // too long, one line per session, and as a last resort fewer sessions.
  const full = free.map((f) => `${f.record.titleLine}\n${f.record.dateLine}`);
  const compact = free.map((f) => `${f.record.titleLine}${f.record.when ? ` · ${f.record.when}` : ''}`);
  let text = reminderText(free.length, full, unresponded);
  if (text.length > MAX_MESSAGE_CHARS) text = reminderText(free.length, compact, unresponded);
  for (let shown = free.length - 1; text.length > MAX_MESSAGE_CHARS && shown > 0; shown--) {
    text = reminderText(free.length, compact.slice(0, shown), unresponded, free.length - shown);
  }
  return { covered: false, text, keyboard, n: free.length, unresponded };
}

function planReminder(store, batch, now = Date.now()) {
  const view = buildReminderView(store, batch, now);
  if (view.covered) return { skip: 'no-free' };
  if (view.unresponded.length === 0) return { skip: 'all-responded' };
  return view;
}

const replyOptions = (batch, keyboard) => ({
  parse_mode: 'HTML',
  reply_to_message_id: batch.headerMessageId,
  allow_sending_without_reply: true,
  reply_markup: { inline_keyboard: keyboard },
});

// Remember the reminder message so presses on it (and later edits) can find
// its batch. A batch can have several (the real 24h one plus /remind_test
// ones); all are kept in step.
function registerReminder(id, messageId) {
  const store = readJson({ messages: {} });
  const batch = (store.batches || []).find((b) => batchId(b) === id);
  if (!batch) return;
  batch.reminders = batch.reminders || [];
  batch.reminders.push({ messageId, sentAt: Date.now() });
  writeJsonAtomic(store);
}

async function refreshReminders(bot, store, batch) {
  if (!batch) return;
  for (const r of batch.reminders || []) {
    const view = buildReminderView(store, batch);
    try {
      await bot.editMessageText(view.text, {
        chat_id: batch.chatId,
        message_id: r.messageId,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: view.keyboard },
      });
    } catch (err) {
      if (!/message is not modified/i.test(err.message)) {
        console.error(`[announce-reminder] не удалось обновить напоминание ${batch.chatId}:${r.messageId}:`, err.message);
      }
    }
  }
}

async function refreshRemindersForCard(bot, store, cardKey) {
  const batch = (store.batches || []).find((b) => b.cardKeys.includes(cardKey));
  await refreshReminders(bot, store, batch);
}

// Called every few minutes (catch-up style: a missed tick or a restart just
// sends it on the next one). Returns any send errors so the caller can tell
// Elena; an ordinary "nothing to remind about" is not an error.
async function checkAndSendAnnounceReminders(bot, now = Date.now()) {
  const errors = [];
  const dueIds = (readJson({ messages: {} }).batches || [])
    .filter((b) => !b.remindedAt && now >= b.sentAt + REMINDER_DELAY_MS)
    .map(batchId);

  for (const id of dueIds) {
    await runSerial(async () => {
      const store = readJson({ messages: {} });
      const batch = (store.batches || []).find((b) => batchId(b) === id);
      if (!batch || batch.remindedAt) return;

      const superseded = store.batches.some((b) => b.chatId === batch.chatId && b.sentAt > batch.sentAt);
      const plan = superseded ? { skip: 'superseded' } : planReminder(store, batch, now);
      batch.remindedAt = now;
      batch.outcome = plan.skip || 'sent';
      writeJsonAtomic(store);

      if (plan.skip) {
        console.log(`[announce-reminder] ${id}: напоминание не нужно (${plan.skip})`);
        return;
      }
      try {
        const sent = await withRetry(() => bot.sendMessage(batch.chatId, plan.text, replyOptions(batch, plan.keyboard)));
        registerReminder(id, sent.message_id);
        console.log(`[announce-reminder] ${id}: отправлено, свободных эфиров ${plan.n}, отмечено хостов ${plan.unresponded.length}`);
      } catch (err) {
        errors.push({ chatId: batch.chatId, message: err.message });
        const after = readJson({ messages: {} });
        const b = (after.batches || []).find((x) => batchId(x) === id);
        if (b) {
          b.outcome = `failed: ${err.message}`;
          writeJsonAtomic(after);
        }
      }
    });
  }
  return { errors };
}

// Manual test: the same reminder (with working buttons) for the latest
// announce in `chatId`, sent right away. Does NOT mark the batch, so its real
// 24h reminder still happens.
function sendReminderNow(bot, chatId) {
  return runSerialStrict(async () => {
    const store = readJson({ messages: {} });
    const batch = (store.batches || []).filter((b) => b.chatId === chatId).sort((a, b) => b.sentAt - a.sentAt)[0];
    if (!batch) return { sent: false, reason: 'no-announce' };
    const plan = planReminder(store, batch);
    if (plan.skip) return { sent: false, reason: plan.skip };
    const sent = await withRetry(() => bot.sendMessage(chatId, plan.text, replyOptions(batch, plan.keyboard)));
    registerReminder(batchId(batch), sent.message_id);
    return { sent: true, n: plan.n, tagged: plan.unresponded.length };
  });
}

module.exports = {
  sendCard,
  sendWeekCards,
  postWeekCards,
  handleCardCallback,
  handleReminderCallback,
  syncCardsWithSheet,
  checkAndSendAnnounceReminders,
  sendReminderNow,
  TAKE_CALLBACK,
  PASS_CALLBACK,
  UNDO_CALLBACK,
  REMINDER_CALLBACK_PREFIX,
};
