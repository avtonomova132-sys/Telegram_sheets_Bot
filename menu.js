// Главное меню (/menu, и на /start) — построено ПОВЕРХ уже существующих
// команд, ничего не меняет и не заменяет: все команды продолжают работать
// напрямую, это только кнопочная навигация. Названия разделов и их порядок —
// по точной спецификации Elena, совпадают с названиями, которыми она
// пользуется вне бота (ветки Claude Code, чаты Claude) — менять
// формулировки при правках не нужно.
//
// Каждая команда раздела — кнопка (третий элемент — run-ключ, см. RUN_PREFIX
// и диспетчер в index.js: bot.on('callback_query') ищет callback_data
// run:<ключ> и вызывает ровно тот же обработчик, что и голая команда без
// аргументов). Для команд, которым аргумент обязателен (например
// "/дата <дата>" или "/добавить <текст>") кнопка вызывает ту же голую
// команду без аргумента — она ответит подсказкой по использованию, как и
// при простом наборе "/дата" без ничего; сам аргумент кнопкой не собрать,
// вводить его всё равно придётся текстом.
const SECTIONS = [
  {
    key: 'afisha',
    title: '🖼 Афиша Алмазного пути',
    intro: '',
    buttons: [[{ label: '🖼 Новое событие (/new)', run: 'new' }]],
  },
  {
    key: 'dnevnik',
    title: '📓 Шестиразовый дневник',
    // Дневник работает не как "набор команд", а как push+ответ — раздел
    // объясняет формат, а не предлагает "зайти" куда-то, по просьбе Elena.
    intro:
      'Дневник работает сам — 6 раз в день бот присылает принцип, ты отвечаешь текстом или голосом прямо в этом чате, заходить никуда не нужно. Кнопки ниже — только чтобы посмотреть текущий принцип или список за день отдельно.',
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
    buttons: [
      [{ label: '📖 Текущий стих', run: 'verse' }],
      [{ label: '📊 Прогресс', run: 'progress' }],
    ],
  },
  {
    key: 'volunteering',
    title: '📅 Волонтёрство',
    intro: 'Координация хостов Zoom-эфиров WVP.',
    buttons: [
      [{ label: '✅ Кто не назначен', run: 'check' }],
      [{ label: '📅 Расписание недели', run: 'weekly' }],
      [{ label: '➡️ Следующая неделя', run: 'next_week' }],
      [{ label: '🔍 Проверить сейчас', run: 'autocheck' }],
      [{ label: '🌐 Ассистенты (ACI | V Houses)', run: 'assistenty' }],
      [{ label: '🌐 Ассистенты SERIES', run: 'check_assistants' }],
      [{ label: '🆕 Новые программы', run: 'novye_programy' }],
    ],
  },
  {
    key: 'peredachi',
    title: '📿 Прямые передачи',
    intro: 'Курсы "Пять домов" (1–6) и медитации.',
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
      [{ label: '🕐 Ближайшая передача (/ближайший)', run: 'blizhaishiy' }],
      [{ label: '📆 Передачи на дату (/дата)', run: 'data' }],
      [{ label: '➕ Добавить передачу (/добавить)', run: 'dobavit' }],
      [{ label: '🗑 Удалить запись (/удалить)', run: 'udalit' }],
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
    buttons: [
      [{ label: '📦 Начать габариты', run: 'gabarity' }],
      [{ label: '📄 Загрузить артикулы (/z)', run: 'z' }],
    ],
  },
  {
    key: 'translator',
    title: '🌐 Переводчик',
    intro: 'Перевод сообщений в групповом чате (en/es/ru) по кнопке под каждым сообщением.',
    buttons: [
      [{ label: '✅ Включить перевод', run: 'translate_on' }],
      [{ label: '🛑 Выключить перевод', run: 'translate_off' }],
    ],
  },
];

const SECTION_PREFIX = 'menu_section:';
const ROOT_CALLBACK = 'menu_root';
const RUN_PREFIX = 'menu_run:';
const BACK_LABEL = '⬅️ Назад';

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

  const lines = [section.title];
  if (section.intro) lines.push('', section.intro);

  const runRows = section.buttons.map((row) =>
    row.map((btn) => ({ text: btn.label, callback_data: `${RUN_PREFIX}${btn.run}` }))
  );

  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [...runRows, [{ text: BACK_LABEL, callback_data: ROOT_CALLBACK }]],
    },
  };
}

module.exports = { buildRootMenu, buildSectionMessage, SECTION_PREFIX, ROOT_CALLBACK, RUN_PREFIX };
