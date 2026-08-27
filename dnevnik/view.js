const { getPrinciple } = require('./principles');

function buildSlotMessage(principle, slotIndex) {
  return (
    `📿 Дневник ${slotIndex}/6 — Принцип №${principle.number} (${principle.category})\n\n` +
    `❌ ${principle.negative}\n` +
    `✅ ${principle.positive}\n\n` +
    `Что сейчас происходит по этому принципу? Напиши или надиктуй голосом — отвечу прямо сюда.\n\n` +
    `(если сейчас не момент — не страшно, через 30 минут окно закроется само, вечером соберу список пропущенного)`
  );
}

function buildPlusConfirmation(principle, parsed) {
  return (
    `✅ Принцип №${principle.number} — плюс\n\n` +
    `${parsed.text}\n\n` +
    `🙏 Посвящение: ${parsed.posvyashenie}`
  );
}

function buildMinusConfirmation(principle, parsed) {
  return (
    `❌ Принцип №${principle.number} — минус\n\n` +
    `1️⃣ Опора: ${parsed.opora}\n` +
    `2️⃣ Сожаление: ${parsed.sozhalenie}\n` +
    `3️⃣ Антидот: ${parsed.antidot}\n` +
    `4️⃣ Решение: ${parsed.reshenie}`
  );
}

function buildEntryLine(entry) {
  const time = entry.sentAt ? entry.sentAt.slice(11, 16) : '--:--';
  if (!entry.answeredAt) {
    return `⏳ ${entry.dateBali} ${time} — принцип №${entry.principleNumber} (ещё не отвечено)`;
  }
  const marker = entry.type === 'plus' ? '✅' : '❌';
  const preview = entry.type === 'plus' ? entry.text : entry.sozhalenie;
  return `${marker} ${entry.dateBali} ${time} — принцип №${entry.principleNumber}: ${preview || ''}`;
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
// ответа). Elena отвечает одним сообщением, называя номера принципов.
function buildMissedListMessage(missedEntries) {
  const lines = missedEntries
    .slice()
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .map((entry) => {
      const principle = getPrinciple(entry.principleNumber);
      return `№${entry.principleNumber} (${principle.category}) — ${principle.positive}`;
    });
  return (
    `🌙 Вечерний обзор — сегодня пропущено (в моменте не ответили):\n\n${lines.join('\n')}\n\n` +
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
// здесь полный разбор каждого пункта, как в обычных подтверждениях.
function buildDayReport(dateBali, entries) {
  if (entries.length === 0) {
    return `📿 Шестиразовый дневник — ${dateBali}\n\nПока сегодня записей нет.`;
  }

  const blocks = entries.map((entry) => {
    const principle = getPrinciple(entry.principleNumber);
    if (!entry.answeredAt) {
      return `⏳ №${entry.principleNumber} (${principle.category}) — ещё не отвечено`;
    }
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
};
