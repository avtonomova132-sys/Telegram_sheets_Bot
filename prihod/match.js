// Сопоставление строк накладной с семьями: кандидаты (нечёткий поиск) в коде,
// выбор среди кандидатов — моделью, жёсткие правила различения — в коде.

const Anthropic = require('@anthropic-ai/sdk');
const { norm, dense, tokens, trigrams, dice } = require('./text');
const nameMap = require('./nameMap');

const MAX_CANDIDATES = 5;
const MIN_SCORE = 0.28;
const WEIGHT_TOL = 0.03;

const MODEL_ALIASES = {
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
  opus: 'claude-opus-4-6',
};
function modelName() {
  const m = String(process.env.PRIHOD_MODEL || 'sonnet').trim();
  return MODEL_ALIASES[m.toLowerCase()] || m;
}

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// Жёсткие правила «разные товары»: возвращают false, если кандидат запрещён.
const RULES = [
  // «Украли сахар» и «Украли сахар с лаймом» — разные товары.
  (inv, cand) => !/украли сахар/.test(inv) || /лайм/.test(inv) === /лайм/.test(cand),
  // Прозрачные = «Комби…»; простые «Крафт…/Белые…» — другие, непрозрачные.
  (inv, cand) => {
    if (!/(крафт|бел)/.test(inv)) return true;
    return /прозрачн/.test(inv) === /комби/.test(cand);
  },
  // Рот Фронт «Лимончики» — не «Лимонная карамель».
  (inv, cand) => !/лимончики/.test(inv) || !/лимонная ?карамель/.test(cand),
];

function weightOk(lineG, famG) {
  if (!lineG || !famG) return true; // неизвестный вес не отсекает, решает модель/Елена
  return Math.abs(lineG - famG) / famG <= WEIGHT_TOL;
}

