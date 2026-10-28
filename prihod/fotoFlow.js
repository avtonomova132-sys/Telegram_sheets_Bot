// /остатки_фото (алиас /вк): фото этикетки с подписью-остатком → штрихкод (zbar) →
// семья артикулов Озона → «было → стало» → после «Применить» бот САМ вносит
// остатки в Озон отдельным ключом OZON_STOCK_WRITE_KEY (без ключа или без прав —
// xlsx «Шаблон для обновления остатков на всех складах», как в /приход).
//
// Вход независим от источника: (фото, подпись, автор, время, id). Версия 1 —
// фото с подписью пересылает Елена в Telegram; в ВК бот ничего не пишет и
// ничего оттуда не читает. Фото на диск не сохраняются: в /data лежат только
// артикул, штрихкод, число, автор, время.

const fs = require('fs');
const path = require('path');
const { decode, normBarcode } = require('./barcode');
const { readLabel } = require('./fotoVision');
const { parseCaption, parseBareNumber, findAuthor } = require('./fotoCaption');
const { makeContext, resolveProduct, remember, buildPlan, buildText } = require('./fotoPlan');
const { getCatalog } = require('./catalog');
const { findFamilyByArticle } = require('./family');
const ozonStock = require('./ozonStock');
const supplier = require('./supplier');
const xlsx = require('./xlsxFill');
const fbo = require('../fbo');
const { dense } = require('./text');

const CB = 'fto:';
const DATA_DIR = process.env.FOTO_DATA_DIR || '/data';
const FILES = {
  seen: path.join(DATA_DIR, 'foto_seen.json'),
  last: path.join(DATA_DIR, 'foto_last.json'),
  batches: path.join(DATA_DIR, 'foto_batches.json'),
  state: path.join(DATA_DIR, 'foto_state.json'),
};
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
const QUIET_MS = Number(process.env.FOTO_QUIET_MS || 25000);
const MAX_CHANGES = 30; // больше — второе подтверждение
const MAX_GROWTH = 50; // рост остатка одной карточки больше — второе подтверждение
const VERIFY_DELAY_MS = Number(process.env.FOTO_VERIFY_DELAY_MS || 4000);
const QTY_BUTTONS = [0, 1, 2, 3, 4, 5, 10];

let bot;
let isTrusted = () => false;
const sessions = new Map();
// подмена в тестах
const deps = { ozonStock, getCatalog, articlesByBarcode: (c) => supplier.articlesByBarcode(c), readLabel, decode };

// ---------- хранилище /data ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[foto] не записала', file, err.message);
  }
}
const seenStore = () => readJson(FILES.seen, { keys: {} });
function markSeen(keys) {
  const d = seenStore();
  const now = Date.now();
  for (const k of keys) d.keys[k] = now;
  const entries = Object.entries(d.keys).sort((a, b) => b[1] - a[1]).slice(0, 3000);
  writeJson(FILES.seen, { keys: Object.fromEntries(entries) });
}
const isSeen = (key) => Boolean(key && seenStore().keys[key]);
const lastTotals = () => readJson(FILES.last, {});
function saveLast(groups, ts) {
  const d = lastTotals();
  for (const g of groups) d[g.family.id] = { total: g.total, ts, author: g.author || null };
  writeJson(FILES.last, d);
}
const firstWriteDone = () => Boolean(readJson(FILES.state, {}).firstWriteDone);
const setFirstWriteDone = () => writeJson(FILES.state, { ...readJson(FILES.state, {}), firstWriteDone: true, at: new Date().toISOString() });
function saveBatch(batch) {
  const list = readJson(FILES.batches, []).filter((b) => b.id !== batch.id);
  list.push(batch);
  writeJson(FILES.batches, list.slice(-20));
}
const getBatch = (id) => readJson(FILES.batches, []).find((b) => b.id === id) || null;

// ---------- мелочи ----------
const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });
const fmt = (n) => (n === null || n === undefined ? '?' : String(n));

async function send(chatId, text, extra) {
  const chunks = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    if (cur && cur.length + line.length + 1 > 3800) { chunks.push(cur); cur = line; } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) chunks.push(cur);
  let last;
  for (let i = 0; i < chunks.length; i += 1) last = await bot.sendMessage(chatId, chunks[i], i === chunks.length - 1 ? extra : undefined);
  return last;
}

