const { getPrinciple } = require('./principles');

// Префикс callback_data для кнопок выбора принципа в /дневник_день и в
// вечернем автосписке — единое место, чтобы index.js (кнопки) и обработчик
// нажатий ссылались на одну и ту же строку.
const SELECT_CALLBACK_PREFIX = 'dnevnik_select:';

// Elena попробовала кураторские 4-5 примеров и решила вернуть ПОЛНЫЙ
// список даже в компактных местах (уведомление о слоте, список
// пропущенного) — насмотренность и сам процесс пролистывания глазами
// весь список тоже часть момента осознанности. Кураторские
// previewNegative/previewPositive остаются в principles.js на случай, если
// понадобится вернуться к короткому варианту — эти функции просто их не
// используют сейчас.
function previewNegative(principle) {
  return principle.negativeExamples;
}

function previewPositive(principle) {
  return principle.positiveExamples;
}

function formatExamples(examples) {
  return examples.map((e) => `   • ${e}`).join('\n');
}

// На случай, если модель пропустит какое-то поле (бывает редко, но
// случается) — подстраховка от буквального "undefined" в сообщении.
function safe(value, fallback = '(не указано)') {
  return value === undefined || value === null || value === '' ? fallback : value;
}

function buildOneMoment(moment, index, total, isPlus) {
  const symbol = isPlus ? '➕' : '➖';
  const word = isPlus ? 'Плюс' : 'Минус';
  const label = total > 1 ? `${symbol} ${word} ${index + 1}` : `${symbol} ${word}`;
  if (isPlus) {
    return `${label}\n${safe(moment.text)}\n😊 ${safe(moment.radost)}\n🙏 Посвящение: ${safe(moment.posvyashenie)}`;
  }
  return (
    `${label}\n` +
    `1️⃣ Опора: ${safe(moment.opora)}\n` +
    `2️⃣ Сожаление: ${safe(moment.sozhalenie)}\n` +
    `3️⃣ Антидот: ${safe(moment.antidot)}\n` +
    `4️⃣ Решение: ${safe(moment.reshenie)}`
  );
}

// Достаёт pluses/minuses из записи, с фолбэком на старый плоский формат
// (до перехода на массивы) — общая логика для полной и краткой карточки.
function extractMoments(entryLike) {
  let pluses = entryLike.pluses || [];
  let minuses = entryLike.minuses || [];

  if (pluses.length === 0 && minuses.length === 0 && entryLike.type) {
    if (entryLike.type === 'plus') {
      pluses = [{ text: entryLike.text, radost: entryLike.radost, posvyashenie: entryLike.posvyashenie }];
    } else if (entryLike.type === 'minus') {
      minuses = [{ opora: entryLike.opora, sozhalenie: entryLike.sozhalenie, antidot: entryLike.antidot, reshenie: entryLike.reshenie }];
    }
  }

  return { pluses, minuses };
}

// Одна карточка принципа со ВСЕМИ ситуациями, которые под ним записаны —
// может быть несколько плюсов и/или несколько минусов за один принцип,
// ничего не сжимается в один. entry/result — объект с полями pluses[],
// minuses[] (см. dnevnik/store.js). Elena: обе стороны (➕/➖) должны быть
// видны ВСЕГДА, даже если по одной из них сегодня ничего не было — тогда
// прямо пишем "не наблюдался", чтобы было видно, что про обе подумали.
function buildPrincipleResult(principle, entryLike) {
  const { pluses, minuses } = extractMoments(entryLike);

  const header = `📿 Принцип №${principle.number} (${principle.category}): ${principle.title}`;
  const plusBlocks = pluses.length > 0 ? pluses.map((m, i) => buildOneMoment(m, i, pluses.length, true)) : ['➕ Плюс: не наблюдался'];
  const minusBlocks = minuses.length > 0 ? minuses.map((m, i) => buildOneMoment(m, i, minuses.length, false)) : ['➖ Минус: не наблюдался'];
  const momentBlocks = [...plusBlocks, ...minusBlocks];
  return `${header}\n\n${momentBlocks.join('\n\n')}`;
}

