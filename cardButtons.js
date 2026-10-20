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
// 6. Напоминание через 24 часа после Анонса (внизу файла): короткая шапка с
//    тегами не отметившихся хостов + копия карточки КАЖДОГО ещё свободного
//    эфира (тот же вид, те же кнопки). Копия и оригинал — одно целое: все
//    данные лежат в записи оригинала, нажатие на любую из двух меняет её и
//    перерисовывает обе.
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
const { escapeHtml, formatCommunityTag, getNextWeekRange, collectWeekEvents, buildWeekCardParts, isPastAzStart, describeDoubt, formatRange24h, formatRange12h, formatMonthDayEn, formatMonthDayRu, mskDate, programLine, setReservationLookup, sessionLabel } = require('./report');

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

// The real hosts (8): both the people allowed to press the buttons and the
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
// Same for Elena's own private chat with the bot (chat id = her user id), where
// she previews an announce before it goes to the group.
const TEMP_EXTRA_HOSTS = {
  '-5172293748': ['@Elena_NangTong_Bali'],
  ...(process.env.MY_CHAT_ID ? { [String(process.env.MY_CHAT_ID)]: ['@Elena_NangTong_Bali'] } : {}),
};

function candidatesFor(chatId, base = loadHostCandidates()) {
  const extra = (TEMP_EXTRA_HOSTS[String(chatId)] || []).filter((t) => !base.some((b) => normUser(b) === normUser(t)));
  return [...base, ...extra];
}

// Cards remember the host list they were created with. Whenever the state is
// read, that list is cut down to the CURRENT one, so someone removed from
// host-candidates.json (or from TEMP_EXTRA_HOSTS) stops counting on cards that
// were already sent: not in "N of M", not allowed to press, not tagged, and a
// reservation of theirs is dropped. It only ever removes people.
function dropFormerHosts(store) {
  if (!store || !store.messages) return store;
  const base = loadHostCandidates();
  for (const [key, record] of Object.entries(store.messages)) {
    if (!record.candidateTags) continue;
    const allowed = candidatesFor(key.split(':')[0], base).map(normUser);
    record.candidateTags = record.candidateTags.filter((t) => allowed.includes(normUser(t)));
    for (const field of ['reservedBy', 'takenBy']) {
      const taker = record[field];
      if (taker && !(taker.username && allowed.includes(normUser(taker.username)))) record[field] = null;
    }
  }
  return store;
}

