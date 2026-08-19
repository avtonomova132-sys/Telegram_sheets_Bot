// Список пунктов ежедневного трекера /pro. Чтобы добавить новый пункт —
// допиши объект { key, label } в нужную секцию, больше нигде ничего менять
// не нужно (view.js и index.js читают список отсюда). key должен быть
// уникальным и не меняться со временем — он же ключ в /data/proekty.json.
const SECTIONS = [
  {
    title: 'Практика дня',
    items: [
      { key: 'sh_utro', label: 'Щедрость — утро' },
      { key: 'sh_den', label: 'Щедрость — день' },
      { key: 'sh_vecher', label: 'Щедрость — вечер' },
    ],
  },
  {
    title: 'Мои проекты',
    items: [
      { key: 'ozon', label: 'Озон' },
      { key: 'peredachi_bot', label: 'Прямые передачи (бот)' },
      { key: 'afisha', label: 'Афиша' },
      { key: 'hosty_wvp', label: 'Хосты WVP (координация волонтёров)' },
      { key: 'host_obuchenie', label: 'Хост — обучение' },
      { key: 'kurs', label: 'Финансовая свобода — курс' },
      { key: 'million', label: 'Миллион долларов' },
    ],
  },
];

const ALL_ITEMS = SECTIONS.flatMap((section) => section.items);
const ITEM_KEYS = new Set(ALL_ITEMS.map((item) => item.key));

function isKnownItem(key) {
  return ITEM_KEYS.has(key);
}

module.exports = { SECTIONS, ALL_ITEMS, isKnownItem };
