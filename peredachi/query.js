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
  const zanyatie = escapeMarkdown(record.zanyatie);
  // zoomLink/groupLink идут через Anthropic API как свободный текст, а не
  // только вручную вбитые ссылки — например Zoom часто кладёт в ?pwd=
  // base64url-значение, у которого в алфавите есть "_" и "-", и непарный "_"
  // в URL так же ломает парсинг легаси-Markdown, как и в любом другом поле.
  const zoom = record.zoomLink ? escapeMarkdown(record.zoomLink) : 'ссылка появится позже, следи за группой';
  const zoomCode = escapeMarkdown(record.zoomCode);
  const group = record.groupLink ? escapeMarkdown(record.groupLink) : '—';

  const lines = [`📅 ${dateStr}, ${timeStr}`];
  if (zanyatie) lines.push(`   ${zanyatie}`);
  lines.push(`   🔗 ${zoom}`);
  if (zoomCode) lines.push(`   Код: ${zoomCode}`);
  lines.push(`   👥 ${group}`);
  return lines.join('\n');
}

// "медитация" — отдельная категория (не привязана к курсу 1-6), заголовок
// для неё формулируется иначе, чем "Курс {N}".
function sectionTitle(kursKey) {
  if (String(kursKey).trim() === 'медитация') return '🧘 *Медитации — ближайшие:*';
  return `📖 *Курс ${escapeMarkdown(kursKey)} — ближайшие передачи:*`;
}

// Заголовок для /ближайший — тот же принцип, но в единственном числе.
function sectionTitleSingle(kursKey) {
  if (String(kursKey).trim() === 'медитация') return '🧘 *Ближайшая медитация:*';
  return `📖 *Курс ${escapeMarkdown(kursKey)} — ближайшая передача:*`;
}

function formatSection(title, records) {
  return `${title}\n\n${records.map(formatRecordBlock).join('\n\n')}`;
}

function upcomingSorted(all) {
  const now = getNowMsk();
  return sortRecords(all.filter((r) => isUpcoming(r, now)));
}

// /курсы — сводка по всем группам (курсы 1-6 и "медитация" отдельно), все
// актуальные записи на группу — объединение полного вывода /курс1...курс6
// и /медитации подряд, без сокращения.
function formatKursOverview(all) {
  const upcoming = upcomingSorted(all);
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

  return sortedKeys.map((key) => formatSection(sectionTitle(key), groups.get(key))).join('\n\n\n');
}

// /курс1.../курс6 — все ближайшие передачи конкретного курса, включая
// вхождение в postfix экспресс-курсов (например "1-5").
function formatKursDetail(all, kursNumber) {
  const upcoming = upcomingSorted(all);
  const filtered = upcoming.filter((r) => recordMatchesKurs(r, kursNumber));
  if (filtered.length === 0) {
    return `По курсу ${kursNumber} пока нет данных о передачах. Появится информация — сразу будет здесь.`;
  }
  return formatSection(sectionTitle(String(kursNumber)), filtered);
}

// /медитации — записи с kurs === "медитация" (самостоятельные медитации,
// не встроенные в занятие курса).
function formatMeditations(all) {
  const upcoming = upcomingSorted(all).filter((r) => String(r.kurs || '').trim() === 'медитация');
  if (upcoming.length === 0) {
    return 'Пока нет данных о ближайших медитациях. Появится информация — сразу будет здесь.';
  }
  return formatSection(sectionTitle('медитация'), upcoming);
}

// /ближайший <курс> — не список, а ровно одна, самая ближайшая по времени
// запись по курсу (recordMatchesKurs понимает и "медитация", и постфиксы
// экспресс-курсов вроде "1-5" — та же логика, что у /курс1...курс6).
function formatNearest(all, kursArg) {
  const upcoming = upcomingSorted(all);
  const filtered = upcoming.filter((r) => recordMatchesKurs(r, kursArg));
  if (filtered.length === 0) {
    return `По курсу ${kursArg} пока нет предстоящих передач.`;
  }
  return formatSection(sectionTitleSingle(kursArg), [filtered[0]]);
}

// /дата <ДД.ММ> — все записи (курсы и медитации вместе) на конкретную
// dateISO, отсортированные по времени. В отличие от /курс1...курс6 (где
// курс понятен из общего заголовка), список смешанный — поэтому у каждой
// карточки свой ярлык "Курс N" / "Медитация". Если запрошенная дата —
// сегодня (по МСК), уже прошедшие по времени записи скрываются (та же
// логика, что isUpcoming уже применяет везде); для будущей даты фильтрации
// по времени суток нет — resolveDateArg в index.js в принципе не может
// вернуть дату в прошлом, так что "сегодня" — единственный случай, где
// внутри одного дня есть что фильтровать.
function formatByDate(all, dateISO) {
  const displayDate = formatDateRu(dateISO);
  const now = getNowMsk();
  const isToday = dateISO === now.dateISO;

  let records = all.filter((r) => String(r.dateISO || '').trim() === dateISO);
  if (isToday) {
    records = records.filter((r) => isUpcoming(r, now));
  }
  records = sortRecords(records);

  if (records.length === 0) {
    return `На ${displayDate} передач не найдено.`;
  }

  const blocks = records.map((r) => {
    const isMeditation = String(r.kurs || '').trim() === 'медитация';
    const label = isMeditation
      ? 'Медитация'
      : `Курс ${escapeMarkdown(r.kurs)}${r.postfix ? ` (${escapeMarkdown(r.postfix)})` : ''}`;
    return `*${label}*\n${formatRecordBlock(r)}`;
  });

  return `📅 *Передачи на ${displayDate}:*\n\n${blocks.join('\n\n')}`;
}

module.exports = {
  getNowMsk,
  extractCourseNumbers,
  recordMatchesKurs,
  isUpcoming,
  sortRecords,
  formatDateRu,
  formatKursOverview,
  formatKursDetail,
  formatMeditations,
  formatNearest,
  formatByDate,
};
