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
const { escapeHtml, formatCommunityTag, getNextWeekRange, collectWeekEvents, buildWeekCardParts, isPastAzStart, describeDoubt, formatRange24h, formatRange12h, formatMonthDayEn, formatMonthDayRu, mskDate, programLine, setReservationLookup, sessionLabel, sundayButtonWhen, weekCardDateLine } = require('./report');

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

// The real hosts: both the people allowed to press the buttons and the
// denominator of the "N of M" counter. The list lives in the bot's own store
// (hostsStore.js: /data/hosts.json), changed with /host_add, /host_remove and
// the join/leave questions to Elena — never in code. Deliberately separate
// from community-tags.json (the @mentions closing /check, /weekly).
const hostsStore = require('./hostsStore');

function loadHostCandidates() {
  return hostsStore.hosts.tags();
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
};

function candidatesFor(chatId, base = loadHostCandidates()) {
  const extra = (TEMP_EXTRA_HOSTS[String(chatId)] || []).filter((t) => !base.some((b) => normUser(b) === normUser(t)));
  return [...base, ...extra];
}

// Cards remember the host list they were created with. Whenever the state is
// read, that list is brought to the CURRENT one (hosts added or removed since),
// so the "N of M" counter, the "haven't responded" line, the tags and who may
// press all follow the list in the store. A ✅ reservation of someone who is no
// longer a host is NOT cancelled automatically — Elena is told which sessions
// are on it and decides (see hostAdmin.js).
function dropFormerHosts(store) {
  if (!store || !store.messages) return store;
  const base = loadHostCandidates();
  for (const [key, record] of Object.entries(store.messages)) {
    if (!record.candidateTags) continue;
    record.candidateTags = candidatesFor(key.split(':')[0], base);
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

// Does this person correspond to this tag? By Telegram id when the store knows
// it (survives a changed @username), otherwise by @username.
function tagMatchesUser(tag, user) {
  if (!user) return false;
  const entry = hostsStore.hosts.entryForTag(tag);
  if (entry) return hostsStore.hosts.matches(entry, user);
  return Boolean(user.username) && normUser(tag) === normUser(user.username);
}

function isHost(user, candidateTags) {
  if (!user) return false;
  // candidateTags = the ACTIVE hosts; a host who is on hold or paused still counts as a host when pressing
  return candidateTags.some((t) => tagMatchesUser(t, user)) || Boolean(hostsStore.hosts.findByUser(user));
}

// Name without "@" — in the card's status block nobody is tagged (a mention would
// notify people who already answered).
function plainName(user) {
  return user.username || [user.first_name, user.last_name].filter(Boolean).join(' ') || 'участник';
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
// `extras`: usernames that are NOT hosts but are counted (numerator AND denominator)
// on this one card — a one-off exception (record.countedExtras), e.g. someone who
// answered before being taken off the list.
function refusalCounterBlock(refusers, candidateTags, extras = []) {
  const extraNames = extras.map(normUser);
  const isExtra = (r) => Boolean(r.username) && extraNames.includes(normUser(r.username));
  const hostRefusers = (refusers || []).filter((r) => isHost(r, candidateTags) || isExtra(r));
  if (hostRefusers.length === 0) return null;
  const rest = candidateTags.filter((t) => !hostRefusers.some((r) => tagMatchesUser(t, r)));
  const m = candidateTags.length + extraNames.filter((n) => !candidateTags.some((t) => normUser(t) === n)).length;
  const lines = [
    `❌ <b>Can't do it / Не могут (${hostRefusers.length} of ${m} / из ${m}):</b> ${hostRefusers.map((r) => escapeHtml(plainName(r))).join(', ')}`,
  ];
  if (rest.length > 0) {
    lines.push(`<b>Haven't responded yet / Ещё не отметились:</b> ${rest.map((t) => escapeHtml(String(t).replace(/^@/, ''))).join(', ')}`);
  }
  return lines.join('\n');
}

function cardText(record) {
  const lines = [record.titleLine, record.dateLine];
  if (record.hosted) {
    lines.push(`👤 <b>Host / Хост:</b> ${escapeHtml(record.hosted.name)}`);
  } else if (record.reservedBy) {
    lines.push(`⏳ <b>Reserved by / Зарезервировал(а):</b> ${escapeHtml(plainName(record.reservedBy))}`);
  } else {
    const counter = refusalCounterBlock(record.refusers, record.candidateTags, record.countedExtras || []);
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

async function sendWeekCards(bot, chatId, { now = new Date(), requireComplete = false, range = getNextWeekRange(now), reviewChatId = null, sendChecklist = false, verify = null, only = null, restOfWeek = false, allowDoubts = false } = {}) {
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
  if (review && chatId < 0 && !allowDoubts) {
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
function reviewNoteText({ doubts, blocked, preview = false }) {
  return [
    '⚠️ <b>Нужна проверка</b> — эти эфиры показались мне странными:',
    '',
    doubts.map(describeDoubt).join('\n\n'),
    '',
    blocked ? 'Это тот же Анонс, который ушёл бы в группу, — в группу он НЕ отправлен.' : preview ? 'Решите, отправлять ли Анонс в группу с такими эфирами (кнопки ниже).' : 'С такими эфирами автоматическая отправка в группу не сработала бы.',
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
    record.reservedBy = { id: user.id, username: user.username, first_name: user.first_name, last_name: user.last_name, language_code: user.language_code, at: Date.now() };
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
    record.refusers.push({ id: user.id, username: user.username, first_name: user.first_name, last_name: user.last_name, language_code: user.language_code });
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
  noteHostSeen(bot, user);

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
  // Only the cards of announces that are still live (the week's, ~9 days) — the
  // sheet is read every 15 minutes while any of them is not yet confirmed there.
  const liveKeys = new Set();
  for (const b of (store.batches || []).filter((x) => isLiveBatch(x, Date.now()))) b.cardKeys.forEach((k) => liveKeys.add(k));
  const pending = Object.entries(store.messages).filter(([k, r]) => liveKeys.has(k) && r.event && !r.hosted);
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
    const tagOfUser = (u) => hosts.find((t) => tagMatchesUser(t, u));
    if (record.reservedBy && tagOfUser(record.reservedBy)) responses.get(normUser(tagOfUser(record.reservedBy))).push(`✅ ${label}`);
    for (const u of record.refusers || []) {
      if (tagOfUser(u)) responses.get(normUser(tagOfUser(u))).push(`❌ ${label}`);
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
    const entry = hostsStore.hosts.entryForTag(tag);
    const person = (entry && entry.id ? { id: entry.id, first_name: entry.name } : null) || known.get(normUser(tag)) || null;
    if (notes.length > 0) responded.push({ tag, notes });
    else silent.push({ tag, id: person ? person.id : null });
  }
  return { batch, hostCount: hosts.length, responded, silent, freeEvents, reservedEvents, failedTabs: collected.failedTabs };
}

// ---- The Tuesday note to Elena: short, three (or four) separate messages ----
//
// (1) how many hosts are needed, which sessions, and — one per line — whom to
//     write to with the language to use; (2) the ready Russian text; (3) the
//     ready English text; (4) a bilingual text for people whose language could
//     not be told. Plain text, so each message can be copied as it is. Whom NOT
//     to write to is not shown at all, nor are reserved sessions.

const WD_RU_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
// Telegram language codes treated as Russian-speaking.
const RU_LANG_CODES = new Set(['ru', 'uk', 'be', 'kk', 'ky', 'uz', 'tg', 'tk', 'az', 'hy', 'ka', 'mo']);
const hasCyrillic = (s) => /[Ѐ-ӿ]/.test(s || '');

// 'RU' | 'EN' | 'RU+EN'. First the language_code Telegram gave the bot for this
// person; without one — Cyrillic in the profile name means RU; otherwise the
// bot does not guess ('RU+EN') and Elena decides.
function hostLanguage(entry) {
  const code = entry && entry.lang ? String(entry.lang).toLowerCase().split('-')[0] : '';
  if (code) return RU_LANG_CODES.has(code) ? 'RU' : 'EN';
  if (entry && hasCyrillic(entry.name)) return 'RU';
  return 'RU+EN';
}

// Link to the session's tab and, when the row is known, to its row — the same
// tab link the "Open the sheet" button of the card uses.
function eventLink(e) {
  if (!e.tabUrl) return '';
  return e.row ? `${e.tabUrl}&range=A${e.row}` : e.tabUrl;
}

function nudgeEventBlocks(e, withLink = false) {
  const programme = programLine(e.tabName, e.title);
  const link = withLink ? eventLink(e) : '';
  const en = [
    `📛 ${programme}`,
    `🕒 Arizona: ${WEEKDAYS_EN[e.date.getUTCDay()]}, ${formatMonthDayEn(e.date)}, ${formatRange12h(e.azStartMin, e.azEndMin)}`,
    `🕒 Moscow: ${formatMonthDayEn(mskDate(e))}, ${formatRange24h(e.mskStartMin, e.mskEndMin)}`,
    link ? `🔗 ${link}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const ru = [
    `📛 ${programme}`,
    `🕒 Аризона: ${WEEKDAYS_RU[e.date.getUTCDay()]}, ${formatMonthDayRu(e.date)}, ${formatRange24h(e.azStartMin, e.azEndMin)}`,
    `🕒 Москва: ${formatMonthDayRu(mskDate(e))}, ${formatRange24h(e.mskStartMin, e.mskEndMin)}`,
    link ? `🔗 ${link}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return { en, ru };
}

// The ready text for one language ('RU' or 'EN'). One session: the link ends
// the paragraph; several: each session carries its own link line.
function hostMessageText(freeEvents, lang) {
  const many = freeEvents.length > 1;
  const blocks = freeEvents.map((e) => nudgeEventBlocks(e, many));
  const link = many ? '' : eventLink(freeEvents[0]);
  if (lang === 'EN') {
    return [
      '🙏 Dear friend, hello!',
      many ? 'This week we still need hosts for these broadcasts:' : 'This week we still need a host for a broadcast:',
      blocks.map((b) => b.en).join('\n\n'),
      `We haven't seen your response in the group yet. Could you please let us know if you can take ${many ? 'one of them' : 'it'}? A simple "yes" or "no" is all we need, it really helps us plan the week. If "yes", please add your name in the Host column of the spreadsheet${many ? ' (the link is under the broadcast above)' : `: ${link}`}`,
      'Thank you for your service 💛',
    ].join('\n');
  }
  return [
    '🙏 Дорогой друг, добрый день!',
    many ? 'На этой неделе нам ещё нужны хосты на эфиры:' : 'На этой неделе нам ещё нужен хост на эфир:',
    blocks.map((b) => b.ru).join('\n\n'),
    `В группе мы не получили от вас отметки. Подскажите, пожалуйста, сможете ли вы ${many ? 'взять один из них' : 'его взять'}? Достаточно ответить «да» или «нет», это очень помогает нам спланировать неделю. Если «да», впишите, пожалуйста, своё имя в колонку Host в таблице${many ? ' (ссылка под нужным эфиром выше)' : `: ${link}`}`,
    'Спасибо за ваше служение 💛',
  ].join('\n');
}

function hostsNeededPhrase(n) {
  const one = n % 10 === 1 && n % 100 !== 11;
  const few = [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100);
  if (one) return `Нужен ${n} хост`;
  return `Нужны ${n} ${few ? 'хоста' : 'хостов'}`;
}

// -> array of plain-text messages (empty when nothing is free).
function buildTuesdayMessages(plan) {
  if (plan.error || plan.freeEvents.length === 0) return [];
  const ddmm2 = (d) => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const lines = [`📋 ${hostsNeededPhrase(plan.freeEvents.length)} на этой неделе`, ''];
  for (const e of plan.freeEvents) {
    const msk = mskDate(e);
    const mskDay = msk.getTime() === e.date.getTime() ? '' : `${WD_RU_SHORT[msk.getUTCDay()]} ${ddmm2(msk)} `;
    lines.push(`📛 ${programLine(e.tabName, e.title)}`);
    lines.push(`   ${WD_RU_SHORT[e.date.getUTCDay()]}, ${ddmm2(e.date)} · AZ ${formatRange24h(e.azStartMin, e.azEndMin)} / MCK ${mskDay}${formatRange24h(e.mskStartMin, e.mskEndMin)}`);
  }
  lines.push('');

  const people = plan.silent.map((s) => {
    const entry = hostsStore.hosts.entryForTag(s.tag) || {};
    return { tag: s.tag, lang: hostLanguage(entry), knownId: Boolean(entry.id || s.id) };
  });
  if (people.length === 0) {
    lines.push('Писать никому не нужно — все уже отметились.');
  } else {
    lines.push('Кому написать:');
    people.forEach((p, i) => lines.push(`${i + 1}) ${p.tag}: ${p.lang}${p.knownId ? '' : ', ⚠️ бот не знает его Telegram-ID, нужно написать самой'}`));
  }
  if (plan.failedTabs.length > 0) lines.push('', `⚠️ Не загрузились вкладки: ${plan.failedTabs.join('; ')}`);

  const messages = [lines.join('\n')];
  const has = (l) => people.some((p) => p.lang === l);
  if (has('RU')) messages.push(hostMessageText(plan.freeEvents, 'RU'));
  if (has('EN')) messages.push(hostMessageText(plan.freeEvents, 'EN'));
  if (has('RU+EN')) messages.push(`${hostMessageText(plan.freeEvents, 'RU')}\n\n— — —\n\n${hostMessageText(plan.freeEvents, 'EN')}`);
  return messages;
}

async function sendPlainToElena(bot, text) {
  const id = elenaChatId();
  if (!id) return;
  try {
    await withRetry(() => bot.sendMessage(id, text, { disable_web_page_preview: true }));
  } catch (err) {
    console.error('[week-flow] не удалось написать Елене:', err.message);
  }
  await sleep(PRIVATE_GAP_MS);
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

// The week as a whole: every live announce of the same chat and the same
// Monday–Sunday week (the Sunday one, a mid-week top-up, urgent single-session
// cards) is ONE picture. "All covered" fires only when every card of all of them
// is closed AND the last hourly sheet scan knows of no free session without a
// card — otherwise a top-up that still had open cards would be thanked too early.
function weekBatchesOf(store, batch) {
  const range = weekRangeOfBatch(store, batch);
  if (!range) return { range: null, batches: [batch] };
  const iso = isoOf(range.start);
  const now = Date.now();
  const batches = (store.batches || []).filter((b) => {
    if (b.chatId !== batch.chatId || !isLiveBatch(b, now)) return false;
    const r = weekRangeOfBatch(store, b);
    return r && isoOf(r.start) === iso;
  });
  return { range, batches: batches.length > 0 ? batches : [batch] };
}

function weekCoverage(store, batches) {
  const seen = new Set();
  const cards = [];
  for (const b of batches) {
    for (const key of b.cardKeys) {
      const record = store.messages[key];
      if (!record || seen.has(key)) continue;
      seen.add(key);
      normalizeRecord(record);
      cards.push({ key, record });
    }
  }
  const open = cards.filter((c) => !c.record.hosted && !c.record.reservedBy);
  return { cards, open, covered: cards.length > 0 && open.length === 0 };
}

// Free sessions of this week seen by the last scan that still have no card.
function freeWithoutCardNow(store, chatId, mondayIso, now) {
  const scan = store.scheduler && store.scheduler.lastScan;
  if (!scan || scan.weekMonday !== mondayIso || now - scan.at > 3 * 60 * 60 * 1000) return [];
  const have = new Set();
  for (const [key, r] of Object.entries(store.messages)) {
    if (!r.mirrorOf && r.event && Number(key.split(':')[0]) === chatId) have.add(recordKeyOf(r));
  }
  return (scan.freeNoCardKeys || []).filter((k) => !have.has(k));
}

// Compares the week's sessions with what was last told, and acts on the CHANGE
// only (so each transition happens once). Call inside the serial queue.
async function evaluateCoverage(bot, batchKey) {
  const store = readJson({ messages: {}, batches: [] });
  const batch = (store.batches || []).find((b) => batchId(b) === batchKey);
  const now = Date.now();
  if (!batch || !isLiveBatch(batch, now)) return;
  const { range, batches } = weekBatchesOf(store, batch);
  const cov = weekCoverage(store, batches);
  const iso = range ? isoOf(range.start) : '';
  const stray = freeWithoutCardNow(store, batch.chatId, iso, now);
  const covered = cov.covered && stray.length === 0;
  const wasCovered = batches.some((b) => b.coveredAt);
  const prefix = batch.chatId === TEST_GROUP_ID ? '🧪 [Дебаты, тест] ' : '';

  if (covered && !wasCovered) {
    // Marked BEFORE anything is sent, so a failure never turns into a repeat.
    for (const b of batches) {
      b.coveredAt = now;
      if (!b.remindedAt) {
        b.remindedAt = now;
        b.outcome = 'covered';
        b.cancelledByCover = true;
      }
      if (!b.tuesdayDoneAt) {
        b.tuesdayDoneAt = now;
        b.tuesdayCancelledByCover = true;
      }
    }
    schedulerOf(store);
    const keys = new Set(batches.map(batchId));
    for (const p of Object.values(store.scheduler.pending)) {
      if (['reminder', 'urgent'].includes(p.kind) && p.status === 'pending' && (keys.has(p.batchKey) || p.chatId === batch.chatId)) {
        p.status = 'stale';
        removeButtons(bot, p);
      }
    }
    writeJsonAtomic(store);
    await sendToElena(bot, prefix + coveredDmText(cov.cards));
    const newest = batches.slice().sort((a, b) => b.sentAt - a.sentAt)[0];
    try {
      const sent = await withRetry(() =>
        bot.sendMessage(batch.chatId, COVERED_TEXT, { reply_to_message_id: newest.headerMessageId, allow_sending_without_reply: true })
      );
      const after = readJson({ messages: {}, batches: [] });
      const b = (after.batches || []).find((x) => batchId(x) === batchId(newest));
      if (b) {
        b.coveredMessageId = sent.message_id;
        writeJsonAtomic(after);
      }
    } catch (err) {
      console.error(`[week-flow] не удалось написать в группу «все эфиры закрыты» (${batchKey}):`, err.message);
    }
    console.log(`[week-flow] ${batchKey}: все эфиры недели закрыты — написала Елене и в группу, напоминания отменены`);
    return;
  }

  if (!covered && wasCovered) {
    for (const b of batches) {
      b.coveredAt = null;
      if (b.cancelledByCover) {
        b.remindedAt = null;
        b.outcome = null;
        b.cancelledByCover = false;
      }
      if (b.tuesdayCancelledByCover) {
        b.tuesdayDoneAt = null;
        b.tuesdayCancelledByCover = false;
      }
    }
    writeJsonAtomic(store);
    const lines = cov.open.map((c) => cardSummaryHtml(c.record));
    stray.forEach(() => lines.push('⭕ ещё один свободный эфир без карточки — смотрите /check'));
    await sendToElena(bot, [`${prefix}🔓 <b>Эфир снова свободен:</b>`, '', lines.join('\n\n')].join('\n'));
    console.log(`[week-flow] ${batchKey}: эфир снова свободен — обычная схема возвращена`);
  }
}

// After a change to one card: re-evaluate the announce it belongs to.
async function evaluateCoverageForCard(bot, cardKey) {
  const store = readJson({ messages: {}, batches: [] });
  const batch = (store.batches || []).find((b) => b.cardKeys.includes(cardKey));
  if (batch) await evaluateCoverage(bot, batchId(batch));
  await voidUrgentForCard(bot, cardKey);
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
  if (!batch || !isLiveBatch(batch, now) || batch.tuesdayDoneAt) return;
  const range = weekRangeOfBatch(store, batch);
  if (!range) return;
  const due = tuesdayDueAt(batch, range);
  if (now < due) return;
  if (batch.sentAt >= due) {
    updateScheduler((s, st) => {
      const x = (st.batches || []).find((y) => batchId(y) === batchKey);
      if (x) x.tuesdayDoneAt = now;
    });
    return;
  }
  if (now > due + CATCHUP_MS) {
    // Missed by more than 3 hours (bot unavailable): not run, and said out loud.
    const activatedAt = store.scheduler?.activatedAt || 0;
    updateScheduler((s, st) => {
      const x = (st.batches || []).find((y) => batchId(y) === batchKey);
      if (x) x.tuesdayDoneAt = now;
    });
    if (due >= activatedAt) await sendToElena(bot, `⚠️ Вторничная проверка по Анонсу ${weekLabel(range)} не выполнилась вовремя (бот был недоступен больше 3 часов). Состояние недели: /check`);
    return;
  }
  const plan = await buildHostNudgePlan(batch.chatId, range, new Date(now), mergedWeekBatch(store, batch, range));
  const after = readJson({ messages: {}, batches: [] });
  const b = (after.batches || []).find((x) => batchId(x) === batchKey);
  if (!b || b.tuesdayDoneAt) return;
  b.tuesdayDoneAt = now; // once, whatever happens next
  writeJsonAtomic(after);
  const messages = buildTuesdayMessages(plan);
  if (messages.length === 0) {
    console.log(`[week-flow] ${batchKey}: во вторник свободных эфиров нет — ничего не пишу`);
    return;
  }
  for (const m of messages) await sendPlainToElena(bot, m);
  console.log(`[week-flow] ${batchKey}: вторничные сообщения отправлены Елене (${messages.length} шт., свободных эфиров ${plan.freeEvents.length})`);
}

// All announces of the same chat and week taken together (the Sunday one and a
// later top-up), so "has this host answered this week" looks at every card.
function mergedWeekBatch(store, batch, range) {
  const keys = new Set(batch.cardKeys);
  for (const other of store.batches || []) {
    if (other.chatId !== batch.chatId) continue;
    const r = weekRangeOfBatch(store, other);
    if (r && r.start.getTime() === range.start.getTime()) other.cardKeys.forEach((k) => keys.add(k));
  }
  return { ...batch, cardKeys: [...keys] };
}

// /tuesday — the same note on demand (any day), for the newest live announce in
// the WVP group. Unlike the Tuesday run it also says when nothing is free.
async function runTuesdayPreview(bot, now = Date.now()) {
  const store = readJson({ messages: {}, batches: [] });
  const batch = (store.batches || []).filter((b) => b.chatId === WVP_GROUP_ID && isLiveBatch(b, now)).sort((a, b) => b.sentAt - a.sentAt)[0];
  if (!batch) return sendPlainToElena(bot, 'Сейчас нет живого Анонса в большой группе — нечего проверять.');
  const range = weekRangeOfBatch(store, batch);
  if (!range) return sendPlainToElena(bot, 'Не нашла эфиры этого Анонса.');
  const plan = await buildHostNudgePlan(batch.chatId, range, new Date(now), mergedWeekBatch(store, batch, range));
  const messages = buildTuesdayMessages(plan);
  if (messages.length === 0) return sendPlainToElena(bot, `Свободных эфиров на неделе ${weekLabel(range)} нет — во вторник я бы ничего не отправляла.`);
  for (const m of messages) await sendPlainToElena(bot, m);
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
      await reportProblem(bot, `flow:${key}`, `Проверка недели (Анонс ${key}) не сработала: ${err.message}`);
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
  return records[0].candidateTags.filter(
    (t) => !records.some((r) => (r.refusers || []).some((u) => tagMatchesUser(t, u)) || (r.reservedBy && tagMatchesUser(t, r.reservedBy)))
  );
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

// One-off exception: on the card(s) of the given session also count this username
// (shown without @, counted in "N of M" on both sides). Not a host, never tagged.
function addCountedExtraForEvent({ dateIso, azStartMin }, username) {
  return runSerialStrict(async () => {
    const store = readJson({ messages: {}, batches: [] });
    let n = 0;
    for (const [key, r] of Object.entries(store.messages)) {
      if (r.mirrorOf || !r.event || r.event.dateIso !== dateIso || r.event.azStartMin !== azStartMin) continue;
      if (Number(key.split(':')[0]) !== WVP_GROUP_ID) continue;
      r.countedExtras = [...new Set([...(r.countedExtras || []), username])];
      n++;
    }
    if (n > 0) writeJsonAtomic(store);
    return n;
  });
}

// ---- Hosts: what the card state tells hostAdmin.js ----

// A host was seen pressing a button: remember the id / name, follow a changed
// @username. A rename also refreshes the cards (tags and counters).
function noteHostSeen(bot, user) {
  const seen = hostsStore.hosts.learn(user);
  if (seen && seen.renamedFrom) {
    sendToElena(bot, `ℹ️ ${escapeHtml(seen.renamedFrom)} сменил(а) имя пользователя на ${escapeHtml(seen.entry.tag)} — в списке хостов обновила.`);
    refreshCardsAfterHostListChange(bot).catch(() => {});
  }
}

// At start: remember the Telegram ids of hosts who already pressed buttons on
// saved cards (so people can be matched by id, and "known id" shows in /hosts).
function learnHostIdsFromCards() {
  const store = readJson({ messages: {} });
  let learned = 0;
  for (const record of Object.values(store.messages)) {
    for (const u of [...(record.refusers || []), record.reservedBy].filter(Boolean)) {
      if (!u.id) continue;
      const before = hostsStore.hosts.findByUser(u);
      if (before && !before.id) {
        hostsStore.hosts.learn(u);
        learned++;
      }
    }
  }
  return learned;
}

// Sessions of live announces that carry this person's ✅ reservation.
function reservationsOfHost(entry) {
  const store = readJson({ messages: {}, batches: [] });
  const keys = new Set();
  for (const b of (store.batches || []).filter((x) => isLiveBatch(x, Date.now()))) b.cardKeys.forEach((k) => keys.add(k));
  const out = [];
  for (const key of keys) {
    const r = store.messages[key];
    if (!r || r.hosted || !r.reservedBy || !hostsStore.hosts.matches(entry, r.reservedBy)) continue;
    out.push({ key, text: `${(r.titleLine || '').replace(/<[^>]+>/g, '')}${r.label ? ` — ${r.label}` : ''} (${r.when || ''})` });
  }
  return out;
}

// Elena frees a reservation (the holder left or is no longer a host).
function releaseReservation(bot, key) {
  return runSerialStrict(async () => {
    const store = readJson({ messages: {}, batches: [] });
    const record = store.messages[key];
    if (!record || !record.reservedBy) return { released: false };
    record.reservedBy = null;
    store.messages[key] = record;
    writeJsonAtomic(store);
    await redrawViews(bot, store, key);
    await evaluateCoverageForCard(bot, key);
    return { released: true };
  });
}

// ---- The weekly schedule WITH Elena's confirmation ----
//
// Nothing goes to the group by itself any more (Elena, 2026-10-21). All times
// are Bali (UTC+8, no DST); the only things written to the group without a
// "yes" from Elena are the thank-you replies of the "all covered" flow.
//
//   Sunday 09:00   preview of NEXT week's announce -> Elena only, exactly as it
//                  would look in the group, plus "Send / Don't send" buttons
//   Monday 09:00   preview of the reminder (header + cards of what is still
//                  free + tags of those who never pressed) -> Elena, same buttons
//   Tuesday 09:00  (only if something is still free) a note to Elena: whom to
//                  write to, whom not, and a ready text. The bot never writes to
//                  a host.
//   any time       "all covered" (see evaluateCoverage) — automatic.
//
// "Yes" = the inline button, the word да/yes as a REPLY to the preview, or
// /yes (/no for the opposite). Before sending, the table is checked again: if
// the list of sessions changed since the preview, nothing is sent and an
// updated preview with what changed is shown instead.
//
// No AI anywhere in here. Everything is a plain clock + saved state, so it
// survives restarts: the state lives in the same /data/card_buttons.json
// (store.scheduler), a slot that is due is done once (a "done" mark), and a slot
// that was missed by up to 3 hours (bot down/restarting) is still run on start;
// older than that it is NOT run and Elena is told. Any failure is reported to
// her in private, never silently.

const CATCHUP_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const isoOf = (d) => d.toISOString().slice(0, 10);
const addDaysUtc = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
const range7 = (monday) => ({ start: monday, end: addDaysUtc(monday, 6) });
// 09:00 Bali of the given calendar date (a UTC-midnight Date) = 01:00 UTC.
const at0900 = (d, plusDays = 0) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + plusDays, 1, 0, 0);

function baliMonday(ms) {
  const b = new Date(ms + 8 * 3600 * 1000);
  const back = (b.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() - back));
}

function schedulerOf(store) {
  store.scheduler = store.scheduler || {};
  const s = store.scheduler;
  s.done = s.done || {};
  s.pending = s.pending || {};
  s.errors = s.errors || {};
  s.urgent = s.urgent || {};
  return s;
}

// Read–change–write of the scheduler part of the state, synchronously.
function updateScheduler(fn) {
  const store = readJson({ messages: {}, batches: [] });
  const s = schedulerOf(store);
  const result = fn(s, store);
  writeJsonAtomic(store);
  return result;
}

// A problem is told to Elena at most once per `everyMs` per key.
async function reportProblem(bot, key, text, everyMs = 60 * 60 * 1000) {
  const now = Date.now();
  const due = updateScheduler((s) => {
    if (s.errors[key] && now - s.errors[key] < everyMs) return false;
    s.errors[key] = now;
    return true;
  });
  console.error(`[week-schedule] ${key}: ${text}`);
  if (due) await sendToElena(bot, `⚠️ ${escapeHtml(text)}`);
}

// ---- When each thing is due ----
// The reminder: Monday 09:00 of the announce's week; for an announce sent after
// that (mid-week top-up) 24 hours after it was sent.
const reminderDueAt = (batch, range) => (batch.sentAt < at0900(range.start) ? at0900(range.start) : batch.sentAt + DAY_MS);
// Tuesday's note: Tuesday 09:00 of the announce's week — and ONLY then. An
// announce sent after that moment (a mid-week top-up) gets no Tuesday note.
const tuesdayDueAt = (batch, range) => at0900(range.start, 1);

// ---- Signatures: "is this still the list that was previewed?" ----
function announceItems(openEvents) {
  return openEvents.map((e) => `${e.tabName} | ${isoOf(e.date)} ${formatRange24h(e.azStartMin, e.azEndMin)} AZ | ${sessionLabel(e.title) || '—'}`).sort();
}
function announceSignature(openEvents) {
  return JSON.stringify(openEvents.map((e) => [e.tabUrl || '', isoOf(e.date), e.azStartMin, e.azEndMin, liveDoubts(e).map((d) => d.code).sort()]).sort());
}
function diffNote(oldItems, newItems) {
  const added = newItems.filter((x) => !oldItems.includes(x));
  const removed = oldItems.filter((x) => !newItems.includes(x));
  const lines = ['⚠️ <b>Список эфиров изменился с момента предыдущего превью</b> — в группу ничего не отправлено. Что поменялось:'];
  added.forEach((x) => lines.push(`➕ ${escapeHtml(x)}`));
  removed.forEach((x) => lines.push(`➖ ${escapeHtml(x)}`));
  if (added.length === 0 && removed.length === 0) lines.push('(поменялись детали эфиров — даты, время или сомнения)');
  return lines.join('\n');
}

const controlKeyboard = (id) => [[{ text: '✅ Отправить в группу / Send to group', callback_data: `wk:ok:${id}` }, { text: "❌ Не отправлять / Don't send", callback_data: `wk:no:${id}` }]];
const weekLabel = (range) => `${ddmm(range.start)}–${ddmm(range.end)}`;
const HOW_TO_ANSWER = 'Нажмите кнопку, ответьте на это сообщение словом «да» / «нет» или напишите /yes / /no.';

async function removeButtons(bot, p) {
  if (!p || !p.controlMessageId) return;
  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: elenaChatId(), message_id: p.controlMessageId });
  } catch {
    /* already gone / unchanged */
  }
}

// ---- A) Announce preview ----
// `prev`: items of the preview this one replaces (to show what changed).
async function createAnnouncePreview(bot, { monday, now = Date.now(), prevItems = null, manual = false }) {
  const elena = elenaChatId();
  if (!elena) throw new Error('MY_CHAT_ID не задан — некому слать превью');
  const range = range7(monday);
  const key = `announce:${isoOf(monday)}`;
  const collected = await collectWeekEvents(range);
  if (collected.failedTabs.length > 0) throw new Error(`не загрузились вкладки таблицы: ${collected.failedTabs.join('; ')}`);
  const events = collected.events.filter((e) => e.hasHost || !isPastAzStart(e, new Date(now)));
  const openEvents = events.filter((e) => !e.hasHost);

  if (openEvents.length === 0) {
    // A manual run never uses up the Sunday slot.
    if (!manual) {
      updateScheduler((s) => {
        s.done[key] = { at: now, outcome: 'none' };
      });
    }
    await sendToElena(bot, manual ? `На неделю ${weekLabel(range)} эфиров без хоста нет` : 'На следующую неделю эфиров без хоста нет');
    return { none: true };
  }

  const doubts = openEvents.filter((e) => liveDoubts(e).length > 0).map((e) => ({ ...e, doubts: liveDoubts(e) }));
  const review = doubts.length > 0 ? { doubts, blocked: false, preview: true } : null;
  await postWeekCards(bot, elena, events, range, [], review);

  const items = announceItems(openEvents);
  const id = `a-${isoOf(monday)}`;
  const text = [
    prevItems ? diffNote(prevItems, items) : null,
    `👆 <b>Превью Анонса на неделю ${weekLabel(range)}</b> — эфиров без хоста: ${openEvents.length}. Отправить в группу «WorldView Productions»?`,
    HOW_TO_ANSWER,
  ]
    .filter(Boolean)
    .join('\n\n');
  const control = await withRetry(() => bot.sendMessage(elena, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: controlKeyboard(id) } }));
  updateScheduler((s) => {
    const old = s.pending[id];
    if (old && old.status === 'pending' && old.controlMessageId !== control.message_id) old.status = 'superseded';
    s.pending[id] = {
      id,
      kind: 'announce',
      weekStart: isoOf(monday),
      signature: announceSignature(openEvents),
      items,
      controlMessageId: control.message_id,
      createdAt: now,
      nudgedAt: null,
      expiresAt: at0900(addDaysUtc(monday, 7)),
      status: 'pending',
    };
    if (!manual) s.done[key] = { at: now, outcome: 'preview' };
  });
  return { preview: true, id, open: openEvents.length };
}

// ---- B) Reminder preview ----
const reminderSignature = (store, batch, plan) => JSON.stringify([plan.free.map((f) => f.key).sort(), unrespondedHosts(store, batch).map(normUser).sort()]);

async function createReminderPreview(bot, batchKey, { now = Date.now(), prevItems = null, note = null } = {}) {
  const elena = elenaChatId();
  if (!elena) throw new Error('MY_CHAT_ID не задан — некому слать превью');
  const store = readJson({ messages: {}, batches: [] });
  const batch = (store.batches || []).find((b) => batchId(b) === batchKey);
  if (!batch) return { gone: true };
  const plan = planReminder(store, batch, now);
  if (plan.skip) {
    updateScheduler((s, st) => {
      const b = (st.batches || []).find((x) => batchId(x) === batchKey);
      if (b) {
        b.remindedAt = now;
        b.outcome = plan.skip;
      }
    });
    console.log(`[week-schedule] ${batchKey}: напоминание не нужно (${plan.skip})`);
    return { skipped: plan.skip };
  }

  // The preview: the same header, then the same cards (their buttons do
  // nothing here — only the 8 hosts can use them, and only in the group).
  await withRetry(() => bot.sendMessage(elena, plan.text, { parse_mode: 'HTML' }));
  for (const f of plan.free) {
    await sleep(PRIVATE_GAP_MS);
    const record = store.messages[f.key];
    await withRetry(() => bot.sendMessage(elena, cardText(record), { parse_mode: 'HTML', reply_markup: { inline_keyboard: cardKeyboard(record) } }));
  }
  const items = plan.free.map((f) => `${f.record.titleLine.replace(/<[^>]+>/g, '')} ${f.record.when || ''}`.trim()).sort();
  const id = `r${Math.abs(batch.chatId)}_${batch.headerMessageId}`;
  const range = weekRangeOfBatch(store, batch);
  const text = [
    note,
    prevItems ? diffNote(prevItems, items) : null,
    `👆 <b>Превью напоминания</b> — свободных эфиров: ${plan.free.length}, не отметились ни разу: ${plan.tagged}. В группе оно уйдёт ответом на шапку Анонса, под карточками будут рабочие кнопки. Отправить?`,
    HOW_TO_ANSWER,
  ]
    .filter(Boolean)
    .join('\n\n');
  const control = await withRetry(() => bot.sendMessage(elena, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: controlKeyboard(id) } }));
  updateScheduler((s, st) => {
    const old = s.pending[id];
    if (old && old.status === 'pending' && old.controlMessageId !== control.message_id) old.status = 'superseded';
    s.pending[id] = {
      id,
      kind: 'reminder',
      batchKey,
      signature: reminderSignature(store, batch, plan),
      items,
      controlMessageId: control.message_id,
      createdAt: now,
      nudgedAt: null,
      expiresAt: range ? at0900(addDaysUtc(range.start, 7)) : now + 7 * DAY_MS,
      status: 'pending',
    };
    const b = (st.batches || []).find((x) => batchId(x) === batchKey);
    if (b) {
      b.remindedAt = now;
      b.outcome = 'preview';
    }
  });
  return { preview: true, id, free: plan.free.length, tagged: unrespondedHosts(store, batch) };
}

// Cancel the reminder preview that is waiting for Elena (if any) and build a new
// one from the current host list — used after the roster changed.
async function rebuildReminderPreview(bot, now = Date.now()) {
  return runSerialStrict(async () => {
    const store = readJson({ messages: {}, batches: [] });
    const monday = isoOf(baliMonday(now));
    const batches = (store.batches || [])
      .filter((b) => b.chatId === WVP_GROUP_ID && b.kind !== 'urgent' && isLiveBatch(b, now))
      .filter((b) => {
        const r = weekRangeOfBatch(store, b);
        return r && isoOf(r.start) === monday;
      })
      .sort((a, b) => b.sentAt - a.sentAt);
    if (batches.length === 0) return { none: true };
    const batch = batches[0];
    const key = batchId(batch);
    for (const p of pendingList().filter((x) => x.kind === 'reminder' && x.batchKey === key)) {
      updateScheduler((s) => {
        s.pending[p.id].status = 'cancelled';
      });
      await removeButtons(bot, p);
    }
    const res = await createReminderPreview(bot, key, { now, note: '🔄 <b>Обновлённое превью</b> — список хостов изменился; предыдущее превью отменено.' });
    return { ...res, batchKey: key };
  });
}

// ---- The answer: button, "да"/"нет" reply, /yes, /no ----
async function confirmPending(bot, id, approve) {
  const now = Date.now();
  const p = readJson({ messages: {}, batches: [] }).scheduler?.pending?.[id];
  if (!p) return sendToElena(bot, 'Не нашла такое превью — возможно, оно уже устарело.');
  if (p.status !== 'pending') return sendToElena(bot, `Это превью уже обработано (${p.status}).`);
  if (now > p.expiresAt) {
    updateScheduler((s) => {
      s.pending[id].status = 'stale';
    });
    await removeButtons(bot, p);
    return sendToElena(bot, p.kind === 'urgent' ? 'Эфир уже начался — в группу ничего не отправляю.' : 'Это превью устарело (неделя прошла) — в группу ничего не отправляю.');
  }

  if (!approve) {
    updateScheduler((s, st) => {
      s.pending[id].status = 'declined';
      if (p.kind === 'reminder') {
        const b = (st.batches || []).find((x) => batchId(x) === p.batchKey);
        if (b) b.outcome = 'declined';
      }
      if (p.kind === 'urgent' && s.urgent[p.eventKey]) s.urgent[p.eventKey].status = 'declined'; // never asked again for this session
    });
    await removeButtons(bot, p);
    return sendToElena(bot, 'Хорошо, в группу ничего не отправляю.');
  }

  // Marked first, so a second tap while sending cannot send twice.
  updateScheduler((s) => {
    s.pending[id].status = 'sending';
  });
  await removeButtons(bot, p);
  try {
    if (p.kind === 'announce') await sendApprovedAnnounce(bot, p, now);
    else if (p.kind === 'urgent') await sendApprovedUrgent(bot, p, now);
    else await sendApprovedReminder(bot, p, now);
  } catch (err) {
    updateScheduler((s) => {
      s.pending[id].status = 'failed';
    });
    console.error('[week-schedule] отправка в группу не удалась:', err.message);
    await sendToElena(bot, `⚠️ Не получилось отправить в группу: ${escapeHtml(err.message)}. Ничего повторно автоматически не отправляю — можно запросить превью заново (/announce).`);
  }
}

async function sendApprovedAnnounce(bot, p, now) {
  const monday = new Date(`${p.weekStart}T00:00:00.000Z`);
  const range = range7(monday);
  const res = await sendWeekCards(bot, WVP_GROUP_ID, {
    now: new Date(now),
    range,
    requireComplete: true,
    reviewChatId: elenaChatId(),
    allowDoubts: true,
    verify: (open) => (announceSignature(open) === p.signature ? null : 'changed'),
  });
  if (res.aborted === 'mismatch') {
    updateScheduler((s) => {
      s.pending[p.id].status = 'superseded';
    });
    await createAnnouncePreview(bot, { monday, now, prevItems: p.items });
    return;
  }
  if (res.aborted) {
    updateScheduler((s) => {
      s.pending[p.id].status = 'failed';
    });
    const why = { allCovered: 'эфиров без хоста уже нет', empty: 'на этой неделе нет эфиров', failedTabs: 'не загрузились вкладки таблицы' }[res.aborted] || res.aborted;
    return sendToElena(bot, `В группу не отправила: ${escapeHtml(why)}.`);
  }
  updateScheduler((s) => {
    s.pending[p.id].status = 'sent';
  });
  await sendToElena(bot, `✅ Отправлено в группу: Анонс на неделю ${weekLabel(range)}, эфиров без хоста — ${res.open}.`);
}

async function sendApprovedReminder(bot, p, now) {
  const store = readJson({ messages: {}, batches: [] });
  const batch = (store.batches || []).find((b) => batchId(b) === p.batchKey);
  if (!batch) throw new Error('Анонс не найден в сохранённых данных');
  const plan = planReminder(store, batch, now);
  if (plan.skip) {
    updateScheduler((s) => {
      s.pending[p.id].status = 'stale';
    });
    return sendToElena(bot, `Напоминание уже не нужно (${escapeHtml(plan.skip === 'no-free' ? 'свободных эфиров не осталось' : plan.skip)}) — в группу ничего не отправляю.`);
  }
  if (reminderSignature(store, batch, plan) !== p.signature) {
    updateScheduler((s) => {
      s.pending[p.id].status = 'superseded';
    });
    await createReminderPreview(bot, p.batchKey, { now, prevItems: p.items });
    return;
  }
  await postReminder(bot, batch, plan);
  updateScheduler((s, st) => {
    s.pending[p.id].status = 'sent';
    const b = (st.batches || []).find((x) => batchId(x) === p.batchKey);
    if (b) {
      b.remindedAt = now;
      b.outcome = 'sent';
    }
  });
  await sendToElena(bot, `✅ Напоминание отправлено в группу (свободных эфиров: ${plan.free.length}).`);
}

function pendingList() {
  const pending = readJson({ messages: {}, batches: [] }).scheduler?.pending || {};
  return Object.values(pending).filter((p) => p.status === 'pending').sort((a, b) => b.createdAt - a.createdAt);
}

// Button on a preview.
function handleWeekCallback(bot, query) {
  const elena = elenaChatId();
  const answer = (text) => bot.answerCallbackQuery(query.id, text ? { text } : {}).catch(() => {});
  if (!elena || !query.from || query.from.id !== elena) return answer();
  const m = String(query.data || '').match(/^wk:(ok|no):(.+)$/);
  if (!m) return answer();
  answer(m[1] === 'ok' ? 'Отправляю…' : 'Не отправляю');
  return runSerial(() => confirmPending(bot, m[2], m[1] === 'ok'));
}

// "да"/"нет" as a REPLY to a preview's question. Returns true if it was one.
async function handleWeekTextReply(bot, msg) {
  const elena = elenaChatId();
  if (!elena || !msg.from || msg.from.id !== elena || !msg.reply_to_message || !msg.text) return false;
  const word = msg.text.trim().toLowerCase().replace(/[.!\s]+$/g, '');
  const approve = ['да', 'yes', 'ага', 'отправляй'].includes(word);
  const decline = ['нет', 'no', 'не надо'].includes(word);
  if (!approve && !decline) return false;
  const p = pendingList().find((x) => x.controlMessageId === msg.reply_to_message.message_id);
  if (!p) return false;
  await runSerial(() => confirmPending(bot, p.id, approve));
  return true;
}

// /yes, /no (the newest preview waiting), /announce [next|this|YYYY-MM-DD].
async function handleWeekCommand(bot, msg, command, arg = '') {
  const elena = elenaChatId();
  if (!elena || !msg.from || msg.from.id !== elena || msg.chat.type !== 'private') return;
  if (command === 'yes' || command === 'no') {
    const p = pendingList()[0];
    if (!p) return sendToElena(bot, 'Сейчас нет превью, которое ждёт ответа.');
    return runSerial(() => confirmPending(bot, p.id, command === 'yes'));
  }
  if (command === 'announce') {
    const a = String(arg || '').trim().toLowerCase();
    let monday;
    if (!a || a === 'next') monday = addDaysUtc(baliMonday(Date.now()), 7);
    else if (a === 'this' || a === 'current') monday = baliMonday(Date.now());
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) monday = baliMonday(Date.parse(`${a}T04:00:00Z`));
    else return sendToElena(bot, 'Формат: /announce — следующая неделя; /announce this — текущая; /announce 2026-11-02 — неделя с этой датой.');
    return runSerialStrict(() => createAnnouncePreview(bot, { monday, manual: true })).catch((err) =>
      reportProblem(bot, `announce-manual:${isoOf(monday)}`, `Не получилось подготовить превью на неделю ${weekLabel(range7(monday))}: ${err.message}`, 0)
    );
  }
}

// ---- The tick: every 5 minutes and once after a start ----
async function announceSlotStep(bot, now) {
  const activatedAt = updateScheduler((s) => {
    if (!s.activatedAt) s.activatedAt = now;
    return s.activatedAt;
  });
  const cur = baliMonday(now);
  for (const monday of [cur, addDaysUtc(cur, 7)]) {
    const key = `announce:${isoOf(monday)}`;
    const due = at0900(monday, -1); // Sunday 09:00 before that Monday
    const done = readJson({ messages: {}, batches: [] }).scheduler?.done?.[key];
    if (done || now < due) continue;
    if (now <= due + CATCHUP_MS) {
      await createAnnouncePreview(bot, { monday, now });
      continue;
    }
    // Missed by more than 3 hours: not run, and said out loud (unless it
    // predates this feature being switched on).
    updateScheduler((s) => {
      s.done[key] = { at: now, outcome: 'missed' };
    });
    if (due >= activatedAt) {
      await sendToElena(bot, `⚠️ Воскресное превью Анонса на неделю ${weekLabel(range7(monday))} не удалось подготовить вовремя (бот был недоступен больше 3 часов). Подготовить вручную: /announce`);
    }
  }
}

async function reminderSlotStep(bot, now) {
  const store = readJson({ messages: {}, batches: [] });
  const activatedAt = store.scheduler?.activatedAt || 0;
  for (const b of (store.batches || []).filter((x) => isLiveBatch(x, now) && !x.remindedAt)) {
    const range = weekRangeOfBatch(store, b);
    if (!range) continue;
    const due = reminderDueAt(b, range);
    if (now < due) continue;
    const key = batchId(b);
    if (now <= due + CATCHUP_MS) {
      await createReminderPreview(bot, key, { now });
      continue;
    }
    updateScheduler((s, st) => {
      const x = (st.batches || []).find((y) => batchId(y) === key);
      if (x) {
        x.remindedAt = now;
        x.outcome = 'missed';
      }
    });
    if (due >= activatedAt) {
      await sendToElena(bot, `⚠️ Превью напоминания по Анонсу ${weekLabel(range)} не удалось подготовить вовремя (бот был недоступен больше 3 часов). Состояние недели: /check`);
    }
  }
}

// One reminder to Elena (at 12:00 Bali, or 3 hours after the preview if that
// is later) when a preview is still waiting.
async function nudgeStep(bot, now) {
  for (const p of pendingList()) {
    if (p.nudgedAt) continue;
    const created = new Date(p.createdAt + 8 * 3600 * 1000);
    const noon = Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate(), 4, 0, 0); // 12:00 Bali
    const nudgeAt = p.createdAt < noon ? noon : p.createdAt + CATCHUP_MS;
    if (now < nudgeAt) continue;
    updateScheduler((s) => {
      s.pending[p.id].nudgedAt = now;
    });
    await sendToElena(bot, `⏰ Превью ${p.kind === 'announce' ? 'Анонса' : 'напоминания'} всё ещё ждёт вашего ответа. Нажмите кнопку под ним, ответьте «да» / «нет» или напишите /yes / /no. Пока вы не ответили, в группу ничего не уходит.`);
  }
}

