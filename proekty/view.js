const { SECTIONS, ALL_ITEMS } = require('./items');

// Не toggle-кнопка — заголовок-разделитель между секциями "Практика дня" и
// "Мои проекты" внутри inline-клавиатуры (Telegram не даёт вставить обычный
// текст между рядами кнопок, поэтому раздел оформлен как некликабельная
// строка-кнопка).
const NOOP_CALLBACK = 'pro_noop';
const TOGGLE_PREFIX = 'pro_toggle:';

function countSown(day) {
  return ALL_ITEMS.filter((item) => day[item.key]).length;
}

function buildProText(day) {
  const sown = countSown(day);
  const total = ALL_ITEMS.length;
  return `🌱 Сегодняшние семена\n\nПосеяно ${sown} из ${total}`;
}

function buildProKeyboard(day) {
  const rows = [];
  for (const section of SECTIONS) {
    rows.push([{ text: `— ${section.title} —`, callback_data: NOOP_CALLBACK }]);
    for (const item of section.items) {
      const mark = day[item.key] ? '🌱' : '⚪';
      rows.push([{ text: `${mark} ${item.label}`, callback_data: `${TOGGLE_PREFIX}${item.key}` }]);
    }
  }
  return { inline_keyboard: rows };
}

function buildProMessage(day) {
  return { text: buildProText(day), reply_markup: buildProKeyboard(day) };
}

module.exports = { buildProMessage, NOOP_CALLBACK, TOGGLE_PREFIX };