function readRawJson(fallback) {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJson(fallback) {
  return dropFormerHosts(readRawJson(fallback));
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
async function sendCard(bot, chatId, { titleLine, dateLine, tabUrl = null, when = null, event = null, label = '', candidateTags = candidatesFor(chatId) }) {
  const record = { titleLine, dateLine, tabUrl, when, event, label, candidateTags, refusers: [], reservedBy: null, hosted: null };
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
// `range` overrides the default (next week) — e.g. the current week on a
// Monday. Sessions whose Arizona start has already passed are left out: asking
// for a host for something that already happened would be misleading.
// Doubts a person has already looked at and approved, so they no longer stop an
// announce. ACI 18 (Tim Lowenhaupt): the sessions stand on Oct 25 in the Data
// column while the title still says "(Oct 18, 2026)" — Elena checked it on
// 2026-10-13 ("эти два эфира относятся к 25 октября"). Matched narrowly: same
// kind of doubt, same program, same Data date.
const ACKNOWLEDGED_DOUBTS = [{ code: 'date-mismatch', tabIncludes: 'ACI 18', dateIso: '2026-10-25' }];

function liveDoubts(e) {
  return (e.doubts || []).filter(
    (d) => !ACKNOWLEDGED_DOUBTS.some((a) => a.code === d.code && e.tabName.includes(a.tabIncludes) && e.date.toISOString().slice(0, 10) === a.dateIso)
  );
}

async function sendWeekCards(bot, chatId, { now = new Date(), requireComplete = false, range = getNextWeekRange(now), reviewChatId = null, sendChecklist = false, verify = null, only = null, restOfWeek = false } = {}) {
  const collected = await collectWeekEvents(range);
  const failedTabs = collected.failedTabs;
  let events = collected.events.filter((e) => e.hasHost || !isPastAzStart(e, now));
  // `only`: the caller wants cards for just some of the sessions (mid-week
  // top-up for the ones that have no live card in the group yet).
  if (only) events = events.filter((e) => only(e));

  if (events.length === 0) return { aborted: 'empty', failedTabs, events: 0, sent: 0 };
  if (requireComplete && failedTabs.length > 0) return { aborted: 'failedTabs', failedTabs, events: events.length, sent: 0 };

  const openEvents = events.filter((e) => !e.hasHost); // = the cards, in order
  // Optional last check by the caller on the freshly built list ("is this the
  // list a person approved?"): any text back means nothing is sent.
  if (verify) {
    const reason = verify(openEvents);
    if (reason) return { aborted: 'mismatch', reason, failedTabs, events: events.length, open: openEvents.length, sent: 0 };
  }
  const strays = collected.strays || [];
  const skippedOff = collected.skippedOff || [];

  // Anything odd about a card that a person should look at first (the sheet's
  // date column disagrees with the title, an unreadable date, strange times).
  // Such an announce NEVER goes to a group by itself: the very same announce is
  // sent to `reviewChatId` (Elena's private chat) with the odd sessions listed
  // at the end. With nothing odd, no such block is added at all.
  const cardDoubts = openEvents.filter((e) => liveDoubts(e).length > 0);
  const review = cardDoubts.length > 0 ? { doubts: cardDoubts.map((e) => ({ ...e, doubts: liveDoubts(e) })), blocked: false } : null;

  let result;
  if (review && chatId < 0) {
    if (!reviewChatId) return { aborted: 'needsReview', failedTabs, events: events.length, doubts: cardDoubts.length, strays: strays.length, sent: 0 };
    review.blocked = true;
    result = { ...(await postWeekCards(bot, reviewChatId, events, range, failedTabs, review, { restOfWeek })), aborted: 'needsReview', reviewSent: true };
  } else {
    result = await postWeekCards(bot, chatId, events, range, failedTabs, chatId > 0 ? review : null, { restOfWeek });
  }

  // Private extras for Elena (never into a group): the check-list she asked
  // for, or — for a normal group send — a note about sessions that were left
  // out because only their title (not the Data column) points at this week.
  if (reviewChatId && !result.aborted) {
    if (sendChecklist) {
      await withRetry(() => bot.sendMessage(reviewChatId, checklistText(openEvents, skippedOff, strays), { parse_mode: 'HTML', disable_web_page_preview: true }));
    } else if (chatId < 0 && strays.length > 0) {
      await withRetry(() => bot.sendMessage(reviewChatId, strayNote(strays), { parse_mode: 'HTML', disable_web_page_preview: true })).catch(() => {});
    }
  } else if (reviewChatId && sendChecklist) {
    await withRetry(() => bot.sendMessage(reviewChatId, checklistText(openEvents, skippedOff, strays), { parse_mode: 'HTML', disable_web_page_preview: true }));
  }
  return { ...result, doubts: cardDoubts.length, strays: strays.length, skippedOff: skippedOff.length };
}

const ddmm = (d) => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const eventWhen = (e) => `${ddmm(e.date)}, ${formatRange24h(e.azStartMin, e.azEndMin)} AZ`;
const eventLine = (e) => `<b>${escapeHtml(e.tabName)}</b> — «${escapeHtml(e.title || 'без названия')}», ${eventWhen(e)}`;

function strayNote(strays) {
  return [
    'ℹ️ <b>Для сведения</b>',
    'Эти эфиры без хоста названием «привязаны» к этой неделе, но в колонке Data стоят в другой день — в Анонс они НЕ включены (дата берётся только из колонки Data):',
    '',
    strays.map(describeDoubt).join('\n\n'),
  ].join('\n');
}

// The short check-list message: every session in the announce with its tab,
// title and date/time from the Data column, the sessions skipped because of an
// "off" mark, and (if any) the title-only strays.
function checklistText(openEvents, skippedOff, strays) {
  const lines = ['📋 <b>Список проверки</b> (дата и время — по колонке Data, время AZ)', '', `<b>Эфиры в Анонсе (${openEvents.length}):</b>`];
  openEvents.forEach((e, i) => lines.push(`${i + 1}. ${eventLine(e)}`));
  lines.push('', skippedOff.length > 0 ? `<b>Пропущены — пометка «off» (${skippedOff.length}):</b>` : '<b>Пропущены — пометка «off»:</b> нет');
  skippedOff.forEach((e) => lines.push(`• ${eventLine(e)}`));
  if (strays.length > 0) {
    lines.push('', `<b>Не включены — в названии дата этой недели, а в колонке Data другая (${strays.length}):</b>`);
    strays.forEach((e) => lines.push(`• ${eventLine(e)}`));
  }
  return lines.join('\n');
}

// The closing block of an announce that has odd sessions (private chat only).
function reviewNoteText({ doubts, blocked }) {
  return [
    '⚠️ <b>Нужна проверка</b> — эти эфиры показались мне странными:',
    '',
    doubts.map(describeDoubt).join('\n\n'),
    '',
    blocked ? 'Это тот же Анонс, который ушёл бы в группу, — в группу он НЕ отправлен.' : 'С такими эфирами автоматическая отправка в группу не сработала бы.',
  ].join('\n');
}

// The sending half of sendWeekCards, on an already-collected event list
// (split out so a test can post a hand-adjusted list through the exact same
// code path). `review` (private chats only): {doubts, blocked} — the odd
// sessions are listed in a last message when there are any.
async function postWeekCards(bot, chatId, events, range, failedTabs = [], review = null, { restOfWeek = false } = {}) {
  const { header, cards, closing, openCount } = buildWeekCardParts(events, range, { restOfWeek });
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
        label: card.label,
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
    // Tags: always the real hosts only (the temporary "Elena is a host" test
    // mode counts her on the cards but must never end up in this line).
    const tagLine = loadHostCandidates()
      .map((t) => escapeHtml(formatCommunityTag(t)))
      .join(' ');
    await withRetry(() => bot.sendMessage(chatId, tagLine, { parse_mode: 'HTML' }));
    sent++;
    // Last: the odd sessions, in plain words — only when there are any.
    if (review) {
      await sleep(gapMs);
      await withRetry(() => bot.sendMessage(chatId, reviewNoteText(review), { parse_mode: 'HTML', disable_web_page_preview: true }));
      sent++;
    }
  } catch (err) {
    err.sentSoFar = sent;
    throw err;
  }

  return {
    aborted: null,
    failedTabs,
    events: events.length,
    open: openCount,
    cards: cards.map((c) => `${c.titleLine} | ${c.dateLine}`),
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

// The rules for what a host's press does to a session. Mutates `record`;
// returns the toast to show and whether the record changed.
function applyHostAction(record, user, action) {
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
    return { toast: 'Reserved for you. Tap "Open the sheet" and add yourself / Зарезервировано за вами. Нажмите «Открыть таблицу» и впишите себя 🙏', changed: true };
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

// A card in a reminder is a "mirror" of an announce card: its record holds
// only `mirrorOf` (the announce card's key); all state lives in that one
// original record. Pressing either copy changes the original, and then every
// copy is redrawn from it, so they always agree.
function originKeyOf(store, key) {
  const record = store.messages[key];
  return record && record.mirrorOf ? record.mirrorOf : key;
}

async function redrawViews(bot, store, originKey) {
  const origin = store.messages[originKey];
  if (!origin) return;
  const keys = [originKey, ...Object.keys(store.messages).filter((k) => store.messages[k].mirrorOf === originKey)];
  for (const key of keys) {
    const [chatId, messageId] = key.split(':');
    try {
      await redrawCard(bot, Number(chatId), Number(messageId), origin);
    } catch (err) {
      console.error(`[card-buttons] не удалось обновить карточку ${key}:`, err.message);
    }
  }
  const batch = (store.batches || []).find((b) => b.cardKeys.includes(originKey));
  await refreshReminders(bot, store, batch);
}

async function processCardCallback(bot, query) {
  const message = query.message;
  const key = `${message.chat.id}:${message.message_id}`;
  const store = readJson({ messages: {} });
  const originKey = originKeyOf(store, key);
  const record = store.messages[originKey];
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
  const result = action ? applyHostAction(record, user, action) : { toast: null, changed: false };

  if (result.changed) {
    store.messages[originKey] = record;
    writeJsonAtomic(store);
  }
  await safeAck(bot, query, result.toast);

  if (result.changed) {
    await redrawViews(bot, store, originKey);
    await evaluateCoverageForCard(bot, originKey);
  }
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
      await redrawViews(bot, fresh, key);
      await evaluateCoverageForCard(bot, key);
    });
  }

  console.log(`[card-buttons] синхронизация с таблицей: карточек проверено ${pending.length}, стало "хост назначен" ${updated}`);
  return { checked: pending.length, updated };
}

// Run once at startup: after the host list changed (see dropFormerHosts),
// redraw the still-upcoming, not-yet-hosted cards whose list or reservation
// was affected — counters and "haven't responded yet" lines lose the removed
// person — and save the cut-down state. Does nothing once everything matches,
// so it is safe on every start. Past events are left alone; the announce's
// closing tag-line (a plain message the bot doesn't track) cannot be edited.
function refreshCardsAfterHostListChange(bot) {
  return runSerial(async () => {
    // The host list in force is remembered IN the state file (meta.hostSig), so
    // the check cannot be pre-empted by another write that already saved the
    // cut-down cards (readJson prunes in memory, any later write persists it).
    const sig = JSON.stringify([loadHostCandidates().map(normUser).sort(), TEMP_EXTRA_HOSTS]);
    const raw = readRawJson(null);
    if (!raw || !raw.messages) return;
    if (raw.meta && raw.meta.hostSig === sig) return;

    const fresh = dropFormerHosts(raw);
    fresh.meta = { ...(fresh.meta || {}), hostSig: sig };
    writeJsonAtomic(fresh);
    const now = Date.now();
    const toRedraw = Object.keys(fresh.messages).filter((k) => {
      const r = fresh.messages[k];
      return !r.mirrorOf && !r.hosted && (!r.event || eventStartMs(r.event) > now);
    });
    console.log(`[card-buttons] список хостов изменился: карточек перерисовать ${toRedraw.length}`);
    for (const key of toRedraw) {
      await redrawViews(bot, fresh, key);
      await sleep(Number(key.split(':')[0]) < 0 ? GROUP_GAP_MS : PRIVATE_GAP_MS);
    }
    // Removing someone can free a session they had reserved (or, rarely, close one).
    await weekFlowTick(bot, Date.now());
  });
}

// ---- Who answered / who did not, and the Tuesday message to Elena ----
//
// The bot NEVER writes to a host itself (Elena's rule, 2026-10-15): it only
// prepares, for Elena, who has not pressed ✅ or ❌ under any session of the
// week's announce and a ready text she can send herself. A bot cannot message
// a person first anyway unless it knows their Telegram id and they pressed
// Start; ids are known only from people who once pressed a card button, so the
// preparation also says whom the bot could not even reach.

const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

// `batch` defaults to the newest announce in the chat. Reads the saved ✅/❌
// answers (per host in the CURRENT host list only) and the live sheet.
async function buildHostNudgePlan(chatId, range, now = new Date(), batch = null) {
  const store = readJson({ messages: {}, batches: [] });
  batch = batch || (store.batches || []).filter((b) => b.chatId === chatId).sort((a, b) => b.sentAt - a.sentAt)[0];
  if (!batch) return { error: 'no-announce' };

  const hosts = loadHostCandidates();
  const responses = new Map(hosts.map((t) => [normUser(t), []]));
  const known = new Map(); // username -> {id, first_name}, from any saved card
  const remember = (u) => {
    if (u && u.username && u.id) known.set(normUser(u.username), { id: u.id, first_name: u.first_name || '' });
  };
  for (const record of Object.values(store.messages)) {
    normalizeRecord(record);
    (record.refusers || []).forEach(remember);
    remember(record.reservedBy);
  }
  batch.cardKeys.forEach((key, i) => {
    const record = store.messages[key];
    if (!record) return;
    const label = `эфир ${i + 1} (${record.when || ''})`;
    if (record.reservedBy && record.reservedBy.username && responses.has(normUser(record.reservedBy.username))) {
      responses.get(normUser(record.reservedBy.username)).push(`✅ ${label}`);
    }
    for (const u of record.refusers || []) {
      if (u.username && responses.has(normUser(u.username))) responses.get(normUser(u.username)).push(`❌ ${label}`);
    }
  });

  const collected = await collectWeekEvents(range);
  const upcoming = collected.events.filter((e) => !isPastAzStart(e, now));
  const recordFor = (e) =>
    batch.cardKeys
      .map((k) => store.messages[k])
      .find((r) => r && r.event && r.event.tabUrl === e.tabUrl && r.event.dateIso === e.date.toISOString() && r.event.azStartMin === e.azStartMin);
  const freeEvents = [];
  const reservedEvents = [];
  for (const e of upcoming.filter((x) => !x.hasHost)) {
    const record = recordFor(e);
    if (record && record.reservedBy) reservedEvents.push({ event: e, by: record.reservedBy });
    else freeEvents.push(e);
  }

  const responded = [];
  const silent = [];
  for (const tag of hosts) {
    const notes = responses.get(normUser(tag));
    const person = known.get(normUser(tag)) || null;
    if (notes.length > 0) responded.push({ tag, notes });
    else silent.push({ tag, id: person ? person.id : null });
  }
  return { batch, hostCount: hosts.length, responded, silent, freeEvents, reservedEvents, failedTabs: collected.failedTabs };
}

function nudgeEventBlocks(e) {
  const programme = programLine(e.tabName, e.title);
  const en = [
    `📛 ${programme}`,
    `🕒 Arizona: ${WEEKDAYS_EN[e.date.getUTCDay()]}, ${formatMonthDayEn(e.date)}, ${formatRange12h(e.azStartMin, e.azEndMin)}`,
    `🕒 Moscow: ${formatMonthDayEn(mskDate(e))}, ${formatRange24h(e.mskStartMin, e.mskEndMin)}`,
  ].join('\n');
  const ru = [
    `📛 ${programme}`,
    `🕒 Аризона: ${WEEKDAYS_RU[e.date.getUTCDay()]}, ${formatMonthDayRu(e.date)}, ${formatRange24h(e.azStartMin, e.azEndMin)}`,
    `🕒 Москва: ${formatMonthDayRu(mskDate(e))}, ${formatRange24h(e.mskStartMin, e.mskEndMin)}`,
  ].join('\n');
  return { en, ru };
}

// The ready text for Elena to send herself: a plain question, answered with
// "yes"/"no" in words — no buttons and no "press" (answers do not go through
// the bot, so they must not be asked for as presses).
function hostQuestionText(freeEvents) {
  const many = freeEvents.length > 1;
  const blocks = freeEvents.map(nudgeEventBlocks);
  return [
    '🙏 Dear friend / Дорогой друг,',
    '',
    'English:',
    many ? 'We still need hosts for these broadcasts this week:' : 'We still need a host for a broadcast this week:',
    blocks.map((b) => b.en).join('\n\n'),
    `Would you be able to take ${many ? 'one of them' : 'it'}? A simple "yes" or "no" is all we need — it really helps us plan. Thank you for your service 💛`,
    '',
    'Русский:',
    many ? 'На этой неделе нам ещё нужны хосты на эфиры:' : 'На этой неделе нам ещё нужен хост на эфир:',
    blocks.map((b) => b.ru).join('\n\n'),
    `Сможете ли вы ${many ? 'взять какой-нибудь из них' : 'его взять'}? Достаточно ответить «да» или «нет» — это очень поможет нам спланировать. Спасибо за ваше служение 💛`,
  ].join('\n');
}

// The Tuesday message to Elena (HTML): free sessions, whom to write to (with a
// mark for people the bot cannot reach), whom not to (already answered), and
// the ready text.
function tuesdayMessageText(plan) {
  const ddmm = (d) => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const lines = ['📋 <b>Вторник: на этой неделе ещё есть свободные эфиры</b>', '', '<b>Свободны:</b>'];
  plan.freeEvents.forEach((e) =>
    lines.push(`• ${escapeHtml(programLine(e.tabName, e.title))} — AZ ${ddmm(e.date)}, ${formatRange24h(e.azStartMin, e.azEndMin)} · MCK ${ddmm(mskDate(e))}, ${formatRange24h(e.mskStartMin, e.mskEndMin)}`)
  );
  plan.reservedEvents.forEach((r) => lines.push(`• (уже есть бронь ${escapeHtml(displayName(r.by))} — не считается свободным: ${escapeHtml(programLine(r.event.tabName, r.event.title))})`));
  lines.push('', '<b>Писать этим людям</b> (ни разу не нажали ✅/❌ на этой неделе):');
  if (plan.silent.length === 0) lines.push('— таких нет, все уже ответили');
  plan.silent.forEach((s) => lines.push(`• ${escapeHtml(s.tag)}${s.id ? '' : ' — ⚠️ бот не знает его Telegram-ID, написать придётся вам лично или отметить в группе'}`));
  lines.push('', '<b>Не писать (уже ответили):</b>');
  if (plan.responded.length === 0) lines.push('— никто');
  plan.responded.forEach((r) => lines.push(`• ${escapeHtml(r.tag)} — ${r.notes.map(escapeHtml).join('; ')}`));
  if (plan.failedTabs.length > 0) lines.push('', `⚠️ Не загрузились вкладки: ${escapeHtml(plan.failedTabs.join('; '))}`);
  lines.push('', '<b>Готовый текст для личного сообщения</b> (без кнопок):', '', escapeHtml(hostQuestionText(plan.freeEvents)));
  return lines.join('\n');
}

// ---- The week's flow around an announce: "all covered", Tuesday check ----
//
// Elena's schedule for a week (2026-10-15):
//   Sunday 10:00 Bali  announce in the group (auto-send is PAUSED until she says)
//   Monday 10:00       reminder in the group, tags only hosts who never pressed
//                      (24h after the announce — checkAndSendAnnounceReminders)
//   Tuesday 10:00      (48h after) ONLY if sessions are still free: ONE message
//                      to Elena, with who to write to and a ready text. The bot
//                      itself never writes to a host — Elena does.
// And at any moment: once every session of the announce is closed (a host named
// in the sheet OR an active ✅ reservation) the bot, ONCE, tells Elena "🎉 all
// covered" and thanks the group (a reply to the announce header), and cancels
// the Monday/Tuesday messages. If an Undo frees a session again, Elena gets
// "Эфир снова свободен: …", the normal schedule is restored, and the next
// time everything closes both messages are sent again.
//
// A session is CLOSED when the sheet names any host (even someone not in the
// host list) or there is an active reservation; FREE only with neither.

const WVP_GROUP_ID = Number(process.env.VOLUNTEER_GROUP_ID) || -1001757671785;
const TEST_GROUP_ID = Number(process.env.TEST_GROUP_CHAT_ID) || -5172293748;
const LIVE_BATCH_MS = 9 * 24 * 60 * 60 * 1000; // older announces are history
const TUESDAY_DELAY_MS = 48 * 60 * 60 * 1000;

const elenaChatId = () => (process.env.MY_CHAT_ID ? Number(process.env.MY_CHAT_ID) : null);

function isLiveBatch(batch, now) {
  return (batch.chatId === WVP_GROUP_ID || batch.chatId === TEST_GROUP_ID) && now - batch.sentAt < LIVE_BATCH_MS;
}

async function sendToElena(bot, text) {
  const id = elenaChatId();
  if (!id) return;
  try {
    await withRetry(() => bot.sendMessage(id, text, { parse_mode: 'HTML', disable_web_page_preview: true }));
  } catch (err) {
    console.error('[week-flow] не удалось написать Елене:', err.message);
  }
}

function coverageOf(store, batch) {
  const cards = batch.cardKeys
    .map((key) => ({ key, record: store.messages[key] }))
    .filter((c) => c.record)
    .map((c) => {
      normalizeRecord(c.record);
      return c;
    });
  const open = cards.filter((c) => !c.record.hosted && !c.record.reservedBy);
  return { cards, open, covered: cards.length > 0 && open.length === 0 };
}

// One card as a short block: title, AZ/MCK line, and who closed it.
function cardSummaryHtml(record) {
  const head = `${record.titleLine}${record.label ? ` — ${escapeHtml(record.label)}` : ''}`;
  const who = record.hosted
    ? `👤 <b>Host / Хост:</b> ${escapeHtml(record.hosted.name)}`
    : record.reservedBy
      ? `⏳ <b>Reserved by / Зарезервировал(а):</b> ${escapeHtml(displayName(record.reservedBy))}`
      : '⭕ без хоста';
  return [head, record.dateLine, who].join('\n');
}

const coveredDmText = (cards) =>
  ['🎉 <b>Ура! Все эфиры недели закрыты / All sessions this week are covered</b>', '', cards.map((c) => cardSummaryHtml(c.record)).join('\n\n')].join('\n');

// Compares the announce's sessions with what was last told, and acts on the
// CHANGE only (so each transition happens once). Call inside the serial queue.
async function evaluateCoverage(bot, batchKey) {
  const store = readJson({ messages: {}, batches: [] });
  const batch = (store.batches || []).find((b) => batchId(b) === batchKey);
  const now = Date.now();
  if (!batch || !isLiveBatch(batch, now)) return;
  const cov = coverageOf(store, batch);

  if (cov.covered && !batch.coveredAt) {
    // Marked BEFORE anything is sent, so a failure never turns into a repeat.
    batch.coveredAt = now;
    if (!batch.remindedAt) {
      batch.remindedAt = now;
      batch.outcome = 'covered';
      batch.cancelledByCover = true;
    }
    if (!batch.tuesdayDoneAt) {
      batch.tuesdayDoneAt = now;
      batch.tuesdayCancelledByCover = true;
    }
    writeJsonAtomic(store);
    await sendToElena(bot, coveredDmText(cov.cards));
    try {
      const sent = await withRetry(() =>
        bot.sendMessage(batch.chatId, COVERED_TEXT, { reply_to_message_id: batch.headerMessageId, allow_sending_without_reply: true })
      );
      const after = readJson({ messages: {}, batches: [] });
      const b = (after.batches || []).find((x) => batchId(x) === batchKey);
      if (b) {
        b.coveredMessageId = sent.message_id;
        writeJsonAtomic(after);
      }
    } catch (err) {
      console.error(`[week-flow] не удалось написать в группу «все эфиры закрыты» (${batchKey}):`, err.message);
    }
    console.log(`[week-flow] ${batchKey}: все эфиры закрыты — написала Елене и в группу, напоминания отменены`);
    return;
  }

  if (!cov.covered && batch.coveredAt) {
    batch.coveredAt = null;
    if (batch.cancelledByCover) {
      batch.remindedAt = null;
      batch.outcome = null;
      batch.cancelledByCover = false;
    }
    if (batch.tuesdayCancelledByCover) {
      batch.tuesdayDoneAt = null;
      batch.tuesdayCancelledByCover = false;
    }
    writeJsonAtomic(store);
    await sendToElena(bot, ['🔓 <b>Эфир снова свободен:</b>', '', cov.open.map((c) => cardSummaryHtml(c.record)).join('\n\n')].join('\n'));
    console.log(`[week-flow] ${batchKey}: эфир снова свободен — обычная схема возвращена`);
  }
}

// After a change to one card: re-evaluate the announce it belongs to.
async function evaluateCoverageForCard(bot, cardKey) {
  const store = readJson({ messages: {}, batches: [] });
  const batch = (store.batches || []).find((b) => b.cardKeys.includes(cardKey));
  if (batch) await evaluateCoverage(bot, batchId(batch));
}

// Monday of the week the announce's sessions fall in, through Sunday.
function weekRangeOfBatch(store, batch) {
  const dates = batch.cardKeys
    .map((k) => store.messages[k])
    .filter((r) => r && r.event)
    .map((r) => new Date(r.event.dateIso).getTime());
  if (dates.length === 0) return null;
  const first = new Date(Math.min(...dates));
  const back = (first.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate() - back));
  return { start, end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 6)) };
}

