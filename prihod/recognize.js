// Распознавание фото накладной моделью с vision. Каждое фото — один вызов.

const Anthropic = require('@anthropic-ai/sdk');
const { modelName } = require('./match');

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const SYSTEM = `Ты читаешь фото одного листа товарной накладной/УПД. Верни СТРОГО JSON-объект без markdown:
{
 "legible": true|false,            // можно ли уверенно прочитать строки
 "problem": "rotated|blurry|cropped|other|", // если legible=false — что не так
 "doc": {"number":"","date":""},
 "printed_total": число|null,      // печатное «Итого» (сумма с НДС по документу), только если оно есть на этом листе
 "lines": [{
   "n": номер строки,
   "name": "название как напечатано",
   "qty": число,                    // количество. Если две колонки количества — бери «Всего шт.»
   "price": число|null,
   "sum": число|null,               // сумма по строке
   "netto_kg": число|null,          // масса нетто по строке, если есть колонка
   "unit_weight_g": число|null,     // вес единицы: из названия (200 г, 1/180, 1/250, 1/1000 = граммы), иначе netto_kg*1000/qty
   "sterilization_pack": true|false // пакеты для стерилизации Альянс Хим, где «1» = пачка 100 листов
 }]
}
Не выдумывай: нечитаемое число = null, а если нечитаемо много — legible=false. Числа — десятичные с точкой.`;

async function readInvoicePhoto(buffer, mediaType = 'image/jpeg') {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY не задан');
  const res = await anthropic.messages.create({
    model: modelName(),
    max_tokens: 6000,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
        { type: 'text', text: 'Распознай лист накладной.' },
      ],
    }],
  });
  const text = res.content.find((b) => b.type === 'text')?.text || '';
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error('модель вернула не JSON');
  const data = JSON.parse(m[0]);
  if (!Array.isArray(data.lines)) data.lines = [];
  return data;
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// Нормализация и проверки строки накладной (код, не модель).
function prepareLine(raw) {
  const printedQty = num(raw.qty);
  const mult = raw.sterilization_pack ? 100 : 1;
  const qty = printedQty === null ? null : printedQty * mult;
  const price = num(raw.price);
  const sum = num(raw.sum);
  const nettoKg = num(raw.netto_kg);
  const flags = [];
  if (printedQty === null) flags.push('не прочитано количество');
  if (price !== null && sum !== null && printedQty !== null) {
    const calc = printedQty * price;
    if (Math.abs(calc - sum) > Math.max(1, sum * 0.02)) flags.push(`кол-во×цена=${calc.toFixed(2)} ≠ сумма ${sum}`);
  }
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
  return {
    n: raw.n, name: String(raw.name || '').trim(), qty, printedQty, packMult: mult,
    price, sum, nettoKg, unitWeightG: raw.sterilization_pack ? null : unitWeightG, flags,
  };
}

module.exports = { readInvoicePhoto, prepareLine };
