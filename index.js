const path = require('path');
const express = require('express');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const { OpenAI, toFile } = require('openai');
const { generateWeeklyReport, generateCheckReport, chunkMessage } = require('./report');
const { generateVerseImageBuffer } = require('./verse/generateVerseImage');
const { getNextVerseNumber, setLastSent, ensureProgressSeeded, applyForceOverride } = require('./verse/progress');
const { extractPeredachi } = require('./peredachi/extract');
const { addRecords, readAll: readPeredachi } = require('./peredachi/store');
const { formatPeredachiReply } = require('./peredachi/query');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`HTTP-сервер запущен на порту ${port}`));

const token = process.env.BOT_TOKEN;
const openaiKey = process.env.OPENAI_API_KEY;
const myChatId = process.env.MY_CHAT_ID;

if (!token) {
  console.error('BOT_TOKEN не задан! Добавьте переменную окружения BOT_TOKEN.');
  process.exit(1);
}

if (!myChatId) {
  console.warn('MY_CHAT_ID не задан — ежедневная отправка изречений отключена.');
}

ensureProgressSeeded();
applyForceOverride();

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

// Ежедневная отправка следующего изречения в 6:00 по Бали (Asia/Makassar, UTC+8, без DST).
if (myChatId) {
  cron.schedule(
    '0 6 * * *',
    async () => {
      const next = getNextVerseNumber();
      if (next === null) return; // изречения в verses.json закончились — ничего не отправляем

      try {
        await sendVerseImage(myChatId, next);
        setLastSent(next);
      } catch (err) {
        console.error('Ошибка ежедневной отправки изречения:', err.message);
      }
    },
    { timezone: 'Asia/Makassar' }
  );
}

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

bot.onText(/^\/передачи(?:@\S+)?(?:\s+(\S+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const kursArg = match[1] ? match[1].trim() : null;

  try {
    const all = readPeredachi();
    const reply = formatPeredachiReply(all, kursArg);
    await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[peredachi] ошибка формирования списка передач:', err.message);
    await bot.sendMessage(chatId, 'Не получилось получить список передач 😔');
  }
});

bot.on('polling_error', (err) => {
  console.error('Ошибка polling:', err.message);
});