// Tuesday check: only if something is still free (sheet + reservations).
async function runTuesdayCheck(bot, batchKey, now) {
  const store = readJson({ messages: {}, batches: [] });
  const batch = (store.batches || []).find((b) => batchId(b) === batchKey);
  if (!batch || !isLiveBatch(batch, now) || batch.tuesdayDoneAt || now < batch.sentAt + TUESDAY_DELAY_MS) return;
  const range = weekRangeOfBatch(store, batch);
  if (!range) return;
  const plan = await buildHostNudgePlan(batch.chatId, range, new Date(now), batch);
  const after = readJson({ messages: {}, batches: [] });
  const b = (after.batches || []).find((x) => batchId(x) === batchKey);
  if (!b || b.tuesdayDoneAt) return;
  b.tuesdayDoneAt = now; // once, whatever happens next
  writeJsonAtomic(after);
  if (plan.error || plan.freeEvents.length === 0) {
    console.log(`[week-flow] ${batchKey}: во вторник свободных эфиров нет — ничего не пишу`);
    return;
  }
  await sendToElena(bot, tuesdayMessageText(plan));
  console.log(`[week-flow] ${batchKey}: вторничное сообщение отправлено Елене (свободных эфиров ${plan.freeEvents.length})`);
}

// The periodic tick (every 5 minutes, from checkAndSendAnnounceReminders):
// catches changes that came from the sheet and fires the Tuesday check.
async function weekFlowTick(bot, now) {
  const batches = (readJson({ messages: {}, batches: [] }).batches || []).filter((b) => isLiveBatch(b, now));
  for (const b of batches) {
    const key = batchId(b);
    try {
      await evaluateCoverage(bot, key);
      await runTuesdayCheck(bot, key, now);
    } catch (err) {
      console.error(`[week-flow] ошибка (${key}):`, err.message);
    }
  }
}

