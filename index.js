const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const os = require('os');

const token = process.env.BOT_TOKEN;
const openaiKey = process.env.OPENAI_API_KEY;

if (!token) {
  console.error('BOT_TOKEN не задан! Добавьте переменную окружения BOT_TOKEN.');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const openai = openaiKey ? new OpenAI({ apiKey: openaiKey, maxRetries: 5, timeout: 30000 }) : null;

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

bot.on('voice', async (msg) => {
  const chatId = msg.chat.id;

  if (!openai) {
    bot.sendMessage(chatId, 'Распознавание голоса пока не настроено 😔');
    return;
  }

  let tempPath;
  try {
    bot.sendMessage(chatId, 'Слушаю... 🎧');

    const fileId = msg.voice.file_id;
    const fileLink = await bot.getFileLink(fileId);

    const response = await fetch(fileLink);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    tempPath = path.join(os.tmpdir(), `voice_${Date.now()}.ogg`);
    fs.writeFileSync(tempPath, buffer);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: 'whisper-1',
      language: 'ru',
    });

    bot.sendMessage(chatId, `Я услышал:\n\n"${transcription.text}"\n\n(Пока просто показываю распознанный текст — скоро научусь красиво его оформлять)`);
  } catch (err) {
    console.error('Ошибка распознавания голоса:', err.message);
    console.error('Детали:', err.cause || err.code || err.name || 'нет доп. деталей');
    console.error('Полный стек:', err.stack);
    bot.sendMessage(chatId, 'Не получилось распознать голос 😔 Попробуй ещё раз.');
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
});

bot.on('polling_error', (err) => {
  console.error('Ошибка polling:', err.message);
});
