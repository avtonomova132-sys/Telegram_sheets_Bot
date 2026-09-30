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
async function sendCard(bot, chatId, { titleLine, dateLine, tabUrl = null, when = null, event = null, candidateTags = loadHostCandidates() }) {
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
    const tagLine = loadHostCandidates()
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

async function processCardCallback(bot, query) {
  const message = query.message;
  const key = `${message.chat.id}:${message.message_id}`;
  const store = readJson({ messages: {} });
  const record = store.messages[key];
  const user = query.from;
  const ack = (text) => bot.answerCallbackQuery(query.id, text ? { text } : {});

  // Only hosts may act. Anyone else: no toast, no edit, nothing.
  const candidates = record ? record.candidateTags : loadHostCandidates();
  if (!isHost(user, candidates)) {
    await ack();
    return;
  }

  if (!record) {
    await ack('This card is no longer active / Эта карточка уже неактуальна');
    return;
  }
  normalizeRecord(record);

  if (record.hosted) {
    await ack('This session already has a host / У этого эфира уже есть хост');
    return;
  }

  const reserver = record.reservedBy;
  const save = async () => {
    store.messages[key] = record;
    writeJsonAtomic(store);
    await redrawCard(bot, message.chat.id, message.message_id, record);
  };

  if (query.data === TAKE_CALLBACK) {
    if (reserver) {
      await ack(
        reserver.id === user.id
          ? 'You already reserved this session / Вы уже зарезервировали этот эфир'
          : `Already reserved by ${displayName(reserver)} / Уже зарезервировал(а): ${displayName(reserver)}`
      );
      return;
    }
    record.reservedBy = { id: user.id, username: user.username, first_name: user.first_name, last_name: user.last_name, at: Date.now() };
    record.refusers = (record.refusers || []).filter((r) => r.id !== user.id);
    await save();
    await ack('Reserved for you. Tap "Open the sheet" and add yourself / Зарезервировано за вами. Нажмите «Открыть таблицу» и впишите себя 🙏');
    return;
  }

  if (query.data === PASS_CALLBACK) {
    if (reserver) {
      await ack(`Already reserved by ${displayName(reserver)} / Уже зарезервировал(а): ${displayName(reserver)}`);
      return;
    }
    record.refusers = record.refusers || [];
    const at = record.refusers.findIndex((r) => r.id === user.id);
    let added;
    if (at >= 0) {
      record.refusers.splice(at, 1);
      added = false;
    } else {
      record.refusers.push({ id: user.id, username: user.username, first_name: user.first_name, last_name: user.last_name });
      added = true;
    }
    await save();
    await ack(added ? "Noted: you can't do it / Записано: вы не можете 🙏" : 'Mark removed / Отметка снята');
    return;
  }

  if (query.data === UNDO_CALLBACK) {
    if (!reserver) {
      await ack('Nothing to cancel / Нечего отменять');
      return;
    }
    if (reserver.id !== user.id) {
      await ack(`Only ${displayName(reserver)} can cancel this reservation / Отменить резерв может только ${displayName(reserver)}`);
      return;
    }
    record.reservedBy = null;
    await save();
    await ack('Reservation cancelled / Резерв отменён');
  }
}

// Presses (and the sheet sync) on one and the same card run strictly one
// after another — two quick taps could otherwise reach Telegram out of order
// and leave a stale card.
const queues = new Map();

function runQueued(key, fn) {
  const next = (queues.get(key) || Promise.resolve()).then(fn).catch((err) => console.error('[card-buttons] ошибка:', err.message));
  queues.set(key, next);
  next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}

function handleCardCallback(bot, query) {
  const message = query.message;
  // Message no longer accessible — nothing to act on; just stop the spinner.
  if (!message) return bot.answerCallbackQuery(query.id).catch(() => {});
  const key = `${message.chat.id}:${message.message_id}`;
  return runQueued(key, async () => {
    try {
      await processCardCallback(bot, query);
    } catch (err) {
      console.error('[card-buttons] ошибка обработки нажатия:', err.message);
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

    await runQueued(key, async () => {
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

const REMINDER_DELAY_MS = 24 * 60 * 60 * 1000;

function recordBatch(chatId, headerMessageId, cardKeys, sentAt) {
  const store = readJson({ messages: {} });
  store.batches = (store.batches || []).filter((b) => (b.sentAt || 0) > Date.now() - KEEP_MS);
  store.batches.push({ chatId, headerMessageId, sentAt, cardKeys, remindedAt: null, outcome: null });
  writeJsonAtomic(store);
}

// Event start = AZ date (UTC-7, no DST) + AZ start minute.
function eventStartMs(event) {
  return Date.parse(event.dateIso) + event.azStartMin * 60000 + 7 * 3600000;
}

const refusedBy = (record, tag) => (record.refusers || []).some((r) => r.username && normUser(r.username) === normUser(tag));

// After "Для" the count takes the genitive: 1 эфира, 2/5/… эфиров, 21 эфира.
function reminderText(n, names) {
  const en = n === 1 ? '<b>1</b> session still needs a host.' : `<b>${n}</b> sessions still need a host.`;
  const ruOne = n % 10 === 1 && n % 100 !== 11;
  const ru = `Для <b>${n}</b> ${ruOne ? 'эфира' : 'эфиров'} всё ещё нужен хост.`;
  return [
    '🔔 <b>Reminder</b>',
    `${en} Please tap ✅ or ❌ under the cards above — it takes just a few seconds and helps us plan. 🙏`,
    '',
    '🔔 <b>Напоминание</b>',
    `${ru} Пожалуйста, нажмите ✅ или ❌ под карточками выше — это займёт пару секунд и очень поможет с планированием. 🙏`,
    '',
    `<b>Haven't responded yet / Ещё не отметились:</b> ${names.map((t) => escapeHtml(formatCommunityTag(t))).join(', ')}`,
  ].join('\n');
}

function planReminder(store, batch, now = Date.now()) {
  const records = batch.cardKeys.map((k) => store.messages[k]).filter(Boolean);
  records.forEach((r) => normalizeRecord(r));
  const free = records.filter((r) => !r.hosted && !r.reservedBy && !(r.event && eventStartMs(r.event) <= now));
  if (free.length === 0) return { skip: 'no-free' };
  const hosts = free[0].candidateTags;
  const unresponded = hosts.filter((t) => free.some((r) => !refusedBy(r, t)));
  if (unresponded.length === 0) return { skip: 'all-responded' };
  return { n: free.length, unresponded, text: reminderText(free.length, unresponded) };
}

const replyOptions = (batch) => ({ parse_mode: 'HTML', reply_to_message_id: batch.headerMessageId, allow_sending_without_reply: true });

const batchId = (b) => `${b.chatId}:${b.headerMessageId}`;

// Called every few minutes (catch-up style: a missed tick or a restart just
// sends it on the next one). Returns any send errors so the caller can tell
// Elena; an ordinary "nothing to remind about" is not an error.
async function checkAndSendAnnounceReminders(bot, now = Date.now()) {
  const errors = [];
  const dueIds = (readJson({ messages: {} }).batches || [])
    .filter((b) => !b.remindedAt && now >= b.sentAt + REMINDER_DELAY_MS)
    .map(batchId);

  for (const id of dueIds) {
    const store = readJson({ messages: {} });
    const batch = (store.batches || []).find((b) => batchId(b) === id);
    if (!batch || batch.remindedAt) continue;

    const superseded = store.batches.some((b) => b.chatId === batch.chatId && b.sentAt > batch.sentAt);
    const plan = superseded ? { skip: 'superseded' } : planReminder(store, batch, now);
    batch.remindedAt = now;
    batch.outcome = plan.skip || 'sent';
    writeJsonAtomic(store);

    if (plan.skip) {
      console.log(`[announce-reminder] ${id}: напоминание не нужно (${plan.skip})`);
      continue;
    }
    try {
      await withRetry(() => bot.sendMessage(batch.chatId, plan.text, replyOptions(batch)));
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
  }
  return { errors };
}

// Manual test: the same reminder for the latest announce in `chatId`, sent
// right away. Does NOT mark the batch, so its real 24h reminder still happens.
async function sendReminderNow(bot, chatId) {
  const store = readJson({ messages: {} });
  const batch = (store.batches || []).filter((b) => b.chatId === chatId).sort((a, b) => b.sentAt - a.sentAt)[0];
  if (!batch) return { sent: false, reason: 'no-announce' };
  const plan = planReminder(store, batch);
  if (plan.skip) return { sent: false, reason: plan.skip };
  await withRetry(() => bot.sendMessage(chatId, plan.text, replyOptions(batch)));
  return { sent: true, n: plan.n, tagged: plan.unresponded.length };
}

module.exports = {
  sendCard,
  sendWeekCards,
  postWeekCards,
  handleCardCallback,
  syncCardsWithSheet,
  checkAndSendAnnounceReminders,
  sendReminderNow,
  TAKE_CALLBACK,
  PASS_CALLBACK,
  UNDO_CALLBACK,
};
