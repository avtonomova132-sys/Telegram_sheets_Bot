// Ежедневная анонимная заявка в форму Ozon (цвет, садовые бирки).
// Состояние хранится на Railway Volume (/data), переживает перезапуски.
// Секретов нет: ID формы публичный, chat_id Елены — в переменной окружения.
const fs = require('fs');
const path = require('path');
const { isTrustedUser } = require('../auth');

const FORM_URL = 'https://forms.ozon.ru/api/v1/v2/form/14a89469f174bccf96cdbd60fde228aa48';
const STATE_PATH = process.env.OZON_FORM_STATE_PATH || '/data/ozon-form.json';
const BALI_OFFSET_MS = 8 * 60 * 60 * 1000;
const WINDOW_START_H = 8;
const WINDOW_END_H = 20;
const TICK_MS = 60 * 1000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BODY = {
  results: [
    {
      answers: [
        { questionOrder: 1, options: [{ value: 'Табличка садовая' }], commentary: '' },
        { questionOrder: 2, options: [{ order: '1' }], commentary: '' },
        { questionOrder: 3, options: [{ value: 'Цвет товара' }], commentary: '' },
        { questionOrder: 4, options: [], commentary: '' },
        { questionOrder: 5, options: [], commentary: '' },
      ],
    },
  ],
  terms: [],
  utm: { utmCampaign: '', utmContent: '', utmMedium: '', utmSource: '', utmTerm: '' },
};

function totalDays() {
  const n = parseInt(process.env.OZON_FORM_DAYS || '14', 10);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[ozon-form] состояние нечитаемо:', err.message);
    return { active: false, chatId: null, sent: [], nextAt: null, nextDate: null, finished: false };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

function baliDate(ms = Date.now()) {
  return new Date(ms + BALI_OFFSET_MS).toISOString().slice(0, 10);
}

function fmtBali(ms) {
  return new Date(ms + BALI_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16) + ' (Бали)';
}

// Случайный момент 08:00–20:00 по Бали в день dateStr; если окно уже прошло
// или идёт — выбираем момент в оставшейся части окна (или в ближайшие 10 мин).
function pickTime(dateStr, now = Date.now()) {
  const dayStart = Date.parse(`${dateStr}T00:00:00Z`) - BALI_OFFSET_MS;
  const from = dayStart + WINDOW_START_H * 3600e3;
  const to = dayStart + WINDOW_END_H * 3600e3;
  if (now >= to) return now + Math.floor(Math.random() * 10 * 60e3);
  const lo = Math.max(from, now);
  return lo + Math.floor(Math.random() * (to - lo));
}

async function submit() {
  let res;
  try {
    res = await fetch(FORM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify(BODY),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    return { ok: false, code: 'сеть', reason: `ошибка сети: ${err.message}` };
  }
  const text = (await res.text().catch(() => '')).slice(0, 2000);
  if (!res.ok) {
    const captcha = /captcha|antibot|challenge|капч/i.test(text) || [403, 429].includes(res.status);
    return { ok: false, code: res.status, reason: captcha ? 'похоже на капчу/защиту' : 'ошибка Ozon', body: text.slice(0, 200) };
  }
  if (/captcha|antibot|challenge|капч/i.test(text)) {
    return { ok: false, code: res.status, reason: 'ответ похож на капчу/защиту', body: text.slice(0, 200) };
  }
  return { ok: true, code: res.status };
}

function init(bot) {
  const say = (chatId, text) => chatId && bot.sendMessage(chatId, text).catch((e) => console.error('[ozon-form] sendMessage:', e.message));
  const envChat = () => process.env.OZON_FORM_CHAT_ID || null;
  const target = (s) => s.chatId || envChat();

  async function runScheduled() {
    const s = readState();
    s.chatId = target(s);
    const day = s.sent.length + 1;
    const M = totalDays();
    const r = await submit();
    if (!r.ok) {
      s.active = false;
      s.nextAt = null;
      writeState(s);
      await say(s.chatId, `⚠️ Заявка Ozon (цвет, садовые бирки): ${r.reason}, HTTP ${r.code}. Серия остановлена, защиту не обхожу.${r.body ? `\nОтвет: ${r.body}` : ''}`);
      return;
    }
    s.sent.push({ date: baliDate(), at: new Date().toISOString(), code: r.code });
    s.nextAt = null;
    s.nextDate = null;
    await say(s.chatId, `Заявка Ozon (цвет, садовые бирки) подана, день ${day} из ${M}, ответ HTTP ${r.code}`);
    if (s.sent.length >= M) {
      s.active = false;
      s.finished = true;
      await say(s.chatId, 'Серия закончена ✅ (форма Ozon, цвет, садовые бирки).');
    }
    writeState(s);
  }

  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const s = readState();
      if (!s.active) return;
      const today = baliDate();
      if (s.sent.some((x) => x.date === today)) return; // сегодня уже отправлено
      if (s.nextDate !== today || !s.nextAt) {
        s.nextDate = today;
        s.nextAt = pickTime(today);
        writeState(s);
      }
      if (Date.now() >= s.nextAt) await runScheduled();
    } catch (err) {
      console.error('[ozon-form] tick:', err);
    } finally {
      busy = false;
    }
  }
  setInterval(tick, TICK_MS);
  setTimeout(tick, 5000);

  bot.onText(/^\/форма_цвет_тест(?:@\S+)?$/, async (msg) => {
    if (!isTrustedUser(msg.chat.id)) return;
    const r = await submit();
    await bot.sendMessage(msg.chat.id, r.ok
      ? `Тестовая отправка: HTTP ${r.code} (в серию не засчитана)`
      : `Тестовая отправка не прошла: ${r.reason}, HTTP ${r.code}. Защиту не обхожу.`);
  });

  bot.onText(/^\/форма_цвет_старт(?:@\S+)?$/, async (msg) => {
    if (!isTrustedUser(msg.chat.id)) return;
    const s = readState();
    s.active = true;
    s.finished = false;
    s.sent = [];
    s.nextAt = null;
    s.nextDate = null;
    s.chatId = envChat() || String(msg.chat.id);
    writeState(s);
    await bot.sendMessage(msg.chat.id, `Серия запущена: ${totalDays()} дней, по одной заявке в день в случайное время 08:00–20:00 по Бали.`);
    tick();
  });

  bot.onText(/^\/форма_цвет_статус(?:@\S+)?$/, async (msg) => {
    if (!isTrustedUser(msg.chat.id)) return;
    const s = readState();
    const M = totalDays();
    let next = 'не запланирована';
    if (s.active) {
      next = s.nextAt && s.nextDate === baliDate() ? fmtBali(s.nextAt) : 'будет выбрано завтра/после ближайшей проверки';
      if (s.sent.some((x) => x.date === baliDate())) next = 'завтра (сегодня уже отправлено)';
    }
    const state = s.finished ? 'серия закончена' : s.active ? 'идёт' : 'остановлена';
    await bot.sendMessage(msg.chat.id, `Форма Ozon (цвет, садовые бирки): ${state}\nОтправлено: ${s.sent.length} из ${M}\nСледующая: ${next}`);
  });

  bot.onText(/^\/форма_цвет_стоп(?:@\S+)?$/, async (msg) => {
    if (!isTrustedUser(msg.chat.id)) return;
    const s = readState();
    s.active = false;
    s.nextAt = null;
    s.nextDate = null;
    writeState(s);
    await bot.sendMessage(msg.chat.id, `Серия остановлена. Отправлено ${s.sent.length} из ${totalDays()}.`);
  });
}

module.exports = { init, pickTime, baliDate };