// One-off for a week whose "all covered" was already announced by hand (the
// group has the thank-you): remember it WITHOUT writing to the group, cancel
// the reminders, and send Elena the "🎉" message once. Labels for the list are
// read from the sheet because older cards didn't store the session name.
async function markCoveredSilently(bot, chatId) {
  const store = readJson({ messages: {}, batches: [] });
  const batch = (store.batches || []).filter((b) => b.chatId === chatId).sort((a, b) => b.sentAt - a.sentAt)[0];
  if (!batch) return { done: false, reason: 'no-announce' };
  const cov = coverageOf(store, batch);
  if (!cov.covered) return { done: false, reason: 'not-covered' };
  if (batch.coveredAt) return { done: false, reason: 'already' };
  const now = Date.now();
  batch.coveredAt = now;
  if (!batch.remindedAt) {
    batch.remindedAt = now;
    batch.outcome = 'covered';
    batch.cancelledByCover = true;
  }
  if (!batch.tuesdayDoneAt) {
    batch.tuesdayDoneAt = now;
    batch.tuesdayCancelledByCover = true;
  }
  writeJsonAtomic(store);

  const range = weekRangeOfBatch(store, batch);
  if (range) {
    try {
      const { events } = await collectWeekEvents(range);
      for (const c of cov.cards) {
        const e = events.find((x) => c.record.event && x.tabUrl === c.record.event.tabUrl && x.date.toISOString() === c.record.event.dateIso && x.azStartMin === c.record.event.azStartMin);
        if (e && !c.record.label) c.record.label = sessionLabel(e.title);
      }
    } catch (err) {
      console.error('[week-flow] не удалось подтянуть названия эфиров:', err.message);
    }
  }
  await sendToElena(bot, coveredDmText(cov.cards));
  return { done: true, cards: cov.cards.length };
}

