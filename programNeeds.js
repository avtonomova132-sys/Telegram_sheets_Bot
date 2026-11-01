// «Нужны ли хосты WVP на программу» (Елена, 2026-11-02). Сообщение «Table update»
// (programsWatch.js) приходит с кнопками «Нужны хосты» / «Не нужны»; решение
// хранится в programRules.js. Здесь: кнопки, команды /program_no /program_need
// /programs /programs_scan, суточный шаг для программ «нужны» (ждём вкладку →
// превью «добавить эфир в напоминание для группы»). Расписание Анонса, вторничную
// сводку, «за 24 ч» и обучение не трогает: только читает таблицу и просит превью.

const rules = require('./programRules');
const { loadConfig, collectWeekEvents, fetchWithTimeout, escapeHtml, isExcludedProgramEvent } = require('./report');
const { fetchProgramRows, programHostStatus } = require('./programsWatch');
const nomenclature = require('./nomenclature');
const cards = require('./cardButtons');
const { baliDateString, baliHour } = require('./verse/progress');

const DAY_MS = 24 * 3600 * 1000;
const elenaId = () => (process.env.MY_CHAT_ID ? Number(process.env.MY_CHAT_ID) : null);
const isElena = (msg) => Boolean(msg && msg.from && elenaId() && msg.from.id === elenaId() && msg.chat && msg.chat.type === 'private');

async function tell(bot, text, opts = {}) {
  const id = elenaId();
  if (!id) return null;
  try {
    return await bot.sendMessage(id, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...opts });
  } catch (err) {
    console.error('[program-needs] не удалось написать Елене:', err.message);
    return null;
  }
}

const unescapeJs = (s) =>
  String(s)
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(.)/g, '$1');

// Все вкладки таблицы (название + gid). Через Sheets API, если есть ключ сервисного
// аккаунта и ему открыта таблица; иначе — публичная страница таблицы (htmlview), на
// ней перечислены все вкладки. Не получилось — бросает ошибку (её видит Елена).
async function listSheetTabs() {
  const config = loadConfig();
  const id = config.spreadsheetId;
  const errors = [];
  try {
    const sa = typeof nomenclature.loadServiceAccount === 'function' ? nomenclature.loadServiceAccount() : null;
    if (sa) {
      const token = await nomenclature.getAccessToken(sa);
      const res = await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties(sheetId,title)`, 25000, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const json = await res.json();
        return (json.sheets || []).map((s) => ({ name: s.properties.title, gid: String(s.properties.sheetId) }));
      }
      errors.push(`Sheets API HTTP ${res.status}`);
    }
  } catch (err) {
    errors.push(`Sheets API: ${err.message}`);
  }
  try {
    const res = await fetchWithTimeout(`https://docs.google.com/spreadsheets/d/${id}/htmlview`, 25000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const tabs = [];
    const re = /items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)"[^}]*?gid:\s*"(\d+)"/g;
    let m;
    while ((m = re.exec(html))) tabs.push({ name: unescapeJs(m[1]), gid: m[2] });
    if (tabs.length > 0) return tabs;
    errors.push('htmlview: вкладки на странице не найдены');
  } catch (err) {
    errors.push(`htmlview: ${err.message}`);
  }
  throw new Error(`не удалось получить список вкладок таблицы (${errors.join('; ')})`);
}

const normTab = (s) => rules.norm(s);
function findTabFor(name, tabs) {
  return tabs.find((t) => rules.sameProgram(t.name, name)) || null;
}

