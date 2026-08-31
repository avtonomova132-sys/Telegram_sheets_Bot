const path = require('path');
const express = require('express');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const { OpenAI, toFile } = require('openai');
const {
  generateWeeklyReport,
  generateWeeklyAnnounceReport,
  generateCheckReport,
  runDailyHostDiffCheck,
  getHostDiffLastRunDate,
  getWeeklyAnnounceLastSentDate,
  markWeeklyAnnounceSent,
  chunkMessage,
} = require('./report');
const { generateVerseImageBuffer } = require('./verse/generateVerseImage');
const {
  getVerseCount,
  getLastSent,
  getLastSentDate,
  getNextVerseNumber,
  setLastSent,
  ensureProgressSeeded,
  applyForceOverride,
  baliDateString,
  baliHour,
} = require('./verse/progress');
const { extractPeredachi } = require('./peredachi/extract');
const { addRecords, readAll: readPeredachi, saveAll: savePeredachi } = require('./peredachi/store');
const {
  formatKursOverview,
  formatKursDetail,
  formatMeditations,
  formatNearest,
  formatByDate,
  recordMatchesKurs,
  getNowMsk,
} = require('./peredachi/query');
const { analyzeDuplicates, isSameEvent } = require('./peredachi/dedupe');
const { validateEntry, describeEntry } = require('./peredachi/validate');
const { analyzeSplits } = require('./peredachi/split');
const { resolveStaleTimeGroups } = require('./peredachi/stale');
const { getWatchedGroupIds, looksLikeAnnouncement } = require('./peredachi/watch');
const {
  readGroupLinks,
  setGroupLink,
  ensureGroupLinksSeeded,
  resolveInviteLink,
} = require('./peredachi/groupLinks');
const { checkReminders, formatReminderMessage, getBroadcastGroupIds } = require('./peredachi/reminders');
const { extractEvent } = require('./events/extract');
const { validateEvent } = require('./events/validate');
const { fillTimezones } = require('./events/timezone');
const { buildConfirmationText } = require('./events/format');
const { readAll: readEvents, addEvent } = require('./events/store');
const { analyzePhoto, isConfigured: gabarityConfigured } = require('./gabarity/extract');
const { saveArticlesFile, findArticle } = require('./gabarity/articles');
const { buildResultText: buildGabarityText } = require('./gabarity/format');
const { isTrustedUser } = require('./auth');
const { isKnownItem } = require('./proekty/items');
const { getDay: getProDay, toggleItem: toggleProItem } = require('./proekty/store');
const { buildProMessage, NOOP_CALLBACK: PRO_NOOP_CALLBACK, TOGGLE_PREFIX: PRO_TOGGLE_PREFIX } = require('./proekty/view');
const {
  PROJECTS: ZAD_PROJECTS,
  looksLikeTaskMessage,
  parseTaskMessage,
  isConfigured: zadachiConfigured,
} = require('./zadachi/items-parser');
const { addTask, markDone, getOpenTasks } = require('./zadachi/store');
const {
  buildTaskAddedText,
  buildTasksListMessage,
  NOOP_CALLBACK: ZAD_NOOP_CALLBACK,
  DONE_PREFIX: ZAD_DONE_PREFIX,
} = require('./zadachi/view');
const { getPrinciple } = require('./dnevnik/principles');
const { SLOTS, EVENING_SUMMARY, baliMinutesNow, slotMinutes, formatSlotTime } = require('./dnevnik/schedule');
const {
  addSentSlot,
  hasEntry: hasDnevnikEntry,
  getById: getDnevnikEntryById,
  getOldestPending,
  countPending,
  getMissedToday,
  getDay: getDnevnikDay,
  saveAnswer,
  getRecent: getRecentDnevnik,
  getNextPrincipleNumber,
  setLastPrincipleSent,
  getEveningSummaryDate,
  setEveningSummaryDate,
} = require('./dnevnik/store');
const { parseDnevnikBatch, parseSinglePrincipleFallback, isConfigured: dnevnikConfigured } = require('./dnevnik/parse');
const {
  buildSlotMessage,
  buildDnevnikConfirmation,
  buildDnevnikSummary,
  buildMissedListMessage,
  buildDayReport,
  buildDayReportShort,
  buildPrincipleDetail,
  buildUnansweredKeyboard,
  SELECT_CALLBACK_PREFIX: DNEVNIK_SELECT_PREFIX,
} = require('./dnevnik/view');
const {
  buildRootMenu,
  buildSectionMessage,
  SECTION_PREFIX: MENU_SECTION_PREFIX,
  ROOT_CALLBACK: MENU_ROOT_CALLBACK,
} = require('./menu');

// Раньше необработанный отказ промиса (например Telegram отклоняет
// sendMessage с "message is too long") валил весь процесс — Node превращает
// необработанный rejected promise в необработанное исключение. При polling
// это означало бесповоротный крэш-луп: контейнер перезапускается, Telegram
// повторно отдаёт то же самое незаквитованное обновление (offset не
// продвинулся), тот же обработчик падает снова — и так до бесконечности,
// пока не поправишь код руками. Логируем и продолжаем работать вместо
// падения — единичная неудачная отправка не должна укладывать всего бота.
process.on('unhandledRejection', (err) => {
  console.error('Необработанный отказ промиса:', err && err.message ? err.message : err);
});
process.on('uncaughtException', (err) => {
  console.error('Необработанное исключение:', err && err.message ? err.message : err);
});

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
// Отдаёт события, добавленные через /new, — public/afisha.html подтягивает
// их на клиенте поверх захардкоженного списка (см. fetch('/api/events') там).
app.get('/api/events', (req, res) => {
  res.json(readEvents());
});
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`HTTP-сервер запущен на порту ${port}`));

const token = process.env.BOT_TOKEN;
const openaiKey = process.env.OPENAI_API_KEY;
const myChatId = process.env.MY_CHAT_ID;
// Час (по Бали) воскресной автоотправки /weekly — см. секцию ниже.
const WEEKLY_ANNOUNCE_HOUR = Number(process.env.WEEKLY_ANNOUNCE_HOUR) || 10;

if (!token) {
  console.error('BOT_TOKEN не задан! Добавьте переменную окружения BOT_TOKEN.');
  process.exit(1);
}

if (!myChatId) {
  console.warn('MY_CHAT_ID не задан — ежедневная отправка изречений отключена.');
}

ensureProgressSeeded();
applyForceOverride();
ensureGroupLinksSeeded();

const bot = new TelegramBot(token, { polling: true });
const openai = openaiKey ? new OpenAI({ apiKey: openaiKey, maxRetries: 0, timeout: 60000 }) : null;

console.log('Бот запущен и слушает сообщения...');

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(
    chatId,
    'Привет! 🙏 Я твой бот-помощник.\n\nЯ умею отвечать на сообщения, напоминать о делах (просто напиши "напомни ... в 15:00 ...") и собирать отчёты по расписанию (/weekly, /check).'
  );
  const { text, reply_markup } = buildRootMenu();
  await bot.sendMessage(chatId, text, { reply_markup });
});

// Главное меню — чистая справка поверх существующих команд, ничего не
// меняет и не требует захода в раздел: все команды по-прежнему работают
// напрямую. См. menu.js за структурой разделов.
bot.onText(/^\/menu(?:@\S+)?$/, async (msg) => {
  const { text, reply_markup } = buildRootMenu();
  await bot.sendMessage(msg.chat.id, text, { reply_markup });
});

bot.on('callback_query', async (query) => {
  const data = query.data || '';
  if (data !== MENU_ROOT_CALLBACK && !data.startsWith(MENU_SECTION_PREFIX)) return;

  const view =
    data === MENU_ROOT_CALLBACK ? buildRootMenu() : buildSectionMessage(data.slice(MENU_SECTION_PREFIX.length));

  if (!view) {
    await bot.answerCallbackQuery(query.id, { text: 'Раздел не найден' });
    return;
  }

  try {
    await bot.editMessageText(view.text, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: view.reply_markup,
    });
    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error('[menu] ошибка навигации:', err.message);
    await bot.answerCallbackQuery(query.id, { text: 'Ошибка' });
  }
});

// Временная диагностическая команда — узнать chat_id текущего чата (например,
// чтобы прописать его в WATCHED_GROUP_IDS). Доступна всем, без ограничений.
bot.onText(/^\/chatid(?:@\S+)?$/, (msg) => {
  bot.sendMessage(msg.chat.id, `ID этого чата: ${msg.chat.id}`);
});

// ===== Напоминания =====
function parseReminder(text) {
  const timeMatch = text.match(/(\d{1,2})[:.](\d{2})/);
  if (!/напомни/i.test(text) || !timeMatch) return null;
  const hours = parseInt(timeMatch[1], 10);
  const minutes = parseInt(timeMatch[2], 10);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

function scheduleReminder(chatId, hours, minutes, message) {
  const baliOffsetMs = 8 * 60 * 60 * 1000;
  const nowBali = new Date(Date.now() + baliOffsetMs);
  const targetBali = new Date(nowBali);
  targetBali.setHours(hours, minutes, 0, 0);
  if (targetBali <= nowBali) {
    targetBali.setDate(targetBali.getDate() + 1);
  }
  const delayMs = targetBali.getTime() - nowBali.getTime();

  setTimeout(() => {
    bot.sendMessage(chatId, `🔔 Напоминание!\n\n${message}`);
  }, delayMs);

  return targetBali;
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Напоминания, /new-сессии, уточнение /габариты и эхо-заглушка ниже — все
  // это 1:1 функции для личного чата с Elena/доверенными людьми, не для
  // группы. Без этого гварда отключение Privacy Mode для мониторинга
  // передач (WATCHED_GROUP_IDS) заодно включило бы эхо-ответы на каждое
  // сообщение в отслеживаемой группе и случайные срабатывания парсера
  // напоминаний на любую фразу вида "... в 15:00 ...".
  if (msg.chat.type !== 'private') return;

  if (!text || text.startsWith('/')) return;

  // Уточнение стороны измерения (/габариты) перехватывает свободный текст
  // первым — пока сессия ждёт ответа "ширина/длина/высота", это сообщение
  // не должно попасть ни в напоминания, ни в /new, ни в эхо-ответ.
  if (await handleGabarityClarification(chatId, text)) {
    return;
  }

  // Активная сессия /new перехватывает свободный текст первой — иначе он
  // упал бы либо в парсер напоминаний, либо в эхо-ответ ниже.
  if (eventSessions.has(chatId)) {
    await handleEventDescription(chatId, text);
    return;
  }

  // Неотвеченная запись шестиразового дневника перехватывает свободный
  // текст следующей — FIFO (самый старый неотвеченный слот). Не привязана
  // к жёсткому окну времени, как гарантированные session-таймауты выше:
  // Elena сама сказала, что хочет отвечать когда получится, а не по
  // дедлайну, поэтому запись просто ждёт в /data/dnevnik.json, пока не
  // придёт текст или голос.
  if (await handleDnevnikPendingText(chatId, text)) {
    return;
  }

  // Задачи/встречи по проектам в формате "Название: текст" — тоже
  // перехватываются здесь, до напоминаний и эхо-ответа, иначе ушедшая на
  // сохранение задача попала бы вдобавок ещё и в заглушку-эхо ниже.
  if (await handleTaskMessage(chatId, text)) {
    return;
  }

  const reminder = parseReminder(text);
  if (reminder) {
    scheduleReminder(chatId, reminder.hours, reminder.minutes, text);
    const timeStr = `${String(reminder.hours).padStart(2, '0')}:${String(reminder.minutes).padStart(2, '0')}`;
    bot.sendMessage(chatId, `✅ Хорошо, напомню в ${timeStr} по Бали!`);
    return;
  }

  bot.sendMessage(chatId, `Я получил твоё сообщение: "${text}"\n\n(Пока я просто эхо — скоро научусь большему)`);
});

