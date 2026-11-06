// Страж обращений в поддержку Ozon («споры»): раз в 2 дня (08:00 по Бали) и по
// /споры_проверка ищет товары, по которым пора подавать обращение, и спрашивает
// Елену кнопками «Да / Нет / Позже». По «Да» готовит тексты (для склада и для
// поддержки). Бот САМ обращение НЕ подаёт и в Озон ничего не пишет.
//
// Группы:
//   W (А) — списано «по результатам проверки», компенсации нет, с даты списания
//           ≥14 дней (срок обращения 30 дней; сообщаем на 14-й день, напоминаем на 25-й);
//   B/V/G — из returnsWatch (возвраты): «Ищем товар» >20 дн., долгий путь >50 дн.,
//           «Не получена доставкой».
// Списанные товары: публичного метода Ozon API для списка «FBS/FBO → Списанные
// товары» подтвердить не удалось. Поэтому источник — свой реестр на диске
// (команда /списание_добавить), а если задан DISPUTES_WRITEOFF_ENDPOINT — бот
// пробует прочитать оттуда (схема не сверена). Нет API — Елене один раз пишем
// и предлагаем проверку через Claude в Chrome (колонка «Компенсация»).

const fs = require('fs');
const path = require('path');
const rw = require('./returnsWatch');

const STATE_PATH = process.env.DISPUTES_STATE_PATH || '/data/disputes_state.json';
const DAY_MS = 86400000;
const FIRST_DAY = 14; // сообщаем с 14-го дня
const REMIND_DAY = 25; // напоминаем на 25-й
const DEADLINE_DAYS = 30; // срок обращения
const SHOP = 'Portretkina Beauty';
const CLIENT_ID_TEXT = '247027';

const GROUP_TITLE = {
  W: 'А. Списано, компенсации нет',
  B: 'Б. Возврат «Ищем товар»',
  V: 'В. Возврат долго в пути',
  G: 'Г. Не получена доставкой',
};

// Известные случаи с октября 2026 (только артикул, дата, кол-во, схема;
// SKU/отправление Елена дополняет сама). Кладутся в реестр один раз.
const SEED = [
  { article: '13162БиркаСадовая2000шт', date: '2026-10-19', qty: 4, scheme: 'FBS' },
  { article: 'МОСКВА1ШТ', date: '2026-10-25', qty: 3, scheme: 'FBS' },
  { article: 'ПеналЧерный1', date: '2026-10-30', qty: null, scheme: 'FBS' },
  { article: '025ПЛАМЯ025СИНП1ШТ', date: '2026-10-30', qty: null, scheme: 'FBO' },
];

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}
function getState() {
  const s = readJson(STATE_PATH, {});
  if (!s.seeded) {
    s.writeoffs = [...(s.writeoffs || [])];
    SEED.forEach((x, i) => {
      if (!s.writeoffs.some((w) => w.article === x.article && w.date === x.date)) {
        s.writeoffs.push({ id: `seed${i + 1}`, sku: '', posting: '', reason: 'по результатам проверки', compensation: '', price: null, ...x });
      }
    });
    s.seeded = true;
    writeJsonAtomic(STATE_PATH, s);
  }
  return applyFixes(s);
}
// Разовые правки реестра на уже существующем состоянии Railway (флаг в state.fixes).
const FIXES = [
  {
    id: 'filed-13162-2026-11-02',
    article: '13162БиркаСадовая2000шт',
    apply: (w) => ({
      ...w,
      posting: '46145506-0435-1',
      filed: { date: '2026-11-02', claims: '1002115720–1002115723' },
    }),
  },
  {
    id: 'filed-moskva-2026-11-06',
    article: 'МОСКВА1ШТ',
    apply: (w) => ({ ...w, filed: { date: '2026-11-06', claims: '1002097774–1002097776' } }),
  },
  {
    id: 'filed-penal-2026-11-02',
    article: 'ПеналЧерный1',
    apply: (w) => ({ ...w, filed: { date: '2026-11-02', claims: '1001782331', approved: true } }),
  },
];
function applyFixes(s) {
  const done = new Set(s.fixes || []);
  let changed = false;
  for (const f of FIXES) {
    if (done.has(f.id)) continue;
    s.writeoffs = (s.writeoffs || []).map((w) => (w.article === f.article ? f.apply(w) : w));
    done.add(f.id);
    changed = true;
  }
  if (changed) { s.fixes = [...done]; writeJsonAtomic(STATE_PATH, s); }
  return s;
}
function patchState(patch) { writeJsonAtomic(STATE_PATH, { ...getState(), ...patch }); }