// ---- Mid-week check: what is still free from now to the end of the week ----
//
// Elena (2026-10-20): look at every session that starts AFTER this moment (AZ
// time from the sheet) up to Sunday and still has no host and no active ✅
// reservation, then:
//   A) nothing free        -> only a note to Elena listing who covers what;
//   B) all free ones already have live cards in the group -> no second
//      announce; Elena is told which sessions and where their cards are;
//   C) some free ones have NO live card -> ONE announce ("for the rest of the
//      week") with cards for exactly those sessions, to the group.
// Odd sessions (see sendWeekCards) still divert the announce to Elena.

const eventKeyOf = (e) => `${e.tabUrl || ''}|${e.date.toISOString()}|${e.azStartMin}`;
const recordKeyOf = (r) => `${(r.event && r.event.tabUrl) || ''}|${r.event && r.event.dateIso}|${r.event && r.event.azStartMin}`;

async function runRestOfWeekCheck(bot, { chatId, range, now = new Date() }) {
  const collected = await collectWeekEvents(range);
  if (collected.failedTabs.length > 0) return { case: 'failedTabs', failedTabs: collected.failedTabs };

  const store = readJson({ messages: {}, batches: [] });
  // Live cards: cards of this chat's announces that are still open (not hosted).
  // A reservation sits on the same record.
  const cardByEvent = new Map();
  for (const [key, record] of Object.entries(store.messages)) {
    if (record.mirrorOf || !record.event || Number(key.split(':')[0]) !== chatId) continue;
    normalizeRecord(record);
    cardByEvent.set(recordKeyOf(record), { key, record });
  }

  const upcoming = collected.events.filter((e) => !isPastAzStart(e, now));
  const closed = []; // {event, who}
  const free = []; // {event, card|null}
  for (const e of upcoming) {
    const card = cardByEvent.get(eventKeyOf(e)) || null;
    if (e.hasHost) closed.push({ event: e, who: `👤 ${escapeHtml(e.host)}` });
    else if (card && card.record.reservedBy) closed.push({ event: e, who: `🔒 зарезервировал(а) ${escapeHtml(displayName(card.record.reservedBy))}, ещё не вписан(а) в таблицу` });
    else free.push({ event: e, card });
  }

  const eventHtml = (e) =>
    `<b>${escapeHtml(e.tabName)}</b> — «${escapeHtml(sessionLabel(e.title) || 'без названия')}»\n   AZ: ${ddmm(e.date)}, ${formatRange24h(e.azStartMin, e.azEndMin)} · MCK: ${ddmm(mskDate(e))}, ${formatRange24h(e.mskStartMin, e.mskEndMin)}`;
  const cardLink = (key) => `https://t.me/c/${String(chatId).replace(/^-100/, '')}/${key.split(':')[1]}`;

  // A) nothing free
  if (free.length === 0) {
    const lines = ['✅ <b>Все ближайшие эфиры закрыты</b>', ''];
    closed.forEach((c) => lines.push(`${eventHtml(c.event)}\n   ${c.who}`, ''));
    if (closed.length === 0) lines.push('(до конца недели больше нет эфиров)');
    await sendToElena(bot, lines.join('\n').trim());
    return { case: 'A', closed: closed.length };
  }

  // B) every free session already has a live card in the group
  const without = free.filter((f) => !f.card);
  if (without.length === 0) {
    const lines = [`🔔 <b>Свободных эфиров: ${free.length}. Карточки с кнопками уже висят в группе</b> — второй Анонс не отправляю:`, ''];
    free.forEach((f) => lines.push(`${eventHtml(f.event)}\n   карточка: ${cardLink(f.card.key)}`, ''));
    lines.push('Отправить напоминание?');
    await sendToElena(bot, lines.join('\n').trim());
    return { case: 'B', free: free.length };
  }

  // C) announce the ones without a live card
  const wanted = new Set(without.map((f) => eventKeyOf(f.event)));
  const result = await sendWeekCards(bot, chatId, {
    now,
    range,
    requireComplete: true,
    reviewChatId: elenaChatId(),
    restOfWeek: true,
    only: (e) => wanted.has(eventKeyOf(e)),
  });
  return { case: 'C', free: free.length, withoutCard: without.length, covered: free.length - without.length, result };
}

