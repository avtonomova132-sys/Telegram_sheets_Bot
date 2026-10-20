// Управление списком хостов без правок кода (Елена, 2026-10-21) и наблюдение за
// группой "WorldView Productions".
//
//   /hosts                 — список (@, имя, знает ли бот Telegram-ID, писал ли боту)
//   /host_add @имя         — добавить хоста
//   /host_remove @имя      — убрать хоста
//   (к любой из трёх можно дописать `test` — действует на ТЕСТОВУЮ копию списка)
//
// Только для Елены, в личке; остальным — молча ничего. После каждого изменения
// бот пишет ей, что изменилось и сколько теперь хостов, и обновляет счётчики в
// уже опубликованных карточках. Брони ✅ убранного хоста автоматически НЕ
// снимаются: Елена получает список этих эфиров с кнопкой «Снять бронь».
//
// Наблюдение за группой (ничего не меняет без ответа Елены):
//   • хост вышел/удалён → «👋 @имя вышел(ла) из группы. Убрать из хостов?» [✅ Убрать][❌ Оставить];
//   • в группу вступили новые люди → ОДНО общее сообщение «Добавить в хосты?»
//     [✅ Добавить][❌ Нет] (без дублей: уже отвеченные не спрашиваются снова).
// События приходят двумя путями: (1) обновления chat_member — Telegram шлёт их
// только если бот АДМИНИСТРАТОР группы; (2) служебные сообщения о
// вступлении/выходе (в больших группах Telegram их не создаёт). Для ухода уже
// известных хостов есть и запасная проверка раз в 30 минут (getChatMember по
// сохранённым Telegram-ID) — работает без прав админа, если Telegram отвечает.
// Всё без ИИ.
//
// Для проверки есть тестовая группа «Дебаты» с отдельной копией списка
// (/data/hosts_test.json): события оттуда идут по тому же сценарию, но меняют
// только копию.

const { hosts: realStore, createHostsStore, normUser, nameOf } = require('./hostsStore');
const cards = require('./cardButtons');

const WVP_GROUP_ID = Number(process.env.VOLUNTEER_GROUP_ID) || -1001757671785;
const TEST_GROUP_ID = Number(process.env.TEST_GROUP_CHAT_ID) || -5172293748;

// A throw-away copy of the real list, created on first use.
const testStore = createHostsStore({
  filePath: process.env.HOSTS_TEST_PATH || '/data/hosts_test.json',
  initial: () => {
    const real = realStore.read();
    return {
      hosts: real.hosts.map((h) => ({ ...h })),
      removed: [...real.removed],
      watch: { joinBuffer: [], joinAsked: {}, joinIgnored: {}, leaveAsked: {}, leaveKept: {}, inGroup: {} },
    };
  },
});

const CONTEXTS = {
  p: { key: 'p', chatId: WVP_GROUP_ID, store: realStore, label: '', real: true },
  t: { key: 't', chatId: TEST_GROUP_ID, store: testStore, label: '🧪 [ТЕСТ — «Дебаты», копия списка, настоящий список не меняется] ', real: false },
};
const ctxByChat = (chatId) => Object.values(CONTEXTS).find((c) => c.chatId === chatId) || null;

const elenaId = () => (process.env.MY_CHAT_ID ? Number(process.env.MY_CHAT_ID) : null);
const isElena = (msg) => Boolean(msg && msg.from && elenaId() && msg.from.id === elenaId() && msg.chat && msg.chat.type === 'private');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function tell(bot, text, options = {}) {
  const id = elenaId();
  if (!id) return null;
  try {
    return await bot.sendMessage(id, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...options });
  } catch (err) {
    console.error('[hosts] не удалось написать Елене:', err.message);
    return null;
  }
}

const personLabel = (p) => (p.username ? `@${p.username}` : p.name || nameOf(p) || `id ${p.id}`);

// ---- list and edits ----
function hostsListText(ctx) {
  const list = ctx.store.entries();
  const lines = [`${ctx.label}👥 <b>Хосты (${list.length}):</b>`];
  list.forEach((h, i) =>
    lines.push(`${i + 1}. ${esc(h.tag)}${h.name ? ` — ${esc(h.name)}` : ''} · ID: ${h.id ? 'известен' : 'не известен'} · Start у бота: ${h.started ? 'да' : 'не замечено'}`)
  );
  lines.push('', 'Изменить: /host_add @имя · /host_remove @имя' + (ctx.real ? ' (с словом test в конце — на тестовой копии)' : ''));
  lines.push('ID появляется, когда человек нажимает кнопку под карточкой, пишет боту или пишет в группе.');
  return lines.join('\n');
}