async function fail(chatId, what, err) {
  console.error(`[foto] ${what}:`, err.message);
  await bot.sendMessage(chatId, `Не получилось: ${what} 😔 ${err.message}`).catch(() => {});
}

function session(chatId) {
  const s = sessions.get(chatId);
  if (s && Date.now() - s.touched > SESSION_TTL_MS) { clearTimeout(s.timer); sessions.delete(chatId); return null; }
  if (s) s.touched = Date.now();
  return s || null;
}

function needsSecondConfirm(rows) {
  return {
    count: rows.length > MAX_CHANGES,
    growth: rows.some((r) => r.was !== null && r.was !== undefined && r.qty - r.was > MAX_GROWTH),
  };
}

let ctxCache = null;
async function getContext(force = false) {
  if (!force && ctxCache && Date.now() - ctxCache.at < 10 * 60 * 1000) return ctxCache.ctx;
  const { products } = await deps.getCatalog();
  ctxCache = { at: Date.now(), ctx: makeContext(products) };
  return ctxCache.ctx;
}

const famLabel = (f) => `${f.title} (${f.weightG ? `${f.weightG} г, ` : ''}${f.members.map((m) => m.pieces).join('/')} шт)`.slice(0, 64);
const itemTitle = (it) => (it.family ? it.family.title : (it.label && (it.label.name || it.label.article)) || (it.codes[0] ? `ШК ${it.codes[0]}` : 'товар не определён'));

function authorOf(msg, captionAuthor) {
  if (captionAuthor) return captionAuthor;
  const fo = msg.forward_origin;
  const raw = (fo && ((fo.sender_user && [fo.sender_user.first_name, fo.sender_user.last_name].filter(Boolean).join(' ')) || fo.sender_user_name || (fo.chat && fo.chat.title)))
    || (msg.forward_from && [msg.forward_from.first_name, msg.forward_from.last_name].filter(Boolean).join(' '))
    || msg.forward_sender_name || '';
  return findAuthor(raw) || raw || null;
}

// ---------- старт ----------
async function start(chatId, arg) {
  if (!isTrusted(chatId)) return;
  if (!fbo.isConfigured()) return bot.sendMessage(chatId, 'Не заданы OZON_API_KEY / OZON_CLIENT_ID — каталог Озона недоступен 😔');
  const old = sessions.get(chatId);
  if (old) clearTimeout(old.timer);
  const dry = /сух|dry|тест/i.test(arg || '');
  sessions.set(chatId, { items: [], queue: Promise.resolve(), pending: 0, touched: Date.now(), rev: 0, dry, input: null, asking: null, statusMsg: null, state: 'collect', timer: null });
  await bot.sendMessage(
    chatId,
    `Пришли фото этикетки с подписью-остатком (можно несколько подряд — это одна партия). Фото без подписи — спрошу «Сколько штук?».${dry ? '\n🧪 Сухой прогон: в Озон ничего не отправляю.' : ''}\nКогда всё отправлено, я сама покажу проверку (или нажми «Готово»).`,
    kb([[{ text: '✅ Готово', callback_data: `${CB}done` }, { text: '❌ Отмена', callback_data: `${CB}cancel` }]]),
  );
}

// ---------- приём фото ----------
function enqueue(chatId, s, input) {
  s.pending += 1;
  s.state = 'collect';
  s.rev += 1;
  clearTimeout(s.timer);
  s.queue = s.queue.then(() => processPhoto(chatId, s, input)).catch((err) => fail(chatId, 'обработать фото', err)).finally(() => {
    s.pending -= 1;
    settle(chatId, s).catch((err) => fail(chatId, 'продолжить', err));
  });
}

function handlePhoto(msg) {
  if (!isTrusted(msg.chat.id) || msg.chat.type !== 'private') return false;
  const s = session(msg.chat.id);
  if (!s) return false;
  const best = msg.photo[msg.photo.length - 1];
  enqueue(msg.chat.id, s, { fileId: best.file_id, uniqueId: best.file_unique_id, mediaType: 'image/jpeg', msg });
  return true;
}