// Краткая версия — только суть: у плюса радость + посвящение (что
// прочувствовала и чему посвятила семя), у минуса сожаление (что именно
// посеяла и почему вредно). Без text/опоры/антидота/решения — для
// пересылки партнёру по практике, чтобы можно было реально прочитать за
// минуту, а не разворачивать телефон текстом на весь день. Полная версия
// (buildPrincipleResult/buildDayReport) остаётся для собственной, подробной
// рефлексии.
function buildPrincipleResultShort(principle, entryLike) {
  const { pluses, minuses } = extractMoments(entryLike);
  const header = `№${principle.number} (${principle.category}): ${principle.title}`;

  const plusLines =
    pluses.length > 0
      ? pluses.map((m, i) => {
          const num = pluses.length > 1 ? ` ${i + 1}` : '';
          return `😊${num} ${safe(m.radost)}\n🙏${num} ${safe(m.posvyashenie)}`;
        })
      : ['➕ не наблюдался'];
  const minusLines =
    minuses.length > 0
      ? minuses.map((m, i) => `😔${minuses.length > 1 ? ` ${i + 1}` : ''} ${safe(m.sozhalenie)}`)
      : ['➖ не наблюдался'];

  return `${header}\n${[...plusLines, ...minusLines].join('\n')}`;
}

function buildSlotMessage(principle, slotIndex) {
  return (
    `📿 Дневник ${slotIndex}/6 — Принцип №${principle.number} (${principle.category}): ${principle.title}\n\n` +
    `❌ ${principle.negative}\n${formatExamples(previewNegative(principle))}\n\n` +
    `✅ ${principle.positive}\n${formatExamples(previewPositive(principle))}\n\n` +
    `Что сейчас происходит по этому принципу? Если ситуаций несколько — рассказывай все, ничего не потеряется. Напиши или надиктуй голосом — отвечу прямо сюда.\n\n` +
    `(если сейчас не момент — не страшно, окно останется живым почти до следующего слота, вечером соберу список того, что всё же не успели)`
  );
}

// Компактный блок для ещё не отвеченного принципа (в текстовых списках) —
// с отобранными примерами (см. previewNegative/previewPositive выше).
function buildUnansweredBlock(entry) {
  const principle = getPrinciple(entry.principleNumber);
  return (
    `⏳ №${entry.principleNumber} (${principle.category}): ${principle.title}\n` +
    `❌ ${principle.negative}\n${formatExamples(previewNegative(principle))}\n` +
    `✅ ${principle.positive}\n${formatExamples(previewPositive(principle))}`
  );
}

// Полная карточка принципа — открывается по нажатию кнопки. Весь список
// примеров, как в оригинальных карточках Gold Клуб, без усечения.
function buildPrincipleDetail(principle) {
  return (
    `📖 Принцип №${principle.number} (${principle.category}): ${principle.title}\n\n` +
    `❌ ${principle.negative}\n${formatExamples(principle.negativeExamples)}\n\n` +
    `✅ ${principle.positive}\n${formatExamples(principle.positiveExamples)}\n\n` +
    `Расскажи, что было сегодня по этому принципу — если ситуаций несколько, рассказывай все подряд, ничего называть отдельно не нужно.`
  );
}

// Кнопки для неотвеченных записей — используются и в /дневник_день, и в
// вечернем автосписке. Нажатие однозначно связывает следующий ответ с
// конкретной записью — никакого угадывания текста моделью.
function buildUnansweredKeyboard(unansweredEntries) {
  if (unansweredEntries.length === 0) return undefined;
  return {
    inline_keyboard: unansweredEntries
      .slice()
      .sort((a, b) => a.principleNumber - b.principleNumber)
      .map((entry) => {
        const principle = getPrinciple(entry.principleNumber);
        return [{ text: `№${entry.principleNumber}: ${principle.title}`, callback_data: `${SELECT_CALLBACK_PREFIX}${entry.id}` }];
      }),
  };
}

function buildEntryLine(entry) {
  const time = entry.sentAt ? entry.sentAt.slice(11, 16) : '--:--';
  const principle = getPrinciple(entry.principleNumber);
  const categoryTag = principle ? ` (${principle.category})` : '';
  if (!entry.answeredAt) {
    return `⏳ ${entry.dateBali} ${time} — принцип №${entry.principleNumber}${categoryTag} (ещё не отвечено)`;
  }
  const pluses = entry.pluses || [];
  const minuses = entry.minuses || [];
  const marker = pluses.length > 0 && minuses.length > 0 ? '✅❌' : pluses.length > 0 ? '✅' : '❌';
  const preview = pluses[0]?.text || minuses[0]?.sozhalenie || '';
  const countsNote = pluses.length + minuses.length > 1 ? ` (+${pluses.length}/−${minuses.length})` : '';
  return `${marker} ${entry.dateBali} ${time} — принцип №${entry.principleNumber}${categoryTag}${countsNote}: ${preview}`;
}