async function afterChange(bot, ctx, summary, goneEntry = null) {
  const lines = [`${ctx.label}${summary}`, `Теперь хостов: <b>${ctx.store.tags().length}</b>.`];
  const buttons = [];
  if (goneEntry && ctx.real) {
    const reserved = cards.reservationsOfHost(goneEntry);
    if (reserved.length > 0) {
      lines.push('', `⚠️ На брони ${esc(goneEntry.tag)} (автоматически НЕ снимаются) такие эфиры:`);
      reserved.forEach((r) => {
        lines.push(`• ${esc(r.text)}`);
        buttons.push([{ text: `↩️ Снять бронь: ${r.text.slice(0, 40)}`, callback_data: `hr:${r.key}` }]);
      });
    }
  }
  if (ctx.real) cards.refreshCardsAfterHostListChange(bot).catch(() => {});
  await tell(bot, lines.join('\n'), buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {});
}

function ctxFromArgs(arg) {
  const parts = String(arg || '').trim().split(/\s+/).filter(Boolean);
  const test = parts[parts.length - 1] && parts[parts.length - 1].toLowerCase() === 'test';
  if (test) parts.pop();
  return { ctx: test ? CONTEXTS.t : CONTEXTS.p, name: parts[0] || '' };
}

async function handleCommand(bot, msg, command, arg = '') {
  if (!isElena(msg)) return;
  const { ctx, name } = ctxFromArgs(arg);
  if (command === 'hosts') return tell(bot, hostsListText(/^test$/i.test(String(arg).trim()) ? CONTEXTS.t : CONTEXTS.p));
  if (!name) return tell(bot, `Формат: /${command} @имя`);
  if (command === 'host_add') {
    const res = ctx.store.add(name);
    if (!res.ok) return tell(bot, res.reason === 'exists' ? `${esc(name)} уже в списке.` : 'Не похоже на имя пользователя Telegram (латиница, цифры и _, от 4 знаков).');
    return afterChange(bot, ctx, `➕ Добавлен хост ${esc(res.entry.tag)}.`);
  }
  if (command === 'host_remove') {
    const res = ctx.store.remove(name);
    if (!res.ok) return tell(bot, `${esc(name)} нет в списке хостов.`);
    return afterChange(bot, ctx, `➖ Убран хост ${esc(res.entry.tag)}.`, res.entry);
  }
}

// ---- watching the group ----
async function memberLeft(bot, ctx, user) {
  if (!user || user.is_bot) return;
  // someone who left before being asked about
  ctx.store.update((s) => {
    s.watch.joinBuffer = s.watch.joinBuffer.filter((j) => j.id !== user.id);
  });
  const host = ctx.store.findByUser(user);
  if (!host) return;
  const key = normUser(host.username);
  const skip = ctx.store.update((s) => {
    if (s.watch.leaveAsked[key] || s.watch.leaveKept[key]) return true;
    s.watch.leaveAsked[key] = Date.now();
    s.watch.inGroup[key] = false;
    return false;
  });
  if (skip) return;
  const sent = await tell(bot, `${ctx.label}👋 ${esc(host.tag)} вышел(ла) из группы. Убрать из хостов? / left the group. Remove from hosts?`, {
    reply_markup: {
      inline_keyboard: [[{ text: '✅ Убрать / Remove', callback_data: `hw:lv:ok:${ctx.key}:${key}` }, { text: '❌ Оставить / Keep', callback_data: `hw:lv:no:${ctx.key}:${key}` }]],
    },
  });
  if (!sent) ctx.store.update((s) => delete s.watch.leaveAsked[key]); // could not ask: try again later
}

function memberJoined(ctx, user) {
  if (!user || user.is_bot) return;
  ctx.store.update((s) => {
    const key = normUser(user.username || '') || String(user.id);
    const host = s.hosts.find((h) => ctx.store.matches(h, user));
    if (host) {
      // a host came back: forget old leave answers
      const hk = normUser(host.username);
      delete s.watch.leaveAsked[hk];
      delete s.watch.leaveKept[hk];
      s.watch.inGroup[hk] = true;
      return;
    }
    if (s.watch.joinIgnored[user.id]) return;
    if (s.watch.joinBuffer.some((j) => j.id === user.id)) return;
    if (Object.values(s.watch.joinAsked).some((list) => list.some((j) => j.id === user.id))) return;
    s.watch.joinBuffer.push({ id: user.id, username: user.username || null, name: nameOf(user), at: Date.now(), key });
  });
}