async function weekSchedulerTick(bot, now = Date.now()) {
  const steps = [
    ['coverage-tuesday', () => runSerialStrict(() => weekFlowTick(bot, now))],
    ['announce-sunday', () => runSerialStrict(() => announceSlotStep(bot, now))],
    ['reminder-monday', () => runSerialStrict(() => reminderSlotStep(bot, now))],
    ['nudge', () => runSerialStrict(() => nudgeStep(bot, now))],
    ['urgent-24h', () => runSerialStrict(() => urgentStep(bot, now))],
  ];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      await reportProblem(bot, `tick:${name}`, `Автоматика недели («${name}») не сработала: ${err.message}. Попробую снова через 5 минут; если не получится — бот напишет ещё раз.`);
    }
  }
}

// ---- "Less than 24 hours left" for a session that still has no host ----
//
// Elena (2026-10-22). Every hour (no AI, just the sheet and the saved card
// state) the bot looks for a FREE session (no name in the Host column, no active
// ✅ reservation) that starts in 24 hours or less and has not been handled yet:
//   a) there are hosts who never pressed ✅/❌ on this week's announce(s) -> a
//      PREVIEW goes to Elena: the group message exactly as it would look (a
//      bilingual text with the tags of ONLY those hosts + a card with ✅/❌ for
//      ONLY this session) and "Send to group / Don't send". Only after her "yes"
//      does it go to the group;
//   b) everyone has answered but the session is still open -> ONE note to Elena
//      ("everyone answered, the session is not closed, decide yourself"),
//      nothing for the group, no buttons;
//   c) each session is handled once; "Don't send" means never again for it;
//   d) never at night: nothing is sent to Elena between 22:00 and 08:00 Bali —
//      what falls into that window is done at 08:00 (even if less than 24 h
//      remain by then);
//   e) a preview whose session closed before Elena answered is withdrawn with
//      "эфир уже закрыт".
// The bot never writes to a host privately.

const URGENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const URGENT_EVERY_MS = 55 * 60 * 1000;

const baliHourOf = (ms) => new Date(ms + 8 * 3600 * 1000).getUTCHours();
const startMsOf = (e) => azStartInstantMs(e);
const azStartInstantMs = (e) => e.date.getTime() + e.azStartMin * 60000 + 7 * 3600 * 1000;

// Active ✅ reservation for a session, from the cards of this chat.
function reservationOnCards(store, chatId, e) {
  const k = eventKeyOf(e);
  for (const [key, r] of Object.entries(store.messages)) {
    if (r.mirrorOf || !r.event || r.hosted || !r.reservedBy || Number(key.split(':')[0]) !== chatId) continue;
    if (recordKeyOf(r) === k) return r.reservedBy;
  }
  return null;
}

// Hosts (tags) who never pressed ✅ or ❌ on ANY card of this chat's live
// announces of the session's week.
function unrespondedForWeek(store, chatId, eventDate) {
  const mondayIso = isoOf(baliMonday(eventDate.getTime() + 12 * 3600 * 1000));
  const keys = new Set();
  for (const b of (store.batches || []).filter((x) => x.chatId === chatId && isLiveBatch(x, Date.now()))) {
    const r = weekRangeOfBatch(store, b);
    if (r && isoOf(r.start) === mondayIso) b.cardKeys.forEach((k) => keys.add(k));
  }
  const records = [...keys].map((k) => store.messages[k]).filter(Boolean);
  const tags = candidatesFor(chatId);
  return tags.filter((t) => !records.some((r) => (r.refusers || []).some((u) => tagMatchesUser(t, u)) || (r.reservedBy && tagMatchesUser(t, r.reservedBy))));
}

