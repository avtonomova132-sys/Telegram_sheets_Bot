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
const { formatKursOverview, formatKursDetail, formatMeditations } = require('./peredachi/query');
const { analyzeDuplicates, isSameEvent } = require('./peredachi/dedupe');
const { validateEntry, describeEntry } = require('./peredachi/validate');
const { analyzeSplits } = require('./peredachi/split');
const { getWatchedGroupIds, looksLikeAnnouncement } = require('./peredachi/watch');
const {
  readGroupLinks,
  setGroupLink,
  ensureGroupLinksSeeded,
  resolveInviteLink,
} = require('./peredachi/groupLinks');
const { checkReminders, formatReminderMessage } = require('./peredachi/reminders');
const { extractEvent } = require('./events/extract');
const { validateEvent } = require('./events/validate');
const { fillTimezones } = require('./events/timezone');
const { buildConfirmationText } = require('./events/format');
const { readAll: readEvents, addEvent } = require('./events/store');
const { analyzePhoto, isConfigured: gabarityConfigured } = require('./gabarity/extract');
const { saveArticlesFile, findArticle } = require('./gabarity/articles');
const { buildResultText: buildGabarityText } = require('./gabarity/format');
const { isTrustedUser } = require('./auth');

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

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    'Привет! 🙏 Я твой бот-помощник.\n\nЯ умею отвечать на сообщения, напоминать о делах (просто напиши "напомни ... в 15:00 ...") и собирать отчёты по расписанию (/weekly, /check).'
  );
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

  const reminder = parseReminder(text);
  if (reminder) {
    scheduleReminder(chatId, reminder.hours, reminder.minutes, text);
    const timeStr = `${String(reminder.hours).padStart(2, '0')}:${String(reminder.minutes).padStart(2, '0')}`;
    bot.sendMessage(chatId, `✅ Хорошо, напомню в ${timeStr} по Бали!`);
    return;
  }

  bot.sendMessage(chatId, `Я получил твоё сообщение: "${text}"\n\n(Пока я просто эхо — скоро научусь большему)`);
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

    for (const chunk of chunkMessage(text)) {
      await bot.sendMessage(chatId, chunk);
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
    for (const chunk of chunkMessage(text)) {
      await bot.sendMessage(chatId, chunk);
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
// чтобы можно было свериться с реальным результатом прямо сейчас. Не
// трогает lastRunDate, так что не мешает следующему плановому тику в 9:00.
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
// же самое напоминание второй раз.
if (myChatId) {
  cron.schedule('* * * * *', async () => {
    try {
      const due = checkReminders();
      for (const record of due) {
        await bot.sendMessage(myChatId, formatReminderMessage(record));
      }
    } catch (err) {
      console.error('[reminders] ошибка проверки напоминаний:', err.message);
    }
  });
}

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
      const { added, updated, skipped } = addRecords(validEntries, rawText);
      if (added.length > 0) {
        blocks.push(`✅ Добавлено новых: ${added.length}\n${added.map(describe).join('\n')}`);
      }
      if (updated.length > 0) {
        blocks.push(`🔄 Обновлено (дополнены данными): ${updated.length}\n${updated.map(describe).join('\n')}`);
      }
      if (skipped.length > 0) {
        blocks.push(`✅ Уже было в расписании: ${skipped.length}\n${skipped.map(describe).join('\n')}`);
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
    await bot.sendMessage(chatId, formatKursOverview(all), { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[peredachi] ошибка формирования списка курсов:', err.message);
    await bot.sendMessage(chatId, 'Не получилось получить список передач 😔');
  }
});

bot.onText(/^\/курс([1-6])(?:@\S+)?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const kursNumber = match[1];

  try {
    const all = readPeredachi();
    await bot.sendMessage(chatId, formatKursDetail(all, kursNumber), { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[peredachi] ошибка формирования списка по курсу:', err.message);
    await bot.sendMessage(chatId, 'Не получилось получить список передач 😔');
  }
});

bot.onText(/^\/медитаци[яи](?:@\S+)?$/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const all = readPeredachi();
    await bot.sendMessage(chatId, formatMeditations(all), { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[peredachi] ошибка формирования списка медитаций:', err.message);
    await bot.sendMessage(chatId, 'Не получилось получить список медитаций 😔');
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