async function handleDocument(msg) {
  if (!isTrusted(msg.chat.id) || msg.chat.type !== 'private' || !msg.document) return false;
  const s = session(msg.chat.id);
  if (!s || !/^image\/(jpeg|png|webp)/i.test(msg.document.mime_type || '')) return false;
  enqueue(msg.chat.id, s, { fileId: msg.document.file_id, uniqueId: msg.document.file_unique_id, mediaType: msg.document.mime_type, msg });
  return true;
}

async function download(fileId) {
  const link = await bot.getFileLink(fileId);
  const res = await fetch(link);
  if (!res.ok) throw new Error(`Telegram вернул ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Конвейер на одно фото: вход = (фото, подпись, автор, время, id).
async function processPhoto(chatId, s, { fileId, uniqueId, mediaType, msg }) {
  const id = `m${msg.message_id}`;
  const seenKey = uniqueId || id;
  if (s.items.some((x) => x.seenKey === seenKey) || isSeen(seenKey)) {
    await bot.sendMessage(chatId, 'Это фото я уже обрабатывала — второй раз не беру.', { reply_to_message_id: msg.message_id });
    return;
  }
  const cap = parseCaption(msg.caption || '');
  const item = {
    id, seenKey, author: authorOf(msg, cap.author), ts: (msg.forward_date || msg.date || Math.floor(Date.now() / 1000)) * 1000,
    msgId: msg.message_id, caption: cap, qty: cap.state === 'ok' ? cap.value : null, qtyAsked: false,
    codes: [], label: null, family: null, res: null, status: 'processing', notFoundText: null,
  };
  s.items.push(item);

  const ctx = await getContext();
  const buf = await download(fileId);
  const ext = /png/i.test(mediaType) ? 'png' : 'jpg';
  const dec = await deps.decode(buf, { ext });
  item.codes = dec.codes;
  let res = await resolveProduct({ codes: item.codes, label: null }, ctx, { articlesByBarcode: deps.articlesByBarcode });
  // vision — только запасной вариант: штрихкод не прочитан или товар по нему не нашёлся
  if (res.status !== 'matched' && res.status !== 'unsplit') {
    try {
      const label = await deps.readLabel(buf, mediaType);
      item.label = label;
      const extra = normBarcode(label.barcodeDigits) && !item.codes.map(normBarcode).includes(normBarcode(label.barcodeDigits)) ? [label.barcodeDigits] : [];
      item.codes = [...item.codes, ...extra];
      res = await resolveProduct({ codes: item.codes, label }, ctx, { articlesByBarcode: deps.articlesByBarcode });
    } catch (err) {
      console.error('[foto] этикетка моделью:', err.message);
    }
  }
  applyResolution(item, res);
  if (!dec.available) console.log('[foto] zbarimg не установлен — штрихкод программно не читается');
}

function applyResolution(item, res) {
  item.res = res;
  if (res.status === 'matched') { item.family = res.family; item.status = 'ready'; return; }
  if (res.status === 'unsplit') {
    item.status = 'notFound';
    item.notFoundText = `${res.product.article} есть в Озоне, но не попал в семьи (архив или размер набора вне списка) — остаток не ставлю`;
    return;
  }
  if (res.status === 'none' && res.remembered) {
    item.status = 'notFound';
    item.notFoundText = `${itemTitle(item)} — «нет в Озоне» (как решено раньше)`;
    return;
  }
  item.status = 'needProduct';
}

// ---------- вопросы ----------
function nextNeed(s) {
  const open = s.items.filter((it) => it.status !== 'dropped');
  const p = open.find((it) => it.status === 'needProduct');
  if (p) return { kind: 'product', item: p };
  const q = open.find((it) => it.status === 'ready' && it.qty === null && !it.skipQty);
  if (q) return { kind: 'qty', item: q };
  return null;
}

async function settle(chatId, s) {
  if (sessions.get(chatId) !== s || s.pending > 0) return;
  if (s.asking) return;
  const need = nextNeed(s);
  if (need) return ask(chatId, s, need);
  await updateStatus(chatId, s);
  clearTimeout(s.timer);
  if (s.state === 'collect' && s.items.some((it) => it.status === 'ready')) {
    s.timer = setTimeout(() => { showReview(chatId, s).catch((e) => fail(chatId, 'показать проверку', e)); }, QUIET_MS);
  }
}

async function updateStatus(chatId, s) {
  const n = s.items.filter((it) => it.status !== 'dropped').length;
  const text = `📷 Принято фото: ${n}. Ещё фото — присылай, через ${Math.round(QUIET_MS / 1000)} с покажу проверку, или нажми «Готово».`;
  const markup = kb([[{ text: '✅ Готово', callback_data: `${CB}done` }, { text: '❌ Отмена', callback_data: `${CB}cancel` }]]);
  if (s.statusMsg) {
    try { await bot.editMessageText(text, { chat_id: chatId, message_id: s.statusMsg, ...markup }); return; } catch { /* текст тот же или сообщение удалено */ }
  }
  const m = await bot.sendMessage(chatId, text, markup);
  s.statusMsg = m.message_id;
}

function qtyKeyboard(item, extraNumbers = []) {
  const nums = [...new Set([...extraNumbers, ...QTY_BUTTONS])];
  const rows = [];
  for (let i = 0; i < nums.length; i += 4) rows.push(nums.slice(i, i + 4).map((n) => ({ text: String(n), callback_data: `${CB}q:${item.id}:${n}` })));
  rows.push([{ text: 'Другое', callback_data: `${CB}qo:${item.id}` }, { text: 'Пропустить', callback_data: `${CB}qs:${item.id}` }]);
  return kb(rows);
}

async function ask(chatId, s, need) {
  const { item } = need;
  s.asking = item.id;
  const reply = { reply_to_message_id: item.msgId };
  if (need.kind === 'qty') {
    const cap = item.caption;
    const head = cap.state === 'ambiguous' ? `Подпись «${cap.text}» неясная (${cap.why}).` : 'Фото без подписи.';
    item.qtyAsked = true;
    await bot.sendMessage(chatId, `${head} Сколько штук? ${itemTitle(item)}`, { ...reply, ...qtyKeyboard(item, cap.state === 'ambiguous' ? cap.numbers : []) });
    return;
  }
  const opts = (item.res && item.res.options) || [];
  const rows = opts.map((f, i) => [{ text: famLabel(f), callback_data: `${CB}pk:${item.id}:${i}` }]);
  rows.push([{ text: '✏️ Ввести артикул', callback_data: `${CB}art:${item.id}` }, { text: '🚫 Нет в Озоне', callback_data: `${CB}none:${item.id}` }]);
  const seen = item.codes.length ? `штрихкод ${item.codes[0]}` : 'штрихкод не прочитан';
  const lab = item.label ? `, на этикетке: ${[item.label.article && `Арт ${item.label.article}`, item.label.name].filter(Boolean).join(', ') || '—'}` : '';
  await bot.sendMessage(chatId, `Не нашёл товар (${seen}${lab}). Какой это?${opts.length ? '' : ' Похожих нет — введи артикул.'}`, { ...reply, ...kb(rows) });
}

// ---------- проверка ----------
async function showReview(chatId, s) {
  if (sessions.get(chatId) !== s || s.pending > 0) return;
  clearTimeout(s.timer);
  const need = nextNeed(s);
  if (need) { s.asking = null; return ask(chatId, s, need); }
  const ready = s.items.filter((it) => it.status === 'ready' && it.qty !== null);
  const notFound = s.items.filter((it) => it.status === 'notFound').map((it) => ({ author: it.author, text: it.notFoundText || itemTitle(it) }));
  const unclear = s.items.filter((it) => it.status === 'ready' && it.qty === null).map((it) => ({ author: it.author, text: it.caption.text || 'без подписи' }));
  if (!ready.length) {
    s.state = 'collect';
    return send(chatId, `Вносить пока нечего.${notFound.length ? `\n\nНе нашёл:\n${notFound.map((x) => x.text).join('\n')}` : ''}\nПришли ещё фото или /отмена.`,
      kb([[{ text: '❌ Отмена', callback_data: `${CB}cancel` }]]));
  }
  const ctx = await getContext();
  const articles = [...new Set(ready.flatMap((it) => it.family.members.map((m) => m.article)))];
  let stocks = null;
  try { stocks = await deps.ozonStock.readStocks(articles); } catch (err) { console.error('[foto] чтение остатков Озона:', err.message); }
  const items = ready.map((it) => ({ id: it.id, author: it.author, ts: it.ts, qty: it.qty, family: it.family }));
  const plan = buildPlan(items, ctx, stocks, lastTotals());
  s.plan = plan;
  s.view = { notFound, unclear };
  s.state = 'review';
  s.rev += 1;
  const changes = plan.writes.length;
  const rows = [];
  if (changes) rows.push([{ text: `✅ Применить (${changes})`, callback_data: `${CB}apply:${s.rev}` }]);
  rows.push([{ text: '✏️ Правка', callback_data: `${CB}fix:${s.rev}` }, { text: '❌ Отмена', callback_data: `${CB}cancel` }]);
  const tail = changes ? '' : '\n\nИзменений нет — все остатки уже такие.';
  await send(chatId, `${buildText(plan, s.view)}${tail}${s.dry ? '\n\n🧪 Сухой прогон: в Озон не отправляю.' : ''}`, kb(rows));
}

// ---------- применение ----------
async function sendFallbackXlsx(chatId, s, rows, why) {
  const { getTemplate } = require('./flow');
  const tpl = getTemplate();
  if (!tpl) return bot.sendMessage(chatId, `${why}\nИ шаблона xlsx тоже нет: пришли пустой «Шаблон для обновления остатков на всех складах» командой /приход_шаблон.`);
  const items = rows.map((r) => ({ article: r.article, qty: r.qty }));
  const out = xlsx.fillTemplate(tpl, items);
  xlsx.verifyFilled(tpl, out, items);
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const dd = (n) => String(n).padStart(2, '0');
  await bot.sendDocument(chatId, out, { caption: `${why}\nСобрала файл для загрузки в Озон: строк ${items.length}. Это установка остатка, не прибавка.` },
    { filename: `Шаблон_остатки_${dd(d.getUTCDate())}_${dd(d.getUTCMonth() + 1)}_${d.getUTCFullYear()}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  finishBatch(s);
}

function finishBatch(s, applied = true) {
  if (!applied) return;
  markSeen(s.items.map((it) => it.seenKey));
  if (s.plan) saveLast(s.plan.groups, Date.now());
}

async function onApply(chatId, s) {
  const rows = s.plan.writes;
  if (!rows.length) return send(chatId, 'Нечего вносить.');
  if (s.dry) {
    return send(chatId, `🧪 Сухой прогон: отправила бы в Озон (склад ${deps.ozonStock.WAREHOUSE_ID()}) ${rows.length} строк:\n${rows.map((r) => `${r.article} → ${r.qty}`).join('\n')}\nНичего не записано.`);
  }
  if (!deps.ozonStock.hasWriteKey()) {
    return sendFallbackXlsx(chatId, s, rows, '🔑 Ключа записи остатков (OZON_STOCK_WRITE_KEY) нет — внести сама не могу.');
  }
  if (!firstWriteDone()) {
    const r = rows[0];
    s.input = { kind: 'first_yes', row: r };
    return send(chatId, `🔒 Первая запись в Озон — только на одной позиции:\n${r.article}: ${fmt(r.was)} → ${r.qty} (склад ${deps.ozonStock.WAREHOUSE_ID()})\nНапиши «да», чтобы внести. Остальные позиции после этого — кнопкой «Применить».`);
  }
  const sc = needsSecondConfirm(rows);
  if (sc.count || sc.growth) {
    const why = [sc.count && `изменений больше ${MAX_CHANGES} (${rows.length})`, sc.growth && `остаток одной карточки растёт больше чем на ${MAX_GROWTH} шт`].filter(Boolean).join('; ');
    return send(chatId, `⚠️ ${why}. Точно вносить?`, kb([[{ text: `Да, внести ${rows.length}`, callback_data: `${CB}apply2:${s.rev}` }, { text: '❌ Отмена', callback_data: `${CB}cancel` }]]));
  }
  return performWrite(chatId, s, rows);
}

async function verify(rows) {
  await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
  const now = await deps.ozonStock.readStocks(rows.map((r) => r.article));
  const bad = rows.filter((r) => !now.has(r.article) || now.get(r.article).stock !== r.qty)
    .map((r) => ({ article: r.article, want: r.qty, got: now.has(r.article) ? now.get(r.article).stock : null }));
  return bad;
}

async function performWrite(chatId, s, rows, { first = false } = {}) {
  const batch = { id: `b${Date.now()}`, ts: Date.now(), rows: rows.map((r) => ({ article: r.article, was: r.was, qty: r.qty })), applied: [] };
  saveBatch(batch); // прежние значения сохраняем ДО записи
  let results;
  try {
    results = await deps.ozonStock.writeStocks(rows.map((r) => ({ article: r.article, productId: r.productId, stock: r.qty })));
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      return sendFallbackXlsx(chatId, s, s.plan.writes, `🔑 Ключ записи не подошёл (${err.message.slice(0, 120)}). Скорее всего у ключа нет права на остатки — смотри инструкцию по ролям.`);
    }
    return send(chatId, `Не получилось внести остатки: ${err.message}\nПовторно сама не отправляю — скажи, когда пробовать ещё раз.`);
  }
  const ok = results.filter((x) => x.ok);
  const errs = results.filter((x) => !x.ok);
  batch.applied = ok.map((x) => x.article);
  saveBatch(batch);
  let mismatch = [];
  try { mismatch = ok.length ? await verify(rows.filter((r) => batch.applied.includes(r.article))) : []; } catch (err) {
    mismatch = [{ article: '—', want: '', got: `сверка не удалась: ${err.message}` }];
  }
  const L = [];
  if (!errs.length && !mismatch.length) L.push(`✅ внесено: ${ok.length}`);
  else {
    if (ok.length) L.push(`Отправлено: ${ok.length}`);
    if (errs.length) L.push('❌ Ошибки Озона (повторно не отправляю):', ...errs.map((e) => `${e.article}: ${e.error}`));
    if (mismatch.length) L.push('⚠️ Расхождения после сверки:', ...mismatch.map((m) => `${m.article}: должно быть ${m.want}, в Озоне ${fmt(m.got)}`));
  }
  const clean = !errs.length && !mismatch.length;
  if (first && clean) { setFirstWriteDone(); L.push('Первая запись прошла и сошлась — дальше обычный режим. Для остальных позиций нажми «Применить» ещё раз.'); }
  if (!first && clean) finishBatch(s);
  const buttons = ok.length ? [[{ text: '↩️ Откатить', callback_data: `${CB}undo:${batch.id}` }]] : [];
  if (first && clean) {
    await send(chatId, L.join('\n'), kb(buttons));
    s.state = 'collect';
    return showReview(chatId, s);
  }
  if (clean) { sessions.delete(chatId); clearTimeout(s.timer); }
  return send(chatId, L.join('\n'), buttons.length ? kb(buttons) : undefined);
}

