// "Одна и та же передача, но время изменилось": kurs+dateISO+groupLink
// совпадают (groupLink обязательно непустой — если его нет, нельзя быть
// уверенным, что это один и тот же поток, а не две разные записи без ссылки
// на группу), а timeMSK — разный, И zanyatie не указывает на явно другое
// событие (см. looksLikeDifferentEvent). Если groupLink разный — это
// независимые параллельные потоки, НЕ дубль. Не путать с dedupe.js: там
// kurs+dateISO+timeMSK совпадают полностью — это точные дубли, время не
// отличается.

function fieldValue(record, field) {
  return String((record && record[field]) || '').trim();
}

const MERGE_FIELDS = ['postfix', 'teacher', 'zanyatie', 'zoomLink', 'zoomCode', 'groupLink'];

function extractNumbers(text) {
  const matches = String(text || '').match(/\d+/g) || [];
  return matches.map(Number).sort((a, b) => a - b);
}

function numbersEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((n, i) => n === b[i]);
}

function hasRepeatWord(text) {
  return /повтор/i.test(String(text || ''));
}

// Явные признаки, что zanyatie двух записей описывают РАЗНЫЕ события, а не
// перенос времени одного и того же: разные номера занятия/урока/медитации
// ("Занятие 3" vs "Занятие 4"), или один из текстов явно помечен как повтор
// ("Класс 1" vs "Класс 1 (повтор)" — намеренный второй показ для другого
// часового пояса, не перенос). Если чисел нет вовсе или они совпадают —
// не считаем это признаком различия (по умолчанию — тот же случай, что было).
function looksLikeDifferentEvent(zanyatieA, zanyatieB) {
  if (hasRepeatWord(zanyatieA) || hasRepeatWord(zanyatieB)) return true;

  const numsA = extractNumbers(zanyatieA);
  const numsB = extractNumbers(zanyatieB);
  if (numsA.length === 0 || numsB.length === 0) return false;

  return !numbersEqual(numsA, numsB);
}

// Пара "тот же поток, время изменилось": kurs+dateISO+groupLink совпадают,
// время разное, и zanyatie не выдаёт явно другое событие.
function isReschedulePair(a, b) {
  const groupLink = fieldValue(a, 'groupLink');
  if (!groupLink || groupLink !== fieldValue(b, 'groupLink')) return false;

  const kurs = fieldValue(a, 'kurs');
  const dateISO = fieldValue(a, 'dateISO');
  if (!kurs || !dateISO || kurs !== fieldValue(b, 'kurs') || dateISO !== fieldValue(b, 'dateISO')) return false;

  const timeA = fieldValue(a, 'timeMSK');
  const timeB = fieldValue(b, 'timeMSK');
  if (!timeA || !timeB || timeA === timeB) return false;

  return !looksLikeDifferentEvent(fieldValue(a, 'zanyatie'), fieldValue(b, 'zanyatie'));
}

// Группирует записи попарно (isReschedulePair) — так пара с явно другим
// номером занятия или пометкой "повтор" не попадёт в одну группу, даже если
// у неё совпадают kurs+dateISO+groupLink и время отличается от третьей
// записи в том же "бакете".
function findStaleTimeGroups(records) {
  const used = new Array(records.length).fill(false);
  const groups = [];

  for (let i = 0; i < records.length; i++) {
    if (used[i]) continue;
    const group = [records[i]];
    used[i] = true;
    for (let j = i + 1; j < records.length; j++) {
      if (used[j]) continue;
      if (isReschedulePair(records[i], records[j])) {
        group.push(records[j]);
        used[j] = true;
      }
    }
    if (group.length > 1) groups.push(group);
  }

  return groups;
}

// Для каждой найденной группы — запись с самым поздним addedAt остаётся,
// остальные идут на удаление. Используется /устаревшие для авто-очистки.
function resolveStaleTimeGroups(records) {
  return findStaleTimeGroups(records).map((group) => {
    let keeper = group[0];
    for (const r of group.slice(1)) {
      if (fieldValue(r, 'addedAt') > fieldValue(keeper, 'addedAt')) keeper = r;
    }
    return { keep: keeper, remove: group.filter((r) => r.id !== keeper.id) };
  });
}

// Индекс записи в existingRecords того же потока (isReschedulePair) —
// используется в /добавить, чтобы перенести время в существующую запись
// вместо создания второй. Если подходит несколько — берём с самым поздним
// addedAt, той же логикой, что /устаревшие выбирает keeper.
function findRescheduledMatch(existingRecords, newEntry) {
  if (!fieldValue(newEntry, 'kurs') || !fieldValue(newEntry, 'dateISO')) return -1;
  if (!fieldValue(newEntry, 'groupLink') || !fieldValue(newEntry, 'timeMSK')) return -1;

  let bestIdx = -1;
  existingRecords.forEach((r, idx) => {
    if (!isReschedulePair(r, newEntry)) return;
    if (bestIdx === -1 || fieldValue(r, 'addedAt') > fieldValue(existingRecords[bestIdx], 'addedAt')) {
      bestIdx = idx;
    }
  });
  return bestIdx;
}

// Переносит время в существующую запись (id/addedAt существующей — как
// была), остальные поля — новые значения, если непустые, как decideForAdd
// в dedupe.js для точных дублей.
function mergeRescheduled(existing, newEntry) {
  const merged = { ...existing, timeMSK: fieldValue(newEntry, 'timeMSK') };
  for (const f of MERGE_FIELDS) {
    const nv = fieldValue(newEntry, f);
    if (nv) merged[f] = nv;
  }
  merged.rawText = newEntry.rawText;
  return merged;
}

module.exports = {
  looksLikeDifferentEvent,
  isReschedulePair,
  findStaleTimeGroups,
  resolveStaleTimeGroups,
  findRescheduledMatch,
  mergeRescheduled,
};