// ---- кнопки под «Table update» ----
async function onCallback(bot, query) {
  const m = String(query.data || '').match(/^prg:(need|no):(.+)$/);
  if (!m) return false;
  const answer = (text) => bot.answerCallbackQuery(query.id, text ? { text } : {}).catch(() => {});
  if (!query.from || query.from.id !== elenaId()) {
    await answer();
    return true;
  }
  const [, action, id] = m;
  const pending = rules.read().pending[id];
  if (!pending) {
    await answer('Не нашла эту программу — используйте /program_need или /program_no «название»');
    return true;
  }
  const res = action === 'no' ? rules.setExcluded(pending.name) : rules.setNeeded(pending.name);
  rules.update((s) => {
    delete s.pending[id];
  });
  await answer(action === 'no' ? 'Хосты не нужны' : 'Хосты нужны');
  const msg = query.message;
  if (msg) {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
  }
  await tell(
    bot,
    action === 'no'
      ? `🚫 Хосты на «${escapeHtml(pending.name)}» не нужны: программа исключена из Анонса, напоминаний, сводок, «за 24 ч» и «Новый эфир». Отменить: /program_need ${escapeHtml(pending.name)}`
      : `✅ Хосты на «${escapeHtml(pending.name)}» нужны. ${res && res.hadExcluded ? 'Программа убрана из исключённых. ' : ''}Если вкладки ещё нет, напомню; как только появится эфир без хоста — пришлю превью для группы.`
  );
  if (action === 'need') await step(bot, Date.now(), { force: true }).catch((err) => console.error('[program-needs]', err.message));
  return true;
}

// ---- команды ----
const STATIC_EXCLUDED = ['Pramana (любой эфир со словом «Pramana»)', 'THE BREAKFAST CLUB with Nick Lashaw', 'ACI с Inna Ivanina / Bill McMichael'];
const dayStr = (ms) => (ms ? new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10) : '—');

function programsText() {
  const s = rules.read();
  const lines = ['📚 <b>Программы и хосты</b>', '', '<b>Исключены (хосты не нужны):</b>'];
  STATIC_EXCLUDED.forEach((n) => lines.push(`• ${escapeHtml(n)} (зашито)`));
  s.excluded.forEach((p) => lines.push(`• ${escapeHtml(p.name)} (с ${dayStr(p.at)})`));
  lines.push('', '<b>Хосты нужны (активные):</b>');
  if (s.needed.length === 0) lines.push('— пока нет');
  s.needed.forEach((p) => lines.push(`• ${escapeHtml(p.name)} — ${p.tab ? `вкладка есть (${escapeHtml(p.tab.name)})` : 'вкладки ещё нет'}`));
  const pend = Object.values(s.pending);
  if (pend.length > 0) {
    lines.push('', '<b>Ждут ответа Насти:</b>');
    pend.forEach((p) => lines.push(`• ${escapeHtml(p.name)}`));
  }
  lines.push('', 'Команды: /program_no «название» · /program_need «название» · /programs_scan');
  return lines.join('\n');
}

async function handleCommand(bot, msg, command, arg = '') {
  if (!isElena(msg)) return;
  const name = String(arg || '').replace(/^["«“]|["»”]$/g, '').trim();
  if (command === 'programs') return tell(bot, programsText());
  if (command === 'programs_scan') return scan(bot);
  if (command === 'program_tab') {
    const r = setTabManually(arg);
    if (!r.ok) return tell(bot, r.reason === 'not-needed' ? 'Этой программы нет в списке «хосты нужны». Сначала /program_need «название».' : 'Формат: /program_tab «название вкладки» gid');
    await tell(bot, `📑 Вкладка привязана к «${escapeHtml(r.program)}».`);
    const seeded = await seedProgramsOnce(bot);
    if (seeded && seeded.resolvedAll) {
      await cards.reissueAnnouncePreview(bot, { monday: new Date(Date.UTC(2026, 10, 2)), once: 'announce-reissue-sanskrit-lamrim-2026-11-02' }).catch((err) => console.error('[program-needs]', err.message));
    }
    return null;
  }
  if (!name) return tell(bot, `Формат: /${command} «название программы»`);
  if (command === 'program_no') {
    const r = rules.setExcluded(name);
    if (!r.ok) return tell(bot, 'Название слишком короткое.');
    return tell(bot, `🚫 «${escapeHtml(r.name)}» — хосты не нужны. Исключена из Анонса, напоминаний, сводок, «за 24 ч», «Новый эфир» и счётчика. Вернуть: /program_need ${escapeHtml(r.name)}`);
  }
  if (command === 'program_need') {
    const r = rules.setNeeded(name);
    if (!r.ok) return tell(bot, 'Название слишком короткое.');
    await tell(bot, `✅ «${escapeHtml(r.name)}» — хосты нужны.${r.hadExcluded ? ' Убрана из исключённых.' : ''}`);
    return step(bot, Date.now(), { force: true }).catch((err) => console.error('[program-needs]', err.message));
  }
}