function buildDnevnikSummary(recentEntries, pendingCount) {
  if (recentEntries.length === 0) {
    return 'Пока нет ни одной записи в шестиразовом дневнике.';
  }
  const lines = recentEntries.map(buildEntryLine);
  const pendingNote = pendingCount > 0 ? `\n\n⏳ Ждёт ответа прямо сейчас: ${pendingCount}` : '';
  return `📿 Шестиразовый дневник — последние записи:\n\n${lines.join('\n')}${pendingNote}`;
}

// Вечерний список пропущенных за день слотов (окно почти до следующего
// слота истекло без ответа). Elena отвечает одним сообщением, называя
// номера принципов — текст каждого принципа сразу тут же, чтобы не искать
// отдельно.
function buildMissedListMessage(missedEntries) {
  const blocks = missedEntries
    .slice()
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .map(buildUnansweredBlock);
  return (
    `🌙 Вечерний обзор — сегодня пропущено (в моменте не ответили):\n\n${blocks.join('\n\n')}\n\n` +
    `Одним сообщением, текстом или голосом, расскажи, что было по каждому — просто называй номер принципа перед тем, что расскажешь. Если по одному принципу было несколько ситуаций — рассказывай все, ничего не потеряется. То, что не назовёшь, — не страшно, просто останется пропущенным сегодня.`
  );
}

// Подтверждение после разбора — блок на каждый принцип, который реально был
// затронут в ответе (может быть один принцип с несколькими плюсами/минусами
// внутри, может быть несколько принципов сразу).
function buildDnevnikConfirmation(results) {
  const blocks = results.map((r) => buildPrincipleResult(getPrinciple(r.principleNumber), r));
  return blocks.join('\n\n〜〜〜\n\n');
}

// Дневной отчёт — все записи конкретного дня одним текстом, чтобы можно
// было скопировать и отправить партнёру по практике (кармическому или по
// щедрости). В отличие от buildDnevnikSummary (для себя, с усечением) —
// здесь полный разбор каждого пункта, как в обычных подтверждениях, и полный
// текст принципа для ещё не отвеченных — можно сразу наговорить по нему.
function buildDayReport(dateBali, entries) {
  if (entries.length === 0) {
    return `📿 Шестиразовый дневник — ${dateBali}\n\nПока сегодня записей нет.`;
  }

  const blocks = entries.map((entry) => {
    if (!entry.answeredAt) {
      return buildUnansweredBlock(entry);
    }
    return buildPrincipleResult(getPrinciple(entry.principleNumber), entry);
  });

  return `📿 Шестиразовый дневник — ${dateBali}\n\n${blocks.join('\n\n〜〜〜\n\n')}`;
}

// Краткая версия дневного отчёта — для пересылки партнёру по практике, не
// для себя. Одна строка на принцип-заголовок + одна строка на каждый плюс
// (только посвящение) и минус (только сожаление). Неотвеченные — коротко,
// без полного списка примеров (тот уместен только в живом уведомлении).
function buildDayReportShort(dateBali, entries) {
  if (entries.length === 0) {
    return `📿 Шестиразовый дневник (кратко) — ${dateBali}\n\nПока сегодня записей нет.`;
  }

  const blocks = entries.map((entry) => {
    const principle = getPrinciple(entry.principleNumber);
    if (!entry.answeredAt) {
      return `⏳ №${entry.principleNumber} (${principle.category}): ${principle.title} — ещё не отвечено`;
    }
    return buildPrincipleResultShort(principle, entry);
  });

  return `📿 Шестиразовый дневник (кратко) — ${dateBali}\n\n${blocks.join('\n\n')}`;
}

module.exports = {
  buildSlotMessage,
  buildPrincipleResult,
  buildDnevnikConfirmation,
  buildDnevnikSummary,
  buildMissedListMessage,
  buildDayReport,
  buildDayReportShort,
  buildPrincipleDetail,
  buildUnansweredKeyboard,
  SELECT_CALLBACK_PREFIX,
};