async function onUndo(chatId, batchId) {
  const batch = getBatch(batchId);
  if (!batch) return send(chatId, 'Эту запись не нашла — откатывать нечего.');
  const rows = batch.rows.filter((r) => batch.applied.includes(r.article) && r.was !== null && r.was !== undefined).map((r) => ({ article: r.article, stock: r.was, qty: r.was }));
  const skipped = batch.rows.filter((r) => batch.applied.includes(r.article) && (r.was === null || r.was === undefined));
  if (!rows.length) return send(chatId, 'Прежние значения не сохранились — откатить нечего.');
  const cur = await deps.ozonStock.readStocks(rows.map((r) => r.article)).catch(() => new Map());
  for (const r of rows) r.productId = cur.has(r.article) ? cur.get(r.article).productId : null;
  let results;
  try { results = await deps.ozonStock.writeStocks(rows); } catch (err) {
    return send(chatId, `Откат не удался: ${err.message}`);
  }
  const errs = results.filter((x) => !x.ok);
  let mismatch = [];
  try { mismatch = await verify(rows.filter((r) => results.find((x) => x.article === r.article && x.ok))); } catch { /* ниже сообщим */ }
  const L = [errs.length ? `Откат: вернула ${results.length - errs.length} из ${results.length}` : `↩️ Откатила: ${results.length}`];
  if (errs.length) L.push(...errs.map((e) => `${e.article}: ${e.error}${/раз в 2 минуты|TOO_MANY|2 min/i.test(e.error) ? ' (Озон меняет один товар не чаще раза в 2 минуты — повтори позже)' : ''}`));
  if (mismatch.length) L.push('⚠️ Расхождения:', ...mismatch.map((m) => `${m.article}: должно быть ${m.want}, в Озоне ${fmt(m.got)}`));
  if (skipped.length) L.push(`Без прежнего значения (не откатываю): ${skipped.map((r) => r.article).join(', ')}`);
  return send(chatId, L.join('\n'));
}