// ===== Шестиразовый дневник =====
// Шесть раз в день (SLOTS в dnevnik/schedule.js) бот присылает принцип из
// десяти (dnevnik/principles.js), по кругу. Ответ (текст или голос) через
// Anthropic API раскладывается либо на плюс+посвящение, либо на минус через
// четыре противосилы (dnevnik/parse.js), и сохраняется в /data/dnevnik.json.

// chatId -> entryId. Заполняется нажатием кнопки под /дневник_день или под
// вечерним автосписком (см. bot.on('callback_query') ниже) — самый надёжный
// способ ответить: никакого угадывания моделью, какой принцип имеется в
// виду, кнопка уже это однозначно зафиксировала. Не персистится на диск —
// это чисто UI-удобство, переживать рестарт контейнера ему не обязательно.
const dnevnikSelectedEntryId = new Map();

// Telegram отклоняет сообщения длиннее 4096 символов ошибкой 400 — и что
// критично, необработанная ошибка в async-обработчике роняла ВЕСЬ процесс
// бота (unhandled promise rejection). После перехода на полные списки
// примеров Gold Клуб длинные отчёты (/дневник_день, вечерний список,
// подтверждение с несколькими принципами) стали регулярно превышать лимит.
// Всегда шлём дневник через это — режет на части по chunkMessage (границы
// абзацев), reply_markup (кнопки) — только на последний кусок.
async function sendDnevnikMessage(chatId, text, options = {}) {
  const chunks = chunkMessage(text);
  for (let i = 0; i < chunks.length; i += 1) {
    const isLast = i === chunks.length - 1;
    await bot.sendMessage(chatId, chunks[i], isLast ? options : undefined);
  }
}

function saveDnevnikResult(entry, rawText, result) {
  saveAnswer(entry.id, { rawText, pluses: result.pluses, minuses: result.minuses });
}

// Перехватывает свободный текст/голос под дневник. Порядок приоритета:
// 1) запись, явно выбранная нажатием кнопки — "гарантированный" принцип:
//    модель ОБЯЗАНА привязать к нему хоть что-то (см. parseDnevnikBatch),
//    а если всё-таки не привяжет — есть аварийный одиночный fallback;
// 2) живой слот (в пределах 30-минутного окна, автоматически по расписанию)
//    — тот же гарантированный статус;
// 3) если ни того, ни другого нет, но сегодня есть пропущенные — пробует
//    разобрать свободный текст как вечерний пакетный ответ, без гарантии.
//
// В любом случае модели передаётся список ВСЕХ сейчас открытых принципов
// (не только один) — Elena часто рассказывает сразу несколько историй в
// одном сообщении, и раньше при "гарантированном" одиночном принципе
// вторая история просто терялась. Теперь распределяется по всем, кого
// реально коснулась.
//
// Возвращает true, если сообщение обработано как дневник (и обработка в
// bot.on('message')/bot.on('voice') должна остановиться), иначе false — и
// сообщение уходит дальше по цепочке (задача/напоминание/эхо) как обычно.
async function handleDnevnikPendingText(chatId, rawText) {
  if (!dnevnikConfigured) return false;

  const selectedId = dnevnikSelectedEntryId.get(chatId);
  dnevnikSelectedEntryId.delete(chatId); // выбор одноразовый — использовали и сбросили, даже если запись устарела

  let primaryEntry = null;
  if (selectedId) {
    const selectedEntry = getDnevnikEntryById(selectedId);
    if (selectedEntry && !selectedEntry.answeredAt) primaryEntry = selectedEntry;
  }
  if (!primaryEntry) {
    const liveEntry = getOldestPending();
    if (liveEntry) primaryEntry = liveEntry;
  }

  const today = baliDateString();
  const candidateEntries = new Map(); // id -> entry, чтобы не задвоить
  for (const e of getMissedToday(today)) candidateEntries.set(e.id, e);
  if (primaryEntry) candidateEntries.set(primaryEntry.id, primaryEntry);

  if (candidateEntries.size === 0) return false; // сегодня вообще нечего разбирать — не перехватываем

  const entries = [...candidateEntries.values()];
  const candidatePrinciples = entries.map((e) => getPrinciple(e.principleNumber));
  const primaryNumber = primaryEntry ? primaryEntry.principleNumber : null;

  try {
    let results = await parseDnevnikBatch(candidatePrinciples, primaryNumber, rawText);

    // Гарантия: если был "прямой" принцип (кнопка/живой слот), а модель его
    // всё равно не включила — аварийный одиночный разбор именно под него,
    // чтобы ответ никогда не терялся молча.
    if (primaryEntry && !results.some((r) => r.principleNumber === primaryEntry.principleNumber)) {
      const fallback = await parseSinglePrincipleFallback(getPrinciple(primaryEntry.principleNumber), rawText);
      results = [...results, fallback];
    }

    if (results.length === 0) {
      // Без гарантированного принципа (чистый вечерний случай) — либо
      // сообщение вообще не про дневник (молча отдаём дальше), либо это
      // была попытка ответить, но не удалось связать ни с чем конкретным.
      if (/принцип/i.test(rawText)) {
        const numbers = candidatePrinciples.map((p) => p.number).join(', ');
        await bot.sendMessage(
          chatId,
          `Не смогла точно понять, к какому из пропущенных принципов (№${numbers}) это относится 😔 Попробуй начать с номера явно, например: "принцип 2: ...".`
        );
        return true;
      }
      return false;
    }

    for (const result of results) {
      const entry = entries.find((e) => e.principleNumber === result.principleNumber);
      if (!entry) continue;
      saveDnevnikResult(entry, rawText, result);
    }
    // Намеренно НЕ напоминаем здесь о других неотвеченных записях — Elena
    // явно попросила не подвязывать один ответ к следующему: пропущенное
    // само уйдёт в вечерний список, никакого "довеска" мидень.
    await sendDnevnikMessage(chatId, buildDnevnikConfirmation(results));
    return true;
  } catch (err) {
    console.error('[dnevnik] ошибка разбора ответа:', err.message);
    await bot.sendMessage(chatId, 'Не получилось разобрать запись 😔 Попробуй переформулировать ещё раз.');
    return true;
  }
}

// Ручная проверка вне расписания — присылает принцип (по умолчанию тот, что
// должен был бы прийти следующим по ротации; можно указать конкретный номер,
// например "/дневник_принцип 5"), не сдвигая реальную ротацию (аналог
// /verse). Создаёт настоящую "живую" запись с обычным 30-минутным окном —
// можно по-настоящему ответить и получить полноценный разбор, не дожидаясь
// реального времени слота.
bot.onText(/^\/дневник_принцип(?:@\S+)?(?:\s+(\d{1,2}))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const requested = match[1] ? Number(match[1]) : null;
  const principleNumber = requested && requested >= 1 && requested <= 10 ? requested : getNextPrincipleNumber();
  const principle = getPrinciple(principleNumber);

  // test-<timestamp> как slotIndex — не пересекается с реальными 1..6,
  // поэтому не мешает ежедневной ротации и дедупликации настоящих слотов.
  addSentSlot({
    dateBali: baliDateString(),
    slotIndex: `test-${Date.now()}`,
    principleNumber,
    sentAt: new Date().toISOString(),
  });

  await sendDnevnikMessage(chatId, buildSlotMessage(principle, '?'));
});

// Последние записи + сколько ещё живых, не отвеченных.
bot.onText(/^\/дневник(?:@\S+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  const recent = getRecentDnevnik(10);
  const pending = countPending();
  await sendDnevnikMessage(chatId, buildDnevnikSummary(recent, pending));
});

// Отчёт за сегодня одним текстом — удобно копировать и отправлять партнёру
// по практике (кармическому или по щедрости). Тестовые записи (через
// /дневник_принцип с номером) сюда не попадают — только настоящие слоты дня.
// Под неотвеченными — кнопки: нажатие однозначно связывает следующий ответ
// с конкретным принципом, надёжнее, чем угадывание текста.
bot.onText(/^\/дневник_день(?:@\S+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  const today = baliDateString();
  const entries = getDnevnikDay(today);
  const unanswered = entries.filter((e) => !e.answeredAt);
  const reply_markup = buildUnansweredKeyboard(unanswered);
  await sendDnevnikMessage(chatId, buildDayReport(today, entries), reply_markup ? { reply_markup } : undefined);
});

// Краткая версия того же отчёта — специально для пересылки партнёру по
// практике: у плюса только посвящение, у минуса только сожаление, без
// текста/радости/опоры/антидота/решения. Полная версия (/дневник_день)
// остаётся для собственной подробной рефлексии.
bot.onText(/^\/дневник_кратко(?:@\S+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  const today = baliDateString();
  const entries = getDnevnikDay(today);
  await sendDnevnikMessage(chatId, buildDayReportShort(today, entries));
});