// ---------- даты ----------

function isoToUtcDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function daysSince(iso, todayIso) { return Math.round((isoToUtcDay(todayIso) - isoToUtcDay(iso)) / DAY_MS); }
function ruDate(iso) { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; }
function parseRuDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.getUTCDate() !== Number(d) ? null : iso;
}
function msToIso(ms) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 10); } // по Бали

// ---------- реестр списаний ----------

// «Компенсация» считается пришедшей, если там сумма или «Предварительная».
function isFiled(w) { return Boolean(w.filed && w.filed.date); }
function hasCompensation(w) { return Boolean(String(w.compensation || '').trim()); }

function addWriteoff(state, raw) {
  const parts = String(raw).split(/[;|]/).map((s) => s.trim());
  const [article, sku, posting, dateStr, qty, scheme, price] = parts;
  const date = parseRuDate(dateStr);
  if (!article || !date) return { error: 'Формат: /списание_добавить артикул; SKU; отправление; ДД.ММ.ГГГГ; шт; FBS|FBO; цена (SKU, отправление, шт, цена можно «-»)' };
  const dash = (v) => (!v || v === '-' || v === '—' ? '' : v);
  const w = {
    id: `w${Date.now().toString(36)}`,
    article, sku: dash(sku), posting: dash(posting), date,
    qty: Number(dash(qty)) || null,
    scheme: /fbo/i.test(scheme || '') ? 'FBO' : 'FBS',
    price: Number(String(dash(price)).replace(',', '.')) || null,
    reason: 'по результатам проверки', compensation: '',
  };
  return { writeoffs: [...(state.writeoffs || []), w], added: w };
}

// Отметить «подано»: артикул; ДД.ММ.ГГГГ; заявки; отправление (необязательно).
function markFiled(state, raw) {
  const [article, dateStr, claims, posting] = String(raw).split(/[;|]/).map((x) => x.trim());
  const date = parseRuDate(dateStr);
  if (!article || !date) return { error: 'Формат: /списание_подано артикул; ДД.ММ.ГГГГ; заявки; отправление' };
  const list = state.writeoffs || [];
  const hit = list.filter((w) => w.article.toLowerCase() === article.toLowerCase() && !isFiled(w));
  if (!hit.length) return { error: 'Не нашёл неподанное списание с таким артикулом.' };
  return {
    count: hit.length,
    writeoffs: list.map((w) => (hit.includes(w)
      ? { ...w, posting: posting || w.posting, filed: { date, claims: claims || '' } } : w)),
  };
}

// Компенсация пришла → убираем из списка (ставим «Предварительная» или сумму).
function setCompensation(state, article, value) {
  const list = state.writeoffs || [];
  const hit = list.filter((w) => w.article.toLowerCase() === String(article).trim().toLowerCase() && !hasCompensation(w));
  if (!hit.length) return null;
  const val = value || 'Предварительная';
  return { writeoffs: list.map((w) => (hit.includes(w) ? { ...w, compensation: val } : w)), count: hit.length };
}