// ---------- правка ----------
async function fixMenu(chatId, s) {
  const open = s.items.filter((it) => it.status !== 'dropped');
  const rows = open.map((it, i) => [{ text: `${i + 1}. ${it.author || '—'} · ${itemTitle(it)} · ${it.qty === null ? '?' : it.qty}`.slice(0, 60), callback_data: `${CB}fi:${it.id}` }]);
  rows.push([{ text: '⬅️ Назад к проверке', callback_data: `${CB}back` }]);
  return send(chatId, 'Что поправить?', kb(rows));
}

// ---------- текст ----------
async function handleText(msg) {
  const chatId = msg.chat.id;
  const s = msg.chat.type === 'private' && isTrusted(chatId) ? session(chatId) : null;
  if (!s || !msg.text || msg.text.startsWith('/')) return false;
  const text = msg.text.trim();
  if (s.input) {
    const inp = s.input;
    if (inp.kind === 'first_yes') {
      s.input = null;
      if (/^да(?![а-яё])/i.test(text)) { await performWrite(chatId, s, [inp.row], { first: true }); return true; }
      await bot.sendMessage(chatId, 'Хорошо, ничего не вношу.');
      return true;
    }
    const item = s.items.find((it) => it.id === inp.itemId);
    if (!item) { s.input = null; return false; }
    if (inp.kind === 'qty') {
      const n = parseBareNumber(text);
      if (n === null) { await bot.sendMessage(chatId, 'Нужно целое число, например 4 или 0.'); return true; }
      s.input = null;
      setQty(item, n);
      s.asking = null;
      await afterChange(chatId, s);
      return true;
    }
    if (inp.kind === 'article') {
      const ctx = await getContext();
      const fam = findFamilyByArticle(ctx.families, text);
      if (!fam) {
        const want = dense(text);
        const near = ctx.products.filter((p) => want && dense(p.article).startsWith(want.slice(0, 6))).slice(0, 8).map((p) => p.article);
        await bot.sendMessage(chatId, `Артикула «${text}» нет среди карточек Озона.${near.length ? `\nПохожие по началу: ${near.join(', ')}` : ''}\nПришли артикул ещё раз.`);
        return true;
      }
      s.input = null;
      chooseFamily(item, fam);
      s.asking = null;
      await bot.sendMessage(chatId, `Принято: ${itemTitle(item)} (${fam.members.map((m) => m.pieces).join('/')} шт). Запомнила.`);
      await afterChange(chatId, s);
      return true;
    }
    return false;
  }
  // число отдельным сообщением → к самому раннему фото без числа
  const n = parseBareNumber(text);
  if (n !== null) {
    const target = s.items.find((it) => it.status === 'ready' && it.qty === null && !it.skipQty) || s.items.find((it) => it.status === 'ready' && it.qty === null);
    if (target) {
      setQty(target, n);
      if (s.asking === target.id) s.asking = null;
      await afterChange(chatId, s);
      return true;
    }
  }
  return false;
}

