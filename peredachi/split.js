// Записи, сохранённые до того, как extract.js стал разбивать "Занятие N +
// Медитация M" на две записи — их zanyatie содержит упоминания обоих сразу.
function isCombinedRecord(record) {
  const text = String((record && record.zanyatie) || '');
  return /занятие/i.test(text) && /медитаци/i.test(text);
}

// Делит текст zanyatie на часть про занятие и часть про медитацию, независимо
// от порядка ("Занятие 2 + Медитация 1" или "Медитация 1 + Занятие 2").
// Возвращает null, если не удалось уверенно разделить — тогда запись нужно
// разобрать вручную, а не гадать.
function splitZanyatie(zanyatie) {
  const text = String(zanyatie || '');
  const zIdx = text.search(/занятие/i);
  const mIdx = text.search(/медитаци/i);
  if (zIdx === -1 || mIdx === -1) return null;

  const zanyatieFirst = zIdx < mIdx;
  const firstIdx = zanyatieFirst ? zIdx : mIdx;
  const secondIdx = zanyatieFirst ? mIdx : zIdx;

  // \b не работает надёжно на кириллице в JS-регулярках (не считает
  // кириллические буквы "словесными"), поэтому обрезаем висячий разделитель
  // через явную границу — начало строки или пробел перед ним.
  let firstPart = text
    .slice(firstIdx, secondIdx)
    .trim()
    .replace(/[+,;]\s*$/, '')
    .trim()
    .replace(/(^|\s)и$/i, '')
    .trim();
  const secondPart = text.slice(secondIdx).trim();

  if (!firstPart || !secondPart) return null;

  // Защита от лишнего совпадения посреди фразы (например, "Занятие 2
  // (обсуждение практики медитации)" — тут "медитации" просто слово в
  // описании занятия, а не отдельное событие). Разрезание по границе слов
  // не должно оставлять несбалансированные скобки ни в одной из половин.
  const balanced = (s) => (s.match(/\(/g) || []).length === (s.match(/\)/g) || []).length;
  if (!balanced(firstPart) || !balanced(secondPart)) return null;

  return zanyatieFirst
    ? { zanyatiePart: firstPart, meditationPart: secondPart }
    : { zanyatiePart: secondPart, meditationPart: firstPart };
}

// Делит одну объединённую запись на две — с сохранёнными общими полями
// (дата/время/ссылки/учитель) и разными kurs/zanyatie. Возвращает null,
// если zanyatie не удалось уверенно разделить.
function splitRecord(record) {
  const parsed = splitZanyatie(record.zanyatie);
  if (!parsed) return null;

  const shared = {
    dateISO: record.dateISO,
    timeMSK: record.timeMSK,
    zoomLink: record.zoomLink,
    groupLink: record.groupLink,
    teacher: record.teacher,
    postfix: record.postfix,
    addedAt: record.addedAt,
    rawText: record.rawText,
  };

  return [
    { id: `${record.id}-z`, ...shared, kurs: record.kurs, zanyatie: parsed.zanyatiePart },
    { id: `${record.id}-m`, ...shared, kurs: 'медитация', zanyatie: parsed.meditationPart },
  ];
}

// Проходит по всем записям и находит комбинированные: те, что удалось
// уверенно разделить, идут в splittable, остальные — в unresolved (их нужно
// разобрать вручную).
function analyzeSplits(records) {
  const splittable = [];
  const unresolved = [];

  for (const record of records) {
    if (!isCombinedRecord(record)) continue;
    const parts = splitRecord(record);
    if (parts) {
      splittable.push({ original: record, parts });
    } else {
      unresolved.push(record);
    }
  }

  return { splittable, unresolved };
}

module.exports = { isCombinedRecord, splitZanyatie, splitRecord, analyzeSplits };
