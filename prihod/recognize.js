// Распознавание фото накладной моделью с vision. Каждое фото — один вызов.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const { modelName } = require('./match');

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const SYSTEM = `Ты читаешь фото одного листа товарной накладной/УПД. Верни СТРОГО JSON-объект без markdown:
{
 "legible": true|false,            // можно ли уверенно прочитать строки
 "problem": "rotated|blurry|cropped|other|", // если legible=false — что не так
 "doc": {"number":"","date":""},
 "printed_total": число|null,      // печатное «Итого»/«Всего к оплате» (С НДС), только если оно есть на этом листе
 "printed_total_no_vat": число|null, // «Итого» без НДС, если в документе есть отдельная колонка/итог без налога
 "lines": [{
   "n": номер строки,
   "name": "название как напечатано",
   "supplier_code": "код товара из колонки «код» (графа 3) дословно, напр. РФ25204D108, КО19986R113, ББ12694K562; пусто, если колонки нет или код не читается",
   "places": число|null,            // графа 8 «мест» (количество мест/коробов), ПЕЧАТНОЕ число
   "per_place": число|null,         // графа 7 «в одном месте», ПЕЧАТНОЕ число
   "qty": число,                    // количество. Если две колонки количества — бери «Всего шт.»
   "price": число|null,
   "y": число,                      // вертикальное положение строки на фото, доля высоты 0..1 (0 — верх)
   "sum": число|null,               // сумма по строке С НДС (последняя колонка стоимости)
   "sum_no_vat": число|null,        // сумма по строке без НДС, если есть такая колонка
   "netto_kg": число|null,          // масса нетто по строке, если есть колонка
   "unit_weight_g": число|null,     // вес единицы: из названия (200 г, 1/180, 1/250, 1/1000 = граммы), иначе netto_kg*1000/qty
   "sterilization_pack": true|false, // пакеты для стерилизации Альянс Хим, где «1» = пачка 100 листов
   "handwritten": null | {          // РУКОПИСНАЯ пометка возле строки (ручкой/карандашом), не печатный текст. НЕ пометка (handwritten=null): кружок/овал/обводка вокруг ПЕЧАТНОГО числа (чаще всего вокруг «мест» — склад так отмечает проверенное), галочка, подчёркивание, дата срока годности вида 28.03 / 12.05.27 / 22.12.26 рядом с названием
     "kind": "not_arrived" | "qty_changed" | "unclear", // «нет», строка зачёркнута / вместо печатного количества написано другое число / непонятно
     "qty": число|null,             // для qty_changed — число из пометки (в тех же единицах, что и qty)
     "text": "как написано",
     "confident": true|false        // false, если пометку не удалось прочитать уверенно
   }
 }]
}
qty, places, per_place и sum — ПЕЧАТНЫЕ значения (обведённое кружком печатное число остаётся печатным); рукописное число никогда не подставляй в qty, а верни его в handwritten. Не выдумывай: нечитаемое число = null, а если нечитаемо много — legible=false. Числа — десятичные с точкой.`;

// temperature 0 — чтение должно быть повторяемым; если модель параметр не
// принимает, повторяем без него.
async function ask(system, content, maxTokens) {
  const base = { model: modelName(), max_tokens: maxTokens, system, messages: [{ role: 'user', content }] };
  let res;
  try {
    res = await anthropic.messages.create({ ...base, temperature: 0 });
  } catch (err) {
    if (!/temperature/i.test(String(err.message))) throw err;
    res = await anthropic.messages.create(base);
  }
  const text = res.content.find((b) => b.type === 'text')?.text || '';
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error('модель вернула не JSON');
  return JSON.parse(m[0]);
}

const imageBlock = (buffer, mediaType) => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } });

async function readInvoicePhoto(buffer, mediaType = 'image/jpeg', { careful = false } = {}) {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY не задан');
  const note = careful
    ? 'Перечитай лист ОЧЕНЬ внимательно, строка за строкой: название, количество, цена и сумма должны относиться к ОДНОЙ строке таблицы (не смешивай соседние строки).'
    : 'Распознай лист накладной.';
  const data = await ask(SYSTEM, [imageBlock(buffer, mediaType), { type: 'text', text: note }], 6000);
  if (!Array.isArray(data.lines)) data.lines = [];
  return data;
}

const REREAD_SYSTEM = `Тебе дан увеличенный фрагмент товарной накладной с одной строкой таблицы (рядом могут быть соседние). Прочитай ТОЛЬКО строку, название которой указано в запросе, и верни СТРОГО JSON без markdown:
{"name":"название как напечатано","qty":число|null,"price":число|null,"sum":число|null,"sum_no_vat":число|null}
qty — количество (если две колонки, «Всего шт.»), sum — сумма с НДС. Не угадывай: нечитаемое = null.`;