function setQty(item, n) { item.qty = n; item.skipQty = false; }

function chooseFamily(item, fam) {
  item.family = fam;
  item.status = 'ready';
  item.res = { status: 'matched', family: fam, via: 'выбор Елены' };
  remember(item, fam);
}

async function afterChange(chatId, s) {
  s.state = 'collect';
  s.rev += 1;
  const need = nextNeed(s);
  if (need) { s.asking = null; return ask(chatId, s, need); }
  if (s.pending === 0) return showReview(chatId, s);
  return undefined;
}

// ---------- кнопки ----------
async function onCallback(query) {
  const data = query.data || '';
  if (!data.startsWith(CB)) return;
  const chatId = query.message && query.message.chat.id;
  if (!chatId || !isTrusted(chatId)) return;
  const answer = (text) => bot.answerCallbackQuery(query.id, text ? { text } : undefined).catch(() => {});
  const [cmd, ...rest] = data.slice(CB.length).split(':');
  const s = session(chatId);

  if (cmd === 'undo') { await answer(); return onUndo(chatId, rest[0]).catch((e) => fail(chatId, 'откатить', e)); }
  if (cmd === 'cancel') {
    await answer('Отменено');
    if (s) { clearTimeout(s.timer); sessions.delete(chatId); }
    return bot.sendMessage(chatId, 'Отменила. Ничего не внесено, фото не сохранялись.');
  }
  if (!s) { await answer('Сессия закончилась'); return bot.sendMessage(chatId, 'Сессия /остатки_фото закончилась — начни заново.'); }
  await answer();

  if (cmd === 'done') { if (s.state === 'review' && s.plan) return undefined; return showReview(chatId, s); }
  if (cmd === 'apply' || cmd === 'apply2') {
    if (Number(rest[0]) !== s.rev || !s.plan) return bot.sendMessage(chatId, 'Эта проверка устарела — смотри последнюю.');
    if (cmd === 'apply2') return performWrite(chatId, s, s.plan.writes);
    return onApply(chatId, s);
  }
  if (cmd === 'fix') { if (Number(rest[0]) !== s.rev) return undefined; return fixMenu(chatId, s); }
  if (cmd === 'back') return showReview(chatId, s);

  // ниже: действия над конкретным фото
  const item = s.items.find((it) => it.id === rest[0]);
  const tail = rest[1];
  if (!item) return bot.sendMessage(chatId, 'Это фото уже не в списке.');

  if (cmd === 'q') {
    setQty(item, Number(tail));
    if (s.asking === item.id) s.asking = null;
    return afterChange(chatId, s);
  }
  if (cmd === 'qo') { s.input = { kind: 'qty', itemId: item.id }; return bot.sendMessage(chatId, 'Напиши число штук.'); }
  if (cmd === 'qs') { item.skipQty = true; if (s.asking === item.id) s.asking = null; return afterChange(chatId, s); }
  if (cmd === 'pk') {
    const fam = item.res && item.res.options && item.res.options[Number(tail)];
    if (!fam) return undefined;
    chooseFamily(item, fam);
    if (s.asking === item.id) s.asking = null;
    return afterChange(chatId, s);
  }
  if (cmd === 'art') { s.input = { kind: 'article', itemId: item.id }; return bot.sendMessage(chatId, 'Пришли артикул Озона (offer_id) любого размера набора.'); }
  if (cmd === 'none') {
    remember(item, null);
    item.status = 'notFound';
    item.notFoundText = `${itemTitle(item)} — нет в Озоне (по твоей кнопке)`;
    if (s.asking === item.id) s.asking = null;
    return afterChange(chatId, s);
  }
  if (cmd === 'fi') {
    return send(chatId, `${item.author || '—'} · ${itemTitle(item)} · ${item.qty === null ? '?' : item.qty} шт`, kb([
      [{ text: 'Кол-во', callback_data: `${CB}fq:${item.id}` }, { text: 'Другой товар', callback_data: `${CB}fp:${item.id}` }],
      [{ text: '🗑 Убрать', callback_data: `${CB}del:${item.id}` }, { text: '⬅️ Назад', callback_data: `${CB}fix:${s.rev}` }],
    ]));
  }
  if (cmd === 'fq') { item.qty = null; item.skipQty = false; s.asking = null; return afterChange(chatId, s); }
  if (cmd === 'fp') { item.status = 'needProduct'; item.family = null; item.res = { ...(item.res || {}), options: (item.res && item.res.options) || [] }; s.asking = null; return afterChange(chatId, s); }
  if (cmd === 'del') { item.status = 'dropped'; return afterChange(chatId, s); }
  return undefined;
}

function init(botInstance, { isTrustedUser }) {
  bot = botInstance;
  isTrusted = isTrustedUser;
  bot.onText(/^\/(?:остатки_фото|вк)(?:@\S+)?(?:\s+([\s\S]+))?$/, (msg, m) => {
    start(msg.chat.id, m[1] || '').catch((e) => fail(msg.chat.id, 'запустить /остатки_фото', e));
  });
  bot.on('callback_query', (q) => { onCallback(q).catch((e) => console.error('[foto] callback:', e.message)); });
  return { handlePhoto, handleDocument, handleText };
}

module.exports = { init, needsSecondConfirm, _deps: deps, _sessions: sessions, _test: { start, handlePhoto, handleText, onCallback, processPhoto, performWrite, onApply, setBot: (b, t) => { bot = b; isTrusted = t; } } };
