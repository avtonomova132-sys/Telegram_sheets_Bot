// Текущая дата/время в МСК. Считаем через Intl с timeZone 'Europe/Moscow' —
// Россия не переходит на летнее/зимнее время, поэтому МСК = UTC+3 всегда,
// а Intl сам берёт актуальное UTC-время сервера независимо от его локальной
// таймзоны (Railway обычно запускает контейнеры в Asia/Makassar/UTC).
function getNowMsk() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const hour = parts.hour === '24' ? '00' : parts.hour; // ICU иногда отдаёт "24:00" вместо "00:00"
  return { dateISO: `${parts.year}-${parts.month}-${parts.day}`, timeMSK: `${hour}:${parts.minute}` };
}

// Извлекает все номера курсов из строки: одиночные числа и диапазоны вида
// "1-5" (для экспресс-курсов, покрывающих несколько курсов сразу).
function extractCourseNumbers(str) {
  const nums = new Set();
  if (!str) return nums;

  const rangeRe = /(\d+)\s*-\s*(\d+)/g;
  let match;
  let remainder = str;
  while ((match = rangeRe.exec(str))) {
    const a = parseInt(match[1], 10);
    const b = parseInt(match[2], 10);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    for (let n = lo; n <= hi; n++) nums.add(n);
    remainder = remainder.replace(match[0], ' ');
  }

  const singleRe = /\d+/g;
  let single;
  while ((single = singleRe.exec(remainder))) {
    nums.add(parseInt(single[0], 10));
  }

  return nums;
}

function recordMatchesKurs(record, requestedKurs) {
  const requested = parseInt(requestedKurs, 10);
  if (Number.isNaN(requested)) {
    return String(record.kurs || '').trim() === String(requestedKurs).trim();
  }
  const nums = new Set([...extractCourseNumbers(record.kurs), ...extractCourseNumbers(record.postfix)]);
  return nums.has(requested);
}

function isUpcoming(record, now) {
  if (!record.dateISO) return false;
  if (record.dateISO > now.dateISO) return true;
  if (record.dateISO < now.dateISO) return false;
  // та же дата — если время неизвестно, оставляем (лучше показать лишнее,
  // чем скрыть передачу, которая ещё не прошла)
  if (!record.timeMSK) return true;
  return record.timeMSK >= now.timeMSK;
}

function sortRecords(records) {
  const key = (r) => `${r.dateISO || '9999-99-99'} ${r.timeMSK || '00:00'}`;
  return [...records].sort((a, b) => key(a).localeCompare(key(b)));
}

function formatDateRu(dateISO) {
  const parts = String(dateISO || '').split('-');
  if (parts.length !== 3) return dateISO || '';
  const [y, m, d] = parts;
  return `${d}.${m}`;
}

// Легаси Markdown Телеграма ломается на непарных _ * ` [ — экранируем их
// в полях со свободным текстом (учитель/занятие), но не трогаем ссылки.
function escapeMarkdown(text) {
  return String(text || '').replace(/([_*`[])/g, '\\$1');
}

function formatRecordBlock(record) {
  const dateStr = formatDateRu(record.dateISO);
  const timeStr = record.timeMSK ? `${record.timeMSK} МСК` : 'время уточняется';
  const teacher = escapeMarkdown(record.teacher) || 'учитель не указан';
  const zanyatie = escapeMarkdown(record.zanyatie);
  const zoom = record.zoomLink || 'ссылка появится позже, следи за группой';
  const group = record.groupLink || '—';

  const lines = [`📅 ${dateStr}, ${timeStr} — ${teacher}`];
  if (zanyatie) lines.push(`   ${zanyatie}`);
  lines.push(`   🔗 ${zoom}`);
  lines.push(`   👥 ${group}`);
  return lines.join('\n');
}

function formatCourseSection(kurs, records) {
  const header = `📖 *Курс ${escapeMarkdown(kurs)} — ближайшие передачи:*`;
  return `${header}\n\n${records.map(formatRecordBlock).join('\n\n')}`;
}

// kursArg — строка курса из аргумента команды, или null/пусто для сводки по всем курсам.
function formatPeredachiReply(all, kursArg) {
  const now = getNowMsk();
  const upcoming = sortRecords(all.filter((r) => isUpcoming(r, now)));

  if (kursArg) {
    const filtered = upcoming.filter((r) => recordMatchesKurs(r, kursArg));
    if (filtered.length === 0) {
      return `По курсу ${kursArg} пока нет данных о передачах. Появится информация — сразу будет здесь.`;
    }
    return formatCourseSection(kursArg, filtered);
  }

  if (upcoming.length === 0) {
    return 'Пока нет данных о предстоящих передачах. Появится информация — сразу будет здесь.';
  }

  const groups = new Map();
  for (const r of upcoming) {
    const key = r.kurs || '?';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const sortedKeys = [...groups.keys()].sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    if (Number.isNaN(na) && Number.isNaN(nb)) return a.localeCompare(b);
    if (Number.isNaN(na)) return 1;
    if (Number.isNaN(nb)) return -1;
    return na - nb;
  });

  return sortedKeys.map((key) => formatCourseSection(key, groups.get(key).slice(0, 3))).join('\n\n\n');
}

// Медитации не выделены отдельным "курсом" в данных — это записи любого
// курса, где в поле zanyatie упомянута медитация (см. схему в extract.js).
function formatMeditationsReply(all) {
  const now = getNowMsk();
  const upcoming = sortRecords(
    all.filter((r) => isUpcoming(r, now) && /медитац/i.test(r.zanyatie || ''))
  );

  if (upcoming.length === 0) {
    return 'Пока нет данных о предстоящих медитациях. Появится информация — сразу будет здесь.';
  }

  const header = '🧘 *Медитации — ближайшие:*';
  return `${header}\n\n${upcoming.map(formatRecordBlock).join('\n\n')}`;
}

module.exports = {
  getNowMsk,
  extractCourseNumbers,
  recordMatchesKurs,
  isUpcoming,
  sortRecords,
  formatDateRu,
  formatPeredachiReply,
  formatMeditationsReply,
};