// Вырезает полосу вокруг строки и увеличивает (Pillow); без неё — весь лист.
function cropBand(buffer, y) {
  if (!Number.isFinite(y)) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prh-crop-'));
  try {
    const inp = path.join(dir, 'in.jpg');
    const out = path.join(dir, 'out.jpg');
    fs.writeFileSync(inp, buffer);
    execFileSync('python3', [path.join(__dirname, 'crop.py'), inp, out, String(y - 0.06), String(y + 0.06)], { timeout: 20000 });
    return fs.readFileSync(out);
  } catch (err) {
    console.error('[prihod] обрезка фото не удалась, читаю целиком:', err.message);
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function rereadLine(buffer, mediaType, line) {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY не задан');
  const crop = cropBand(buffer, line.y);
  const img = crop ? imageBlock(crop, 'image/jpeg') : imageBlock(buffer, mediaType);
  return ask(REREAD_SYSTEM, [img, { type: 'text', text: `Строка: «${line.name}»` }], 600);
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// Количество × цена должно совпасть с суммой строки: цена в накладной бывает
// без НДС, поэтому допускаем отношения 1 / 1,05 / 1,07 / 1,1 / 1,2 / 1,22 или
// сверку с колонкой «без НДС».
const VAT_RATIOS = [1, 1.05, 1.07, 1.1, 1.2, 1.22];
function arithmeticOk(qty, price, sum, sumNoVat) {
  if (qty === null || price === null || (sum === null && sumNoVat === null)) return false;
  const calc = qty * price;
  const near = (a, b) => Math.abs(a - b) <= Math.max(1, b * 0.01);
  if (sumNoVat !== null && near(calc, sumNoVat)) return true;
  if (sum === null) return false;
  return VAT_RATIOS.some((r) => near(calc * r, sum));
}

// Нормализация и проверки строки накладной (код, не модель).
function prepareLine(raw) {
  const printedQty = num(raw.qty);
  const mult = raw.sterilization_pack ? 100 : 1;
  const qty = printedQty === null ? null : printedQty * mult;
  const price = num(raw.price);
  const sum = num(raw.sum);
  const sumNoVat = num(raw.sum_no_vat);
  const nettoKg = num(raw.netto_kg);
  const flags = [];
  if (printedQty === null) flags.push('не прочитано количество');
  const arithmetic = arithmeticOk(printedQty, price, sum, sumNoVat);
  if (price !== null && printedQty !== null && !arithmetic) flags.push('кол-во×цена не сходится с суммой');
  let unitWeightG = num(raw.unit_weight_g);
  if (nettoKg !== null && qty && !raw.sterilization_pack) {
    const byNetto = (nettoKg * 1000) / qty;
    if (unitWeightG && Math.abs(byNetto - unitWeightG) / unitWeightG > 0.06) {
      flags.push(`вес по названию ${unitWeightG} г ≠ нетто÷кол-во ${Math.round(byNetto)} г`);
    }
    if (!unitWeightG) unitWeightG = Math.round(byNetto);
  }
  if (!unitWeightG && !raw.sterilization_pack) {
    const fr = /(?:^|[^\d])1\s*\/\s*(\d{2,4})(?!\d)/.exec(String(raw.name || ''));
    if (fr) unitWeightG = Number(fr[1]);
  }
  // Рукописная пометка: «нет»/зачёркнуто → не пришло; другое число → правка количества.
  let mark = null;
  const hw = raw.handwritten;
  const places = num(raw.places);
  const perPlace = num(raw.per_place);
  if (hw && typeof hw === 'object' && ['not_arrived', 'qty_changed', 'unclear'].includes(hw.kind)) {
    const markQty = num(hw.qty);
    // Склад обводит кружком печатное число мест (4 места × 10 = 40 шт): это не правка количества.
    const isRingedPrint = markQty !== null && (
      (places !== null && markQty === places) ||
      (printedQty !== null && perPlace && markQty * perPlace === printedQty) ||
      (printedQty !== null && markQty === printedQty));
    // Дата срока годности (28.03, 12.05.27) — не пометка о количестве.
    const isDate = /^\s*\d{1,2}\s*[.\/]\s*\d{1,2}(\s*[.\/]\s*\d{2,4})?\s*$/.test(String(hw.text || ''));
    if (hw.kind !== 'not_arrived' && (isRingedPrint || isDate)) {
      console.log(`[prihod] «${raw.name}»: пометка «${hw.text || markQty}» — ${isDate ? 'срок годности' : 'обводка печатного числа'}, не правка количества`);
    } else {
      const kind = hw.kind === 'qty_changed' && markQty === null ? 'unclear' : hw.kind;
      mark = { kind, qty: markQty, text: String(hw.text || '').trim(), pending: kind === 'unclear' || hw.confident === false };
    }
  }
  return {
    mark, n: raw.n, name: String(raw.name || '').trim(), supplierCode: String(raw.supplier_code || '').trim(), qty, printedQty, packMult: mult, sterilization: Boolean(raw.sterilization_pack),
    price, sum, sumNoVat, nettoKg, y: num(raw.y), arithmetic, unitWeightG: raw.sterilization_pack ? null : unitWeightG, flags,
  };
}

module.exports = { readInvoicePhoto, rereadLine, prepareLine, arithmeticOk };