// Отправляет слот, если наступило его время по Бали и он ещё не отправлялся
// сегодня. Проверка каждые 5 минут (как ежедневное изречение) — если тик
// пропущен (рестарт контейнера), следующая проверка сама досылает слот, не
// пропуская день. Идём по SLOTS по порядку, чтобы при катап-апе (например,
// бот был выключен несколько часов) принципы уходили по одному, а не все
// разом одним сообщением.
async function checkAndSendDnevnikSlots() {
  if (!myChatId) return;

  const today = baliDateString();
  const nowMinutes = baliMinutesNow();

  for (const slot of SLOTS) {
    if (nowMinutes < slotMinutes(slot)) continue; // время слота ещё не наступило

    const slotId = `${today}#${slot.index}`;
    // addSentSlot сам защищает от повторной отправки (проверяет id) — но
    // читать принцип/слать сообщение нужно ДО вызова addSentSlot, поэтому
    // проверяем явно и тут же, чтобы не отправить одно и то же дважды при
    // двух тиках подряд.
    if (hasDnevnikEntry(slotId)) continue;

    const principleNumber = getNextPrincipleNumber();
    const principle = getPrinciple(principleNumber);

    try {
      await sendDnevnikMessage(myChatId, buildSlotMessage(principle, slot.index));
      addSentSlot({ dateBali: today, slotIndex: slot.index, principleNumber, sentAt: new Date().toISOString() });
      setLastPrincipleSent(principleNumber);
    } catch (err) {
      console.error('[dnevnik] ошибка отправки слота:', err.message);
      break; // не продолжаем катап-ап этим же тиком, если сеть/телеграм сейчас недоступны
    }
  }
}

cron.schedule('*/5 * * * *', checkAndSendDnevnikSlots);

// В 21:45 по Бали (после последнего слота 19:30, с запасом) — если за
// сегодня остались пропущенные слоты, присылает список, чтобы Elena могла
// одним сообщением разобрать всё перед сном. Отправляется максимум один раз
// в день (флаг eveningSummaryDate в /data/dnevnik_progress.json).
async function checkAndSendEveningDnevnikSummary() {
  if (!myChatId) return;

  const today = baliDateString();
  if (getEveningSummaryDate() === today) return; // уже отправляли сегодня

  const nowMinutes = baliMinutesNow();
  if (nowMinutes < EVENING_SUMMARY.hour * 60 + EVENING_SUMMARY.minute) return;

  const missed = getMissedToday(today);
  if (missed.length > 0) {
    const reply_markup = buildUnansweredKeyboard(missed);
    await sendDnevnikMessage(myChatId, buildMissedListMessage(missed), reply_markup ? { reply_markup } : undefined);
  }
  setEveningSummaryDate(today); // отмечаем в любом случае — и когда пропусков нет, чтобы не проверять весь остаток дня
}

cron.schedule('*/5 * * * *', checkAndSendEveningDnevnikSummary);

// Нажатие кнопки под /дневник_день или вечерним автосписком — фиксирует
// выбор (dnevnikSelectedEntryId) и сразу присылает полную карточку принципа
// (весь список примеров, не усечённый). Следующий текст/голос от Elena
// уйдёт именно на эту запись — см. приоритет в handleDnevnikPendingText.
bot.on('callback_query', async (query) => {
  const data = query.data || '';
  if (!data.startsWith(DNEVNIK_SELECT_PREFIX)) return;

  const chatId = query.message.chat.id;
  const entryId = data.slice(DNEVNIK_SELECT_PREFIX.length);
  const entry = getDnevnikEntryById(entryId);

  if (!entry) {
    await bot.answerCallbackQuery(query.id, { text: 'Запись не найдена' });
    return;
  }
  if (entry.answeredAt) {
    await bot.answerCallbackQuery(query.id, { text: 'Уже отвечено' });
    return;
  }

  dnevnikSelectedEntryId.set(chatId, entryId);
  await bot.answerCallbackQuery(query.id);
  await sendDnevnikMessage(chatId, buildPrincipleDetail(getPrinciple(entry.principleNumber)));
});

