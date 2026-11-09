// Единый вид сообщений бота про Озон (правило Елены, 2026-11-09):
//   🛍️ Заголовок
//   Зачем: одна фраза
//   Период: с ДД.ММ по ДД.ММ   (если у напоминания есть период)
//   текст…
// Промпт для Claude — отдельным сообщением в блоке кода (копируется одним нажатием).
// Длинное режется на части меньше 4096 символов.
const MARK = '🛍️';
const OZON_RE = /ozon|озон|акци[июяй]|начислен|списани|подписк|габарит|остатк/i;
const MAX = 4000;

const isOzonText = (t) => typeof t === 'string' && OZON_RE.test(t);
// Первой строкой 🛍️ — только если её ещё нет.
function mark(text) {
  const t = String(text ?? '');
  return t.startsWith(MARK) ? t : `${MARK} ${t}`;
}

const dm = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
// Со дня после конца прошлого присланного отчёта по сегодня; нет прошлого — с 1-го числа месяца.
function periodRange(today, lastTo) {
  let from = lastTo && /^\d{4}-\d{2}-\d{2}$/.test(lastTo) ? addDays(lastTo, 1) : `${today.slice(0, 8)}01`;
  if (from > today) from = today;
  return { from, to: today };
}
function periodLine(today, lastTo) {
  const r = periodRange(today, lastTo);
  return `Период: с ${dm(r.from)} по ${dm(r.to)}`;
}

// Шапка: 🛍️ заголовок, «Зачем:», «Период:» (необязательно), пустая строка, текст.
function build({ title, why, period, body }) {
  const head = [`${MARK} ${title}`];
  if (why) head.push(`Зачем: ${why}`);
  if (period) head.push(period.startsWith('Период:') ? period : `Период: ${period}`);
  return head.join('\n') + (body ? `\n\n${body}` : '');
}

// Деление по абзацам/строкам на части ≤ max.
function split(text, max = MAX) {
  const out = []; let cur = '';
  const push = (s) => { if (cur) out.push(cur); cur = s; };
  for (const para of String(text).split('\n')) {
    let line = para;
    while (line.length > max) { push(line.slice(0, max)); line = line.slice(max); }
    if (cur && cur.length + 1 + line.length > max) push(line); else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Промпт — блоки <pre> (HTML), каждый ≤ ~4000 символов с учётом экранирования.
function codeBlocks(prompt) {
  return split(prompt, 3000).map((p) => `<pre>${esc(p)}</pre>`);
}
async function sendCode(bot, chatId, prompt) {
  for (const html of codeBlocks(prompt)) await bot.sendMessage(chatId, html, { parse_mode: 'HTML' });
}
async function sendParts(bot, chatId, text) {
  for (const part of split(text)) await bot.sendMessage(chatId, part);
}

// Обёртка bot.sendMessage: любое текстовое сообщение в личку про Озон получает 🛍️ первой строкой.
// Группы (chatId < 0) и сообщения без ключевых слов не трогаем.
function installMarker(bot) {
  const orig = bot.sendMessage.bind(bot);
  bot.sendMessage = (chatId, text, opts) => {
    try {
      const priv = !String(chatId).startsWith('-');
      if (priv && !(opts && opts.parse_mode === 'HTML' && String(text).startsWith('<pre>')) && isOzonText(text)) text = mark(text);
    } catch { /* ignore */ }
    return orig(chatId, text, opts);
  };
}

module.exports = { MARK, isOzonText, mark, periodRange, periodLine, build, split, codeBlocks, sendCode, sendParts, installMarker };