// ---- One reminder, 24h after an announce, to hosts who haven't responded ----
//
// Every announce posted to a group (Sunday auto-send or a manual command) is
// remembered as a "batch" (header message + its cards). REMINDER_DELAY_MS
// after it went out, ONE reminder is posted as a reply to the header: a short
// message (the text, plus the hosts who haven't tapped anything at all under
// any session of this announce) followed by a copy of the card of every
// session that is still free, each with its own ✅/❌ buttons — the same look
// as in the announce. Sessions that are reserved, already hosted, or already
// started aren't copied; if none are left, nothing is sent. A batch is marked
// done BEFORE sending, so a failure never turns into a second reminder. If a
// newer announce went to the same chat first, the older batch is skipped (its
// cards are superseded).
//
// The copies are "mirrors" of the announce cards (see originKeyOf): the state
// lives only in the original record, every change redraws the original and all
// its copies, and the reminder's header (count, "haven't responded yet" list)
// is re-rendered too. When no session is free any more, the header turns into
// a thank-you line (the cards stay, showing who took each one).

const REMINDER_DELAY_MS = 24 * 60 * 60 * 1000;
const COVERED_TEXT = '✅ All sessions are covered, thank you! / Все эфиры разобраны, спасибо! 🙏';

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

const batchId = (b) => `${b.chatId}:${b.headerMessageId}`;

