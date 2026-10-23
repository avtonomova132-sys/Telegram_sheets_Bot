// Команда /приход: фото накладной → таблица для Елены → после «Всё верно»
// xlsx для загрузки в Ozon. Бот ничего не пишет в Ozon сам (только чтение
// каталога). Состояние диалога — в памяти (по chatId).

const fs = require('fs');
const path = require('path');
const { readInvoicePhoto, prepareLine } = require('./recognize');
const { getCatalog } = require('./catalog');
const { buildFamilies } = require('./family');
const { matchLines, candidatesFor } = require('./match');
const { computePlan } = require('./plan');
const nameMap = require('./nameMap');
const xlsx = require('./xlsxFill');
const fbo = require('../fbo');

const CB = 'prh:';
const TEMPLATE_PATH = process.env.PRIHOD_TEMPLATE_PATH || '/data/prihod_template.xlsx';
const REPO_TEMPLATE_PATH = path.join(__dirname, 'template', 'ostatki_template.xlsx');
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;

let bot;
let isTrusted = () => false;
const sessions = new Map();
const awaitingTemplate = new Set();

function getTemplate() {
  for (const p of [TEMPLATE_PATH, REPO_TEMPLATE_PATH]) {
    try { return fs.readFileSync(p); } catch { /* пробуем дальше */ }
  }
  return null;
}