const urgentSignature = (e, tags) => JSON.stringify([eventKeyOf(e), tags.map(normUser).sort()]);

function urgentTexts(e, tags, { test = false } = {}) {
  const label = sessionLabel(e.title);
  const what = `${escapeHtml(e.tabName)}${label ? ` — ${escapeHtml(label)}` : ''}`;
  const when = `AZ: ${ddmm(e.date)}, ${formatRange24h(e.azStartMin, e.azEndMin)} · MCK: ${ddmm(mskDate(e))}, ${formatRange24h(e.mskStartMin, e.mskEndMin)}`;
  const header = [
    `${test ? '🧪 <i>ТЕСТ (тестовая группа)</i>\n' : ''}⏰ <b>Less than 24 hours left / Осталось меньше 24 часов</b>`,
    '',
    `EN: Less than 24 hours until <b>${what}</b> (${when}). There is no host yet. Please tap ✅ if you can take it, or ❌ if you can't. 🙏`,
    `RU: Осталось меньше 24 часов до эфира <b>${what}</b> (${when}). Хоста пока нет. Нажмите ✅, если сможете, или ❌, если не можете. 🙏`,
    '',
    tags.map((t) => escapeHtml(formatCommunityTag(t))).join(' '),
  ].join('\n');
  const card = {
    titleLine: `⏰ <b>${escapeHtml(e.tabName)}</b>`,
    dateLine: weekCardDateLine(e),
    tabUrl: e.tabUrl || null,
    when: sundayButtonWhen(e),
    event: { tabUrl: e.tabUrl || null, dateIso: e.date.toISOString(), azStartMin: e.azStartMin },
    label: label || '',
  };
  return { header, card };
}