// One combined message for everyone who joined (waits ~1 minute so a wave of
// joins becomes a single question).
async function flushJoins(bot, ctx, now = Date.now(), force = false) {
  const ready = ctx.store.update((s) => {
    const buf = s.watch.joinBuffer;
    if (buf.length === 0 || (!force && now - Math.max(...buf.map((j) => j.at)) < 60 * 1000)) return null;
    s.watch.joinBuffer = [];
    return buf;
  });
  if (!ready) return;
  const lines = ready.map((j) => (j.username ? `@${j.username}${j.name ? ` (${j.name})` : ''}` : `${j.name || `id ${j.id}`} — без @имени`));
  const many = ready.length > 1;
  const text = `${ctx.label}👋 ${many ? 'Новые участники' : 'Новый участник'}: ${lines.map(esc).join(', ')}. Добавить в хосты?${many ? ' (✅ — всех, у кого есть @имя)' : ''}`;
  // The list is filed under a token that is already inside the buttons, so the
  // answer finds exactly this list even if nothing else is edited afterwards.
  const token = Date.now().toString(36);
  ctx.store.update((s) => {
    s.watch.joinAsked[token] = ready;
  });
  const sent = await tell(bot, text, {
    reply_markup: { inline_keyboard: [[{ text: '✅ Добавить / Add', callback_data: `hw:jn:ok:${ctx.key}:${token}` }, { text: '❌ Нет / No', callback_data: `hw:jn:no:${ctx.key}:${token}` }]] },
  });
  if (!sent) {
    // could not ask: put them back, the next tick asks again
    ctx.store.update((s) => {
      delete s.watch.joinAsked[token];
      s.watch.joinBuffer.push(...ready);
    });
  }
}

function transition(update) {
  const old = update.old_chat_member && update.old_chat_member.status;
  const nu = update.new_chat_member && update.new_chat_member.status;
  const inside = (st, m) => ['member', 'administrator', 'creator'].includes(st) || (st === 'restricted' && m && m.is_member);
  const wasIn = inside(old, update.old_chat_member);
  const isIn = inside(nu, update.new_chat_member);
  if (!wasIn && isIn) return 'joined';
  if (wasIn && !isIn) return 'left';
  return null;
}

// Updates of type chat_member (the bot must be an administrator of the group).
async function onChatMember(bot, update) {
  const ctx = update && update.chat ? ctxByChat(update.chat.id) : null;
  if (!ctx) return;
  const user = update.new_chat_member && update.new_chat_member.user;
  const kind = transition(update);
  if (kind === 'left') await memberLeft(bot, ctx, user);
  else if (kind === 'joined') memberJoined(ctx, user);
}

// Service messages "X joined" / "X left" (not produced in big groups).
async function onNewMembers(bot, msg) {
  const ctx = ctxByChat(msg.chat.id);
  if (!ctx) return;
  for (const u of msg.new_chat_members || []) memberJoined(ctx, u);
}
async function onLeftMember(bot, msg) {
  const ctx = ctxByChat(msg.chat.id);
  if (!ctx || !msg.left_chat_member) return;
  await memberLeft(bot, ctx, msg.left_chat_member);
}

// Any message: learn the id / profile name of hosts, and whether a person has
// written to the bot privately (which is what allows the bot to write back).
function noteMessage(msg) {
  if (!msg || !msg.from || msg.from.is_bot) return;
  if (msg.chat.type === 'private') {
    realStore.learn(msg.from, { privateChat: true });
    testStore.learn(msg.from, { privateChat: true });
    return;
  }
  const ctx = ctxByChat(msg.chat.id);
  if (ctx) {
    ctx.store.learn(msg.from); // a changed @username refreshes the cards on the next tick
  }
}