// ===== Голосовые сообщения =====
async function transcribeVoice(buffer, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const file = await toFile(buffer, 'voice.ogg', { type: 'audio/ogg' });
      return await openai.audio.transcriptions.create({
        file,
        model: 'whisper-1',
        language: 'ru',
      });
    } catch (err) {
      lastErr = err;
      const transient =
        err.code === 'ECONNRESET' ||
        err.cause?.code === 'ECONNRESET' ||
        err.status === undefined ||
        err.status >= 500;
      console.error(`Попытка ${attempt}/${attempts} не удалась:`, err.message);
      if (!transient || attempt === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastErr;
}

bot.on('voice', async (msg) => {
  const chatId = msg.chat.id;

  if (!openai) {
    bot.sendMessage(chatId, 'Распознавание голоса пока не настроено 😔');
    return;
  }

  try {
    bot.sendMessage(chatId, 'Слушаю... 🎧');

    const fileId = msg.voice.file_id;
    const fileLink = await bot.getFileLink(fileId);

    const response = await fetch(fileLink);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const transcription = await transcribeVoice(buffer);

    // Голосовой ответ на дневник перехватывается той же функцией, что и
    // текстовый — сначала живой слот (окно 30 минут), затем, если живого
    // нет, но сегодня есть пропущенные — как вечерний пакетный разбор.
    const handledAsDnevnik = await handleDnevnikPendingText(chatId, transcription.text);
    if (handledAsDnevnik) return;

    bot.sendMessage(chatId, `Я услышал:\n\n"${transcription.text}"\n\n(Пока просто показываю распознанный текст — скоро научусь красиво его оформлять)`);
  } catch (err) {
    console.error('Ошибка распознавания голоса:', err.message);
    console.error('Детали:', err.cause || err.code || err.name || 'нет доп. деталей');
    console.error('Полный стек:', err.stack);
    bot.sendMessage(chatId, 'Не получилось распознать голос 😔 Попробуй ещё раз.');
  }
});

// ===== Отчёты =====
async function handleReportCommand(chatId, label, generate) {
  try {
    await bot.sendMessage(chatId, `Собираю ${label}... 📊 Секунду.`);

    const { text, totalEvents, failedTabs, debug } = await generate();

    // parse_mode: 'HTML' — report.js's buildCheckMessage/buildWeeklyMessage
    // bold the program name and link it to its tab whenever a host is still
    // needed (escaping every dynamic value from the spreadsheet along the
    // way; see escapeHtml there). Without this, the <b>/<a> tags they emit
    // would show up as literal text instead of being rendered.
    for (const chunk of chunkMessage(text)) {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
    }

    if (failedTabs.length > 0) {
      await bot.sendMessage(
        chatId,
        `⚠️ Не удалось загрузить данные из вкладок:\n${failedTabs.join('\n')}\n\nОтчёт составлен по остальным вкладкам (событий найдено: ${totalEvents}).`
      );
    }

    // Отладочная сводка по вкладкам — только в логи Railway, не в Telegram.
    if (debug) {
      console.log(debug);
    }
  } catch (err) {
    console.error('Ошибка формирования отчёта:', err.message);
    console.error(err.stack);
    bot.sendMessage(chatId, `Не получилось собрать отчёт 😔 ${err.message}`);
  }
}

bot.onText(/\/weekly\b/, (msg) => {
  handleReportCommand(msg.chat.id, 'полный обзор недели', generateWeeklyReport);
});

bot.onText(/\/(check|report)\b/, (msg) => {
  handleReportCommand(msg.chat.id, 'проверку по текущей неделе', generateCheckReport);
});

// /следующая_неделя (он же /next_week) — та же generateWeeklyAnnounceReport,
// что и воскресная авторассылка ниже (следующая Пн-Вс неделя, формат
// /weekly), просто по запросу в любой день, а не только в 10:00 по
// воскресеньям. Не трогает markWeeklyAnnounceSent — вызов вручную никак не
// связан с "отправляли ли уже сегодня" авторассылки.
bot.onText(/\/(следующая_неделя|next_week)\b/, (msg) => {
  handleReportCommand(msg.chat.id, 'расписание на следующую неделю', generateWeeklyAnnounceReport);
});

// ===== Воскресная авторассылка /weekly =====
// Каждое воскресенье в WEEKLY_ANNOUNCE_HOUR (по умолчанию 10:00) по Бали бот
// сам присылает Елене в личку то же самое сообщение, что и команда /weekly —
// без ручного запуска, чтобы оно было готово к пересылке в группу с утра.
// Тот же устойчивый "проверяем каждые 5 минут" паттерн, что и у изречения:
// не завязан на ровный тик именно в нужную минуту.
async function checkAndSendWeeklyAnnounce() {
  const nowBali = new Date(Date.now() + 8 * 60 * 60 * 1000);
  if (nowBali.getUTCDay() !== 0) return; // не воскресенье (по Бали)

  const today = baliDateString();
  if (getWeeklyAnnounceLastSentDate() === today) return; // сегодня уже отправляли
  if (baliHour() < WEEKLY_ANNOUNCE_HOUR) return; // ещё не наступил нужный час

  try {
    await handleReportCommand(myChatId, 'воскресную рассылку /weekly', generateWeeklyAnnounceReport);
    markWeeklyAnnounceSent(today);
  } catch (err) {
    console.error('[weekly-announce] ошибка воскресной рассылки:', err.message);
  }
}

if (myChatId) {
  cron.schedule('*/5 * * * *', checkAndSendWeeklyAnnounce);
}

// ===== Ежедневная diff-проверка хостов =====
// Раз в день (в 9:00 по Бали) сравнивает вкладки из daily-check-tabs.json с
// тем, что было при прошлой проверке (снимок на Railway Volume), и пишет
// Елене в личку ТОЛЬКО если что-то реально изменилось: у уже назначенного
// хоста эфир опустел, или в расписании появился эфир, которого вчера не
// было. Если изменений нет — тишина, никакого "всё ок" сообщения. /check
// эту логику не использует и продолжает отвечать всегда, по запросу.
async function runDiffCheck(chatId, { updateLastRunDate = false, announceNoChange = false } = {}) {
  const { text, failedTabs } = await runDailyHostDiffCheck(new Date(), { updateLastRunDate });

  if (text) {
    // Same HTML formatting as /check and /weekly (see handleReportCommand)
    // — this text can include an escaped-and-linked program name via the
    // appended buildCheckMessage recap, plus escaped host names elsewhere.
    for (const chunk of chunkMessage(text)) {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
    }
  } else if (announceNoChange) {
    await bot.sendMessage(chatId, 'Изменений с прошлой проверки не найдено — тишина 🤫');
  }

  if (failedTabs.length > 0) {
    await bot.sendMessage(
      chatId,
      `⚠️ Не удалось загрузить данные из вкладок:\n${failedTabs.join('\n')}\n\nПроверка проведена по остальным вкладкам.`
    );
  }
}

// Ручной запуск вне расписания — всегда отвечает (даже "изменений нет"),
// чтобы можно было свериться с реальным результатом прямо сейчас. С
// updateLastRunDate: false — а report.js теперь (см. runDailyHostDiffCheck)
// пропускает запись снимка целиком при этом флаге, не только lastRunDate —
// поэтому чисто читает и сравнивает, не трогая сохранённую вчерашнюю
// базу для сравнения. Раньше запись снимка была безусловной, и ручной вызов
// здесь мог тихо стереть реальное "вчера", из-за чего следующий плановый
// тик в 9:00 сравнивал уже подменённую базу и ничего не находил.
bot.onText(/^\/автопроверка(?:@\S+)?$/, async (msg) => {
  try {
    await runDiffCheck(msg.chat.id, { updateLastRunDate: false, announceNoChange: true });
  } catch (err) {
    console.error('[host-diff] ошибка ручного запуска:', err.message);
    await bot.sendMessage(msg.chat.id, `Не получилось выполнить проверку 😔 ${err.message}`);
  }
});

// Тот же "проверяем каждые 5 минут, сработало ли время" паттерн, что и у
// ежедневного изречения — устойчив к пропущенному ровно-в-9:00 тику
// (например, из-за рестарта контейнера).
async function checkAndRunDailyHostDiff() {
  const today = baliDateString();
  if (getHostDiffLastRunDate() === today) return; // сегодня уже проверяли
  if (baliHour() < 9) return; // ещё не наступило 9:00 по Бали

  try {
    await runDiffCheck(myChatId, { updateLastRunDate: true, announceNoChange: false });
  } catch (err) {
    console.error('[host-diff] ошибка ежедневной проверки:', err.message);
  }
}

if (myChatId) {
  cron.schedule('*/5 * * * *', checkAndRunDailyHostDiff);
}

// ===== Изречения =====
async function sendVerseImage(chatId, verseNumber) {
  const buffer = await generateVerseImageBuffer(verseNumber);
  // send_photo (не send_document/send_sticker) — Telegram сожмёт PNG в JPEG
  // и зальёт прозрачные углы белым, это осознанный компромисс: зато фото
  // открывается на весь экран с приближением текста и без рамки файла.
  await bot.sendPhoto(
    chatId,
    buffer,
    {},
    { filename: `verse-${verseNumber}.png`, contentType: 'image/png' }
  );
}

// Ручная проверка вне расписания — присылает текущее следующее изречение,
// прогресс при этом не сдвигает (сдвигает только ежедневная авто-отправка).
bot.onText(/\/verse\b/, async (msg) => {
  const chatId = msg.chat.id;
  const next = getNextVerseNumber();

  if (next === null) {
    await bot.sendMessage(chatId, 'Изречения закончились — добавьте новые в verses.json 🙏');
    return;
  }

  try {
    await bot.sendMessage(chatId, `Готовлю изречение №${next}... 🖼️`);
    await sendVerseImage(chatId, next);
  } catch (err) {
    console.error('Ошибка генерации изречения:', err.message);
    await bot.sendMessage(chatId, `Не получилось сгенерировать изречение 😔 ${err.message}`);
  }
});

// Показывает текущий прогресс — быстрая проверка "растёт ли счётчик", не
// дожидаясь следующего утра, чтобы поймать регресс сразу, а не через дни.
bot.onText(/^\/прогресс(?:@\S+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  const lastSent = getLastSent();
  const lastSentDate = getLastSentDate() || '— (ещё не отправляли по расписанию)';
  const next = getNextVerseNumber();
  const nextLabel = next === null ? 'изречения закончились' : `№${next} (всего в базе: ${getVerseCount()})`;
  await bot.sendMessage(
    chatId,
    `📊 Прогресс изречений\nПоследнее отправленное: №${lastSent}\nДата последней авто-отправки (Бали): ${lastSentDate}\nСледующее к отправке: ${nextLabel}`
  );
});

// Ежедневная отправка следующего изречения. Вместо точного выстрела cron'ом
// ровно в 6:00 (одиночный пропущенный тик — например, из-за рестарта
// контейнера в нужную минуту — раньше означал пропуск всего дня) — проверка
// каждые 5 минут: "уже наступило ли 6:00 по Бали и отправляли ли мы сегодня".
// Если тик пропущен, следующая проверка через 5 минут сама досылает изречение.
async function checkAndSendDailyVerse() {
  const today = baliDateString();
  if (getLastSentDate() === today) return; // сегодня уже отправляли
  if (baliHour() < 6) return; // ещё не наступило 6:00 по Бали

  const next = getNextVerseNumber();
  if (next === null) return; // изречения в verses.json закончились — ничего не отправляем

  try {
    await sendVerseImage(myChatId, next);
    setLastSent(next, today);
  } catch (err) {
    console.error('Ошибка ежедневной отправки изречения:', err.message);
  }
}

if (myChatId) {
  cron.schedule('*/5 * * * *', checkAndSendDailyVerse);
}

// Проверка каждую минуту: если до начала какой-то передачи осталось 19-20
// минут (МСК) и напоминание по ней ещё не отправлялось — шлём. checkReminders
// сам помечает найденные записи reminderSent и сохраняет на диск, так что
// повторный тик крона в ту же минуту (или в течение следующей) не пришлёт то
// же самое напоминание второй раз. Один и тот же текст уходит и лично
// Elena (MY_CHAT_ID), и во все группы из BROADCAST_GROUP_IDS — дополнительной
// проверки перед рассылкой не нужно: validate.js уже не даёт неполным
// записям (без обязательного при наличии zoomLink zoomCode) попасть в
// расписание через /добавить.
const broadcastGroupIds = getBroadcastGroupIds();
if (broadcastGroupIds.size === 0) {
  console.log('BROADCAST_GROUP_IDS не задан — рассылка напоминаний в группы отключена, личное напоминание не затронуто.');
}

if (myChatId || broadcastGroupIds.size > 0) {
  cron.schedule('* * * * *', async () => {
    try {
      const due = checkReminders();
      for (const record of due) {
        const text = formatReminderMessage(record);

        if (myChatId) {
          await bot.sendMessage(myChatId, text);
        }

        for (const groupId of broadcastGroupIds) {
          try {
            await bot.sendMessage(groupId, text);
          } catch (err) {
            console.error(`[reminders] не удалось отправить напоминание в группу ${groupId}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.error('[reminders] ошибка проверки напоминаний:', err.message);
    }
  });
}

// ===== Ежедневный трекер практик и проектов (/pro) =====
// Список пунктов — в proekty/items.js, чтобы добавлять новые не трогая
// остальной код. Данные — /data/proekty.json на volume, ключ дня — дата по
// Бали (та же baliDateString, что использует /verse), сбрасывается сам
// собой каждый новый день.
bot.onText(/^\/pro(?:@\S+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isTrustedUser(chatId)) return;

  const dateKey = baliDateString();
  const day = getProDay(dateKey);
  const { text, reply_markup } = buildProMessage(day);

  await bot.sendMessage(chatId, text, { reply_markup });
});

// ===== Задачи и встречи по проектам в свободной форме (/задача, /задачи) =====
// Elena диктует голосом через клавиатуру iPhone одной строкой в формате
// "Название проекта: текст задачи" — обычным текстовым сообщением, без
// команды. Список проектов — тот же, что в proekty/items.js (секция "Мои
// проекты"), см. zadachi/items-parser.js. Данные — /data/zadachi.json на
// volume, дата/время — в МСК (как и в /добавить).
bot.onText(/^\/задача(?:@\S+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isTrustedUser(chatId)) return;

  const projectsList = ZAD_PROJECTS.map((p) => `• ${p.label}`).join('\n');
  await bot.sendMessage(
    chatId,
    '📝 Как добавить задачу или встречу\n\n' +
      'Напиши сообщением (можно продиктовать голосом через клавиатуру) в формате:\n' +
      'Название проекта: текст задачи\n\n' +
      'Например:\n' +
      '«Афиша: встреча с Оксаной завтра в 15:00 по Бали»\n' +
      '«Прямые передачи: доделать проверку дубликатов»\n' +
      '«Хосты WVP: написать Тимоти про замену на четверг»\n\n' +
      'Проекты, которые я понимаю:\n' +
      `${projectsList}\n\n` +
      'Посмотреть список задач — /задачи'
  );
});

bot.onText(/^\/задачи(?:@\S+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isTrustedUser(chatId)) return;

  const { text, reply_markup } = buildTasksListMessage(getOpenTasks());
  await bot.sendMessage(chatId, text, { reply_markup });
});

// Возвращает true, только если сообщение реально обработано здесь (задача
// сохранена, либо явная ошибка API/записи уже показана пользователю) — и
// цепочка в bot.on('message', ...) дальше не идёт. Если формат похож, но
// Claude не уверен, к какому проекту это относится (matched: false) —
// возвращаем false: сообщение не наше, пусть идёт дальше как обычно (в
// парсер напоминаний/эхо), а не проглатывается молча.
async function handleTaskMessage(chatId, text) {
  if (!looksLikeTaskMessage(text)) return false;
  if (!isTrustedUser(chatId)) return false;
  if (!zadachiConfigured) return false;

  try {
    const result = await parseTaskMessage(text);
    if (!result.matched) return false;

    const record = addTask(result);
    await bot.sendMessage(chatId, buildTaskAddedText(record));
    return true;
  } catch (err) {
    console.error('[zadachi] ошибка распознавания/сохранения задачи:', err.message);
    await bot.sendMessage(chatId, 'Не получилось разобрать и сохранить задачу 😔 Попробуй ещё раз.');
    return true;
  }
}

bot.on('callback_query', async (query) => {
  const data = query.data || '';
  if (data !== ZAD_NOOP_CALLBACK && !data.startsWith(ZAD_DONE_PREFIX)) return;

  const chatId = query.message.chat.id;

  if (data === ZAD_NOOP_CALLBACK) {
    await bot.answerCallbackQuery(query.id);
    return;
  }

  if (!isTrustedUser(chatId)) {
    await bot.answerCallbackQuery(query.id, { text: 'Команда недоступна' });
    return;
  }

  const id = data.slice(ZAD_DONE_PREFIX.length);

  try {
    const record = markDone(id);
    if (!record) {
      await bot.answerCallbackQuery(query.id, { text: 'Задача уже не найдена' });
      return;
    }

    const { text, reply_markup } = buildTasksListMessage(getOpenTasks());
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup,
    });
    await bot.answerCallbackQuery(query.id, { text: 'Готово!' });
  } catch (err) {
    console.error('[zadachi] ошибка сохранения:', err.message);
    await bot.answerCallbackQuery(query.id, { text: 'Ошибка сохранения' });
  }
});

// ===== Прямые передачи курсов "Пять домов" =====
bot.onText(/^\/добавить(?:@\S+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;

  if (!isTrustedUser(chatId)) {
    await bot.sendMessage(chatId, 'Эта команда доступна только организаторам.');
    return;
  }

  const argText = match[1] ? match[1].trim() : '';
  const replyText = msg.reply_to_message?.text || msg.reply_to_message?.caption || '';
  const rawText = argText || replyText;

  if (!rawText) {
    await bot.sendMessage(
      chatId,
      'Использование: /добавить <текст сообщения от учителя>\nили ответь командой /добавить на сообщение с текстом.'
    );
    return;
  }

  try {
    await bot.sendMessage(chatId, 'Распознаю текст... 🧠');

    const entries = await extractPeredachi(rawText);
    if (entries.length === 0) {
      await bot.sendMessage(chatId, 'Не нашёл в тексте информации о передачах. Проверь текст или добавь вручную.');
      return;
    }

    // Внутренние ссылки вида https://t.me/c/<id>/<номер> не открываются у тех,
    // кто не состоит в группе — подменяем на пригласительную по таблице
    // соответствий (/группы), если для этого id она известна.
    let replacedLinksCount = 0;
    const resolvedEntries = entries.map((entry) => {
      const invite = resolveInviteLink(entry.groupLink);
      if (!invite) return entry;
      replacedLinksCount += 1;
      return { ...entry, groupLink: invite };
    });

    const validEntries = [];
    const invalidEntries = [];
    for (const entry of resolvedEntries) {
      const { valid, missing } = validateEntry(entry);
      if (valid) {
        validEntries.push(entry);
      } else {
        invalidEntries.push({ entry, missing });
      }
    }

    const describe = (r) => {
      const kursLabel = r.postfix ? `${r.kurs} (${r.postfix})` : r.kurs || '?';
      const dateLabel = r.dateISO || 'дата неизвестна';
      const timeLabel = r.timeMSK ? `, ${r.timeMSK} МСК` : '';
      return `• Курс ${kursLabel} — ${dateLabel}${timeLabel}`;
    };

    const blocks = [];

    if (validEntries.length > 0) {
      const { added, updated, skipped, rescheduled } = addRecords(validEntries, rawText);

      if (added.length > 0) {
        blocks.push(`✅ Добавлено новых: ${added.length}\n${added.map(describe).join('\n')}`);
      }
      if (updated.length > 0) {
        blocks.push(`🔄 Обновлено (дополнены данными): ${updated.length}\n${updated.map(describe).join('\n')}`);
      }
      if (skipped.length > 0) {
        blocks.push(`✅ Уже было в расписании: ${skipped.length}\n${skipped.map(describe).join('\n')}`);
      }
      if (rescheduled.length > 0) {
        const lines = rescheduled.map((r) => {
          const kursLabel = r.merged.postfix ? `${r.merged.kurs} (${r.merged.postfix})` : r.merged.kurs || '?';
          return `• Курс ${kursLabel} — ${r.merged.dateISO}: было ${r.oldTime} → стало ${r.newTime}`;
        });
        blocks.push(`🔄 Изменено время: ${rescheduled.length}\n${lines.join('\n')}`);
      }
    }

    if (invalidEntries.length > 0) {
      const lines = invalidEntries.map(
        ({ entry, missing }) => `— ${describeEntry(entry)} — не хватает: ${missing.join(' / ')}`
      );
      blocks.push(
        `⚠️ Не удалось сохранить (не хватает данных):\n${lines.join('\n')}\n\nДополни текст этой информацией и отправь через /добавить ещё раз.`
      );
    }

    if (replacedLinksCount > 0) {
      blocks.push(`🔄 Автоматически заменено ссылок на пригласительные: ${replacedLinksCount}`);
    }

    await bot.sendMessage(chatId, blocks.join('\n\n') || 'Ничего не изменилось.');
  } catch (err) {
    console.error('[peredachi] ошибка распознавания/сохранения:', err.message);
    await bot.sendMessage(
      chatId,
      'Не смог распознать 😔 Попробуй переслать текст ещё раз или добавь вручную командой /добавить_вручную.'
    );
  }
});

// ===== Мониторинг групп на анонсы передач =====
// Слушает новые текстовые сообщения только в группах из WATCHED_GROUP_IDS
// (требует отключённый Privacy Mode в каждой такой группе — иначе Telegram
// не доставляет боту чужие сообщения вообще). Для каждого сообщения сначала
// дешёвая эвристика (looksLikeAnnouncement, без API) — если совсем не похоже
// на анонс, выходим без единого вызова Anthropic. Если похоже — тот же
// extractPeredachi, что и /добавить, и та же проверка на дубли (isSameEvent
// по kurs+dateISO+timeMSK). НИЧЕГО не пишется в /data/peredachi.json отсюда:
// это только уведомление Elena, запись создаётся исключительно через её
// собственный /добавить после того, как она посмотрит на распознанное.
const watchedGroupIds = getWatchedGroupIds();

if (watchedGroupIds.size === 0) {
  console.warn('WATCHED_GROUP_IDS не задан — мониторинг групп на анонсы передач отключён.');
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  if (!watchedGroupIds.has(String(chatId))) return;

  const text = msg.text || msg.caption || '';
  if (!looksLikeAnnouncement(text)) return;

  if (!myChatId) return;

  try {
    const entries = await extractPeredachi(text);
    if (entries.length === 0) return;

    const existing = readPeredachi();
    const groupTitle = msg.chat.title || String(chatId);
    const excerpt = text.length > 300 ? `${text.slice(0, 300)}…` : text;

    for (const entry of entries) {
      const normalized = {
        kurs: entry.kurs || '',
        postfix: entry.postfix || '',
        teacher: entry.teacher || '',
        dateISO: entry.dateISO || '',
        timeMSK: entry.timeMSK || '',
        zanyatie: entry.zanyatie || '',
        zoomLink: entry.zoomLink || '',
        zoomCode: entry.zoomCode || '',
        groupLink: entry.groupLink || '',
      };

      // Тот же критерий дубля, что использует /добавить при сохранении —
      // совпадение kurs+dateISO+timeMSK с уже существующей записью.
      const isDuplicate = existing.some((r) => isSameEvent(r, normalized));
      if (isDuplicate) continue;

      const kursLabel = normalized.postfix ? `${normalized.kurs} (${normalized.postfix})` : normalized.kurs || 'не определён';
      const dateLabel = normalized.dateISO || 'не определена';
      const timeLabel = normalized.timeMSK ? `${normalized.timeMSK} МСК` : 'не определено';
      const hasLink = normalized.zoomLink.trim() || normalized.groupLink.trim();
      const missingZoomCode = normalized.zoomLink.trim() && !normalized.zoomCode.trim();

      // Отсутствие ссылки/кода не должно блокировать само уведомление — Elena
      // всё равно должна узнать про новую передачу, просто с явной пометкой,
      // что нужно уточнить отдельно.
      const notifyLines = [
        `🔔 Похоже на новую передачу (группа: ${groupTitle})`,
        '',
        'Распознано:',
        `Курс: ${kursLabel}`,
        `Дата: ${dateLabel}, Время: ${timeLabel}`,
      ];
      if (!hasLink) {
        notifyLines.push('⚠️ Ссылки не найдено — уточни у автора, где искать Zoom (часто "ссылка будет в этом же чате")');
      }
      if (missingZoomCode) {
        notifyLines.push('⚠️ нет кода Zoom');
      }
      notifyLines.push('', 'Исходный текст:', excerpt, '', 'Чтобы добавить в расписание, перешли этот текст через /добавить.');

      const notifyText = notifyLines.join('\n');

      await bot.sendMessage(myChatId, notifyText);
    }
  } catch (err) {
    console.error('[group-watch] ошибка распознавания анонса:', err.message);
  }
});

bot.onText(/^\/курсы(?:@\S+)?$/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const all = readPeredachi();
    // /курсы больше не сокращает список (см. историю), поэтому с реальным
    // объёмом данных легко перевалить за лимит Telegram в 4096 символов —
    // chunkMessage режет только по границам "параграфов" (\n\n), а каждый
    // блок записи/заголовок сам по себе уже сбалансирован по Markdown после
    // экранирования, так что разрезание не может порвать какой-то *…*/_…_
    // посередине.
    for (const chunk of chunkMessage(formatKursOverview(all))) {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('[peredachi] ошибка формирования списка курсов:', err.message);
    console.error(err.stack);
    await bot.sendMessage(chatId, 'Не получилось получить список передач 😔');
  }
});

bot.onText(/^\/курс([1-6])(?:@\S+)?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const kursNumber = match[1];

  try {
    const all = readPeredachi();
    for (const chunk of chunkMessage(formatKursDetail(all, kursNumber))) {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('[peredachi] ошибка формирования списка по курсу:', err.message);
    console.error(err.stack);
    await bot.sendMessage(chatId, 'Не получилось получить список передач 😔');
  }
});

bot.onText(/^\/медитаци[яи](?:@\S+)?$/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const all = readPeredachi();
    for (const chunk of chunkMessage(formatMeditations(all))) {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('[peredachi] ошибка формирования списка медитаций:', err.message);
    console.error(err.stack);
    await bot.sendMessage(chatId, 'Не получилось получить список медитаций 😔');
  }
});

// /ближайший <курс> — не список (как /курс1...курс6), а ровно одна, самая
// ближайшая по времени запись, полным форматом. <курс> — номер 1-6 или
// "медитация".
bot.onText(/^\/ближайший(?:@\S+)?(?:\s+(\S+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const kursArg = match[1] ? match[1].trim() : '';

  if (!kursArg) {
    await bot.sendMessage(chatId, 'Использование: /ближайший <курс>\nНапример: /ближайший 6 или /ближайший медитация');
    return;
  }

  try {
    const all = readPeredachi();
    for (const chunk of chunkMessage(formatNearest(all, kursArg))) {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('[peredachi] ошибка формирования ближайшей передачи:', err.message);
    console.error(err.stack);
    await bot.sendMessage(chatId, 'Не получилось получить ближайшую передачу 😔');
  }
});

// ДД.ММ -> {day, month} или null, если формат неверный.
function parseDDMM(token) {
  const match = /^(\d{1,2})\.(\d{1,2})$/.exec(String(token || '').trim());
  if (!match) return null;
  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { day, month };
}

// Собирает и проверяет реальную календарную дату для конкретного года —
// отсекает несуществующие даты вроде 31.02 (через UTC round-trip: если
// day/month "переполнились" при сборке, Date.UTC их нормализует, и сверка
// с исходными значениями не совпадёт).
function buildDateISO(year, month, day) {
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// /дата <ДД.ММ> — год подбирается автоматически: если день.месяц ещё не
// прошёл в этом году (по МСК) — текущий год, иначе — следующий.
function resolveDateArg(token, todayISO) {
  const parsed = parseDDMM(token);
  if (!parsed) return null;

  const currentYear = Number(todayISO.slice(0, 4));
  const thisYear = buildDateISO(currentYear, parsed.month, parsed.day);
  if (thisYear && thisYear >= todayISO) return thisYear;

  const nextYear = buildDateISO(currentYear + 1, parsed.month, parsed.day);
  if (nextYear) return nextYear;

  return thisYear; // редкий край (29 февраля, невисокосный ни в этом, ни в следующем) — вернём валидный, если он вообще был
}

// Доступна всем, как /курсы и /медитации — показывает все записи (курсы и
// медитации вместе) на конкретную дату, независимо от курса.
bot.onText(/^\/дата(?:@\S+)?(?:\s+(\S+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const dateArg = match[1] ? match[1].trim() : '';
  const usage = 'Используй формат: /дата 27.08';

  const { dateISO: todayISO } = getNowMsk();
  const resolvedDateISO = dateArg ? resolveDateArg(dateArg, todayISO) : null;

  if (!resolvedDateISO) {
    await bot.sendMessage(chatId, usage);
    return;
  }

  try {
    const all = readPeredachi();
    for (const chunk of chunkMessage(formatByDate(all, resolvedDateISO))) {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('[peredachi] ошибка формирования списка на дату:', err.message);
    console.error(err.stack);
    await bot.sendMessage(chatId, 'Не получилось получить список передач 😔');
  }
});

// Разовая/повторная проверка volume на задвоенные передачи (одинаковые
// kurs+dateISO+timeMSK). Однозначные дубли (без конфликтующих полей)
// схлопываются автоматически в более полную версию; там, где записи
// конфликтуют — например, разные zoomLink — ничего не удаляется, обе версии
// просто показываются, чтобы решение принял человек.
bot.onText(/^\/дубли(?:@\S+)?$/, async (msg) => {
  const chatId = msg.chat.id;

  if (!isTrustedUser(chatId)) {
    await bot.sendMessage(chatId, 'Эта команда доступна только организаторам.');
    return;
  }

  try {
    const all = readPeredachi();
    const { autoResolved, ambiguous } = analyzeDuplicates(all);

    if (autoResolved.length === 0 && ambiguous.length === 0) {
      await bot.sendMessage(chatId, 'Дублей не найдено 👍');
      return;
    }

    if (autoResolved.length > 0) {
      const removeIds = new Set(autoResolved.flatMap((g) => g.remove.map((r) => r.id)));
      const keepById = new Map(autoResolved.map((g) => [g.keep.id, g.keep]));
      const next = all.filter((r) => !removeIds.has(r.id)).map((r) => keepById.get(r.id) || r);
      savePeredachi(next);
    }

    const lines = [];

    if (autoResolved.length > 0) {
      lines.push(`✅ Автоматически объединено дублей: ${autoResolved.length}`);
      for (const g of autoResolved) {
        lines.push(
          `• Курс ${g.keep.kurs} — ${g.keep.dateISO}, ${g.keep.timeMSK} МСК (удалено записей: ${g.remove.length})`
        );
      }
    }

    if (ambiguous.length > 0) {
      lines.push('');
      lines.push('⚠️ Неоднозначные дубли — реши сама, какую версию оставить (ничего не удалено):');
      ambiguous.forEach((group, gi) => {
        lines.push('');
        lines.push(`Группа ${gi + 1}:`);
        group.forEach((r) => {
          lines.push(
            [
              `  id=${r.id}`,
              `курс=${r.kurs}${r.postfix ? ` (${r.postfix})` : ''}`,
              `дата=${r.dateISO} ${r.timeMSK} МСК`,
              `учитель=${r.teacher || '—'}`,
              `занятие=${r.zanyatie || '—'}`,
              `zoom=${r.zoomLink || '—'}`,
              `код=${r.zoomCode || '—'}`,
              `группа=${r.groupLink || '—'}`,
              `добавлено=${r.addedAt || '—'}`,
            ].join(', ')
          );
        });
      });
    }

    for (const chunk of chunkMessage(lines.join('\n'))) {
      await bot.sendMessage(chatId, chunk);
    }
  } catch (err) {
    console.error('[peredachi] ошибка поиска дублей:', err.message);
    await bot.sendMessage(chatId, 'Не получилось проверить дубли 😔');
  }
});

// Разовая/повторная проверка volume на записи, сохранённые ещё до того, как
// /добавить стал разбивать "Занятие N + Медитация M" на две записи. Находит
// такие комбинированные zanyatie, уверенно делимые — разбивает на две записи
// (сохраняя дату/время/ссылки) и удаляет исходную; неуверенно делимые —
// оставляет как есть и показывает текстом, чтобы разобрать вручную.
bot.onText(/^\/разделить(?:@\S+)?$/, async (msg) => {
  const chatId = msg.chat.id;

  if (!isTrustedUser(chatId)) {
    await bot.sendMessage(chatId, 'Эта команда доступна только организаторам.');
    return;
  }

  try {
    const all = readPeredachi();
    const { splittable, unresolved } = analyzeSplits(all);

    if (splittable.length === 0 && unresolved.length === 0) {
      await bot.sendMessage(chatId, 'Комбинированных записей не найдено.');
      return;
    }

    if (splittable.length > 0) {
      const removeIds = new Set(splittable.map((s) => s.original.id));
      const additions = splittable.flatMap((s) => s.parts);
      const next = all.filter((r) => !removeIds.has(r.id)).concat(additions);
      savePeredachi(next);
    }

    const lines = [];

    if (splittable.length > 0) {
      lines.push(`✅ Разделено записей: ${splittable.length}`);
      for (const s of splittable) {
        const dateLabel = s.original.dateISO || 'дата неизвестна';
        const timeLabel = s.original.timeMSK ? `, ${s.original.timeMSK} МСК` : '';
        lines.push(`• ${dateLabel}${timeLabel} — было: "${s.original.zanyatie}"`);
      }
    }

    if (unresolved.length > 0) {
      lines.push('');
      lines.push('⚠️ Не удалось разделить автоматически — раздели вручную:');
      unresolved.forEach((r) => {
        lines.push(`— id=${r.id}, ${r.dateISO || '?'} ${r.timeMSK || ''} МСК — "${r.zanyatie}"`);
      });
    }

    for (const chunk of chunkMessage(lines.join('\n'))) {
      await bot.sendMessage(chatId, chunk);
    }
  } catch (err) {
    console.error('[peredachi] ошибка разделения комбинированных записей:', err.message);
    await bot.sendMessage(chatId, 'Не получилось выполнить разделение 😔');
  }
});

// Таблица соответствий "internal group id → пригласительная ссылка" — нужна,
// чтобы /добавить мог автоматически подменять внутренние ссылки
// (https://t.me/c/<id>/<номер>, не открываются у тех, кто не в группе) на
// рабочие пригласительные. Без аргументов — показывает весь список.
bot.onText(/^\/группы(?:@\S+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;

  if (!isTrustedUser(chatId)) {
    await bot.sendMessage(chatId, 'Эта команда доступна только организаторам.');
    return;
  }

  const argText = match[1] ? match[1].trim() : '';

  try {
    if (!argText) {
      const map = readGroupLinks();
      const rows = Object.entries(map);
      if (rows.length === 0) {
        await bot.sendMessage(chatId, 'Список соответствий пуст.');
        return;
      }
      const lines = rows.map(([id, link]) => `${id} → ${link}`);
      await bot.sendMessage(chatId, `Текущие соответствия:\n${lines.join('\n')}`);
      return;
    }

    const parts = argText.split(/\s+/);
    if (parts.length !== 2) {
      await bot.sendMessage(
        chatId,
        'Использование: /группы <internal_id> <пригласительная_ссылка>\nНапример: /группы 3698510352 https://t.me/+Va-z6dHKYT81OWVk'
      );
      return;
    }

    const [internalId, inviteLink] = parts;
    setGroupLink(internalId, inviteLink);
    await bot.sendMessage(chatId, `Добавлено соответствие: ID ${internalId} → ${inviteLink}`);
  } catch (err) {
    console.error('[group-links] ошибка сохранения соответствия:', err.message);
    await bot.sendMessage(chatId, 'Не получилось сохранить соответствие 😔');
  }
});

// Разовая/повторная проверка volume на записи с внутренней ссылкой
// (https://t.me/c/<id>/<номер>), для которой к этому моменту уже появилось
// соответствие в /data/group-links.json — например, добавили его через
// /группы уже после того, как эти записи были сохранены.
bot.onText(/^\/обновитьссылки(?:@\S+)?$/, async (msg) => {
  const chatId = msg.chat.id;

  if (!isTrustedUser(chatId)) {
    await bot.sendMessage(chatId, 'Эта команда доступна только организаторам.');
    return;
  }

  try {
    const all = readPeredachi();
    const updated = [];

    for (const record of all) {
      const invite = resolveInviteLink(record.groupLink);
      if (!invite) continue;
      record.groupLink = invite;
      updated.push(record);
    }

    if (updated.length === 0) {
      await bot.sendMessage(chatId, 'Записей для обновления не найдено.');
      return;
    }

    savePeredachi(all);

    const lines = updated.map(
      (r) => `• Курс ${r.kurs}${r.postfix ? ` (${r.postfix})` : ''} — ${r.dateISO || 'дата неизвестна'}`
    );
    await bot.sendMessage(chatId, `✅ Обновлено записей: ${updated.length}\n${lines.join('\n')}`);
  } catch (err) {
    console.error('[peredachi] ошибка обновления ссылок:', err.message);
    await bot.sendMessage(chatId, 'Не получилось обновить ссылки 😔');
  }
});

// ДД.ММ.ГГГГ или ГГГГ-ММ-ДД -> ГГГГ-ММ-ДД (как в dateISO), иначе null.
function parseDateArg(token) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token);
  if (iso) return token;
  const ru = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(token);
  if (!ru) return null;
  const [, d, m, y] = ru;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// /удалить <курс> <дата> [время] — курс как везде (1-6 или "медитация",
// через recordMatchesKurs — понимает и postfix-диапазоны экспресс-курсов);
// дата — ДД.ММ.ГГГГ или ГГГГ-ММ-ДД (через parseDateArg). Если на эту дату
// у курса несколько записей с разным временем — ничего не удаляет, только
// показывает варианты и просит уточнить время третьим параметром.
bot.onText(/^\/удалить(?:@\S+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;

  if (!isTrustedUser(chatId)) {
    await bot.sendMessage(chatId, 'Эта команда доступна только организаторам.');
    return;
  }

  const argText = match[1] ? match[1].trim() : '';
  const usage = 'Использование: /удалить <курс> <дата> [время]\nНапример: /удалить 6 2026-08-26\nили /удалить 6 2026-08-26 17:00, если записей на эту дату несколько';

  if (!argText) {
    await bot.sendMessage(chatId, usage);
    return;
  }

  const tokens = argText.split(/\s+/);
  if (tokens.length < 2 || tokens.length > 3) {
    await bot.sendMessage(chatId, usage);
    return;
  }

  const [kursArg, dateToken, timeArg] = tokens;
  const dateISO = parseDateArg(dateToken);

  if (!dateISO) {
    await bot.sendMessage(chatId, `Не понял дату "${dateToken}".\n\n${usage}`);
    return;
  }

  try {
    const all = readPeredachi();
    let matches = all.filter((r) => r.dateISO === dateISO && recordMatchesKurs(r, kursArg));

    if (matches.length === 0) {
      await bot.sendMessage(chatId, `Запись не найдена: Курс ${kursArg} — ${dateISO}.`);
      return;
    }

    if (timeArg) {
      matches = matches.filter((r) => String(r.timeMSK || '').trim() === timeArg);
      if (matches.length === 0) {
        await bot.sendMessage(chatId, `Запись не найдена: Курс ${kursArg} — ${dateISO}, ${timeArg} МСК.`);
        return;
      }
    }

    if (matches.length > 1) {
      const lines = matches.map((r) => `— ${r.timeMSK || '?'} МСК — ${r.zanyatie || '—'}`);
      await bot.sendMessage(
        chatId,
        `Найдено несколько записей: Курс ${kursArg} — ${dateISO}:\n${lines.join('\n')}\n\nУточни время, например: /удалить ${kursArg} ${dateISO} ${matches[0].timeMSK || 'ЧЧ:ММ'}`
      );
      return;
    }

    const removed = matches[0];
    savePeredachi(all.filter((r) => r.id !== removed.id));

    const kursLabel = removed.postfix ? `${removed.kurs} (${removed.postfix})` : removed.kurs || '?';
    await bot.sendMessage(
      chatId,
      `Удалено: Курс ${kursLabel} — ${removed.dateISO}, ${removed.timeMSK || '?'} МСК — ${removed.zanyatie || '—'}`
    );
  } catch (err) {
    console.error('[peredachi] ошибка удаления записи:', err.message);
    console.error(err.stack);
    await bot.sendMessage(chatId, 'Не получилось удалить запись 😔');
  }
});

// Разовая/повторная проверка volume на записи с одинаковым kurs+dateISO+
// groupLink, но разным timeMSK — старую запись со сдвинутым временем не
// удалили при добавлении новой (тот же поток, просто перенос). Для каждой
// такой группы автоматически оставляет запись с самым поздним addedAt и
// удаляет более старые версии. Если groupLink разный — не группируются
// (независимые потоки), см. peredachi/stale.js.
bot.onText(/^\/устаревшие(?:@\S+)?$/, async (msg) => {
  const chatId = msg.chat.id;

  if (!isTrustedUser(chatId)) {
    await bot.sendMessage(chatId, 'Эта команда доступна только организаторам.');
    return;
  }

  try {
    const all = readPeredachi();
    const resolved = resolveStaleTimeGroups(all);

    if (resolved.length === 0) {
      await bot.sendMessage(chatId, 'Записей с устаревшим временем не найдено.');
      return;
    }

    const removeIds = new Set(resolved.flatMap((g) => g.remove.map((r) => r.id)));
    savePeredachi(all.filter((r) => !removeIds.has(r.id)));

    const lines = [`✅ Почищено групп: ${resolved.length}`];
    resolved.forEach((g, gi) => {
      const kursLabel = g.keep.postfix ? `${g.keep.kurs} (${g.keep.postfix})` : g.keep.kurs;
      lines.push('');
      lines.push(`Группа ${gi + 1}: курс ${kursLabel}, дата ${g.keep.dateISO}`);
      lines.push(`  оставлено: id=${g.keep.id}, время=${g.keep.timeMSK} МСК, добавлено=${g.keep.addedAt || '—'}, "${g.keep.zanyatie || '—'}"`);
      g.remove.forEach((r) => {
        lines.push(`  удалено: id=${r.id}, время=${r.timeMSK || '?'} МСК, добавлено=${r.addedAt || '—'}, "${r.zanyatie || '—'}"`);
      });
    });

    for (const chunk of chunkMessage(lines.join('\n'))) {
      await bot.sendMessage(chatId, chunk);
    }
  } catch (err) {
    console.error('[peredachi] ошибка очистки устаревших записей:', err.message);
    console.error(err.stack);
    await bot.sendMessage(chatId, 'Не получилось почистить устаревшие записи 😔');
  }
});

// Разовая очистка volume от записей, где есть zoomLink, но groupLink пустой —
// для них нет способа связаться с учителем при проблемах, а исходный чат
// восстановить неоткуда. Удаляет сразу (не список для ручного разбора, как
// /дубли/устаревшие) — этот случай однозначен, альтернативы нет.
bot.onText(/^\/безгруппы(?:@\S+)?$/, async (msg) => {
  const chatId = msg.chat.id;

  if (!isTrustedUser(chatId)) {
    await bot.sendMessage(chatId, 'Эта команда доступна только организаторам.');
    return;
  }

  try {
    const all = readPeredachi();
    const toRemove = all.filter((r) => String(r.zoomLink || '').trim() && !String(r.groupLink || '').trim());

    if (toRemove.length === 0) {
      await bot.sendMessage(chatId, 'Записей без ссылки на чат не найдено.');
      return;
    }

    const removeIds = new Set(toRemove.map((r) => r.id));
    savePeredachi(all.filter((r) => !removeIds.has(r.id)));

    const lines = toRemove.map((r) => {
      const kursLabel = r.postfix ? `${r.kurs} (${r.postfix})` : r.kurs || '?';
      return `• Курс ${kursLabel} — ${r.dateISO || '?'}, ${r.timeMSK || '?'} МСК — ${r.zanyatie || '—'}`;
    });

    for (const chunk of chunkMessage(`🗑 Удалено записей без ссылки на чат: ${toRemove.length}\n${lines.join('\n')}`)) {
      await bot.sendMessage(chatId, chunk);
    }
  } catch (err) {
    console.error('[peredachi] ошибка очистки записей без groupLink:', err.message);
    console.error(err.stack);
    await bot.sendMessage(chatId, 'Не получилось почистить записи без ссылки на чат 😔');
  }
});

// ===== Новое событие в афише (/new) =====
// Сессия по chatId: history — messages для Anthropic (весь диалог, чтобы
// уточнения не теряли уже распознанный контекст), parsed — последний
// собранный объект события, stage — 'collecting' (ждём описание/уточнения)
// или 'confirming' (показана карточка с кнопками Да/Отменить).
const eventSessions = new Map();

bot.onText(/^\/new(?:@\S+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  eventSessions.set(chatId, { history: [], parsed: null, stage: 'collecting' });
  await bot.sendMessage(
    chatId,
    'Добавляем новое событие в афишу 🙏\n\nОпиши его одним сообщением — программа, формат (онлайн/офлайн/запись), кто ведёт, дата и время.\n\nНапример:\n«Пять домов, офлайн, Мария и Питер Мертал, 26 августа в 15:00 по Москве»\n\nЧтобы отменить в любой момент — напиши «отмена».'
  );
});

async function handleEventDescription(chatId, text) {
  const trimmed = text.trim();

  if (/^(отмена|cancel)$/i.test(trimmed)) {
    eventSessions.delete(chatId);
    await bot.sendMessage(chatId, 'Отменено.');
    return;
  }

  const session = eventSessions.get(chatId);
  if (!session) return;

  session.history.push({ role: 'user', content: trimmed });

  try {
    const { parsed, assistantText } = await extractEvent(session.history);
    session.history.push({ role: 'assistant', content: assistantText });
    session.parsed = parsed;

    const { valid, missing } = validateEvent(parsed);
    if (!valid) {
      await bot.sendMessage(
        chatId,
        `Не хватает: ${missing.join(', ')}.\nДопиши, пожалуйста, только эту информацию (можно одним сообщением) — остальное я уже понял.`
      );
      return;
    }

    const complete = fillTimezones(parsed);
    session.parsed = complete;
    session.stage = 'confirming';

    await bot.sendMessage(chatId, buildConfirmationText(complete), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Да, добавить', callback_data: 'newevent_confirm' },
            { text: '❌ Отменить', callback_data: 'newevent_cancel' },
          ],
        ],
      },
    });
  } catch (err) {
    console.error('[events] ошибка распознавания:', err.message);
    await bot.sendMessage(chatId, `Не получилось разобрать описание 😔 ${err.message}\nПопробуй переформулировать.`);
  }
}

bot.on('callback_query', async (query) => {
  const data = query.data;
  if (data !== 'newevent_confirm' && data !== 'newevent_cancel') return;

  const chatId = query.message.chat.id;
  const session = eventSessions.get(chatId);

  if (!session || session.stage !== 'confirming') {
    await bot.answerCallbackQuery(query.id, { text: 'Сессия истекла, начни заново командой /new' });
    return;
  }

  await bot.editMessageReplyMarkup(
    { inline_keyboard: [] },
    { chat_id: chatId, message_id: query.message.message_id }
  );

  if (data === 'newevent_cancel') {
    eventSessions.delete(chatId);
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, 'Отменено.');
    return;
  }

  try {
    const addedBy = query.from.username ? `@${query.from.username}` : query.from.first_name || '';
    addEvent(session.parsed, addedBy);
    eventSessions.delete(chatId);
    await bot.answerCallbackQuery(query.id, { text: 'Добавлено!' });
    await bot.sendMessage(chatId, '✅ Событие добавлено в афишу! На сайте появится при следующем обновлении страницы.');
  } catch (err) {
    console.error('[events] ошибка сохранения:', err.message);
    await bot.answerCallbackQuery(query.id, { text: 'Ошибка сохранения' });
    await bot.sendMessage(chatId, `Не получилось сохранить 😔 ${err.message}`);
  }
});

bot.on('callback_query', async (query) => {
  const data = query.data || '';
  if (data !== PRO_NOOP_CALLBACK && !data.startsWith(PRO_TOGGLE_PREFIX)) return;

  const chatId = query.message.chat.id;

  if (data === PRO_NOOP_CALLBACK) {
    await bot.answerCallbackQuery(query.id);
    return;
  }

  if (!isTrustedUser(chatId)) {
    await bot.answerCallbackQuery(query.id, { text: 'Команда недоступна' });
    return;
  }

  const itemKey = data.slice(PRO_TOGGLE_PREFIX.length);
  if (!isKnownItem(itemKey)) {
    await bot.answerCallbackQuery(query.id);
    return;
  }

  try {
    const dateKey = baliDateString();
    const day = toggleProItem(dateKey, itemKey);
    const { text, reply_markup } = buildProMessage(day);

    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup,
    });
    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error('[proekty] ошибка сохранения:', err.message);
    await bot.answerCallbackQuery(query.id, { text: 'Ошибка сохранения' });
  }
});

// ===== Габариты Ozon (/габариты) =====
// Сессия по chatId копит распознанные данные с нескольких фото одного
// товара (этикетка+линейка, отдельно весы), пока не наберётся достаточно
// данных или не истечёт ~2 минуты с первого фото. pending — счётчик фото,
// которые сейчас в обработке (ждём ответ Anthropic) — пока он больше 0,
// сессию не завершаем, чтобы не потерять данные фото, которое ещё летит.
const gabaritySessions = new Map();
const GABARITY_DEBOUNCE_MS = 8 * 1000; // тишина после последнего фото перед обработкой
const GABARITY_MAX_MS = 2 * 60 * 1000; // жёсткий потолок сессии с первого фото

function clearGabarityTimers(session) {
  if (session.debounceTimer) clearTimeout(session.debounceTimer);
  if (session.maxTimer) clearTimeout(session.maxTimer);
}

function isGabaritySessionComplete(session) {
  return Boolean(
    session.articleId &&
      session.width != null &&
      session.length != null &&
      session.height != null &&
      session.weightKg != null
  );
}

function scheduleGabarityDebounce(chatId) {
  const session = gabaritySessions.get(chatId);
  if (!session) return;
  if (session.debounceTimer) clearTimeout(session.debounceTimer);
  session.debounceTimer = setTimeout(() => finalizeGabaritySession(chatId), GABARITY_DEBOUNCE_MS);
}

// После обработки фото (или ответа на уточнение) решает, завершать сессию
// сейчас или подождать ещё немного — единая точка входа, чтобы условие
// "pending === 0 && не ждём уточнения" не дублировалось в трёх местах.
function maybeAdvanceGabaritySession(chatId) {
  const session = gabaritySessions.get(chatId);
  if (!session || session.pending > 0 || session.awaitingClarification) return;

  if (isGabaritySessionComplete(session)) {
    finalizeGabaritySession(chatId);
  } else {
    scheduleGabarityDebounce(chatId);
  }
}

// Возвращает список measurements с axis "unknown" — их не удалось привязать
// к стороне автоматически, вызывающий код решает, нужно ли уточнение.
function mergeGabarityResult(session, result) {
  if (result.articleId && !session.articleId) {
    session.articleId = result.articleId;
  }
  if (result.weightKg !== null && session.weightKg == null) {
    session.weightKg = result.weightKg;
  }

  const unknowns = [];
  for (const m of result.measurements) {
    if (m.axis === 'unknown') {
      unknowns.push(m.valueCm);
      continue;
    }
    if (session[m.axis] == null) {
      session[m.axis] = m.valueCm;
    }
  }
  return unknowns;
}

async function finalizeGabaritySession(chatId) {
  const session = gabaritySessions.get(chatId);
  if (!session) return;
  clearGabarityTimers(session);
  gabaritySessions.delete(chatId);

  try {
    if (!session.articleId) {
      await bot.sendMessage(
        chatId,
        'Не удалось распознать артикул ни на одном фото 😔 Пришли фото этикетки с артикулом ещё раз, покрупнее и почётче.'
      );
      return;
    }

    let lookup;
    try {
      lookup = findArticle(session.articleId);
    } catch (err) {
      if (err.code === 'ARTICLES_NOT_LOADED') {
        await bot.sendMessage(chatId, 'Список артикулов ещё не загружен — сначала пришли его командой /z.');
        return;
      }
      throw err;
    }

    if (!lookup) {
      await bot.sendMessage(
        chatId,
        `Артикул "${session.articleId}" не найден в загруженном списке 😔 Проверь, актуален ли файл (/z), или сверь артикул вручную.`
      );
      return;
    }

    const text = buildGabarityText({
      sku: lookup.sku,
      articleId: session.articleId,
      widthCm: session.width,
      lengthCm: session.length,
      heightCm: session.height,
      weightKg: session.weightKg,
    });

    await bot.sendMessage(chatId, text);
  } catch (err) {
    console.error('[gabarity] ошибка завершения сессии:', err.message);
    await bot.sendMessage(chatId, `Не получилось собрать результат 😔 ${err.message}`);
  }
}

// Возвращает true, если сообщение было уточнением стороны измерения и уже
// обработано (вызывающий код должен остановиться и не передавать текст
// дальше другим обработчикам).
async function handleGabarityClarification(chatId, text) {
  const session = gabaritySessions.get(chatId);
  if (!session || !session.awaitingClarification) return false;

  const answer = text.trim().toLowerCase();
  const axisMap = {
    ширина: 'width',
    ш: 'width',
    длина: 'length',
    длинна: 'length',
    д: 'length',
    высота: 'height',
    в: 'height',
  };
  const axis = axisMap[answer];

  if (!axis) {
    await bot.sendMessage(chatId, 'Не понял ответ — напиши одно слово: ширина, длина или высота.');
    return true;
  }

  if (session[axis] == null) {
    session[axis] = session.awaitingClarification.valueCm;
  }
  session.awaitingClarification = null;

  maybeAdvanceGabaritySession(chatId);
  return true;
}

bot.onText(/^\/габариты(?:@\S+)?$/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    'Помогаю поправить габариты товара для Ozon 📦\n\n' +
      '1) Если ещё не загружала список артикулов — пришли его командой /z (.csv или .xlsx, колонки Артикул, SKU, Название).\n\n' +
      '2) Дальше просто присылай фото товара: этикетка с артикулом и линейка (см), и по желанию — фото весов (кг). Можно одним фото, если видно всё сразу, можно несколькими подряд (у тебя есть ~2 минуты между фото) — я сам соберу данные и пришлю готовый текст для техподдержки Ozon.'
  );
});

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;

  if (!gabarityConfigured) {
    await bot.sendMessage(chatId, 'Распознавание фото пока не настроено (нет ANTHROPIC_API_KEY) 😔');
    return;
  }

  let session = gabaritySessions.get(chatId);
  const isNewSession = !session;
  if (!session) {
    session = {
      pending: 0,
      articleId: null,
      width: null,
      length: null,
      height: null,
      weightKg: null,
      awaitingClarification: null,
      debounceTimer: null,
      maxTimer: null,
    };
    gabaritySessions.set(chatId, session);
    session.maxTimer = setTimeout(() => finalizeGabaritySession(chatId), GABARITY_MAX_MS);
  }

  if (session.debounceTimer) {
    clearTimeout(session.debounceTimer);
    session.debounceTimer = null;
  }
  session.pending += 1;

  if (isNewSession) {
    bot
      .sendMessage(
        chatId,
        '🔍 Вижу фото, распознаю... Если это не всё — пришли остальные фото (этикетка+линейка, весы) в течение пары минут, я сам соберу данные вместе.'
      )
      .catch(() => {});
  }

  try {
    const photos = msg.photo;
    const best = photos[photos.length - 1];
    const fileLink = await bot.getFileLink(best.file_id);
    const response = await fetch(fileLink);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const result = await analyzePhoto(buffer);
    const unknowns = mergeGabarityResult(session, result);

    if (unknowns.length > 0 && !session.awaitingClarification) {
      session.awaitingClarification = { valueCm: unknowns[0] };
      await bot.sendMessage(
        chatId,
        `На фото вижу измерение ${unknowns[0]} см, но не могу понять, это ширина, длина или высота — уточни, пожалуйста, одним словом (ширина / длина / высота).`
      );
    }
  } catch (err) {
    console.error('[gabarity] ошибка обработки фото:', err.message);
    await bot.sendMessage(chatId, 'Не получилось обработать это фото 😔 Попробуй переслать его ещё раз.');
  } finally {
    session.pending -= 1;
    maybeAdvanceGabaritySession(chatId);
  }
});

// ===== Загрузка списка артикулов (/z) =====
// Файл можно прислать как есть с подписью-командой, либо сначала отправить
// команду, а файл — следующим сообщением (ждём до ARTICLES_UPLOAD_WAIT_MS).
const pendingArticlesUpload = new Map();
const ARTICLES_UPLOAD_WAIT_MS = 5 * 60 * 1000;

async function processArticlesDocument(chatId, document) {
  const fileName = document.file_name || '';
  if (!/\.(csv|xlsx|xls)$/i.test(fileName)) {
    await bot.sendMessage(chatId, 'Нужен файл в формате .csv, .xlsx или .xls с колонками Артикул, SKU, Название.');
    return;
  }

  try {
    const fileLink = await bot.getFileLink(document.file_id);
    const response = await fetch(fileLink);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const count = saveArticlesFile(buffer);
    await bot.sendMessage(chatId, `✅ Загружено артикулов: ${count}. Список сохранён и заменил предыдущий.`);
  } catch (err) {
    console.error('[gabarity] ошибка загрузки списка артикулов:', err.message);
    await bot.sendMessage(chatId, `Не получилось загрузить файл 😔 ${err.message}`);
  }
}

// bot.onText матчится только против msg.text — у сообщения с документом
// текста нет (только caption, если он есть), поэтому вариант "команда
// подписью к файлу" целиком обрабатывается ниже в bot.on('document', ...).
bot.onText(/^\/z(?:@\S+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  pendingArticlesUpload.set(chatId, Date.now());
  await bot.sendMessage(
    chatId,
    'Пришли файл со списком артикулов (.csv или .xlsx) — колонки Артикул, SKU, Название. Новый файл заменит предыдущий.'
  );
});

bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const caption = (msg.caption || '').trim();
  const isUploadCommand = /^\/z(?:@\S+)?$/.test(caption);
  const waitingSince = pendingArticlesUpload.get(chatId);

  if (!isUploadCommand && !waitingSince) return;

  pendingArticlesUpload.delete(chatId);

  if (!isUploadCommand && Date.now() - waitingSince > ARTICLES_UPLOAD_WAIT_MS) {
    await bot.sendMessage(chatId, 'Слишком долго ждал файл — отправь команду /z заново.');
    return;
  }

  await processArticlesDocument(chatId, msg.document);
});

bot.on('polling_error', (err) => {
  console.error('Ошибка polling:', err.message);
});
