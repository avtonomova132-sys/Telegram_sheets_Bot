const fs = require('fs');
const path = require('path');
const { isSameEvent, decideForAdd } = require('./dedupe');
const { findRescheduledMatch, mergeRescheduled } = require('./stale');

// /data — тот же примонтированный Railway Volume, что уже используется для
// прогресса стихов (см. verse/progress.js), переживает передеплои.
const PEREDACHI_PATH = process.env.PEREDACHI_PATH || '/data/peredachi.json';

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(PEREDACHI_PATH, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[peredachi] volume недоступен или файл повреждён, читаю как пустой список:', err.message);
    }
    return [];
  }
}

function writeAll(records) {
  fs.mkdirSync(path.dirname(PEREDACHI_PATH), { recursive: true });
  // Атомарная запись (tmp + rename), как в verse/progress.js — обрыв процесса
  // на полпути записи не должен оставить битый/пустой JSON.
  const tmpPath = `${PEREDACHI_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2));
  fs.renameSync(tmpPath, PEREDACHI_PATH);
}

// entries — объекты от extractPeredachi (без id/addedAt/rawText), rawText —
// исходный текст сообщения учителя, для отладки.
// Перед добавлением каждая запись сверяется с уже существующими:
// 1) точный дубль (kurs+dateISO+timeMSK, см. peredachi/dedupe.js) —
//    добавляется, полностью совпадающий пропускается, уточняющий обновляет
//    существующую запись на месте;
// 2) если точного дубля нет — перенос времени (kurs+dateISO+groupLink
//    совпадают, время другое, см. peredachi/stale.js) — переносит время (и
//    остальные поля) в существующую запись вместо создания второй; если
//    groupLink другой (или пустой) — это независимый поток, добавляется как
//    новая запись.
function addRecords(entries, rawText) {
  const all = readAll();
  const addedAt = new Date().toISOString();

  const added = [];
  const updated = [];
  const skipped = [];
  const rescheduled = [];

  entries.forEach((entry, i) => {
    const normalized = {
      kurs: entry.kurs || '',
      postfix: entry.postfix || '',
      teacher: entry.teacher || '',
      dateISO: entry.dateISO || '',
      timeMSK: entry.timeMSK || '',
      zanyatie: entry.zanyatie || '',
      zoomLink: entry.zoomLink || '',
      zoomCode: entry.zoomCode || '',
      groupLink: entry.groupLink || '',
      rawText,
    };

    const matchIdx = all.findIndex((r) => isSameEvent(r, normalized));

    if (matchIdx === -1) {
      const rescheduleIdx = findRescheduledMatch(all, normalized);
      if (rescheduleIdx !== -1) {
        const oldTime = all[rescheduleIdx].timeMSK;
        const merged = mergeRescheduled(all[rescheduleIdx], normalized);
        all[rescheduleIdx] = merged;
        rescheduled.push({ merged, oldTime, newTime: normalized.timeMSK });
        return;
      }

      const record = { id: String(Date.now() + i), ...normalized, addedAt };
      all.push(record);
      added.push(record);
      return;
    }

    const decision = decideForAdd(all[matchIdx], normalized);
    if (decision.action === 'skip') {
      skipped.push(all[matchIdx]);
      return;
    }

    all[matchIdx] = decision.merged;
    updated.push(decision.merged);
  });

  try {
    writeAll(all);
  } catch (err) {
    console.error('[peredachi] не удалось записать файл данных (volume недоступен?):', err.message);
    throw new Error('не получилось сохранить на диск — проверь, подключён ли volume');
  }

  return { added, updated, skipped, rescheduled };
}

module.exports = { readAll, addRecords, saveAll: writeAll };