// ---- суточный шаг для программ «хосты нужны» ----
const stepState = { lastDate: null };
async function step(bot, now = Date.now(), { force = false } = {}) {
  const needed = rules.read().needed;
  if (needed.length === 0) return;
  if (!force) {
    if (baliHour(new Date(now)) < 9) return;
    const today = baliDateString(new Date(now));
    if (stepState.lastDate === today) return;
    stepState.lastDate = today;
  }

  let tabs = null;
  let tabsError = null;
  try {
    tabs = await listSheetTabs();
  } catch (err) {
    tabsError = err.message;
  }
  const config = loadConfig();

  for (const p of needed) {
    // 1) вкладка
    let tab = p.tab || null;
    if (!tab) {
      const names = [p.tabName, p.name].filter(Boolean);
      const known = config.tabs.find((t) => names.some((n) => rules.sameProgram(t.name, n)));
      const found = known || (tabs && names.map((n) => findTabFor(n, tabs)).find(Boolean));
      if (found) {
        tab = { name: found.name, gid: String(found.gid) };
        rules.update((s) => {
          const r = s.needed.find((x) => x.norm === p.norm);
          if (r) r.tab = tab;
        });
        await tell(bot, `📑 Вкладка «${escapeHtml(tab.name)}» найдена в таблице — программа «${escapeHtml(p.name)}» подключена к проверке хостов.`);
      }
    }
    if (!tab) {
      // раз в 2 дня, первое — через сутки после ответа «нужны»
      const due = (p.lastNoTabAt || p.at) + (p.lastNoTabAt ? 2 : 1) * DAY_MS;
      if (force || now < due) continue;
      rules.update((s) => {
        const r = s.needed.find((x) => x.norm === p.norm);
        if (r) r.lastNoTabAt = now;
      });
      await tell(bot, `📑 Вкладки <b>${escapeHtml(p.name)}</b> ещё нет в таблице.${tabsError ? ` (Список вкладок не получила: ${escapeHtml(tabsError)})` : ''}`);
      continue;
    }

    // 2) свободные эфиры текущей и ближайшей недели
    const base = new Date(now + 8 * 3600 * 1000);
    const monday = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() - ((base.getUTCDay() + 6) % 7)));
    const range = { start: new Date(monday.getTime() - DAY_MS), end: new Date(monday.getTime() + 13 * DAY_MS) };
    const collected = await collectWeekEvents(range);
    if (collected.failedTabs.length > 0) {
      console.warn('[program-needs] часть вкладок не загрузилась:', collected.failedTabs.join('; '));
    }
    const mine = collected.events.filter((e) => !e.hasHost && String(e.tabUrl || '').includes(`gid=${tab.gid}`) && !isExcludedProgramEvent(e.title, e.tabName));
    for (const e of mine) {
      const key = cards.eventKeyOf(e);
      if ((p.previewed || {})[key]) continue;
      const result = await cards.previewNewSession(bot, e, now);
      if (result === 'in-announce') continue; // уйдёт в воскресный Анонс — отметим позже, когда Анонс выйдет
      rules.update((s) => {
        const r = s.needed.find((x) => x.norm === p.norm);
        if (r) r.previewed = { ...(r.previewed || {}), [key]: now };
      });
    }
  }
}


// ---- Разовое подключение двух программ (Елена, 2026-11-02) ----
const SEED_PROGRAMS = [
  { name: 'The Sanskrit Mantra Pronunciation Workshop', tabName: 'Sanskrit with Christina Kasica' },
  { name: 'Lam Rim with Timothy Lowenhaupt', tabName: 'Lam Rim with Timothy Lowenhaupt' },
];
const SEED_ID = '2026-11-02-sanskrit-lamrim';
const ddmmOf = (d) => d.toISOString().slice(5, 10).split('-').reverse().join('.');