function candidatesFor(line, families, { minScore = MIN_SCORE, max = MAX_CANDIDATES } = {}) {
  const inv = norm(line.name);
  const tok = tokens(line.name);
  const tri = trigrams(line.name);
  const scored = [];
  for (const f of families) {
    const candText = norm(`${f.title} ${f.stems.join(' ')} ${f.base}`);
    if (!RULES.every((r) => r(inv, candText))) continue;
    if (!weightOk(line.unitWeightG, f.weightG)) continue;
    const overlap = tok.length ? tok.filter((t) => f.tok.has(t) || [...f.tok].some((x) => x.startsWith(t.slice(0, 5)) && t.length >= 5)).length / tok.length : 0;
    const score = 0.6 * dice(tri, f.tri) + 0.4 * overlap;
    if (score >= minScore) scored.push({ f, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((s) => s.f);
}

function describe(f) {
  return {
    id: f.id,
    название: f.title,
    вес_г: f.weightG,
    наборы_шт: f.members.map((m) => m.pieces),
    основа_артикула: f.base,
    артикулы: f.members.map((m) => m.article),
  };
}

async function askModel(items) {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY не задан');
  const system = `Ты сопоставляешь строки товарной накладной с карточками каталога Ozon. Совпадение ТОЛЬКО по названию, вкусу/виду и весу единицы; код поставщика не используй. У кандидата есть основа_артикула вида {вес}{БРЕНД_название} (напр. 250КАРАМЕЛЬ_Лимончики) — по ней тоже сравнивай вкус и вес. Для каждой строки выбери ровно одного кандидата по его id, или "none" (нет такого вкуса/веса/товара среди кандидатов), или "ambiguous" (подходят 2 и больше — перечисли их id в options). Не подставляй похожий товар: другой вкус или другой вес = "none". «Н.П.» = Новогодний Подарок. Ответ — СТРОГО JSON-массив без markdown: [{"i":номер строки,"choice":"id|none|ambiguous","options":["id",...],"reason":"коротко"}].`;
  const user = JSON.stringify(
    items.map((it) => ({ i: it.i, накладная: it.name, вес_единицы_г: it.unitWeightG, кандидаты: it.cands.map(describe) })),
  );
  const res = await anthropic.messages.create({
    model: modelName(),
    max_tokens: 2048,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = res.content.find((b) => b.type === 'text')?.text || '';
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) throw new Error('модель вернула не JSON при сопоставлении');
  return JSON.parse(m[0]);
}

// Результат для каждой строки: {status: 'matched'|'none'|'ambiguous', family, options, via}
async function matchLines(lines, families) {
  const out = new Array(lines.length);
  const pending = [];
  lines.forEach((line, i) => {
    // 1) подтверждённая карта названий
    const entry = nameMap.lookup(line.name);
    if (entry && entry.none) {
      // «Нет в Озоне» из памяти; переспрашиваем, только если среди подходящих
      // появились артикулы, которых Елена ещё не видела.
      const seen = new Set(entry.seen || []);
      const cands = candidatesFor(line, families);
      const fresh = cands.filter((f) => f.members.some((m) => !seen.has(m.article)));
      out[i] = fresh.length ? { status: 'ambiguous', options: cands, via: 'в каталоге появились новые карточки' } : { status: 'none', via: 'запомнено: нет в Озоне' };
      return;
    }
    if (entry) {
      // Семья всегда собирается из каталога по основе; словарь даёт только основу.
      let fams = families.filter((f) => nameMap.familyMatches(entry, f));
      if (line.unitWeightG && fams.some((f) => f.weightG)) fams = fams.filter((f) => weightOk(line.unitWeightG, f.weightG));
      if (fams.length === 1) { out[i] = { status: 'matched', family: fams[0], via: 'карта' }; return; }
      if (fams.length > 1) { out[i] = { status: 'ambiguous', options: fams.slice(0, MAX_CANDIDATES), via: 'карта' }; return; }
      console.log(`[prihod] запись словаря «${entry.family}» не нашла семью в каталоге для «${line.name}» — ищу заново по названию`);
    }
    // 2) размер бирки (18x162 → 18162…) идёт первым; один подходящий — берём сами
    const sz = sizeCandidates(line, families);
    if (sz.list.length === 1) { out[i] = { status: 'matched', family: sz.list[0], via: `размер ${sz.code}` }; return; }
    // 3) кандидаты + модель
    const cands = [...sz.list, ...candidatesFor(line, families).filter((f) => !sz.list.includes(f))].slice(0, Math.max(MAX_CANDIDATES, sz.list.length));
    if (!cands.length) { out[i] = { status: 'none', via: 'нет кандидатов' }; return; }
    pending.push({ i, name: line.name, unitWeightG: line.unitWeightG, cands });
  });

  if (pending.length) {
    let answers = [];
    try {
      answers = await askModel(pending);
    } catch (err) {
      console.error('[prihod] ошибка сопоставления моделью:', err.message);
    }
    for (const p of pending) {
      const a = answers.find((x) => x.i === p.i);
      const byId = (id) => p.cands.find((c) => c.id === id);
      if (a && a.choice === 'none') out[p.i] = { status: 'none', via: a.reason || 'модель: нет такого' };
      else if (a && byId(a.choice)) out[p.i] = { status: 'matched', family: byId(a.choice), via: 'модель' };
      else {
        const opts = ((a && a.options) || []).map(byId).filter(Boolean);
        out[p.i] = { status: 'ambiguous', options: opts.length >= 2 ? opts : p.cands, via: a ? a.reason || 'неоднозначно' : 'модель недоступна' };
      }
    }
  }
  return out;
}

// Размер «ШxД» в накладной (18x162, 20x162(70), 20х200) → код 18162: артикулы
// бирок начинаются с этих цифр. Самый сильный сигнал; дальше сужаем по числу
// штук в упаковке (1000 шт) и цвету. Один остаток — подставляем сами.
const SIZE_RE = /(\d{1,3})\s*[xхX×*]\s*(\d{1,3})(?:\s*\(\d+\))?/;

function sizeCode(name) {
  const m = SIZE_RE.exec(String(name || ''));
  if (!m) return null;
  const code = `${m[1]}${m[2]}`;
  return code.length >= 4 ? code : null;
}

function sizeCandidates(line, families) {
  const code = sizeCode(line.name);
  if (!code) return { code: null, list: [] };
  const startsWith = (f) => f.members.some((m) => String(m.article).replace(/\s/g, '').toLowerCase().startsWith(code));
  let list = families.filter(startsWith);
  if (list.length <= 1) return { code, list };
  const hay = (f) => dense(`${f.base} ${f.members.map((m) => m.article).join(' ')}`);
  const pack = /(\d{3,5})\s*шт/i.exec(line.name);
  if (pack) {
    const byPack = list.filter((f) => hay(f).includes(pack[1]));
    if (byPack.length) list = byPack;
  }
  const words = (norm(line.name).match(/[а-я]{3,}/g) || []).filter((w) => !['шт', 'бирка', 'бирки', 'садовая', 'садовые'].includes(w));
  const hits = (f) => words.filter((w) => hay(f).includes(w.slice(0, Math.max(3, w.length - 2)))).length;
  const best = Math.max(...list.map(hits));
  if (best > 0) list = list.filter((f) => hits(f) === best);
  return { code, list };
}

// Повторная проверка «Нет в Озоне» после обновления каталога: без модели,
// мягче порог; найденное по названию/артикулу НЕ подставляется само —
// возвращаются кандидаты для кнопок.
function suggestForNone(line, families) {
  return candidatesFor(line, families, { minScore: 0.2, max: 4 });
}

module.exports = { sizeCode, sizeCandidates, suggestForNone, matchLines, candidatesFor, modelName, weightOk };
