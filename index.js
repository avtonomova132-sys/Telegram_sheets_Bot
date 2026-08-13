const path = require('path');
const express = require('express');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const { OpenAI, toFile } = require('openai');
const { generateWeeklyReport, generateCheckReport, chunkMessage } = require('./report');
const { generateVerseImageBuffer } = require('./verse/generateVerseImage');
const { getNextVerseNumber, setLastSent, ensureProgressSeeded, applyForceOverride } = require('./verse/progress');
const { extractPeredachi } = require('./peredachi/extract');
const { addRecords, readAll: readPeredachi, saveAll: savePeredachi } = require('./peredachi/store');
const { formatKursOverview, formatKursDetail, formatMeditations } = require('./peredachi/query');
const { analyzeDuplicates } = require('./peredachi/dedupe');
const { validateEntry, describeEntry } = require('./peredachi/validate');
const { analyzeSplits } = require('./peredachi/split');
const {
  readGroupLinks,
  setGroupLink,
  ensureGroupLinksSeeded,
  resolveInviteLink,
} = require('./peredachi/groupLinks');

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

  if (myChatId && String(chatId) !== String(myChatId)) {
    await bot.sendMessage(chatId, 'Эта команда доступна только администратору.');
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

  if (myChatId && String(chatId) !== String(myChatId)) {
    await bot.sendMessage(chatId, 'Эта команда доступна только администратору.');
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

  if (myChatId && String(chatId) !== String(myChatId)) {
    await bot.sendMessage(chatId, 'Эта команда доступна только администратору.');
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

bot.on('polling_error', (err) => {
  console.error('Ошибка polling:', err.message);
});
