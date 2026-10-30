// Команда /приход: фото накладной → таблица для Елены → после «Всё верно»
// xlsx для загрузки в Ozon. Бот ничего не пишет в Ozon сам (только чтение
// каталога). Состояние диалога — в памяти (по chatId).

const fs = require('fs');
const path = require('path');
const { readInvoicePhoto, rereadLine, prepareLine, arithmeticOk } = require('./recognize');
const { getCatalog, searchProducts } = require('./catalog');
const { buildFamilies, findFamilyByArticle } = require('./family');
const { matchLines, candidatesFor, looseCandidates } = require('./match');
const { computePlan, checkTotals } = require('./plan');
const nameMap = require('./nameMap');
const supplier = require('./supplier');
const { dense } = require('./text');
const ostatki = require('./ostatki');
const sheet = require('./sheet');
const xlsx = require('./xlsxFill');
const fbo = require('../fbo');
const { chunkMessage } = require('../report');

const CB = 'prh:';
const TEMPLATE_PATH = process.env.PRIHOD_TEMPLATE_PATH || '/data/prihod_template.xlsx';
const REPO_TEMPLATE_PATH = path.join(__dirname, 'template', 'ostatki_template.xlsx');
const SESSION_TTL_MS = 3 * 60 * 60 * 1000;
// Сессия живёт в памяти и теряется при перезапуске контейнера (деплой Railway).
// Поэтому готовый расчёт (экран проверки) дублируем на диск: «Всё верно» срабатывает и после рестарта.
const PENDING_PATH = process.env.PRIHOD_PENDING_PATH || '/data/prihod_pending.json';
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REREADS = 12;

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