function saveTemplate(buf) {
  fs.mkdirSync(path.dirname(TEMPLATE_PATH), { recursive: true });
  const tmp = `${TEMPLATE_PATH}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, TEMPLATE_PATH);
}

function session(chatId) {
  const s = sessions.get(chatId);
  if (s && Date.now() - s.touched > SESSION_TTL_MS) { sessions.delete(chatId); return null; }
  if (s) s.touched = Date.now();
  return s || null;
}

const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });
const cancelRow = [{ text: '❌ Отмена', callback_data: `${CB}cancel` }];
const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 }));

async function send(chatId, text, extra) {
  // Лимит Telegram 4096 — режем по строкам.
  const chunks = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    if (cur && cur.length + line.length + 1 > 3800) { chunks.push(cur); cur = line; } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) chunks.push(cur);
  for (let i = 0; i < chunks.length; i += 1) {
    await bot.sendMessage(chatId, chunks[i], i === chunks.length - 1 ? extra : undefined);
  }
}

// Одно сообщение об ошибке, без повторов.
async function fail(chatId, what, err) {
  console.error(`[prihod] ${what}:`, err.message);
  await bot.sendMessage(chatId, `Не получилось: ${what} 😔 ${err.message}`).catch(() => {});
}

async function download(fileId) {
  const link = await bot.getFileLink(fileId);
  const res = await fetch(link);
  if (!res.ok) throw new Error(`Telegram вернул ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------- старт ----------
async function start(chatId) {
  if (!isTrusted(chatId)) return;
  if (!process.env.ANTHROPIC_API_KEY) return bot.sendMessage(chatId, 'Не задан ANTHROPIC_API_KEY — распознать накладную не смогу 😔');
  if (!fbo.isConfigured()) return bot.sendMessage(chatId, 'Не заданы OZON_API_KEY / OZON_CLIENT_ID — каталог Озона недоступен 😔');
  if (!getTemplate()) {
    awaitingTemplate.add(chatId);
    return bot.sendMessage(chatId, 'Сначала пришли пустой «Шаблон для обновления остатков на всех складах» (xlsx из Озона) — я сохраню его, и потом /приход заработает.');
  }
  sessions.set(chatId, { state: 'collect', sheets: [], queue: Promise.resolve(), touched: Date.now() });
  await bot.sendMessage(
    chatId,
    'Пришли фото товарной накладной — по одному листу на фото (можно несколько). Лучше ровно, при хорошем свете, чтобы был виден весь лист; можно отправить фото как файл — качество будет лучше. Когда все листы отправлены, нажми «Готово».',
    kb([[{ text: '✅ Готово, все листы отправлены', callback_data: `${CB}done` }], cancelRow]),
  );
}

// ---------- фото ----------
async function processImage(chatId, s, fileId, mediaType) {
  const idx = s.sheets.length + s.pendingCount - 1;
  try {
    const buf = await download(fileId);
    const r = await readInvoicePhoto(buf, mediaType);
    if (!r.legible || !r.lines.length) {
      const why = { rotated: 'повёрнуто', blurry: 'нечёткое', cropped: 'обрезано' }[r.problem] || 'не удалось прочитать строки';
      await bot.sendMessage(chatId, `Фото (${why}) — переснимите этот лист ровно, чётко и целиком, и пришлите заново.`);
      return;
    }
    s.sheets.push({ order: idx, data: r });
    const total = r.printed_total !== null && r.printed_total !== undefined ? `, «Итого» ${fmt(r.printed_total)}` : '';
    await bot.sendMessage(chatId, `Лист принят: строк ${r.lines.length}${total}. Ещё лист или «Готово».`,
      kb([[{ text: '✅ Готово', callback_data: `${CB}done` }], cancelRow]));
  } catch (err) {
    await fail(chatId, 'прочитать фото', err);
  } finally {
    s.pendingCount -= 1;
  }
}

function handleMedia(chatId, fileId, mediaType) {
  const s = session(chatId);
  if (!s || s.state !== 'collect') return false;
  s.pendingCount = (s.pendingCount || 0) + 1;
  s.queue = s.queue.then(() => processImage(chatId, s, fileId, mediaType));
  return true;
}

function handlePhoto(msg) {
  if (!isTrusted(msg.chat.id) || msg.chat.type !== 'private') return false;
  const best = msg.photo[msg.photo.length - 1];
  return handleMedia(msg.chat.id, best.file_id, 'image/jpeg');
}

async function handleDocument(msg) {
  const chatId = msg.chat.id;
  if (!isTrusted(chatId) || msg.chat.type !== 'private') return false;
  const doc = msg.document || {};
  const name = doc.file_name || '';
  const caption = (msg.caption || '').trim();
  if ((awaitingTemplate.has(chatId) || /^\/приход_шаблон/.test(caption)) && /\.xlsx$/i.test(name)) {
    try {
      const buf = await download(doc.file_id);
      xlsx.validateTemplate(buf);
      saveTemplate(buf);
      awaitingTemplate.delete(chatId);
      await bot.sendMessage(chatId, '✅ Шаблон сохранён. Теперь /приход.');
    } catch (err) {
      await fail(chatId, 'сохранить шаблон', err);
    }
    return true;
  }
  if (/^image\/(jpeg|png|webp)$/.test(doc.mime_type || '')) return handleMedia(chatId, doc.file_id, doc.mime_type);
  return false;
}

// ---------- сопоставление ----------
async function finishCollecting(chatId, s) {
  await s.queue;
  if (!s.sheets.length) return bot.sendMessage(chatId, 'Пока нет ни одного принятого листа. Пришли фото накладной.');
  s.state = 'matching';
  await bot.sendMessage(chatId, 'Сверяю с каталогом Озона… 🔎');
  try {
    s.sheets.sort((a, b) => a.order - b.order);
    const raw = s.sheets.flatMap((sh) => sh.data.lines);
    s.lines = raw.map((r, i) => ({ ...prepareLine(r), n: i + 1 }));
    const totals = s.sheets.map((sh) => sh.data.printed_total).filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)));
    s.printedTotal = totals.length ? Number(totals[totals.length - 1]) : null;
    const cat = await getCatalog();
    const { families } = buildFamilies(cat.products);
    s.families = families;
    const results = await matchLines(s.lines, families);
    s.lines.forEach((l, i) => {
      const r = results[i];
      l.match = r;
      l.decision = r.status === 'matched' ? { status: 'matched', family: r.family, via: r.via }
        : r.status === 'none' ? { status: 'none', via: r.via } : null;
    });
    s.state = 'resolving';
    await askNextAmbiguous(chatId, s);
  } catch (err) {
    sessions.delete(chatId);
    await fail(chatId, 'сопоставить с каталогом', err);
  }
}

