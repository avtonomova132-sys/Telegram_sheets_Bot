const TelegramBot = require('node-telegram-bot-api');
const { OpenAI, toFile } = require('openai');
const { generateWeeklyReport, generateCheckReport, chunkMessage } = require('./report');
const { extractPeredachi } = require('./peredachi/extract');
const { addRecords, readAll: readPeredachi } = require('./peredachi/store');
const { formatPeredachiReply, formatMeditationsReply } = require('./peredachi/query');

const token = process.env.BOT_TOKEN;
const openaiKey = process.env.OPENAI_API_KEY;

if (!token) {
  console.error('BOT_TOKEN не задан! Добавьте переменную окружения BOT_TOKEN.');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const openai = openaiKey ? new OpenAI({ apiKey: openaiKey, maxRetries: 0, timeout: 60000 }) : null;

console.log('Бот запущен и слушает сообщения...');

const HELP_TEXT =
  'Привет! 🙏 Я твой бот-помощник.\n\n' +
  'Я умею отвечать на сообщения, напоминать о делах (просто напиши "напомни ... в 15:00 ...") и собирать отчёты по расписанию (/weekly, /check).\n\n' +
  'Команды:\n' +
  '/menu — главное меню с кнопками\n' +
  '/vhouses — курсы «Пять домов»\n' +
  '/weekly — расписание хостинга (полный обзор недели)\n' +
  '/check — проверка по текущей неделе\n' +
  '/передачи [курс] — ближайшие передачи\n' +
  '/добавить — добавить передачу вручную\n' +
  '/help — эта справка';

const REMINDERS_INFO_TEXT =
  '🔔 Напоминания\n\n' +
  'Чтобы поставить напоминание, просто напиши сообщение в формате:\n' +
  '"напомни <текст> в 15:00"\n\n' +
  'Я напомню в указанное время (по Бали).';

// TODO: подключить реальный источник стихов Уттаратантры — пока такой
// функции/данных в проекте нет, отдаём заглушку вместо выдуманного текста.
function getVerseOfDayText() {
  return '📖 Стих дня (Уттаратантра)\n\nФункция в разработке — скоро здесь будет ежедневный стих с комментарием.';
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, HELP_TEXT);
});

bot.onText(/^\/help(?:@\S+)?$/, (msg) => {
  bot.sendMessage(msg.chat.id, HELP_TEXT);
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

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;

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

// ===== Прямые передачи курсов "Пять домов" =====
bot.onText(/^\/добавить(?:@\S+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
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

    const saved = addRecords(entries, rawText);
    const lines = saved.map((r) => {
      const kursLabel = r.postfix ? `${r.kurs} (${r.postfix})` : r.kurs || '?';
      const dateLabel = r.dateISO || 'дата неизвестна';
      const timeLabel = r.timeMSK ? `, ${r.timeMSK} МСК` : '';
      return `• Курс ${kursLabel} — ${dateLabel}${timeLabel}`;
    });

    await bot.sendMessage(chatId, `✅ Добавлено записей: ${saved.length}\n\n${lines.join('\n')}`);
  } catch (err) {
    console.error('[peredachi] ошибка распознавания/сохранения:', err.message);
    await bot.sendMessage(
      chatId,
      'Не смог распознать 😔 Попробуй переслать текст ещё раз или добавь вручную командой /добавить_вручную.'
    );
  }
});

async function sendPeredachiReply(chatId, kursArg) {
  try {
    const all = readPeredachi();
    const reply = formatPeredachiReply(all, kursArg);
    await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[peredachi] ошибка формирования списка передач:', err.message);
    await bot.sendMessage(chatId, 'Не получилось получить список передач 😔');
  }
}

async function sendMeditationsReply(chatId) {
  try {
    const all = readPeredachi();
    const reply = formatMeditationsReply(all);
    await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[peredachi] ошибка формирования списка медитаций:', err.message);
    await bot.sendMessage(chatId, 'Не получилось получить список медитаций 😔');
  }
}

bot.onText(/^\/передачи(?:@\S+)?(?:\s+(\S+))?$/, (msg, match) => {
  sendPeredachiReply(msg.chat.id, match[1] ? match[1].trim() : null);
});

// /курс1 .. /курс6 — то же самое, что /передачи <N>, просто короче набирать.
for (let n = 1; n <= 6; n++) {
  bot.onText(new RegExp(`^/курс${n}(?:@\\S+)?$`), (msg) => {
    sendPeredachiReply(msg.chat.id, String(n));
  });
}

bot.onText(/^\/медитации(?:@\S+)?$/, (msg) => {
  sendMeditationsReply(msg.chat.id);
});

bot.onText(/^\/стих(?:@\S+)?$/, (msg) => {
  bot.sendMessage(msg.chat.id, getVerseOfDayText());
});

bot.onText(/^\/напоминания(?:@\S+)?$/, (msg) => {
  bot.sendMessage(msg.chat.id, REMINDERS_INFO_TEXT);
});

// ===== Inline-меню =====
function mainMenuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📅 Расписание хостинга', callback_data: 'menu:weekly' }],
        [{ text: '📖 Стих дня', callback_data: 'menu:verse' }],
        [{ text: '🏠 Пять домов', callback_data: 'menu:vhouses' }],
        [{ text: '🔔 Напоминания', callback_data: 'menu:reminders' }],
        [{ text: 'ℹ️ Помощь', callback_data: 'menu:help' }],
      ],
    },
  };
}

function vhousesKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Курс 1', callback_data: 'vhouses:kurs:1' },
          { text: 'Курс 2', callback_data: 'vhouses:kurs:2' },
        ],
        [
          { text: 'Курс 3', callback_data: 'vhouses:kurs:3' },
          { text: 'Курс 4', callback_data: 'vhouses:kurs:4' },
        ],
        [
          { text: 'Курс 5', callback_data: 'vhouses:kurs:5' },
          { text: 'Курс 6', callback_data: 'vhouses:kurs:6' },
        ],
        [{ text: '🧘 Медитации', callback_data: 'vhouses:meditations' }],
      ],
    },
  };
}

bot.onText(/^\/menu(?:@\S+)?$/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Главное меню 👇', mainMenuKeyboard());
});

bot.onText(/^\/vhouses(?:@\S+)?$/, (msg) => {
  bot.sendMessage(msg.chat.id, '🏠 Пять домов — выбери курс:', vhousesKeyboard());
});

bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat.id;
  const data = query.data || '';

  try {
    if (chatId) {
      if (data === 'menu:weekly') {
        await handleReportCommand(chatId, 'полный обзор недели', generateWeeklyReport);
      } else if (data === 'menu:verse') {
        await bot.sendMessage(chatId, getVerseOfDayText());
      } else if (data === 'menu:vhouses') {
        await bot.sendMessage(chatId, '🏠 Пять домов — выбери курс:', vhousesKeyboard());
      } else if (data === 'menu:reminders') {
        await bot.sendMessage(chatId, REMINDERS_INFO_TEXT);
      } else if (data === 'menu:help') {
        await bot.sendMessage(chatId, HELP_TEXT);
      } else if (data.startsWith('vhouses:kurs:')) {
        await sendPeredachiReply(chatId, data.slice('vhouses:kurs:'.length));
      } else if (data === 'vhouses:meditations') {
        await sendMeditationsReply(chatId);
      }
    }
  } catch (err) {
    console.error('Ошибка обработки callback_query:', err.message);
  } finally {
    bot.answerCallbackQuery(query.id).catch((err) => {
      console.error('Ошибка answerCallbackQuery:', err.message);
    });
  }
});

bot.on('polling_error', (err) => {
  console.error('Ошибка polling:', err.message);
});