function savePending(chatId, s) {
  try {
    if (s.kind === 'ostatki' || !s.plan || !s.plan.check || !s.plan.check.ok) return;
    const remember = (s.lines || [])
      .filter((l) => l.decision && l.decision.status === 'matched' && l.decision.via !== 'карта' && l.decision.family)
      .map((l) => ({ name: l.name, base: l.decision.family.base, weightG: l.decision.family.weightG ?? null }));
    const body = JSON.stringify({ chatId, savedAt: Date.now(), plan: s.plan, remember }, (k, v) => {
      if (v instanceof Set) return [...v];
      if (k === 'family' || k === 'families' || k === 'match' || k === 'members') return undefined;
      return v;
    });
    fs.mkdirSync(path.dirname(PENDING_PATH), { recursive: true });
    const tmp = `${PENDING_PATH}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, PENDING_PATH);
  } catch (err) {
    console.error('[prihod] не сохранила расчёт на диск:', err.message);
  }
}

function loadPending(chatId) {
  try {
    const d = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
    if (String(d.chatId) !== String(chatId) || Date.now() - d.savedAt > PENDING_TTL_MS || !d.plan) return null;
    // Восстановленная «сессия»: build() берёт из неё plan и lines (для карты названий).
    return {
      state: 'review',
      plan: d.plan,
      lines: (d.remember || []).map((r) => ({ name: r.name, decision: { status: 'matched', via: 'восстановлено', family: { base: r.base, weightG: r.weightG } } })),
      touched: Date.now(),
    };
  } catch { return null; }
}

function clearPending() {
  try { fs.unlinkSync(PENDING_PATH); } catch { /* нет файла */ }
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
    s.sheets.push({ order: idx, data: r, buf, mediaType });
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
// Рукописное число вместо печатного: в файл идёт оно, исходное запоминаем.
function applyQtyMark(l) {
  l.origQty = l.qty;
  l.qty = l.mark.qty * (l.packMult || 1);
}

const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function assemble(s, versions) {
  // versions[si] — массив подготовленных строк листа si
  s.lines = [];
  versions.forEach((lines, si) => lines.forEach((l) => s.lines.push({ ...l, sheet: si })));
  s.lines.forEach((l, i) => { l.n = i + 1; });
}

// Проверка чтения: количество × цена ≈ сумма по каждой строке; не сошлось —
// перечитываем строку по увеличенному фрагменту. Не сошёлся итог — второе,
// внимательное чтение листов и выбор варианта, который сходится с «Итого».
async function verifyReadings(s) {
  let rereads = 0;
  for (const l of s.lines) {
    if (l.arithmetic) continue;
    if (rereads >= MAX_REREADS) break;
    rereads += 1;
    const sh = s.sheets[l.sheet];
    try {
      const r = await rereadLine(sh.buf, sh.mediaType, l);
      const qty = numOrNull(r.qty); const price = numOrNull(r.price);
      const sum = numOrNull(r.sum); const sumNoVat = numOrNull(r.sum_no_vat);
      if (arithmeticOk(qty, price, sum, sumNoVat)) {
        console.log(`[prihod] стр. ${l.n} «${l.name}» перечитана: ${l.printedQty}×${l.price}=${l.sum} → ${qty}×${price}=${sum}`);
        Object.assign(l, { printedQty: qty, qty: qty * l.packMult, price, sum: sum ?? l.sum, sumNoVat, arithmetic: true, flags: [] });
      }
    } catch (err) {
      console.error(`[prihod] перечитать строку ${l.n}:`, err.message);
    }
  }
  const total = () => checkTotals(s.lines, s.printedTotal, s.printedNoVat);
  if ((s.printedTotal === null && s.printedNoVat === null) || total().ok) return;

  const alts = [];
  for (const sh of s.sheets) {
    try {
      const r = await readInvoicePhoto(sh.buf, sh.mediaType, { careful: true });
      alts.push(r.legible && r.lines.length ? r.lines.map(prepareLine) : null);
    } catch (err) {
      console.error('[prihod] второе чтение листа:', err.message);
      alts.push(null);
    }
  }
  const orig = s.sheets.map((_, si) => s.lines.filter((l) => l.sheet === si));
  const idxs = alts.map((a, si) => (a ? si : -1)).filter((x) => x >= 0);
  let best = null;
  for (let mask = 1; mask < (1 << idxs.length); mask += 1) {
    const versions = orig.map((o, si) => {
      const k = idxs.indexOf(si);
      return k >= 0 && (mask & (1 << k)) ? alts[si] : o;
    });
    const flat = versions.flat();
    if (checkTotals(flat, s.printedTotal, s.printedNoVat).ok) {
      const swaps = idxs.filter((_, k) => mask & (1 << k)).length;
      if (!best || swaps < best.swaps) best = { versions, swaps };
    }
  }
  if (best) {
    console.log('[prihod] итог сошёлся после второго чтения листов');
    assemble(s, best.versions);
  }
}

// Бот НИКОГДА не относит строку в «Нет в Озоне» сам: нет уверенного совпадения —
// вопрос «Какой товар?» с лучшими кандидатами. «Нет» только по кнопке Елены
// (или из её прежнего решения в словаре).
function applyResults(lines, results, families) {
  lines.forEach((l, i) => {
    let r = results[i];
    if (r.status === 'none' && !String(r.via).startsWith('запомнено')) {
      r = { status: 'ambiguous', options: looseCandidates(l, families, 4), via: r.via, fromNone: true };
    }
    l.match = r;
    l.decision = r.status === 'matched' ? { status: 'matched', family: r.family, via: r.via }
      : r.status === 'none' ? { status: 'none', via: r.via } : null;
  });
}

// Вопросы без кандидатов при кэшированном каталоге: обновляем каталог один раз и ищем заново.
async function refineNone(s, cached) {
  const open = () => s.lines.filter((l) => l.match && l.match.fromNone && !l.decision);
  if (!cached || !open().length) return;
  const fresh = await getCatalog({ force: true });
  s.products = fresh.products;
  s.families = buildFamilies(fresh.products).families;
  const lines = open();
  applyResults(lines, await matchLines(lines, s.families), s.families);
}

async function finishCollecting(chatId, s) {
  await s.queue;
  if (!s.sheets.length) return bot.sendMessage(chatId, 'Пока нет ни одного принятого листа. Пришли фото накладной.');
  s.state = 'matching';
  await bot.sendMessage(chatId, 'Сверяю с каталогом Озона… 🔎');
  try {
    s.sheets.sort((a, b) => a.order - b.order);
    assemble(s, s.sheets.map((sh) => sh.data.lines.map(prepareLine)));
    const last = (key) => {
      const v = s.sheets.map((sh) => numOrNull(sh.data[key])).filter((x) => x !== null);
      return v.length ? v[v.length - 1] : null;
    };
    s.printedTotal = last('printed_total');
    s.printedNoVat = last('printed_total_no_vat');
    await verifyReadings(s);
    for (const l of s.lines) if (l.flags.length) console.log(`[prihod] стр. ${l.n} «${l.name}»: ${l.flags.join('; ')}`);
    const cat = await getCatalog();
    s.products = cat.products;
    s.families = buildFamilies(cat.products).families;
    // Уверенное «нет»/зачёркнуто: строка не пришла — в сопоставление не идёт.
    for (const l of s.lines) {
      if (l.mark && !l.mark.pending && l.mark.kind === 'not_arrived') l.decision = { status: 'not_arrived', via: 'пометка' };
      else if (l.mark && !l.mark.pending && l.mark.kind === 'qty_changed') applyQtyMark(l);
    }
    const toMatch = s.lines.filter((l) => !l.decision || l.decision.status !== 'not_arrived');
    applyResults(toMatch, await matchLines(toMatch, s.families), s.families);
    await refineNone(s, cat.cached);
    // Поиск по коду поставщика недоступен (нет доступа к Номенклатуре) — один раз скажем Елене.
    const supErr = supplier.status().lastError;
    if (supErr && s.lines.some((l) => l.supplierCode)) {
      await bot.sendMessage(chatId, `ℹ️ По коду поставщика искать не смогла (${String(supErr.message).slice(0, 300)}), искала по названию.`);
    }
    s.state = 'resolving';
    await askNextAmbiguous(chatId, s);
  } catch (err) {
    sessions.delete(chatId);
    await fail(chatId, 'сопоставить с каталогом', err);
  }
}

const famLabel = (f) => `${f.base} — ${f.title}`;

// Артикулы, начинающиеся так же, как введённый (без регистра); не нашлось —
// укорачиваем начало до 3 символов.
function similarByStart(products, text, limit = 8) {
  const typed = dense(text);
  for (let n = typed.length; n >= Math.min(3, typed.length) && n > 0; n -= 1) {
    const pre = typed.slice(0, n);
    const found = products.filter((p) => !p.archived && dense(p.article).startsWith(pre)).slice(0, limit).map((p) => p.article);
    if (found.length) return found;
  }
  return [];
}

async function askNextMark(chatId, s, line) {
  const m = line.mark;
  const rows = [];
  if (m.qty !== null) rows.push([{ text: `Пришло ${fmt(m.qty)} шт`, callback_data: `${CB}mk:${line.n}:qty` }]);
  rows.push([{ text: 'Не пришло', callback_data: `${CB}mk:${line.n}:no` }]);
  rows.push([{ text: `Как в накладной (${fmt(line.qty)} шт)`, callback_data: `${CB}mk:${line.n}:ign` }]);
  await send(chatId, `✍️ Строка ${line.n}: «${line.name}», в накладной ${fmt(line.qty)} шт. Рядом рукописная пометка${m.text ? ` «${m.text}»` : ''}, прочитала неуверенно. Что это?`, kb(rows));
}

async function askNextAmbiguous(chatId, s) {
  const marked = s.lines.find((l) => l.mark && l.mark.pending);
  if (marked) return askNextMark(chatId, s, marked);
  const line = s.lines.find((l) => !l.decision);
  if (!line) return showReview(chatId, s);
  const opts = (line.match.options || []).slice(0, 5);
  line.opts = opts;
  const rows = opts.map((f, i) => [{ text: famLabel(f).slice(0, 64), callback_data: `${CB}pick:${line.n}:${i}` }]);
  rows.push([{ text: '✏️ Ввести артикул', callback_data: `${CB}art:${line.n}` }, { text: '🚫 Нет в Озоне', callback_data: `${CB}pick:${line.n}:x` }]);
  const why = line.match.fromNone ? (opts.length ? 'не нашла уверенного совпадения, вот лучшие варианты' : 'ничего похожего в каталоге не нашла') : 'неоднозначно';
  await send(chatId, `❓ Строка ${line.n}: «${line.name}» (${fmt(line.qty)} шт${line.unitWeightG ? `, ${line.unitWeightG} г` : ''}) — ${why}. Какой товар?`, kb(rows));
}

// ---------- отчёт ----------
function buildReport(s) {
  const plan = computePlan(s.lines, s.printedTotal, s.printedNoVat);
  s.plan = plan;
  const L = [];
  // Контроль полноты: строк в накладной = в файле + «Нет в Озоне» + по пометке «нет» (+ убранные Еленой).
  const status = (l) => (l.decision ? l.decision.status : null);
  const inFile = s.lines.filter((l) => status(l) === 'matched' && Number(l.qty) > 0).length;
  const removed = s.lines.filter((l) => status(l) === 'removed').length;
  const handled = inFile + plan.notInOzon.length + plan.notArrived.length + removed;
  if (handled !== s.lines.length) {
    const lost = s.lines.filter((l) => !['none', 'not_arrived', 'removed'].includes(status(l)) && !(status(l) === 'matched' && Number(l.qty) > 0));
    L.push(`⚠️ Не обработано строк: ${s.lines.length - handled}`);
    for (const l of lost) L.push(`• ${l.n}. ${l.name}${l.qty ? '' : ' (не прочитано количество)'}`);
    L.push('');
  }
  L.push('📋 Проверь: что попадёт в файл');
  for (const g of plan.groups) {
    L.push('');
    L.push(`📦 ${g.names.join(' + ')} — всего ${fmt(g.total)} шт`);
    for (const m of g.members) if (m.qty > 0) L.push(`${m.article} — ${m.qty}`);
  }
  if (plan.notInOzon.length) {
    L.push('');
    L.push('🚫 Нет в Озоне:');
    for (const l of plan.notInOzon) L.push(`• ${l.name} — ${fmt(l.qty)} шт`);
  }
  if (plan.notArrived.length) {
    L.push('');
    L.push('Не пришло по пометке:');
    for (const l of plan.notArrived) L.push(`• ${l.name} — ${fmt(l.qty)} шт`);
  }
  if (plan.edited.length) {
    L.push('');
    L.push('Правки по пометкам:');
    for (const l of plan.edited) L.push(`• ${l.name}: было ${fmt(l.origQty)} → стало ${fmt(l.qty)} (по пометке)`);
  }
  L.push('');
  if (plan.notArrived.length || plan.edited.length) {
    // Сверка идёт по НАПЕЧАТАННЫМ количествам и суммам; пометки — отдельной строкой, без ложного ✅.
    L.push(plan.check.ok ? 'Сверка по напечатанным количествам: сумма строк = Итого накладной' : `⚠️ ${plan.check.reason}`);
    L.push(`Расхождение из-за пометок: ${fmt(plan.markDiff)} шт`);
  } else {
    L.push(plan.check.ok ? `${plan.check.reason} ✅` : `⚠️ ${plan.check.reason}`);
  }
  return { text: L.join('\n'), plan };
}

async function showReview(chatId, s) {
  s.state = 'review';
  const { text, plan } = buildReport(s);
  savePending(chatId, s);
  const rows = [];
  if (plan.check.ok) rows.push([{ text: '✅ Всё верно', callback_data: `${CB}ok` }]);
  rows.push([{ text: '✏️ Исправить', callback_data: `${CB}fixmenu` }]);
  if (plan.notInOzon.length) rows.push([{ text: '✍️ Указать артикул для «Нет в Озоне»', callback_data: `${CB}artmenu` }]);
  rows.push(cancelRow);
  let msg = text;
  if (!plan.check.ok) {
    const doubtful = s.lines.filter((l) => !l.arithmetic && l.decision && l.decision.status !== 'removed');
    if (doubtful.length) msg += `\nНе уверена в строках: ${doubtful.map((l) => `${l.n} «${l.name}» (${fmt(l.qty)} шт, ${fmt(l.sum)})`).join('; ')}`;
    msg += '\nФайл не собираю, пока не сойдётся. Нажми «Исправить» или пришли недостающий лист.';
  }
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
    if (plan.remainders.length) console.log(`[prihod] остатки от деления: ${plan.remainders.map((r) => `${r.article} — ${r.remainder} шт`).join('; ')}`);
    if (plan.zeroSets.length) console.log(`[prihod] наборы с нулём (в файл не пишутся): ${plan.zeroSets.map((z) => z.article).join(', ')}`);
    if (plan.notInOzon.length) S.push(`Нет в Озоне: ${plan.notInOzon.map((l) => `${l.name} (${fmt(l.qty)} шт)`).join('; ')}.`);
    if (plan.notArrived.length) S.push(`Не пришло по пометке: ${plan.notArrived.map((l) => l.name).join('; ')}.`);
    if (plan.edited.length) S.push(`Правки по пометкам: ${plan.edited.map((l) => `${l.name} ${fmt(l.origQty)}→${fmt(l.qty)}`).join('; ')}.`);
    await send(chatId, S.join('\n'));
    sessions.delete(chatId);
    clearPending();
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
    [{ text: '✍️ Указать артикул', callback_data: `${CB}art:${n}` }],
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
  if (s.input.kind === 'ostatki_bad') {
    const q = ostatki.parseQty(msg.text);
    if (q.state !== 'ok') { await bot.sendMessage(chatId, 'Нужно число, например 12 или 0.'); return true; }
    s.overrides[s.input.row] = q.value;
    await showOstatki(chatId, s);
    if (s.plan.bad.length) await askBadValue(chatId, s);
    return true;
  }
  if (s.input.kind === 'ostatki_range') {
    const r = ostatki.parseRange(msg.text);
    if (!r) { await bot.sendMessage(chatId, 'Напиши диапазон строк, например 200-260 (можно с подсказкой: 200-260 бирки петельки).'); return true; }
    s.input = null;
    await runOstatki(chatId, r);
    return true;
  }
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
  if (kind === 'article') {
    const fam = findFamilyByArticle(s.families, msg.text);
    if (!fam) {
      const raw = s.products.find((p) => p.article.toLowerCase() === msg.text.trim().toLowerCase());
      if (raw) {
        await bot.sendMessage(chatId, `Артикул ${raw.article} есть в Озоне, но не попал в семьи (${raw.archived ? 'в архиве' : 'размер набора не из списка 1/2/3/4/5/6/8/10/12/20'}). Укажи другой или оставь «Нет в Озоне».`);
      } else {
        const near = similarByStart(s.products, msg.text);
        await bot.sendMessage(chatId, `Артикула «${msg.text.trim()}» нет в каталоге Озона.${near.length ? `\nПохожие по началу: ${near.join(', ')}` : ''}\nПришли артикул ещё раз.`);
      }
      return true;
    }
    s.input = null;
    l.decision = { status: 'matched', family: fam, via: 'артикул от Елены' };
    try { nameMap.remember(l.name, fam); } catch (err) { console.error('[prihod] карта названий:', err.message); }
    await bot.sendMessage(chatId, `Принято: «${l.name}» → ${fam.base} (наборы ${fam.members.map((m) => m.pieces).join('/')} шт). Запомнила.`);
    if (s.lines.some((x) => !x.decision)) await askNextAmbiguous(chatId, s);
    else await showReview(chatId, s);
    return true;
  }
  const v = parseNum(msg.text);
  if (v === null) { await bot.sendMessage(chatId, 'Нужно число, например 55 или 120,5.'); return true; }
  s.input = null;
  if (kind === 'qty') { l.qty = v; l.printedQty = v; l.packMult = 1; l.flags = []; delete l.origQty; l.mark = null; }
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
  if (cmd === 'cancel') { sessions.delete(chatId); clearPending(); return bot.sendMessage(chatId, 'Отменено. /приход — начать заново.'); }
  let s = session(chatId);
  if (!s && cmd === 'ok') {
    const restored = loadPending(chatId);
    if (restored) { s = restored; sessions.set(chatId, s); }
  }
  if (!s) return bot.sendMessage(chatId, 'Сессия закончилась. /приход — начать заново.');
  try {
    if (cmd === 'done' && s.state === 'collect') return await finishCollecting(chatId, s);
    if (cmd === 'ost_ok') return s.kind === 'ostatki' && s.state === 'review' && !s.plan.bad.length ? await buildOstatki(chatId, s) : undefined;
    if (cmd === 'ost_fix') return s.kind === 'ostatki' ? await askBadValue(chatId, s) : undefined;
    if (!s.lines) return undefined;
    const [op, a, b] = cmd.split(':');
    const n = Number(a);
    if (op === 'pick') {
      const l = s.lines.find((x) => x.n === n);
      if (!l) return undefined;
      if (b === 'x') {
        l.decision = { status: 'none', via: 'Елена: нет в Озоне' };
        try { nameMap.rememberNone(l.name, (l.opts || (l.match && l.match.options) || candidatesFor(l, s.families)).flatMap((f) => f.members.map((m) => m.article))); } catch (err) { console.error('[prihod] карта названий:', err.message); }
      } else {
        const f = (l.opts || l.match.options || [])[Number(b)];
        if (!f) return undefined;
        l.decision = { status: 'matched', family: f, via: 'Елена' };
        try { nameMap.remember(l.name, f); } catch (err) { console.error('[prihod] карта названий:', err.message); }
      }
      l.flags = l.flags || [];
      return s.lines.some((x) => !x.decision) ? await askNextAmbiguous(chatId, s) : await showReview(chatId, s);
    }
    if (cmd === 'ok') {
      if (s.state !== 'review') return undefined;
      return await build(chatId, s);
    }
    if (op === 'mk') {
      const l = s.lines.find((x) => x.n === n);
      if (!l || !l.mark) return undefined;
      if (b === 'no') { l.mark = { ...l.mark, kind: 'not_arrived', pending: false }; l.decision = { status: 'not_arrived', via: 'пометка' }; }
      else if (b === 'qty') { l.mark = { ...l.mark, kind: 'qty_changed', pending: false }; applyQtyMark(l); }
      else { l.mark = null; }
      return await askNextAmbiguous(chatId, s);
    }
    if (cmd === 'artmenu') {
      const none = s.lines.filter((l) => l.decision && l.decision.status === 'none');
      const rows = none.map((l) => [{ text: `${l.n}. ${l.name}`.slice(0, 60), callback_data: `${CB}art:${l.n}` }]);
      rows.push([{ text: '⬅️ Назад к таблице', callback_data: `${CB}back` }]);
      return await bot.sendMessage(chatId, 'Для какой строки указать артикул?', kb(rows));
    }
    if (op === 'art') { s.input = { kind: 'article', n }; return await bot.sendMessage(chatId, `Строка ${n}: напиши артикул из Озона текстом (можно без числа штук — возьму всё семейство).`); }
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

// ---------- /остатки N-M ----------
async function startOstatki(chatId, arg) {
  if (!isTrusted(chatId)) return;
  if (!fbo.isConfigured()) return bot.sendMessage(chatId, 'Не заданы OZON_API_KEY / OZON_CLIENT_ID — каталог Озона недоступен 😔');
  if (!getTemplate()) {
    awaitingTemplate.add(chatId);
    return bot.sendMessage(chatId, 'Сначала пришли пустой «Шаблон для обновления остатков на всех складах» (xlsx из Озона) — я сохраню его, и потом /остатки заработает.');
  }
  const r = arg ? ostatki.parseRange(arg) : null;
  if (r) return runOstatki(chatId, r);
  sessions.set(chatId, { kind: 'ostatki', state: 'range', input: { kind: 'ostatki_range' }, touched: Date.now() });
  return bot.sendMessage(chatId, arg
    ? 'Не поняла диапазон. Напиши номера строк, например 200-260 (можно с подсказкой: 200-260 бирки петельки).'
    : 'Какие строки пересчитал склад? Напиши диапазон, например 200-260 (можно с подсказкой: 200-260 бирки петельки).');
}

async function runOstatki(chatId, r) {
  await bot.sendMessage(chatId, `Читаю строки ${r.from}–${r.to} таблицы «Склад Заказы»… 📊`);
  try {
    const [{ rows }, cat] = await Promise.all([sheet.fetchRange(r.from, r.to), getCatalog()]);
    const families = buildFamilies(cat.products).families;
    const s = { kind: 'ostatki', state: 'review', rows, products: cat.products, families, range: r, overrides: {}, touched: Date.now() };
    sessions.set(chatId, s);
    if (!rows.some((x) => x.article)) {
      sessions.delete(chatId);
      return bot.sendMessage(chatId, `В строках ${r.from}–${r.to} нет артикулов. Проверь диапазон.`);
    }
    await showOstatki(chatId, s);
  } catch (err) {
    sessions.delete(chatId);
    if (err instanceof sheet.SheetAccessError) await bot.sendMessage(chatId, `Не могу прочитать таблицу: ${err.message}`);
    else await fail(chatId, 'прочитать остатки', err);
  }
}

// Экран проверки; значения, которые Елена уточнила (текст/дата в G), подставляются поверх таблицы.
async function showOstatki(chatId, s) {
  const rows = s.rows.map((x) => (s.overrides[x.row] !== undefined ? { ...x, qtyRaw: String(s.overrides[x.row]) } : x));
  const plan = ostatki.buildPlan(rows, s.products, s.families);
  s.plan = plan;
  s.input = null;
  const text = ostatki.buildText({ ...s.range, rows, products: s.products, plan });
  const buttons = [];
  if (plan.bad.length) buttons.push([{ text: '✏️ Ввести значения', callback_data: `${CB}ost_fix` }]);
  else if (plan.items.length) buttons.push([{ text: '✅ Всё верно', callback_data: `${CB}ost_ok` }]);
  buttons.push(cancelRow);
  const body = plan.bad.length || plan.items.length ? text : `${text}\n\nВ файл нечего писать.`;
  const parts = chunkMessage(body, 3800); // по пустым строкам = границам семей
  for (let i = 0; i < parts.length; i += 1) {
    await bot.sendMessage(chatId, parts[i], i === parts.length - 1 ? kb(buttons) : undefined);
  }
}

async function askBadValue(chatId, s) {
  const b = s.plan.bad[0];
  if (!b) return showOstatki(chatId, s);
  s.input = { kind: 'ostatki_bad', row: b.row };
  return bot.sendMessage(chatId, `П${b.row} ${b.article}: в таблице «${b.raw}». Какое количество? Напиши число (0 — обнулить).`);
}

async function buildOstatki(chatId, s) {
  const items = s.plan.items;
  try {
    const tpl = getTemplate();
    const out = xlsx.fillTemplate(tpl, items);
    xlsx.verifyFilled(tpl, out, items);
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const dd = (n) => String(n).padStart(2, '0');
    const fileName = `Шаблон_остатки_${dd(d.getUTCDate())}_${dd(d.getUTCMonth() + 1)}_${d.getUTCFullYear()}.xlsx`;
    await bot.sendDocument(chatId, out, { caption: `Строки ${s.range.from}–${s.range.to}: ${items.length} артикулов (нули — обнуление). Это установка остатка, не прибавка. Загрузи в Озон сама — бот туда ничего не пишет.` },
      { filename: fileName, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    sessions.delete(chatId);
  } catch (err) {
    await fail(chatId, 'собрать файл (файл не отправлен)', err);
  }
}

async function refreshCatalog(chatId) {
  if (!isTrusted(chatId)) return;
  if (!fbo.isConfigured()) return bot.sendMessage(chatId, 'Не заданы OZON_API_KEY / OZON_CLIENT_ID.');
  const cat = await getCatalog({ force: true });
  const { families } = buildFamilies(cat.products);
  return bot.sendMessage(chatId, `✅ Каталог Озона обновлён: товаров ${cat.products.length}, семей ${families.length}.`);
}

// /приход_каталог [текст]: сколько товаров загружено и что каталог знает про запрос.
async function catalogDebug(chatId, query) {
  if (!isTrusted(chatId)) return;
  if (!fbo.isConfigured()) return bot.sendMessage(chatId, 'Не заданы OZON_API_KEY / OZON_CLIENT_ID.');
  const cat = await getCatalog({ force: true });
  const { families, skipped } = buildFamilies(cat.products);
  const st = cat.stats || {};
  const L = [
    `Каталог загружен заново: товаров ${cat.products.length}${st.apiTotal !== null && st.apiTotal !== undefined ? ` (Озон сообщает total ${st.apiTotal})` : ''}, страниц списка ${st.pages ?? '—'}, архивных ${st.archived ?? '—'}.`,
    `Семей: ${families.length}. Не вошло в семьи: ${skipped.length}${skipped.length ? ` (${[...new Set(skipped.map((x) => x.reason))].slice(0, 3).join('; ')})` : ''}.`,
  ];
  if (query) {
    const found = searchProducts(cat.products, query, 12);
    L.push('', `По запросу «${query}» (название и артикул): ${found.length ? '' : 'ничего'}`);
    for (const p of found) {
      const sk = skipped.find((x) => x.article === p.article);
      const fam = families.find((f) => f.members.some((m) => m.article === p.article));
      L.push(`• ${p.article} | ${p.name || 'без названия'} | ${p.status || '—'}${p.archived ? ' | архив' : ''}`);
      L.push(`   ${sk ? `пропущен: ${sk.reason}` : fam ? `семья ${fam.base}, вес ${fam.weightG ?? '?'} г, наборы ${fam.members.map((m) => m.pieces).join('/')}` : '—'}`);
    }
  }
  await send(chatId, L.join('\n'));
}

// /приход_коды: сколько строк Номенклатуры, где поиск по артикулу поставщика (AB) работает.
async function codesCoverage(chatId) {
  const email = supplier.accountEmail();
  if (!email) {
    // нет сервисного аккаунта — пробуем срез Номенклатуры из файла
    try {
      const st = await supplier.coverage();
      if (supplier.status().source === 'file') return sendCoverage(chatId, st, 'файл-срез (/data/supplier_codes.json или prihod/data), без цен');
    } catch (_) { /* ниже — подсказка */ }
    return bot.sendMessage(chatId, '🔒 Номенклатуру читаю только через сервисный аккаунт. В Railway не задан GOOGLE_SERVICE_ACCOUNT_JSON: создай ключ сервисного аккаунта Google (роль не нужна), вставь JSON в эту переменную, затем дай аккаунту доступ «Читатель» к Номенклатуре и повтори /приход_коды.');
  }
  let st;
  try {
    st = await supplier.coverage();
  } catch (err) {
    if (err instanceof supplier.SupplierAccessError) {
      return bot.sendMessage(chatId, `🔒 Дай доступ «Читатель» к таблице «Номенклатура» на e-mail сервисного аккаунта:\n${email}\nи повтори /приход_коды.`);
    }
    throw err;
  }
  await bot.sendMessage(chatId, `Сервисный аккаунт (доступ «Читатель»): ${email}`);
  return sendCoverage(chatId, st);
}

async function sendCoverage(chatId, st, from) {
  if (from) await bot.sendMessage(chatId, `Источник: ${from}`);
  const pct = (n) => (st.total ? Math.round((n / st.total) * 100) : 0);
  await bot.sendMessage(chatId, [
    '🔎 Артикул поставщика в Номенклатуре (столбец AB)',
    `Строк с артикулом: ${st.total}`,
    `Заполнено: ${st.filled} (${pct(st.filled)}%)`,
    `• из них код вида «РФ25204» (как в накладной): ${st.codeForm} (${pct(st.codeForm)}%), разных кодов: ${st.codes}`,
    `• из них текст/название (крафт, косметика — по коду накладной не ищется): ${st.textOnly}`,
    `Пусто: ${st.empty} (${pct(st.empty)}%) — такие товары ищутся по названию.`,
  ].join('\n'));
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
  bot.onText(/^\/остатки(?:@\S+)?(?:\s+([\s\S]+))?$/, (msg, m) => {
    startOstatki(msg.chat.id, m[1] ? m[1].trim() : '').catch((e) => fail(msg.chat.id, 'запустить /остатки', e));
  });
  bot.onText(/^\/каталог_обновить(?:@\S+)?$/, (msg) => {
    refreshCatalog(msg.chat.id).catch((e) => fail(msg.chat.id, 'обновить каталог', e));
  });
  bot.onText(/^\/приход_каталог(?:@\S+)?(?:\s+([\s\S]+))?$/, (msg, m) => {
    catalogDebug(msg.chat.id, m[1] ? m[1].trim() : '').catch((e) => fail(msg.chat.id, 'проверить каталог', e));
  });
  bot.onText(/^\/приход_коды(?:@\S+)?$/, (msg) => {
    if (!isTrusted(msg.chat.id)) return;
    codesCoverage(msg.chat.id).catch((e) => fail(msg.chat.id, 'проверить коды поставщика', e));
  });
  bot.on('callback_query', (q) => { onCallback(q).catch((e) => console.error('[prihod] callback:', e.message)); });
  return { handlePhoto, handleDocument, handleText };
}

module.exports = { init, buildReport, applyResults, getTemplate, _savePending: savePending, _loadPending: loadPending };