const famLabel = (f) => `${f.title}${f.weightG ? ` (${f.weightG} г)` : ''} · ${f.members.map((m) => m.pieces).join('/')} шт`;

async function askNextAmbiguous(chatId, s) {
  const line = s.lines.find((l) => !l.decision);
  if (!line) return showReview(chatId, s);
  const opts = (line.match.options || []).slice(0, 5);
  line.opts = opts;
  const rows = opts.map((f, i) => [{ text: famLabel(f).slice(0, 60), callback_data: `${CB}pick:${line.n}:${i}` }]);
  rows.push([{ text: '🚫 Нет в Озоне', callback_data: `${CB}pick:${line.n}:x` }]);
  await send(chatId, `❓ Строка ${line.n}: «${line.name}» (${line.qty} шт${line.unitWeightG ? `, ${line.unitWeightG} г` : ''}) — неоднозначно. Какой товар?`, kb(rows));
}

// ---------- отчёт ----------
function buildReport(s) {
  const plan = computePlan(s.lines, s.printedTotal);
  s.plan = plan;
  const L = [];
  L.push('📋 Проверь разнос по накладной');
  L.push('');
  L.push('Строки → семейство:');
  for (const l of s.lines) {
    const d = l.decision;
    if (d.status === 'removed') { L.push(`${l.n}. ${l.name} — убрана`); continue; }
    const target = d.status === 'none' ? '🚫 нет в Озоне' : `→ ${famLabel(d.family)}`;
    const pack = l.packMult > 1 ? ` (${l.printedQty}×${l.packMult})` : '';
    L.push(`${l.n}. ${l.name} — ${fmt(l.qty)} шт${pack}, сумма ${fmt(l.sum)} ${target}`);
    for (const f of l.flags) L.push(`   ⚠️ ${f}`);
  }
  L.push('');
  L.push('Количество по членам семьи:');
  for (const g of plan.groups) {
    L.push(`${g.family.title}${g.family.weightG ? ` (${g.family.weightG} г)` : ''}: всего ${fmt(g.total)} шт (строки ${g.lines.join(', ')})`);
    L.push(`   ${g.members.map((m) => `${m.pieces}шт=${m.qty}`).join(', ')}`);
  }
  if (plan.notInOzon.length) {
    L.push('');
    L.push('🚫 Нет в Озоне (нужна новая карточка):');
    for (const l of plan.notInOzon) L.push(`• ${l.name} — ${fmt(l.qty)} шт`);
  }
  if (plan.remainders.length) {
    L.push('');
    L.push('Остатки от деления (не попадут в файл):');
    for (const r of plan.remainders) L.push(`• ${r.family}, набор ${r.pieces} шт: остаток ${r.remainder} шт`);
  }
  if (plan.zeroSets.length) {
    L.push('');
    L.push(`Наборов 0 (строка в файл не пишется): ${plan.zeroSets.map((z) => `${z.article}`).join(', ')}`);
  }
  L.push('');
  L.push(`${plan.check.ok ? '✅' : '❌'} Сверка: ${plan.check.reason}`);
  return { text: L.join('\n'), plan };
}

async function showReview(chatId, s) {
  s.state = 'review';
  const { text, plan } = buildReport(s);
  const rows = [];
  if (plan.check.ok) rows.push([{ text: '✅ Всё верно', callback_data: `${CB}ok` }]);
  rows.push([{ text: '✏️ Исправить', callback_data: `${CB}fixmenu` }]);
  rows.push(cancelRow);
  let msg = text;
  if (!plan.check.ok) msg += '\n\nФайл не собираю, пока сумма не сойдётся. Нажми «Исправить» (строку или «Итого») или пришли недостающий лист.';
  await send(chatId, msg, kb(rows));
}

