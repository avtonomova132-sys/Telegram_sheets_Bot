const TelegramBot = require('node-telegram-bot-api');
const { OpenAI, toFile } = require('openai');
const { generateWeeklyReport, chunkMessage } = require('./report');

const token = process.env.BOT_TOKEN;
const openaiKey = process.env.OPENAI_API_KEY;

if (!token) {
  console.error('BOT_TOKEN не задан! Добавьте переменную окружения BOT_TOKEN.');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
// maxRetries: 0 — встроенный ретрай openai-node переиспользует тот же поток
// тела multipart-запроса, а нативный fetch (undici) не даёт прочитать уже
// "потревоженный" body повторно => "Response body object should not be
// disturbed or locked". Поэтому ретраим вручную ниже, пересобирая файл
// с нуля на каждой попытке.
const openai = openaiKey ? new OpenAI({ apiKey: openaiKey, maxRetries: 0, timeout: 60000 }) : null;

console.log('Бот запущен и слушает сообщения...');

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    'Привет! 🙏 Я твой бот-помощник.\n\nПока я умею только отвечать на сообщения, но скоро научусь гораздо большему — проверять расписание, напоминать и упаковывать твои инсайты.'
  );
});

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;

  bot.sendMessage(chatId, `Я получил твоё сообщение: "${text}"\n\n(Пока я просто эхо — скоро научусь большему)`);
});

async function transcribeVoice(buffer, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // Пересобираем Uploadable на каждой попытке — переиспользовать один и
      // тот же File/поток между попытками нельзя (см. комментарий у openai клиента).
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
        err.status === undefined || // сетевая ошибка до получения ответа
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

bot.onText(/\/report/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await bot.sendMessage(chatId, 'Собираю сводку по мероприятиям на следующую неделю... 📊 Секунду.');

    const { text, totalEvents, failedTabs } = await generateWeeklyReport();

    for (const chunk of chunkMessage(text)) {
      await bot.sendMessage(chatId, chunk);
    }

    if (failedTabs.length > 0) {
      await bot.sendMessage(
        chatId,
        `⚠️ Не удалось загрузить данные из вкладок:\n${failedTabs.join('\n')}\n\nОтчёт составлен по остальным вкладкам (событий найдено: ${totalEvents}).`
      );
    }
  } catch (err) {
    console.error('Ошибка формирования отчёта:', err.message);
    console.error(err.stack);
    bot.sendMessage(chatId, `Не получилось собрать отчёт 😔 ${err.message}`);
  }
});

bot.on('polling_error', (err) => {
  console.error('Ошибка polling:', err.message);
});