// Попытка прочитать списания из API (если задан метод). Возвращает { items, available }.
async function fetchWriteoffsApi() {
  const endpoint = process.env.DISPUTES_WRITEOFF_ENDPOINT;
  if (!endpoint || !rw.isConfigured()) return { available: false, items: [] };
  const host = process.env.OZON_API_HOST || 'https://api-seller.ozon.ru';
  const res = await fetch(`${host}${endpoint}`, {
    method: 'POST',
    headers: {
      'Client-Id': String(process.env.OZON_CLIENT_ID).trim(),
      'Api-Key': String(process.env.OZON_API_KEY).trim(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ limit: 1000 }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Озон ${endpoint}: HTTP ${res.status} ${text.slice(0, 200)}`);
  const data = text ? JSON.parse(text) : {};
  const list = data.items || data.writeoffs || data.result?.items || [];
  const items = list.map((x, i) => ({
    id: `api${x.id ?? i}`,
    article: x.offer_id || x.article || '',
    sku: x.sku || '',
    posting: x.posting_number || x.supply_id || '',
    date: String(x.date || x.writeoff_date || '').slice(0, 10),
    qty: Number(x.quantity) || null,
    scheme: /fbo/i.test(x.scheme || '') ? 'FBO' : 'FBS',
    price: Number(x.price) || null,
    reason: x.reason || 'по результатам проверки',
    compensation: x.compensation ?? x.compensation_amount ?? '',
  })).filter((x) => x.article && /^\d{4}-\d{2}-\d{2}$/.test(x.date));
  return { available: true, items };
}

// ---------- отбор ----------

function candidatesFromWriteoffs(writeoffs, todayIso) {
  const out = [];
  for (const w of writeoffs) {
    if (hasCompensation(w) || isFiled(w)) continue;
    const days = daysSince(w.date, todayIso);
    if (days < FIRST_DAY || days > DEADLINE_DAYS) continue;
    out.push({
      key: `W|${w.id}`, group: 'W', article: w.article, sku: w.sku, ref: w.posting || '',
      dateIso: w.date, days, daysLeft: DEADLINE_DAYS - days, price: w.price, qty: w.qty,
      scheme: w.scheme, reason: w.reason || 'по результатам проверки',
    });
  }
  return out;
}

// Для ручной /споры_проверка: списания без компенсации, которым ещё нет 14 дней
// (только показать, без кнопок и без «уже сообщали»).
function earlyWriteoffs(writeoffs, todayIso) {
  const out = [];
  for (const w of writeoffs) {
    if (hasCompensation(w) || isFiled(w)) continue;
    const days = daysSince(w.date, todayIso);
    if (days >= FIRST_DAY || days < 0) continue;
    out.push({ group: 'W', article: w.article, sku: w.sku, ref: w.posting || '', dateIso: w.date, days,
      daysLeft: DEADLINE_DAYS - days, price: w.price, qty: w.qty });
  }
  return out;
}

function formatEarly(early) {
  if (!early.length) return '';
  return `\n\n🕓 Ещё рано (меньше ${FIRST_DAY} дн., сообщу на ${FIRST_DAY}-й день):\n${early.sort((a, b) => b.days - a.days).map(line).join('\n')}`;
}

function formatFiled(writeoffs) {
  const rows = writeoffs.filter((w) => isFiled(w) && !hasCompensation(w));
  if (!rows.length) return '';
  const lines = rows.map((w) => `• ${w.article} · отпр. ${w.posting || '—'} · подано ${ruDate(w.filed.date)}${w.filed.claims ? `, заявки ${w.filed.claims}` : ''}`);
  return `\n\n✅ Уже подано (не напоминаю):\n${lines.join('\n')}`;
}

// Позиция, которая уже есть в А (списание), во втором месте (возврат) не показывается:
// совпадение по номеру отправления, а если его нет — по артикулу.
function dropDuplicatesOfWriteoffs(cands, writeoffs) {
  const live = writeoffs.filter((w) => !hasCompensation(w));
  const norm = (x) => String(x || '').trim().toLowerCase();
  return cands.filter((c) => {
    if (c.group === 'W') return true;
    return !live.some((w) => (c.posting && w.posting ? norm(c.posting) === norm(w.posting) : norm(c.article) === norm(w.article)));
  });
}

function candidatesFromReturns(returns, now) {
  return rw.classify(returns, now).map((f) => ({
    key: `R|${f.key}`, group: f.group, article: f.offerId, sku: f.sku, posting: f.posting || '',
    claim: String(f.claim || ''), status: f.status || '',
    ref: [f.claim && `заявка ${f.claim}`, f.posting && `отпр. ${f.posting}`].filter(Boolean).join(', '),
    dateIso: msToIso(f.ms), days: f.days,
    daysLeft: f.group === 'V' ? f.daysLeft : null,
    price: f.price, qty: null, scheme: 'FBS', reason: `статус возврата «${f.status}»`,
  }));
}

// ---------- короткий отчёт «К спору» ----------

const RETURN_DISPUTE_DAYS = 60; // «Ожидает отправки» / «Едет на склад Ozon» дольше 60 дней
const RETURN_MAX_AGE_DAYS = 180; // статус старше 180 дней не показываем

function addDaysIso(iso, n) { return new Date(isoToUtcDay(iso) + n * DAY_MS).toISOString().slice(0, 10); }
function ruDM(iso) { const [, m, d] = iso.split('-'); return `${d}.${m}`; }

// Номера заявок из строки вида «1002115720–1002115723» или «1001782331, 1002...» → массив строк.
function expandClaims(str) {
  const out = [];
  const re = /(\d{7,})\s*[–—-]\s*(\d{7,})|(\d{7,})/g;
  let m;
  while ((m = re.exec(String(str || '')))) {
    if (m[3]) out.push(m[3]);
    else {
      const a = Number(m[1]); const b = Number(m[2]);
      if (b >= a && b - a <= 200) for (let n = a; n <= b; n++) out.push(String(n));
      else out.push(m[1], m[2]);
    }
  }
  return out;
}
function filedClaimSet(state) {
  const set = new Set(expandClaims((state.filedClaims || []).join(' ')));
  for (const w of state.writeoffs || []) if (isFiled(w)) expandClaims(w.filed.claims).forEach((c) => set.add(c));
  return set;
}
function addFiledClaims(state, raw) {
  const nums = expandClaims(raw);
  if (!nums.length) return { error: 'Формат: /спор_подано 1002115720–1002115723 (или номера заявок через пробел)' };
  return { filedClaims: [...new Set([...(state.filedClaims || []), ...nums])], count: nums.length };
}

// К спору: (1) возвраты «Ожидает отправки» / «Едет на склад Ozon» дольше 60 дней (не старше 180);
// (2) списанные без компенсации в срок до 30 дней (с 14-го дня). «Едет к вам», «декомпенсация»,
// «Ищем товар», «Не получена доставкой» — не показываем. Подано (по номеру заявки или в реестре) — убрано.
// Скоро: списания младше 14 дней и возвраты 50–60 дней.
function buildReport(state, returnCands, todayIso) {
  const writeoffs = state.writeoffs || [];
  const claims = filedClaimSet(state);
  const toDispute = candidatesFromWriteoffs(writeoffs, todayIso);
  const soon = earlyWriteoffs(writeoffs, todayIso)
    .filter((w) => w.days >= 0)
    .map((w) => ({ ...w, deadlineIso: addDaysIso(w.dateIso, DEADLINE_DAYS) }));
  const okStatus = (st) => {
    const n = String(st || '').toLowerCase().replace(/ё/g, 'е');
    if (n.includes('декомпенсац') || n.includes('едет к вам')) return false;
    return n.includes('ожидает отправки') || n.includes('едет на склад');
  };
  for (const c of dropDuplicatesOfWriteoffs(returnCands, writeoffs)) {
    if (c.group !== 'V' || !okStatus(c.status)) continue;
    if (c.claim && claims.has(c.claim)) continue;
    if (c.days > RETURN_MAX_AGE_DAYS) continue;
    if (c.days >= RETURN_DISPUTE_DAYS) toDispute.push(c);
    else soon.push({ ...c, deadlineIso: addDaysIso(c.dateIso, RETURN_DISPUTE_DAYS) });
  }
  return { toDispute, soon };
}

function shortRef(c) {
  if (c.claim) return `заявка ${c.claim}`;
  if (c.posting) return `отпр. ${c.posting}`;
  return '';
}

function formatShort({ toDispute, soon }, notes = []) {
  const parts = [];
  if (!toDispute.length) parts.push('✅ Сейчас подавать нечего');
  else {
    const rows = toDispute.map((c, i) => `\t${i + 1}.\t${[c.article || '—', shortRef(c)].filter(Boolean).join(' · ')}`);
    parts.push(`⚖️ К спору: ${toDispute.length}\n${rows.join('\n')}\nОтветь «подавай» и перешли мне это сообщение.`);
  }
  if (soon.length) {
    const nearest = soon.map((c) => c.deadlineIso).sort()[0];
    parts.push(`Скоро: ${soon.length} поз., ближайший срок ${ruDM(nearest)}`);
  }
  if (notes.length) parts.push(notes.map((n) => `⚠️ ${n}`).join('\n'));
  return parts.join('\n\n');
}

// Что слать при плановой проверке: новое, смена группы, либо напоминание на 25-й день (А).
function pickNew(cands, sent) {
  return cands.filter((c) => {
    const prev = sent[c.key];
    if (!prev) return true;
    if (prev.group !== c.group) return true;
    if (c.group === 'W' && c.days >= REMIND_DAY && !prev.reminded) return true;
    return false;
  });
}
function markSent(sent, list, now = Date.now()) {
  const next = { ...sent };
  for (const c of list) {
    const prev = next[c.key];
    const reminded = c.group === 'W' && c.days >= REMIND_DAY;
    next[c.key] = { group: c.group, at: now, reminded: reminded || (prev && prev.group === c.group && prev.reminded) || false };
  }
  for (const [k, v] of Object.entries(next)) if (now - v.at > 365 * DAY_MS) delete next[k];
  return next;
}

// ---------- текст сообщения Елене ----------

const money = (n) => (n == null ? 'цена —' : `${Math.round(n).toLocaleString('ru-RU')} ₽`);

function line(c) {
  const left = c.group === 'W'
    ? (c.daysLeft >= 0 ? `до срока ${c.daysLeft} дн.` : `срок вышел ${-c.daysLeft} дн. назад`)
    : (c.group === 'V' ? (c.daysLeft > 0 ? `прошло ${c.days} дн., до 60 осталось ${c.daysLeft}` : `прошло ${c.days} дн. (больше 60, можно спор)`) : `${c.days} дн.`);
  const date = c.group === 'W' ? `списано ${ruDate(c.dateIso)}` : `статус с ${ruDate(c.dateIso)}`;
  const qty = c.qty ? ` ${c.qty} шт` : '';
  return `• ${c.article || '—'}${qty} · SKU ${c.sku || '—'} · ${c.ref || 'номер не указан'} · ${date} · ${left} · ${money(c.price)}`;
}

function formatCandidates(cands, header = '⚖️ Ozon: нужны обращения в поддержку') {
  if (!cands.length) return `${header}\n\n✅ Сейчас обращений не требуется.`;
  const parts = [header];
  for (const g of ['W', 'B', 'V', 'G']) {
    const rows = cands.filter((c) => c.group === g).sort((a, b) => b.days - a.days);
    if (rows.length) parts.push(`\n${GROUP_TITLE[g]}:\n${rows.map(line).join('\n')}`);
  }
  parts.push('\nПодавать обращение по этим? Да / Нет / Позже');
  return parts.join('\n');
}

const API_NOTICE = 'ℹ️ Списанные товары через API Озона мне недоступны, поэтому группу А беру из своего реестра (команда /списание_добавить). Чтобы сверить с кабинетом, скажите Claude в Chrome: «проверь FBS → Списанные товары, колонку “Компенсация”». Пришла компенсация — /списание_компенсация артикул.';

// ---------- тексты по «Да» ----------

function warehouseMessage(c) {
  const ref = c.ref || 'номер уточню';
  return [
    `Нужно по товару ${c.article}, отправление ${ref}, чтобы подать обращение в Ozon.`,
    '1. Видео сборки: взять такой же товар (если есть на складе), показать этикетку и штрихкод, положить в упаковку, заклеить, наклеить этикетку отправления. Одним куском, 20–40 секунд, без монтажа и с хорошим светом.',
    '2. 2–3 фото упаковки: общий вид, этикетка с артикулом, штрихкод.',
    '3. Кто паковал и дата упаковки.',
    '4. Если товар вернулся на склад или нашёлся: сразу написать Елене, обращение тогда не нужно.',
    'Всё прислать Елене в личное сообщение с артикулом в подписи.',
  ].join('\n');
}

function topicOf(c) {
  return c.scheme === 'FBO'
    ? 'FBO. Отгрузка со склада Ozon → Списанные товары'
    : 'FBS. Доставка Ozon со своего склада → Списанные товары';
}

// Текст обращения, до 1000 символов.
function supportText(c) {
  const what = c.group === 'W'
    ? `Дата списания: ${ruDate(c.dateIso)}. Причина списания: ${c.reason}. Компенсация не начислена.`
    : `Дата статуса: ${ruDate(c.dateIso)}. Причина обращения: ${c.reason}. Компенсация не начислена.`;
  const text = [
    `Магазин ${SHOP}, Client ID ${CLIENT_ID_TEXT}.`,
    `Артикул: ${c.article}${c.qty ? `, кол-во ${c.qty} шт` : ''}. SKU: ${c.sku || 'уточню'}.`,
    `${c.scheme === 'FBO' ? 'Поставка/отправление' : 'Отправление'}: ${c.ref || 'уточню'}.`,
    what,
    'Прошу вернуть стоимость товара или указать причину отказа. Видео сборки прилагается.',
  ].join('\n');
  return text.length <= 1000 ? text : `${text.slice(0, 997)}...`;
}

function approvalMessages(items) {
  const out = [];
  for (const c of items) {
    out.push(`📦 Для склада (перешлите в группу склада):\n\n${warehouseMessage(c)}`);
    out.push(`✉️ Текст обращения для поддержки (${c.article}), тема: «${topicOf(c)}»:\n\n${supportText(c)}`);
  }
  const arts = items.map((c) => c.article).join(', ');
  out.push(`Откройте Chrome и скажите Claude: подай обращение по ${arts}\n\n(Бот сам обращение не отправляет: у Озона для этого нет API, нужен вход Елены.)`);
  return out;
}

function splitMessage(text, max = 3800) { return rw.splitMessage(text, max); }

module.exports = {
  getState, patchState, addWriteoff, setCompensation, fetchWriteoffsApi,
  buildReport, formatShort, addFiledClaims, filedClaimSet, expandClaims, candidatesFromWriteoffs, earlyWriteoffs, markFiled, formatFiled, dropDuplicatesOfWriteoffs, isFiled, formatEarly, candidatesFromReturns, pickNew, markSent,
  formatCandidates, approvalMessages, supportText, warehouseMessage, topicOf,
  splitMessage, parseRuDate, daysSince, msToIso, hasCompensation, API_NOTICE,
  FIRST_DAY, REMIND_DAY, DAY_MS,
};