// Sessions of the batch that can still be asked for: not hosted, not
// reserved, not started yet.
function freeSessions(store, batch, now) {
  const free = [];
  for (const key of batch.cardKeys) {
    const record = store.messages[key];
    if (!record) continue;
    normalizeRecord(record);
    if (record.hosted || record.reservedBy) continue;
    if (record.event && eventStartMs(record.event) <= now) continue;
    free.push({ key, record });
  }
  return free;
}

// Hosts who have not tapped ✅ or ❌ under ANY session of this announce
// (reserved sessions count as a ✅).
function unrespondedHosts(store, batch) {
  const records = batch.cardKeys.map((k) => store.messages[k]).filter(Boolean);
  if (records.length === 0) return [];
  const responded = new Set();
  for (const r of records) {
    for (const u of r.refusers || []) if (u.username) responded.add(normUser(u.username));
    if (r.reservedBy && r.reservedBy.username) responded.add(normUser(r.reservedBy.username));
  }
  return records[0].candidateTags.filter((t) => !responded.has(normUser(t)));
}

// The reminder's header message as it should look RIGHT NOW.
function reminderHeaderText(n, names) {
  if (n === 0) return COVERED_TEXT;
  const en = n === 1 ? '<b>1</b> session still needs a host.' : `<b>${n}</b> sessions still need a host.`;
  // After "Для" the count takes the genitive: 1 эфира, 2/5/… эфиров, 21 эфира.
  const ruOne = n % 10 === 1 && n % 100 !== 11;
  const ru = `Для <b>${n}</b> ${ruOne ? 'эфира' : 'эфиров'} всё ещё нужен хост.`;
  const parts = [
    '🔔 <b>Reminder</b>',
    `${en} Please tap ✅ or ❌ below — it takes just a few seconds and helps us plan. 🙏`,
    '',
    '🔔 <b>Напоминание</b>',
    `${ru} Пожалуйста, нажмите ✅ или ❌ ниже — это займёт пару секунд и очень поможет с планированием. 🙏`,
  ];
  if (names.length > 0) {
    parts.push('', `<b>Haven't responded yet / Ещё не отметились:</b> ${names.map((t) => escapeHtml(formatCommunityTag(t))).join(', ')}`);
  }
  return parts.join('\n');
}