// ---- answers to Elena's questions ----
async function onCallback(bot, query) {
  const data = String(query.data || '');
  const ack = (text) => bot.answerCallbackQuery(query.id, text ? { text } : {}).catch(() => {});
  if (!elenaId() || !query.from || query.from.id !== elenaId()) return ack();

  if (data.startsWith('hr:')) {
    await ack('Снимаю бронь');
    const res = await cards.releaseReservation(bot, data.slice(3));
    return tell(bot, res.released ? '↩️ Бронь снята, эфир снова свободен (карточка обновлена).' : 'Эту бронь уже не нашла — возможно, она снята.');
  }

  const m = data.match(/^hw:(lv|jn):(ok|no):([pt]):(.+)$/);
  if (!m) return ack();
  const [, kind, answer, ctxKey, ref] = m;
  const ctx = CONTEXTS[ctxKey];
  const msgId = query.message && query.message.message_id;
  const clear = async (suffix) => {
    try {
      await bot.editMessageText(`${(query.message.text || '').trim()}\n\n${suffix}`, { chat_id: elenaId(), message_id: msgId, reply_markup: { inline_keyboard: [] } });
    } catch {
      /* text unchanged or message gone */
    }
  };

  if (kind === 'lv') {
    const open = ctx.store.update((s) => {
      const had = Boolean(s.watch.leaveAsked[ref]);
      delete s.watch.leaveAsked[ref];
      if (had && answer === 'no') s.watch.leaveKept[ref] = Date.now();
      return had;
    });
    if (!open) {
      await ack('Уже обработано');
      return clear('— уже обработано');
    }
    if (answer === 'no') {
      await ack('Оставила в списке');
      return clear('✅ Оставлен(а) в списке хостов.');
    }
    const res = ctx.store.remove(`@${ref}`);
    await ack(res.ok ? 'Убрала из хостов' : 'Его уже нет в списке');
    await clear(res.ok ? '✅ Убран(а) из хостов.' : '— его уже нет в списке.');
    if (res.ok) await afterChange(bot, ctx, `➖ Убран хост ${esc(res.entry.tag)} (вышел(ла) из группы).`, res.entry);
    return;
  }

  // joins
  const list = ctx.store.update((s) => {
    const l = s.watch.joinAsked[ref] || null;
    delete s.watch.joinAsked[ref];
    if (l && answer === 'no') l.forEach((j) => (s.watch.joinIgnored[j.id] = Date.now()));
    return l;
  });
  if (!list) {
    await ack('Уже обработано');
    return clear('— уже обработано');
  }
  if (answer === 'no') {
    await ack('Не добавляю');
    return clear('✅ Не добавлены.');
  }
  const added = [];
  const skipped = [];
  for (const j of list) {
    if (!j.username) {
      skipped.push(j);
      continue;
    }
    const res = ctx.store.add(j.username, { id: j.id, name: j.name, source: 'group-join' });
    if (res.ok) added.push(res.entry.tag);
  }
  await ack('Добавила');
  await clear(`✅ Добавлено: ${added.join(', ') || 'никого'}${skipped.length ? `. Без @имени (добавить нельзя, пока нет имени пользователя): ${skipped.map(personLabel).join(', ')}` : ''}.`);
  if (added.length > 0) await afterChange(bot, ctx, `➕ Добавлены хосты: ${esc(added.join(', '))}.`);
}

// ---- periodic: combined join question + fallback leave check ----
let lastMemberCheckAt = 0;

async function tick(bot, now = Date.now()) {
  // cards follow the list (a change of the list / a renamed host); no-op when nothing changed
  await cards.refreshCardsAfterHostListChange(bot).catch(() => {});
  for (const ctx of Object.values(CONTEXTS)) {
    try {
      await flushJoins(bot, ctx, now);
    } catch (err) {
      await cards.reportProblem(bot, `hosts-joins:${ctx.key}`, `Не получилось обработать вступивших в группу: ${err.message}`);
    }
  }
  if (now - lastMemberCheckAt < 30 * 60 * 1000) return;
  lastMemberCheckAt = now;
  const ctx = CONTEXTS.p;
  for (const h of ctx.store.entries().filter((x) => x.id)) {
    try {
      const member = await bot.getChatMember(ctx.chatId, h.id);
      const key = normUser(h.username);
      if (['left', 'kicked'].includes(member.status)) await memberLeft(bot, ctx, { id: h.id, username: h.username, first_name: h.name });
      else {
        ctx.store.update((s) => {
          s.watch.inGroup[key] = true;
          if (s.watch.leaveKept[key]) delete s.watch.leaveKept[key]; // is back in the group
        });
      }
    } catch (err) {
      if (/chat not found|not enough rights|bot was kicked|CHAT_ADMIN_REQUIRED/i.test(err.message)) {
        await cards.reportProblem(bot, 'hosts-memberscheck', `Не могу проверить участников группы (${err.message}). Чтобы бот замечал уходы, сделайте его администратором группы.`, 24 * 60 * 60 * 1000);
        return;
      }
      /* "user not found" and the like for one person: skip, try again later */
    }
  }
}

module.exports = {
  handleCommand,
  onChatMember,
  onNewMembers,
  onLeftMember,
  noteMessage,
  onCallback,
  tick,
  CONTEXTS,
  testStore,
  hostsListText,
  // for tests
  flushJoins,
  memberLeft,
  memberJoined,
};