// Header (with the tags) and the single-session card, as an urgent batch.
async function postUrgent(bot, chatId, e, tags, { test = false } = {}) {
  const { header, card } = urgentTexts(e, tags, { test });
  const h = await withRetry(() => bot.sendMessage(chatId, header, { parse_mode: 'HTML', disable_web_page_preview: true }));
  const sentAt = Date.now();
  await sleep(chatId < 0 ? GROUP_GAP_MS : PRIVATE_GAP_MS);
  const c = await sendCard(bot, chatId, { ...card, candidateTags: candidatesFor(chatId) });
  recordBatch(chatId, h.message_id, [`${chatId}:${c.message_id}`], sentAt);
  updateScheduler((s, st) => {
    const b = (st.batches || []).find((x) => x.chatId === chatId && x.headerMessageId === h.message_id);
    if (b) {
      b.kind = 'urgent';
      b.remindedAt = sentAt; // no Monday reminder / Tuesday note for a single-session card
      b.tuesdayDoneAt = sentAt;
      b.outcome = 'urgent';
    }
  });
  return { headerId: h.message_id, cardId: c.message_id };
}

async function createUrgentPreview(bot, { event: e, tags, chatId, now = Date.now(), prevNote = null }) {
  const elena = elenaChatId();
  const { header, card } = urgentTexts(e, tags);
  await withRetry(() => bot.sendMessage(elena, header, { parse_mode: 'HTML', disable_web_page_preview: true }));
  await sleep(PRIVATE_GAP_MS);
  const record = { ...card, candidateTags: candidatesFor(chatId), refusers: [], reservedBy: null, hosted: null };
  await withRetry(() => bot.sendMessage(elena, cardText(record), { parse_mode: 'HTML', reply_markup: { inline_keyboard: cardKeyboard(record) } }));
  const id = `u${Math.abs(chatId)}_${createHash8(eventKeyOf(e))}`;
  const text = [
    prevNote,
    `👆 <b>Превью срочного напоминания</b> — до эфира меньше 24 часов, хоста нет; отметиться не успели: ${tags.length}. В группу уйдёт ровно так (кнопки на карточке там будут рабочие). Отправить?`,
    HOW_TO_ANSWER,
  ]
    .filter(Boolean)
    .join('\n\n');
  const control = await withRetry(() => bot.sendMessage(elena, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: controlKeyboard(id) } }));
  updateScheduler((s) => {
    const old = s.pending[id];
    if (old && old.status === 'pending' && old.controlMessageId !== control.message_id) old.status = 'superseded';
    s.pending[id] = {
      id,
      kind: 'urgent',
      chatId,
      eventKey: eventKeyOf(e),
      eventLabel: `${e.tabName} ${ddmm(e.date)} ${formatRange24h(e.azStartMin, e.azEndMin)} AZ`,
      weekDate: e.date.getTime(),
      signature: urgentSignature(e, tags),
      items: tags,
      controlMessageId: control.message_id,
      createdAt: now,
      nudgedAt: null,
      expiresAt: startMsOf(e),
      status: 'pending',
    };
    s.urgent[eventKeyOf(e)] = { status: 'preview', at: now, chatId };
  });
  return { preview: true, id };
}

