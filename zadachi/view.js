const { PROJECTS } = require('./items-parser');

// Не toggle-кнопка — заголовок-разделитель между проектами внутри
// inline-клавиатуры /задачи (тот же приём, что и NOOP_CALLBACK в
// proekty/view.js).
const NOOP_CALLBACK = 'zad_noop';
const DONE_PREFIX = 'zad_done:';

const PROJECT_LABELS = new Map(PROJECTS.map((p) => [p.key, p.label]));

function projectLabel(key) {
  return PROJECT_LABELS.get(key) || key;
}

function truncate(str, max) {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

// "20.08" из даты-без-времени, "20.08 15:00 МСК" из полного datetime, '' —
// если дата/время не упомянуты (datetime === null).
function formatDateTimeLabel(datetime) {
  if (!datetime) return '';
  const [datePart, timePart] = datetime.split('T');
  const [, month, day] = datePart.split('-');
  const dateLabel = `${day}.${month}`;
  if (!timePart) return dateLabel;
  return `${dateLabel} ${timePart.slice(0, 5)} МСК`;
}

function buildTaskAddedText(record) {
  const label = projectLabel(record.project);
  const when = formatDateTimeLabel(record.datetime);
  return `✅ Добавлено в ${label}: ${record.text}${when ? ` (${when})` : ''}`;
}

// Задачи с датой — раньше по времени выше (сравнение ISO-строк лексикографически
// совпадает с хронологическим порядком); задачи без даты — внизу группы, в
// порядке добавления.
function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    if (Boolean(a.datetime) !== Boolean(b.datetime)) return a.datetime ? -1 : 1;
    if (a.datetime && b.datetime) return a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : 0;
    return a.createdAt < b.createdAt ? -1 : 1;
  });
}

function buildTasksListMessage(openTasks) {
  if (openTasks.length === 0) {
    return { text: '🎉 Активных задач нет.', reply_markup: { inline_keyboard: [] } };
  }

  const byProject = new Map();
  for (const task of openTasks) {
    if (!byProject.has(task.project)) byProject.set(task.project, []);
    byProject.get(task.project).push(task);
  }

  const rows = [];
  // Порядок групп — как в proekty/items.js ("Мои проекты"), чтобы список
  // выглядел предсказуемо и совпадал с порядком в /pro.
  for (const { key, label } of PROJECTS) {
    const group = byProject.get(key);
    if (!group || group.length === 0) continue;

    rows.push([{ text: `📁 ${label}`, callback_data: NOOP_CALLBACK }]);
    for (const task of sortTasks(group)) {
      const when = formatDateTimeLabel(task.datetime);
      const buttonLabel = when ? `${when} — ${task.text}` : task.text;
      rows.push([{ text: truncate(buttonLabel, 60), callback_data: `${DONE_PREFIX}${task.id}` }]);
    }
  }

  return {
    text: '📋 Активные задачи\n\nНажми на задачу, чтобы отметить выполненной.',
    reply_markup: { inline_keyboard: rows },
  };
}

module.exports = { buildTaskAddedText, buildTasksListMessage, projectLabel, NOOP_CALLBACK, DONE_PREFIX };