function planReminder(store, batch, now = Date.now()) {
  const free = freeSessions(store, batch, now);
  if (free.length === 0) return { skip: 'no-free' };
  return { free, text: reminderHeaderText(free.length, unrespondedHosts(store, batch)), tagged: unrespondedHosts(store, batch).length };
}

// Post the reminder: header (a reply to the announce's header), then one
// mirror card per free session. Each message is remembered as soon as it is
// sent, so presses on it work and a failure midway leaves a consistent state.
async function postReminder(bot, batch, plan) {
  const gapMs = batch.chatId < 0 ? GROUP_GAP_MS : PRIVATE_GAP_MS;
  const id = batchId(batch);
  const header = await withRetry(() =>
    bot.sendMessage(batch.chatId, plan.text, {
      parse_mode: 'HTML',
      reply_to_message_id: batch.headerMessageId,
      allow_sending_without_reply: true,
    })
  );
  const reminder = { messageId: header.message_id, sentAt: Date.now(), cardKeys: [] };
  {
    const store = readJson({ messages: {} });
    const b = (store.batches || []).find((x) => batchId(x) === id);
    if (b) {
      b.reminders = b.reminders || [];
      b.reminders.push(reminder);
      writeJsonAtomic(store);
    }
  }

  for (const f of plan.free) {
    await sleep(gapMs);
    const record = readJson({ messages: {} }).messages[f.key] || f.record;
    const sent = await withRetry(() =>
      bot.sendMessage(batch.chatId, cardText(record), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: cardKeyboard(record) },
      })
    );
    const store = readJson({ messages: {} });
    const mirrorKey = `${batch.chatId}:${sent.message_id}`;
    store.messages[mirrorKey] = { mirrorOf: f.key, createdAt: Date.now() };
    const b = (store.batches || []).find((x) => batchId(x) === id);
    const r = b && (b.reminders || []).find((x) => x.messageId === reminder.messageId);
    if (r) r.cardKeys = [...(r.cardKeys || []), mirrorKey];
    writeJsonAtomic(store);
  }
}

// Re-render the header of every reminder of the batch (the real 24h one plus
// any /remind_test ones).
async function refreshReminders(bot, store, batch) {
  if (!batch) return;
  const view = reminderHeaderText(freeSessions(store, batch, Date.now()).length, unrespondedHosts(store, batch));
  for (const r of batch.reminders || []) {
    try {
      await bot.editMessageText(view, {
        chat_id: batch.chatId,
        message_id: r.messageId,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] },
      });
    } catch (err) {
      if (!/message is not modified/i.test(err.message)) {
        console.error(`[announce-reminder] не удалось обновить напоминание ${batch.chatId}:${r.messageId}:`, err.message);
      }
    }
  }
}

// For diagnostics (logged by a one-shot): which announces the bot remembers.
function batchSummaries() {
  const store = readRawJson({ messages: {}, batches: [] });
  return (store.batches || []).map((b) => ({
    chatId: b.chatId,
    sentAt: new Date(b.sentAt).toISOString(),
    cards: b.cardKeys.length,
    eventDates: b.cardKeys.map((k) => (store.messages[k] && store.messages[k].event ? store.messages[k].event.dateIso.slice(0, 10) : '?')),
    outcome: b.outcome,
  }));
}

// Called every few minutes (catch-up style: a missed tick or a restart just
// sends it on the next one). Returns any send errors so the caller can tell
// Elena; an ordinary "nothing to remind about" is not an error.
async function checkAndSendAnnounceReminders(bot, now = Date.now()) {
  const errors = [];
  // First: "all covered" / Tuesday check — which may cancel a reminder below.
  await runSerial(() => weekFlowTick(bot, now));
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
        await postReminder(bot, batch, plan);
        console.log(`[announce-reminder] ${id}: отправлено, свободных эфиров ${plan.free.length}, не отметились совсем: ${plan.tagged}`);
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

// Manual test: the same reminder for the latest announce in `chatId`, sent
// right away. Does NOT mark the batch, so its real 24h reminder still happens.
function sendReminderNow(bot, chatId) {
  return runSerialStrict(async () => {
    const store = readJson({ messages: {} });
    const batch = (store.batches || []).filter((b) => b.chatId === chatId).sort((a, b) => b.sentAt - a.sentAt)[0];
    if (!batch) return { sent: false, reason: 'no-announce' };
    const plan = planReminder(store, batch);
    if (plan.skip) return { sent: false, reason: plan.skip };
    await postReminder(bot, batch, plan);
    return { sent: true, n: plan.free.length, tagged: plan.tagged };
  });
}

module.exports = {
  sendCard,
  sendWeekCards,
  postWeekCards,
  handleCardCallback,
  syncCardsWithSheet,
  refreshCardsAfterHostListChange,
  markCoveredSilently,
  runRestOfWeekCheck,
  weekFlowTick,
  buildHostNudgePlan,
  tuesdayMessageText,
  batchSummaries,
  checkAndSendAnnounceReminders,
  sendReminderNow,
  TAKE_CALLBACK,
  PASS_CALLBACK,
  UNDO_CALLBACK,
};

// /check must treat an active ✅ reservation in the WVP group as a closed
// session (the sheet may not name the person yet).
setReservationLookup((e) => {
  const store = readJson({ messages: {} });
  const iso = e.date.toISOString();
  for (const [key, r] of Object.entries(store.messages)) {
    if (r.mirrorOf || !r.event || !r.reservedBy || r.hosted) continue;
    if (Number(key.split(':')[0]) !== WVP_GROUP_ID) continue;
    if (r.event.tabUrl === (e.tabUrl || null) && r.event.dateIso === iso && r.event.azStartMin === e.azStartMin) return r.reservedBy;
  }
  return null;
});