// ---------- сборка файла ----------
async function build(chatId, s) {
  const plan = s.plan;
  if (!plan || !plan.check.ok) return bot.sendMessage(chatId, `Сверка не сошлась: ${plan ? plan.check.reason : '—'}. Файл не отправляю.`);
  if (!plan.items.length) return bot.sendMessage(chatId, 'В файл нечего писать (все наборы 0 или нет в Озоне).');
  try {
    const tpl = getTemplate();
    const out = xlsx.fillTemplate(tpl, plan.items);
    xlsx.verifyFilled(tpl, out, plan.items);
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const dd = (n) => String(n).padStart(2, '0');
    const fileName = `Шаблон_остатки_${dd(d.getUTCDate())}_${dd(d.getUTCMonth() + 1)}_${d.getUTCFullYear()}.xlsx`;
    for (const l of s.lines) {
      if (l.decision.status === 'matched' && l.decision.via !== 'карта') {
        try { nameMap.remember(l.name, l.decision.family); } catch (err) { console.error('[prihod] карта названий:', err.message); }
      }
    }
    await bot.sendDocument(chatId, out, { caption: `Строк в файле: ${plan.items.length}. Загрузи в Озон сама — бот туда ничего не пишет.` },
      { filename: fileName, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const S = [`✅ Файл проверен (шапка цела). ${plan.check.reason}.`];
    if (plan.remainders.length) S.push(`Остатки от деления: ${plan.remainders.map((r) => `${r.family} ${r.pieces}шт — ${r.remainder} шт`).join('; ')}.`);
    if (plan.notInOzon.length) S.push(`Нет в Озоне: ${plan.notInOzon.map((l) => `${l.name} (${fmt(l.qty)} шт)`).join('; ')}.`);
    const disputed = s.lines.filter((l) => l.flags.length && l.decision.status !== 'removed');
    if (disputed.length) S.push(`Спорное: ${disputed.map((l) => `стр. ${l.n} — ${l.flags.join(', ')}`).join('; ')}.`);
    await send(chatId, S.join('\n'));
    sessions.delete(chatId);
  } catch (err) {
    await fail(chatId, 'собрать файл (файл не отправлен)', err);
  }
}

// ---------- исправление ----------
async function fixMenu(chatId, s) {
  const rows = s.lines.filter((l) => l.decision.status !== 'removed').map((l) => [{ text: `${l.n}. ${l.name}`.slice(0, 60), callback_data: `${CB}fix:${l.n}` }]);
  rows.push([{ text: '🧾 Поправить «Итого»', callback_data: `${CB}total` }]);
  rows.push([{ text: '⬅️ Назад к таблице', callback_data: `${CB}back` }]);
  await bot.sendMessage(chatId, 'Что исправить?', kb(rows));
}

async function fixLine(chatId, s, n) {
  const l = s.lines.find((x) => x.n === n);
  if (!l) return;
  await bot.sendMessage(chatId, `Строка ${n}: «${l.name}», ${fmt(l.qty)} шт, сумма ${fmt(l.sum)}`, kb([
    [{ text: 'Кол-во', callback_data: `${CB}fq:${n}` }, { text: 'Сумма', callback_data: `${CB}fs:${n}` }],
    [{ text: 'Другой товар', callback_data: `${CB}fp:${n}` }, { text: '🚫 Нет в Озоне', callback_data: `${CB}pick:${n}:x` }],
    [{ text: '🗑 Убрать строку', callback_data: `${CB}del:${n}` }],
    [{ text: '⬅️ Назад', callback_data: `${CB}fixmenu` }],
  ]));
}

const parseNum = (t) => {
  const v = Number(String(t).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(v) && v >= 0 ? v : null;
};

async function handleText(msg) {
  const chatId = msg.chat.id;
  const s = session(chatId);
  if (!s || !s.input || !msg.text || msg.text.startsWith('/')) return false;
  const { kind, n } = s.input;
  const l = s.lines && s.lines.find((x) => x.n === n);
  if (kind === 'search') {
    s.input = null;
    const cands = candidatesFor({ name: msg.text, unitWeightG: l && l.unitWeightG }, s.families);
    if (!cands.length) { await bot.sendMessage(chatId, 'Ничего похожего в каталоге. Попробуй иначе или нажми «Нет в Озоне».'); s.input = { kind: 'search', n }; return true; }
    l.match = { status: 'ambiguous', options: cands };
    l.decision = null;
    await askNextAmbiguous(chatId, s);
    return true;
  }
  const v = parseNum(msg.text);
  if (v === null) { await bot.sendMessage(chatId, 'Нужно число, например 55 или 120,5.'); return true; }
  s.input = null;
  if (kind === 'qty') { l.qty = v; l.printedQty = v; l.packMult = 1; l.flags = []; }
  if (kind === 'sum') { l.sum = v; l.flags = l.flags.filter((f) => !f.startsWith('кол-во×цена')); }
  if (kind === 'total') s.printedTotal = v;
  await showReview(chatId, s);
  return true;
}

// ---------- кнопки ----------
async function onCallback(query) {
  const data = query.data || '';
  if (!data.startsWith(CB)) return;
  const chatId = query.message && query.message.chat.id;
  try { await bot.answerCallbackQuery(query.id); } catch { /* ignore */ }
  if (!chatId || !isTrusted(query.from && query.from.id)) return;
  const cmd = data.slice(CB.length);
  if (cmd === 'cancel') { sessions.delete(chatId); return bot.sendMessage(chatId, 'Отменено. /приход — начать заново.'); }
  const s = session(chatId);
  if (!s) return bot.sendMessage(chatId, 'Сессия закончилась. /приход — начать заново.');
  try {
    if (cmd === 'done' && s.state === 'collect') return await finishCollecting(chatId, s);
    if (!s.lines) return undefined;
    const [op, a, b] = cmd.split(':');
    const n = Number(a);
    if (op === 'pick') {
      const l = s.lines.find((x) => x.n === n);
      if (!l) return undefined;
      if (b === 'x') l.decision = { status: 'none', via: 'Елена: нет в Озоне' };
      else {
        const f = (l.opts || l.match.options || [])[Number(b)];
        if (!f) return undefined;
        l.decision = { status: 'matched', family: f, via: 'Елена' };
      }
      l.flags = l.flags || [];
      return s.lines.some((x) => !x.decision) ? await askNextAmbiguous(chatId, s) : await showReview(chatId, s);
    }
    if (cmd === 'ok') {
      if (s.state !== 'review') return undefined;
      return await build(chatId, s);
    }
    if (cmd === 'fixmenu') return await fixMenu(chatId, s);
    if (cmd === 'back') return await showReview(chatId, s);
    if (op === 'fix') return await fixLine(chatId, s, n);
    if (op === 'del') { s.lines.find((x) => x.n === n).decision = { status: 'removed' }; return await showReview(chatId, s); }
    if (op === 'fq') { s.input = { kind: 'qty', n }; return await bot.sendMessage(chatId, `Строка ${n}: напиши правильное количество штук числом.`); }
    if (op === 'fs') { s.input = { kind: 'sum', n }; return await bot.sendMessage(chatId, `Строка ${n}: напиши правильную сумму числом.`); }
    if (op === 'fp') { s.input = { kind: 'search', n }; return await bot.sendMessage(chatId, `Строка ${n}: напиши часть названия товара из Озона (вкус, бренд, вес).`); }
    if (cmd === 'total') { s.input = { kind: 'total', n: 0 }; return await bot.sendMessage(chatId, 'Напиши печатное «Итого» накладной числом.'); }
  } catch (err) {
    await fail(chatId, 'обработать кнопку', err);
  }
  return undefined;
}

function init(botInstance, { isTrustedUser }) {
  bot = botInstance;
  isTrusted = isTrustedUser;
  bot.onText(/^\/приход(?:@\S+)?$/, (msg) => { start(msg.chat.id).catch((e) => fail(msg.chat.id, 'запустить /приход', e)); });
  bot.onText(/^\/приход_шаблон(?:@\S+)?$/, (msg) => {
    if (!isTrusted(msg.chat.id)) return;
    awaitingTemplate.add(msg.chat.id);
    bot.sendMessage(msg.chat.id, 'Пришли пустой «Шаблон для обновления остатков на всех складах» (xlsx) — он заменит сохранённый.');
  });
  bot.on('callback_query', (q) => { onCallback(q).catch((e) => console.error('[prihod] callback:', e.message)); });
  return { handlePhoto, handleDocument, handleText };
}

module.exports = { init, buildReport };