async function seedProgramsOnce(bot) {
  if ((rules.read().seeded || {})[SEED_ID]) return { skipped: true };
  const warnedBefore = Boolean(rules.read().seedWarned);
  const out = ['📚 <b>Подключаю две программы (хосты нужны)</b>'];
  let tabs = null;
  try {
    tabs = await listSheetTabs();
  } catch (err) {
    out.push(`⚠️ ${escapeHtml(err.message)}`);
  }
  const config = loadConfig();
  const week = { start: new Date(Date.UTC(2026, 10, 2)), end: new Date(Date.UTC(2026, 10, 8)) };
  const wide = { start: new Date(Date.UTC(2026, 10, 1)), end: new Date(Date.UTC(2027, 0, 31)) };
  const missing = [];
  for (const sp of SEED_PROGRAMS) {
    // убрать из исключённых всё, что относится к этой программе (по названию программы и вкладки)
    rules.update((s) => {
      s.excluded = s.excluded.filter((x) => !rules.sameProgram(x.name, sp.name) && !rules.sameProgram(x.name, sp.tabName));
    });
    rules.setNeeded(sp.name, { tabName: sp.tabName });
    const found = config.tabs.find((t) => rules.sameProgram(t.name, sp.tabName)) || (tabs && findTabFor(sp.tabName, tabs));
    rules.update((s) => {
      const r = s.needed.find((x) => rules.sameProgram(x.name, sp.name));
      if (r) {
        r.tabName = sp.tabName;
        if (found) r.tab = { name: found.name, gid: String(found.gid) };
      }
    });
    if (!found) missing.push(sp);
  }
  if (missing.length > 0) {
    out.push('', '❓ Не нашла вкладку (нет ни в проверке, ни в списке вкладок): ' + missing.map((m) => `«${escapeHtml(m.tabName)}»`).join(', '));
    out.push('Если знаете gid (число после gid= в ссылке на вкладку): /program_tab «название вкладки» gid');
  }

  // что бот видит в этих вкладках
  let collected = null;
  try {
    collected = await collectWeekEvents(wide);
  } catch (err) {
    out.push('', `⚠️ Не получилось прочитать вкладки: ${escapeHtml(err.message)}`);
  }
  const now = Date.now();
  for (const sp of SEED_PROGRAMS) {
    const rec = rules.read().needed.find((x) => rules.sameProgram(x.name, sp.name));
    out.push('', `<b>${escapeHtml(sp.name)}</b> — вкладка «${escapeHtml(sp.tabName)}»: ${rec && rec.tab ? `видна (gid ${escapeHtml(rec.tab.gid)})` : 'НЕ видна боту'}`);
    if (!rec || !rec.tab || !collected) continue;
    if (collected.failedTabs.some((f) => f.includes(rec.tab.name))) out.push('⚠️ вкладка не загрузилась');
    const mine = collected.events.filter((e) => String(e.tabUrl || '').includes(`gid=${rec.tab.gid}`));
    const inWeek = mine.filter((e) => e.date >= week.start && e.date <= week.end);
    out.push(`Эфиров в вкладке (до конца января): ${mine.length}; на 2–8.11: ${inWeek.length}`);
    inWeek.forEach((e) => out.push(`• ${ddmmOf(e.date)} ${escapeHtml(e.title || e.tabName)} — ${e.hasHost ? `хост: ${escapeHtml(e.host)}` : 'хоста нет'}`));
    // эти эфиры уйдут в новый Анонс - отдельное «новый эфир» по ним не нужно
    rules.update((s) => {
      const r = s.needed.find((x) => x.norm === rec.norm);
      if (r) for (const e of inWeek) r.previewed = { ...(r.previewed || {}), [cards.eventKeyOf(e)]: now };
    });
  }
  const resolvedAll = SEED_PROGRAMS.every((sp) => {
    const rec = rules.read().needed.find((x) => rules.sameProgram(x.name, sp.name));
    return rec && rec.tab;
  });
  rules.update((s) => {
    if (resolvedAll) s.seeded = { ...(s.seeded || {}), [SEED_ID]: now };
    else s.seedWarned = true;
  });
  // Not resolved yet: say it once (the seed re-runs at every start and after /program_tab until both tabs are seen).
  if (resolvedAll || !warnedBefore) await tell(bot, out.join('\n'));
  return { ok: true, resolvedAll };
}

