const { getPrinciple } = require('./principles');

// Префикс callback_data для кнопок выбора принципа в /дневник_день и в
// вечернем автосписке — единое место, чтобы index.js (кнопки) и обработчик
// нажатий ссылались на одну и ту же строку.
const SELECT_CALLBACK_PREFIX = 'dnevnik_select:';

// Сколько примеров показывать в компактных местах (уведомление о слоте,
// список пропущенного) — полный список в разы длиннее и годится только для
// отдельной карточки принципа (buildPrincipleDetail), открытой по кнопке.
const PREVIEW_EXAMPLES_COUNT = 4;

function formatExamples(examples) {
  return examples.map((e) => `   • ${e}`).join('\n');
}

function buildSlotMessage(principle, slotIndex) {
  return (
    `📿 Дневник ${slotIndex}/6 — Принцип №${principle.number} (${principle.category}): ${principle.title}\n\n` +
    `❌ ${principle.negative}\n${formatExamples(principle.negativeExamples.slice(0, PREVIEW_EXAMPLES_COUNT))}\n\n` +
    `✅ ${principle.positive}\n${formatExamples(principle.positiveExamples.slice(0, PREVIEW_EXAMPLES_COUNT))}\n\n` +
    `Что сейчас происходит по этому принципу? Напиши или надиктуй голосом — отвечу прямо сюда.\n\n` +
    `(если сейчас не момент — не страшно, через 30 минут окно закроется само, вечером соберу список пропущенного)`
  );
}

function buildPlusConfirmation(principle, parsed) {
  return (
    `✅ Принцип №${principle.number} (${principle.category}): ${principle.title} — плюс\n\n` +
    `${parsed.text}\n\n` +
    `🙏 Посвящение: ${parsed.posvyashenie}`
  );
}

function buildMinusConfirmation(principle, parsed) {
  return (
    `❌ Принцип №${principle.number} (${principle.category}): ${principle.title} — минус\n\n` +
    `1️⃣ Опора: ${parsed.opora}\n` +
    `2️⃣ Сожаление: ${parsed.sozhalenie}\n` +
    `3️⃣ Антидот: ${parsed.antidot}\n` +
    `4️⃣ Решение: ${parsed.reshenie}`
  );
}

// Компактный блок для ещё не отвеченного принципа (в текстовых списках) —
// с примерами, но усечённо (см. PREVIEW_EXAMPLES_COUNT).
function buildUnansweredBlock(entry) {
  const principle = getPrinciple(entry.principleNumber);
  return (
    `⏳ №${entry.principleNumber} (${principle.category}): ${principle.title}\n` +
    `❌ ${principle.negative}\n${formatExamples(principle.negativeExamples.slice(0, PREVIEW_EXAMPLES_COUNT))}\n` +
    `✅ ${principle.positive}\n${formatExamples(principle.positiveExamples.slice(0, PREVIEW_EXAMPLES_COUNT))}`
  );
}

// Полная карточка принципа — открывается по нажатию кнопки. Весь список
// примеров, как в оригинальных карточках Gold Клуб, без усечения.
function buildPrincipleDetail(principle) {
  return (
    `📖 Принцип №${principle.number} (${principle.category}): ${principle.title}\n\n` +
    `❌ ${principle.negative}\n${formatExamples(principle.negativeExamples)}\n\n` +
    `✅ ${principle.positive}\n${formatExamples(principle.positiveExamples)}\n\n` +
    `Расскажи, что было сегодня по этому принципу — я жду именно этот ответ, ничего разбирать не нужно называть отдельно.`
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
  const marker = entry.type === 'plus' ? '✅' : '❌';
  const preview = entry.type === 'plus' ? entry.text : entry.sozhalenie;
  return `${marker} ${entry.dateBali} ${time} — принцип №${entry.principleNumber}${categoryTag}: ${preview || ''}`;
}

function buildDnevnikSummary(recentEntries, pendingCount) {
  if (recentEntries.length === 0) {
    return 'Пока нет ни одной записи в шестиразовом дневнике.';
  }
  const lines = recentEntries.map(buildEntryLine);
  const pendingNote = pendingCount > 0 ? `\n\n⏳ Ждёт ответа прямо сейчас: ${pendingCount}` : '';
  return `📿 Шестиразовый дневник — последние записи:\n\n${lines.join('\n')}${pendingNote}`;
}

// Вечерний список пропущенных за день слотов (окно 30 минут истекло без
// ответа). Elena отвечает одним сообщением, называя номера принципов —
// текст каждого принципа сразу тут же, чтобы не искать отдельно.
function buildMissedListMessage(missedEntries) {
  const blocks = missedEntries
    .slice()
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .map(buildUnansweredBlock);
  return (
    `🌙 Вечерний обзор — сегодня пропущено (в моменте не ответили):\n\n${blocks.join('\n\n')}\n\n` +
    `Одним сообщением, текстом или голосом, расскажи, что было по каждому — просто называй номер принципа перед тем, что расскажешь. То, что не назовёшь, — не страшно, просто останется пропущенным сегодня.`
  );
}

// Подтверждение после вечернего пакетного разбора — блок на каждый принцип,
// который реально был затронут в её ответе.
function buildEveningBatchConfirmation(results) {
  const blocks = results.map((r) => {
    const principle = getPrinciple(r.principleNumber);
    if (r.type === 'plus') {
      return buildPlusConfirmation(principle, r);
    }
    return buildMinusConfirmation(principle, r);
  });
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
    const principle = getPrinciple(entry.principleNumber);
    if (entry.type === 'plus') {
      return buildPlusConfirmation(principle, entry);
    }
    return buildMinusConfirmation(principle, entry);
  });

  return `📿 Шестиразовый дневник — ${dateBali}\n\n${blocks.join('\n\n〜〜〜\n\n')}`;
}

module.exports = {
  buildSlotMessage,
  buildPlusConfirmation,
  buildMinusConfirmation,
  buildDnevnikSummary,
  buildMissedListMessage,
  buildEveningBatchConfirmation,
  buildDayReport,
  buildPrincipleDetail,
  buildUnansweredKeyboard,
  SELECT_CALLBACK_PREFIX,
};
