const WEEKDAYS_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTHS_RU = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const FORMAT_LABELS_RU = { online: 'Онлайн', offline: 'Офлайн', recording: 'Запись' };

function formatDateRu(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS_RU[dt.getUTCDay()]}, ${d} ${MONTHS_RU[m - 1]} ${y}`;
}

// Текстовая карточка для подтверждения в Telegram перед сохранением —
// показывает только то, что реально распознано (пустые поля не выводятся).
function buildConfirmationText(e) {
  const lines = ['📋 Проверь событие перед добавлением:', ''];

  lines.push(`Программа: ${e.program}`);
  lines.push(`Формат: ${FORMAT_LABELS_RU[e.format] || e.format}`);
  if (e.title_ru) lines.push(`Название: ${e.title_ru}`);
  if (e.teacher) lines.push(`Ведёт: ${e.teacher}`);
  if (e.city) lines.push(`Город: ${e.city}`);
  if (e.date_az && e.time_az) lines.push(`Аризона (MST): ${formatDateRu(e.date_az)}, ${e.time_az}`);
  if (e.date_msk && e.time_msk) lines.push(`Москва (MSK): ${formatDateRu(e.date_msk)}, ${e.time_msk}`);
  if (e.lang) lines.push(`Языки: ${e.lang}`);
  if (e.link) lines.push(`Ссылка: ${e.link}`);

  lines.push('');
  lines.push('Добавить это событие в афишу?');

  return lines.join('\n');
}

module.exports = { formatDateRu, buildConfirmationText };