// /program_tab «название вкладки» gid - вручную привязать вкладку к программе из списка «нужны хосты»
function setTabManually(argText) {
  const m = String(argText || '').match(/^(.*?)[\s]+(\d{3,})\s*$/);
  if (!m) return { ok: false };
  const name = m[1].replace(/^["«“]|["»”]$/g, '').trim();
  const res = rules.update((s) => {
    const r = s.needed.find((x) => rules.sameProgram(x.name, name) || (x.tabName && rules.sameProgram(x.tabName, name)));
    if (!r) return { ok: false, reason: 'not-needed' };
    r.tab = { name: r.tabName || name, gid: m[2] };
    return { ok: true, program: r.name };
  });
  return res;
}

// ---- /programs_scan: что в таблице бот ещё не знает или не учитывает ----
async function scan(bot) {
  await tell(bot, 'Смотрю таблицу WVP 2026… Секунду.');
  const config = loadConfig();
  const out = ['🔎 <b>Что бот не знает / не учитывает в Анонсе</b>'];
  let tabs = null;
  try {
    tabs = await listSheetTabs();
  } catch (err) {
    out.push('', `⚠️ ${escapeHtml(err.message)}`);
  }
  if (tabs) {
    const known = new Set(config.tabs.map((t) => String(t.gid)));
    const unknown = tabs.filter((t) => !known.has(String(t.gid)));
    out.push('', `<b>Вкладки, которых нет в проверке хостов (${unknown.length}):</b>`);
    if (unknown.length === 0) out.push('— нет');
    unknown.forEach((t) => out.push(`• ${escapeHtml(t.name)} (gid ${escapeHtml(t.gid)})`));
  }
  try {
    const { programs } = await fetchProgramRows();
    const tabNames = [...config.tabs.map((t) => t.name), ...(tabs || []).map((t) => t.name)];
    const rows = programs.filter((pr) => programHostStatus(pr) !== 'excluded');
    const lines = rows.map((pr) => {
      const hasTab = tabNames.some((n) => rules.sameProgram(n, pr.name));
      const st = programHostStatus(pr);
      return `• ${escapeHtml(pr.abbrev ? `${pr.abbrev} — ${pr.name}` : pr.name)}; ${escapeHtml(pr.dates || '—')}; вкладка: ${hasTab ? 'да' : 'нет'}; хосты: ${st === 'needed' ? 'нужны' : 'не решено'}`;
    });
    out.push('', `<b>Программы из «2026 Programs» без решения или без вкладки (список для Насти):</b>`);
    const need = lines.filter((l) => l.includes('вкладка: нет') || l.includes('не решено'));
    if (need.length === 0) out.push('— нет');
    need.forEach((l) => out.push(l));
  } catch (err) {
    out.push('', `⚠️ «2026 Programs»: ${escapeHtml(err.message)}`);
  }
  // свободные эфиры известных вкладок на 2 недели (чтобы видеть, что реально идёт в Анонс)
  try {
    const now = Date.now();
    const collected = await collectWeekEvents({ start: new Date(now - DAY_MS), end: new Date(now + 21 * DAY_MS) });
    const free = collected.events.filter((e) => !e.hasHost);
    out.push('', `<b>Эфиры без хоста на ближайшие 3 недели (${free.length}):</b>`);
    free.slice(0, 40).forEach((e) => out.push(`• ${escapeHtml(e.tabName)} — ${e.date.toISOString().slice(5, 10).split('-').reverse().join('.')}`));
  } catch (err) {
    out.push('', `⚠️ эфиры: ${escapeHtml(err.message)}`);
  }
  const text = out.join('\n');
  for (let i = 0; i < text.length; i += 3800) await tell(bot, text.slice(i, i + 3800));
}

module.exports = { seedProgramsOnce, onCallback, handleCommand, step, listSheetTabs, programsText, scan };
