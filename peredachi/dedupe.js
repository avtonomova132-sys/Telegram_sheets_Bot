// Поля, которые сравниваем при определении "заполненности" и конфликтов между
// записями. kurs/dateISO/timeMSK сюда не входят — это ключ совпадения, а не
// содержимое, которое может отличаться по качеству.
const MATCH_FIELDS = ['postfix', 'teacher', 'zanyatie', 'zoomLink', 'groupLink'];

function fieldValue(record, field) {
  return String((record && record[field]) || '').trim();
}

// Одна и та же передача — совпадают курс, дата и время (МСК). teacher
// намеренно игнорируется: его не всегда указывают одинаково. Дата и время
// должны быть заполнены у обеих записей — иначе два разных "пока без даты"
// события ошибочно схлопнутся в одно.
function isSameEvent(a, b) {
  const dateA = fieldValue(a, 'dateISO');
  const timeA = fieldValue(a, 'timeMSK');
  if (!dateA || !timeA) return false;
  return (
    fieldValue(a, 'kurs') === fieldValue(b, 'kurs') &&
    dateA === fieldValue(b, 'dateISO') &&
    timeA === fieldValue(b, 'timeMSK')
  );
}

function completeness(record) {
  return MATCH_FIELDS.reduce((n, f) => n + (fieldValue(record, f) ? 1 : 0), 0);
}

// Поле, где у обеих записей непустые, но РАЗНЫЕ значения — истинный конфликт,
// который нельзя разрешить автоматически (не ясно, какая версия верна).
function hasConflict(a, b) {
  return MATCH_FIELDS.some((f) => {
    const va = fieldValue(a, f);
    const vb = fieldValue(b, f);
    return va && vb && va !== vb;
  });
}

// ===== Для /добавить: новая запись против уже существующей =====
// Разрешает конфликт всегда (без запроса пользователю) — новая версия
// считается уточнением и побеждает при расхождении.
function decideForAdd(existing, newEntry) {
  const bringsSomethingNew = MATCH_FIELDS.some((f) => {
    const nv = fieldValue(newEntry, f);
    return nv && nv !== fieldValue(existing, f);
  });

  if (!bringsSomethingNew) {
    return { action: 'skip' };
  }

  const merged = { ...existing };
  for (const f of MATCH_FIELDS) {
    const nv = fieldValue(newEntry, f);
    if (nv) merged[f] = nv;
  }
  merged.rawText = newEntry.rawText;

  return { action: 'update', merged };
}

// ===== Для разовой очистки существующих данных на volume =====
// Группирует записи по совпадению события, автоматически объединяет группы
// без конфликтов (оставляя наиболее полную версию), а группы с конфликтами
// возвращает отдельно — их должен разрешить человек.
function analyzeDuplicates(records) {
  const used = new Array(records.length).fill(false);
  const groups = [];

  for (let i = 0; i < records.length; i++) {
    if (used[i]) continue;
    const group = [records[i]];
    used[i] = true;
    for (let j = i + 1; j < records.length; j++) {
      if (used[j]) continue;
      if (isSameEvent(records[i], records[j])) {
        group.push(records[j]);
        used[j] = true;
      }
    }
    if (group.length > 1) groups.push(group);
  }

  const autoResolved = [];
  const ambiguous = [];

  for (const group of groups) {
    let conflict = false;
    for (let a = 0; a < group.length && !conflict; a++) {
      for (let b = a + 1; b < group.length; b++) {
        if (hasConflict(group[a], group[b])) {
          conflict = true;
          break;
        }
      }
    }

    if (conflict) {
      ambiguous.push(group);
      continue;
    }

    let keeper = group[0];
    for (const r of group.slice(1)) {
      if (completeness(r) > completeness(keeper)) {
        keeper = r;
      } else if (completeness(r) === completeness(keeper) && fieldValue(r, 'addedAt') && fieldValue(keeper, 'addedAt') && r.addedAt < keeper.addedAt) {
        keeper = r;
      }
    }

    const merged = { ...keeper };
    for (const r of group) {
      for (const f of MATCH_FIELDS) {
        if (!fieldValue(merged, f) && fieldValue(r, f)) merged[f] = r[f];
      }
    }

    const remove = group.filter((r) => r.id !== keeper.id);
    autoResolved.push({ keep: merged, remove });
  }

  return { autoResolved, ambiguous };
}

module.exports = { isSameEvent, completeness, hasConflict, decideForAdd, analyzeDuplicates };
