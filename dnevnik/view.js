function buildSlotMessage(principle, slotIndex) {
  return (
    `📿 Дневник ${slotIndex}/6 — Принцип №${principle.number} (${principle.category})\n\n` +
    `❌ ${principle.negative}\n` +
    `✅ ${principle.positive}\n\n` +
    `Что сейчас происходит по этому принципу? Напиши или надиктуй голосом — отвечу прямо сюда.`
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
  const pendingNote = pendingCount > 0 ? `\n\n⏳ Неотвеченных записей: ${pendingCount}` : '';
  return `📿 Шестиразовый дневник — последние записи:\n\n${lines.join('\n')}${pendingNote}`;
}

module.exports = { buildSlotMessage, buildPlusConfirmation, buildMinusConfirmation, buildDnevnikSummary };
