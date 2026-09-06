// Главное меню (/menu, и на /start) — построено ПОВЕРХ уже существующих
// команд, ничего не меняет и не заменяет: все команды продолжают работать
// напрямую, это только справочная навигация с кнопками. Названия разделов
// и их порядок — по точной спецификации Elena, совпадают с названиями,
// которыми она пользуется вне бота (ветки Claude Code, чаты Claude) —
// менять формулировки при правках не нужно.
//
// Команды без обязательного аргумента получают кнопку (третий элемент —
// run-ключ, см. RUN_PREFIX и диспетчер в index.js: bot.on('callback_query')
// ищет callback_data run:<ключ> и вызывает ровно тот же обработчик, что и
// голая команда без аргументов). Команды, которым аргумент обязателен
// (например "/дата <дата>" или "/добавить <текст>") — кнопкой не заменить,
// вводить их всё равно придётся текстом, поэтому они остаются как раньше,
// простой строкой с описанием.
const SECTIONS = [
  {
    key: 'afisha',
    title: '🖼 Афиша Алмазного пути',
    intro: '',
    commands: [],
    buttons: [[{ label: '🖼 Новое событие (/new)', run: 'new' }]],
  },
  {
    key: 'dnevnik',
    title: '📓 Шестиразовый дневник',
    // Дневник работает не как "набор команд", а как push+ответ — раздел
    // объясняет формат, а не предлагает "зайти" куда-то, по просьбе Elena.
    intro:
      'Дневник работает сам — 6 раз в день бот присылает принцип, ты отвечаешь текстом или голосом прямо в этом чате, заходить никуда не нужно. Кнопки ниже — только чтобы посмотреть текущий принцип или список за день отдельно.',
    commands: [],
    buttons: [
      [{ label: '📓 Текущий принцип', run: 'dnevnik' }],
      [{ label: '🧪 Тестовая запись (/дневник_принцип)', run: 'dnevnik_princip' }],
      [{ label: '📋 Отчёт за сегодня', run: 'dnevnik_day' }],
      [{ label: '📋 Кратко (для партнёра)', run: 'dnevnik_kratko' }],
    ],
  },
  {
    key: 'uttaratantra',
    title: '📜 Уттаратантра',
    intro: '',
    commands: [],
    buttons: [
      [{ label: '📖 Текущий стих', run: 'verse' }],
      [{ label: '📊 Прогресс', run: 'progress' }],
    ],
  },
  {
    key: 'volunteering',
    title: '📅 Волонтёрство',
    intro: 'Координация хостов Zoom-эфиров WVP.',
    commands: [],
    buttons: [
      [{ label: '✅ Кто не назначен', run: 'check' }],
      [{ label: '📅 Расписание недели', run: 'weekly' }],
      [{ label: '➡️ Следующая неделя', run: 'next_week' }],
      [{ label: '🔍 Проверить сейчас', run: 'autocheck' }],
    ],
  },
  {
    key: 'peredachi',
    title: '📿 Прямые передачи',
    intro: 'Курсы "Пять домов" (1–6) и медитации.',
    commands: [
      ['/ближайший <курс>', 'ближайшая передача по курсу'],
      ['/дата <дата>', 'что назначено на эту дату'],
      ['/добавить', 'добавить передачу из текста объявления'],
      ['/удалить', 'удалить запись'],
    ],
    buttons: [
      [{ label: '📚 Обзор всех курсов', run: 'kursy' }],
      [
        { label: 'Курс 1', run: 'kurs1' },
        { label: 'Курс 2', run: 'kurs2' },
      ],
      [
        { label: 'Курс 3', run: 'kurs3' },
        { label: 'Курс 4', run: 'kurs4' },
      ],
      [
        { label: 'Курс 5', run: 'kurs5' },
        { label: 'Курс 6', run: 'kurs6' },
      ],
      [{ label: '🧘 Медитации', run: 'meditacii' }],
      [{ label: '🔁 Проверить дубли', run: 'dubli' }],
      [{ label: '✂️ Разделить склеенные', run: 'razdelit' }],
      [{ label: '🧹 Почистить устаревшие', run: 'ustarevshie' }],
      [{ label: '👥 Таблица групп', run: 'gruppy' }],
      [{ label: '🔗 Обновить ссылки', run: 'obnovitssylki' }],
      [{ label: '🗑 Без ссылки на группу', run: 'bezgruppy' }],
    ],
  },
  {
    key: 'ozon',
    title: '🛍 Ozon',
    intro:
      'Пересчёт габаритов (см→мм) и готовое сообщение в техподдержку Ozon по фото товара с линейкой и этикеткой (включая вес, если видны весы на фото).',
    commands: [],
    buttons: [
      [{ label: '📦 Начать габариты', run: 'gabarity' }],
      [{ label: '📄 Загрузить артикулы (/z)', run: 'z' }],
    ],
  },
  {
    key: 'misc',
    title: '💬 Разное',
    intro: 'Без привязки к конкретному направлению — случайные запросы и заметки.',
    commands: [['«напомни ... в 15:00 ...»', 'разовое напоминание свободным текстом']],
    buttons: [
      [{ label: '✅ Чек-лист практик (/pro)', run: 'pro' }],
      [{ label: '📝 Как добавить задачу', run: 'zadacha' }],
      [{ label: '📋 Список задач', run: 'zadachi' }],
    ],
  },
];

const SECTION_PREFIX = 'menu_section:';
const ROOT_CALLBACK = 'menu_root';
const RUN_PREFIX = 'menu_run:';

function buildRootMenu() {
  return {
    text: '📋 Главное меню — выбери раздел:',
    reply_markup: {
      inline_keyboard: SECTIONS.map((s) => [{ text: s.title, callback_data: `${SECTION_PREFIX}${s.key}` }]),
    },
  };
}

function buildSectionMessage(key) {
  const section = SECTIONS.find((s) => s.key === key);
  if (!section) return null;

  const lines = [section.title, ''];
  if (section.intro) lines.push(section.intro, '');
  lines.push(...section.commands.map(([cmd, desc]) => `${cmd} — ${desc}`));

  const runRows = (section.buttons || []).map((row) =>
    row.map((btn) => ({ text: btn.label, callback_data: `${RUN_PREFIX}${btn.run}` }))
  );

  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [...runRows, [{ text: '⬅️ Меню', callback_data: ROOT_CALLBACK }]],
    },
  };
}

module.exports = { buildRootMenu, buildSectionMessage, SECTION_PREFIX, ROOT_CALLBACK, RUN_PREFIX };