// Tiny deterministic id fragment from the session key (callback_data is limited to 64 bytes).
function createHash8(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// One hourly pass. `windowMs`/`force` are for the one-off run Elena asked for
// ("everything starting within ~48 h, right now, even at night").
async function urgentStep(bot, now, { windowMs = URGENT_WINDOW_MS, force = false, chatId = WVP_GROUP_ID } = {}) {
  if (!force) {
    const last = readJson({ messages: {}, batches: [] }).scheduler?.urgentLastRun || 0;
    if (now - last < URGENT_EVERY_MS) return { skipped: 'throttled' };
  }
  updateScheduler((s) => {
    s.urgentLastRun = now;
  });

  const monday = baliMonday(now);
  const range = { start: addDaysUtc(monday, -1), end: addDaysUtc(monday, 13) };
  const collected = await collectWeekEvents(range);
  if (collected.failedTabs.length > 0) throw new Error(`не загрузились вкладки таблицы: ${collected.failedTabs.join('; ')}`);
  const store = readJson({ messages: {}, batches: [] });
  const upcoming = collected.events.filter((e) => startMsOf(e) > now);
  const isFree = (e) => !e.hasHost && !reservationOnCards(store, chatId, e);

  // What the week-coverage check needs to know: free sessions of this Bali week with no card yet.
  const weekMonday = isoOf(monday);
  const weekEnd = addDaysUtc(monday, 6);
  const have = new Set();
  for (const [key, r] of Object.entries(store.messages)) if (!r.mirrorOf && r.event && Number(key.split(':')[0]) === chatId) have.add(recordKeyOf(r));
  const freeNoCardKeys = upcoming.filter((e) => e.date >= monday && e.date <= weekEnd && isFree(e) && !have.has(eventKeyOf(e))).map(eventKeyOf);
  updateScheduler((s) => {
    s.lastScan = { at: now, weekMonday, freeNoCardKeys };
  });

  // previews whose session has been closed (or has started) in the meantime
  const keyed = new Map(collected.events.map((e) => [eventKeyOf(e), e]));
  for (const p of pendingList().filter((x) => x.kind === 'urgent' && x.chatId === chatId)) {
    const e = keyed.get(p.eventKey);
    const closed = !e || startMsOf(e) <= now || !isFree(e);
    if (closed) await withdrawUrgent(bot, p, e && startMsOf(e) <= now ? 'эфир уже начался' : 'эфир уже закрыт');
  }

  const handled = readJson({ messages: {}, batches: [] }).scheduler?.urgent || {};
  const candidates = upcoming
    .filter((e) => startMsOf(e) - now <= windowMs && isFree(e) && !handled[eventKeyOf(e)])
    .sort((a, b) => startMsOf(a) - startMsOf(b));
  const nextFree = upcoming.filter(isFree).sort((a, b) => startMsOf(a) - startMsOf(b))[0] || null;
  const out = { candidates: candidates.length, previews: 0, allAnswered: 0, deferred: 0, nextFree: nextFree ? { text: `${nextFree.tabName} — ${eventWhen(nextFree)}`, hoursAway: Math.round((startMsOf(nextFree) - now) / 3600000) } : null };
  if (candidates.length === 0) return out;

  const hour = baliHourOf(now);
  if (!force && (hour < 8 || hour >= 22)) {
    out.deferred = candidates.length; // night: done at 08:00
    return out;
  }
  for (const e of candidates) {
    const tags = unrespondedForWeek(readJson({ messages: {}, batches: [] }), chatId, e.date);
    if (tags.length === 0) {
      updateScheduler((s) => {
        s.urgent[eventKeyOf(e)] = { status: 'allAnswered', at: now, chatId };
      });
      await sendToElena(
        bot,
        `Все хосты ответили, но эфир <b>${escapeHtml(e.tabName)}</b>${sessionLabel(e.title) ? ` — ${escapeHtml(sessionLabel(e.title))}` : ''}, ${eventWhen(e)} (MCK ${ddmm(mskDate(e))}, ${formatRange24h(e.mskStartMin, e.mskEndMin)}), не закрыт. Нужно решить самой (например, написать Михаилу).`
      );
      out.allAnswered++;
    } else {
      await createUrgentPreview(bot, { event: e, tags, chatId, now });
      out.previews++;
    }
  }
  return out;
}

async function withdrawUrgent(bot, p, why) {
  updateScheduler((s) => {
    if (s.pending[p.id]) s.pending[p.id].status = 'stale';
    if (s.urgent[p.eventKey]) s.urgent[p.eventKey].status = 'closed';
  });
  await removeButtons(bot, p);
  await sendToElena(bot, `ℹ️ Срочное напоминание по эфиру «${escapeHtml(p.eventLabel)}» отменено: ${escapeHtml(why)}.`);
}

// A card just changed: a pending urgent preview for that session may be moot.
async function voidUrgentForCard(bot, cardKey) {
  const store = readJson({ messages: {}, batches: [] });
  const r = store.messages[cardKey];
  if (!r || !r.event || !(r.reservedBy || r.hosted)) return;
  const k = recordKeyOf(r);
  for (const p of pendingList().filter((x) => x.kind === 'urgent' && x.eventKey === k)) await withdrawUrgent(bot, p, 'эфир уже закрыт');
}

async function sendApprovedUrgent(bot, p, now) {
  const monday = baliMonday(p.weekDate + 12 * 3600 * 1000);
  const collected = await collectWeekEvents({ start: addDaysUtc(monday, -1), end: addDaysUtc(monday, 7) });
  if (collected.failedTabs.length > 0) throw new Error(`не загрузились вкладки таблицы: ${collected.failedTabs.join('; ')}`);
  const e = collected.events.find((x) => eventKeyOf(x) === p.eventKey);
  const store = readJson({ messages: {}, batches: [] });
  if (!e || startMsOf(e) <= now || e.hasHost || reservationOnCards(store, p.chatId, e)) {
    updateScheduler((s) => {
      s.pending[p.id].status = 'stale';
      if (s.urgent[p.eventKey]) s.urgent[p.eventKey].status = 'closed';
    });
    return sendToElena(bot, 'Эфир уже закрыт (или начался) — в группу ничего не отправляю.');
  }
  const tags = unrespondedForWeek(store, p.chatId, e.date);
  if (urgentSignature(e, tags) !== p.signature) {
    updateScheduler((s) => {
      s.pending[p.id].status = 'superseded';
    });
    if (tags.length === 0) {
      updateScheduler((s) => {
        s.urgent[p.eventKey] = { status: 'allAnswered', at: now, chatId: p.chatId };
      });
      return sendToElena(bot, `За это время все хосты ответили, но эфир «${escapeHtml(p.eventLabel)}» не закрыт — в группу ничего не отправляю. Нужно решить самой.`);
    }
    return createUrgentPreview(bot, { event: e, tags, chatId: p.chatId, now, prevNote: '⚠️ <b>Список не отметившихся изменился с момента предыдущего превью</b> — в группу ничего не отправлено. Вот обновлённое превью:' });
  }
  await postUrgent(bot, p.chatId, e, tags);
  updateScheduler((s) => {
    s.pending[p.id].status = 'sent';
    s.urgent[p.eventKey] = { status: 'sent', at: now, chatId: p.chatId };
  });
  await sendToElena(bot, `✅ Срочное напоминание отправлено в группу: «${escapeHtml(p.eventLabel)}».`);
}

// /urgent_test — the same message into the TEST group «Дебаты» straight away
// (no confirmation needed there), for the nearest free session. Real state is untouched.
async function runUrgentTest(bot, now = Date.now()) {
  const monday = baliMonday(now);
  const collected = await collectWeekEvents({ start: addDaysUtc(monday, -1), end: addDaysUtc(monday, 13) });
  if (collected.failedTabs.length > 0) throw new Error(`не загрузились вкладки таблицы: ${collected.failedTabs.join('; ')}`);
  const e = collected.events.filter((x) => startMsOf(x) > now && !x.hasHost).sort((a, b) => startMsOf(a) - startMsOf(b))[0];
  if (!e) return sendToElena(bot, 'Для теста нет ни одного предстоящего эфира без хоста.');
  const store = readJson({ messages: {}, batches: [] });
  const tags = unrespondedForWeek(store, TEST_GROUP_ID, e.date);
  await postUrgent(bot, TEST_GROUP_ID, e, tags, { test: true });
  await sendToElena(bot, `🧪 Тест: срочное напоминание по эфиру «${escapeHtml(e.tabName)}» (${eventWhen(e)}) отправлено в «Дебаты». В большую группу ничего не уходило.`);
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
  buildTuesdayMessages,
  batchSummaries,
  weekSchedulerTick,
  runTuesdayPreview,
  rebuildReminderPreview,
  addCountedExtraForEvent,
  urgentStep,
  runUrgentTest,
  noteHostSeen,
  learnHostIdsFromCards,
  reservationsOfHost,
  releaseReservation,
  handleWeekCallback,
  handleWeekTextReply,
  handleWeekCommand,
  reportProblem,
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
