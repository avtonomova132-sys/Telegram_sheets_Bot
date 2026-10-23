// Заполнение шаблона Ozon «Шаблон для обновления остатков на всех складах»
// правкой XML внутри архива: переписывается ТОЛЬКО <sheetData> листа
// «Остатки товаров» (строки с 4-й) и общие строки; всё остальное
// (стили, шапка, валидации, прочие части архива) копируется байт в байт.
// Поэтому «битые» стили Ozon-файла не мешают и шаблон не портится.

const zlib = require('zlib');

const SHEET_NAME = 'Остатки товаров';
const FIRST_DATA_ROW = 4;
const STORE_CELL = 'Портреткина (22403679106000)';

// ---------- zip ----------
let CRC_TABLE;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('это не .xlsx (не найден конец архива)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('повреждён каталог архива');
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    entries.push({ name, method, time, date, crc, size, raw: buf.slice(start, start + compSize), data: null });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryText(e) {
  const b = e.data ? e.data : e.method === 0 ? e.raw : zlib.inflateRawSync(e.raw);
  return b.toString('utf8');
}

function setEntryText(e, text) {
  const data = Buffer.from(text, 'utf8');
  e.data = data;
  e.raw = zlib.deflateRawSync(data);
  e.method = 8;
  e.crc = crc32(data);
  e.size = data.length;
}

function writeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(e.method, 8);
    lh.writeUInt16LE(e.time, 10);
    lh.writeUInt16LE(e.date, 12);
    lh.writeUInt32LE(e.crc, 14);
    lh.writeUInt32LE(e.raw.length, 18);
    lh.writeUInt32LE(e.size, 22);
    lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, e.raw);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(e.method, 10);
    ch.writeUInt16LE(e.time, 12);
    ch.writeUInt16LE(e.date, 14);
    ch.writeUInt32LE(e.crc, 16);
    ch.writeUInt32LE(e.raw.length, 20);
    ch.writeUInt32LE(e.size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + e.raw.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ---------- xml ----------
function decodeXml(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function find(entries, name) {
  return entries.find((e) => e.name === name);
}

function locateSheet(entries) {
  const wb = find(entries, 'xl/workbook.xml');
  const rels = find(entries, 'xl/_rels/workbook.xml.rels');
  if (!wb || !rels) throw new Error('в файле нет workbook.xml');
  let rid = null;
  for (const m of entryText(wb).matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[1]);
    if (name && decodeXml(name[1]) === SHEET_NAME) rid = (/\br:id="([^"]*)"/.exec(m[1]) || [])[1];
  }
  if (!rid) throw new Error(`в шаблоне нет листа «${SHEET_NAME}»`);
  let target = null;
  for (const m of entryText(rels).matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    if (new RegExp(`\\bId="${rid}"`).test(m[1])) target = (/\bTarget="([^"]*)"/.exec(m[1]) || [])[1];
  }
  if (!target) throw new Error('не найден файл листа');
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const sheet = find(entries, sheetPath);
  if (!sheet) throw new Error(`нет части ${sheetPath}`);
  return sheet;
}

function splitSheetData(xml) {
  const m = /<sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/sheetData>)/.exec(xml);
  if (!m) throw new Error('на листе нет sheetData');
  return { start: m.index, end: m.index + m[0].length, inner: m[1] || '' };
}

// Строки листа: [{n, xml}]; номер берём из r="…" или считаем подряд.
function parseRows(inner) {
  const rows = [];
  let prev = 0;
  for (const m of inner.matchAll(/<row\b([^>]*?)(?:\/>|>[\s\S]*?<\/row>)/g)) {
    const r = /\br="(\d+)"/.exec(m[1]);
    const n = r ? Number(r[1]) : prev + 1;
    rows.push({ n, xml: m[0] });
    prev = n;
  }
  return rows;
}

function cellStyle(rowXml, col) {
  const m = new RegExp(`<c\\b[^>]*\\br="${col}\\d+"[^>]*>`).exec(rowXml);
  return m ? (/\bs="(\d+)"/.exec(m[0]) || [])[1] : undefined;
}

// ---------- fill ----------
// items: [{article, qty}] → Buffer нового xlsx.
function fillTemplate(templateBuf, items) {
  const entries = readZip(templateBuf);
  const sheet = locateSheet(entries);
  const xml = entryText(sheet);
  const { start, end, inner } = splitSheetData(xml);
  const rows = parseRows(inner);
  const keep = rows.filter((r) => r.n < FIRST_DATA_ROW);
  const sample = rows.find((r) => r.n === FIRST_DATA_ROW);
  const sA = sample ? cellStyle(sample.xml, 'A') : undefined;
  const sB = sample ? cellStyle(sample.xml, 'B') : undefined;
  const sD = sample ? cellStyle(sample.xml, 'D') : undefined;

  // Общие строки: дописываем в конец, существующие индексы не трогаем.
  const sstEntry = find(entries, 'xl/sharedStrings.xml');
  let sstXml = sstEntry ? entryText(sstEntry) : null;
  let sstCount = sstXml ? (sstXml.match(/<si\b/g) || []).length : 0;
  const newSi = [];
  const strIndex = new Map();
  const str = (s) => {
    if (!sstXml) return null;
    if (!strIndex.has(s)) {
      strIndex.set(s, sstCount + newSi.length);
      newSi.push(`<si><t xml:space="preserve">${escXml(s)}</t></si>`);
    }
    return strIndex.get(s);
  };
  const strCell = (ref, s, style) => {
    const idx = str(s);
    const st = style !== undefined ? ` s="${style}"` : '';
    return idx === null
      ? `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${escXml(s)}</t></is></c>`
      : `<c r="${ref}"${st} t="s"><v>${idx}</v></c>`;
  };

  const dataRows = items.map((it, i) => {
    const n = FIRST_DATA_ROW + i;
    const a = strCell(`A${n}`, STORE_CELL, sA);
    const b = strCell(`B${n}`, it.article, sB);
    const d = `<c r="D${n}"${sD !== undefined ? ` s="${sD}"` : ''}><v>${it.qty}</v></c>`;
    return `<row r="${n}">${a}${b}${d}</row>`;
  });

  const newInner = keep.map((r) => r.xml).join('') + dataRows.join('');
  let out = xml.slice(0, start) + `<sheetData>${newInner}</sheetData>` + xml.slice(end);
  const lastRow = Math.max(3, FIRST_DATA_ROW + items.length - 1, ...keep.map((r) => r.n));
  out = out.replace(/<dimension\b([^>]*?)ref="([A-Z]+\d+)(?::([A-Z]+)\d+)?"/, (m0, pre, a1, endCol) => `<dimension${pre}ref="${a1}:${endCol || 'D'}${lastRow}"`);
  setEntryText(sheet, out);

  if (sstEntry && newSi.length) {
    let s = sstXml.replace('</sst>', `${newSi.join('')}</sst>`);
    const total = sstCount + newSi.length;
    s = s.replace(/uniqueCount="\d+"/, `uniqueCount="${total}"`).replace(/(<sst\b[^>]*?)\bcount="\d+"/, `$1count="${total + items.length * 2}"`);
    setEntryText(sstEntry, s);
  }
  return writeZip(entries);
}

// ---------- чтение для проверки ----------
// Возвращает {rowsXml: Map<n, xml>, rows: Map<n, [значения A..D]>} листа «Остатки товаров».
function readSheet(buf) {
  const entries = readZip(buf);
  const sheet = locateSheet(entries);
  const sstEntry = find(entries, 'xl/sharedStrings.xml');
  const shared = [];
  if (sstEntry) {
    for (const m of entryText(sstEntry).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      shared.push(decodeXml([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
    }
  }
  const { inner } = splitSheetData(entryText(sheet));
  const rowsXml = new Map();
  const rows = new Map();
  for (const r of parseRows(inner)) {
    rowsXml.set(r.n, r.xml);
    const vals = [];
    let pos = 0;
    for (const cm of r.xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+)\d+"/.exec(cm[1]);
      let idx = pos;
      if (ref) { idx = 0; for (const ch of ref[1]) idx = idx * 26 + ch.charCodeAt(0) - 64; idx -= 1; }
      const type = (/\bt="([^"]+)"/.exec(cm[1]) || [])[1];
      const body = cm[2] || '';
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
      let val = '';
      if (type === 'inlineStr') val = decodeXml([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
      else if (v) val = type === 's' ? shared[Number(v[1])] ?? '' : type === 'str' ? decodeXml(v[1]) : Number.isFinite(Number(v[1])) ? Number(v[1]) : decodeXml(v[1]);
      vals[idx] = val;
      pos = idx + 1;
    }
    for (let i = 0; i < vals.length; i += 1) if (vals[i] === undefined) vals[i] = '';
    rows.set(r.n, vals);
  }
  return { rowsXml, rows };
}

// Проверка шаблона при загрузке: есть лист и хотя бы строки шапки.
function validateTemplate(buf) {
  const { rows } = readSheet(buf);
  if (![1, 2, 3].some((n) => rows.has(n))) throw new Error('на листе нет строк шапки (1–3)');
  return true;
}

// Открывает файл заново: шапка (строки 1–3) побайтно равна шаблону, данные = items.
function verifyFilled(templateBuf, outBuf, items) {
  const t = readSheet(templateBuf);
  const o = readSheet(outBuf);
  for (const n of [1, 2, 3]) {
    if ((t.rowsXml.get(n) || '') !== (o.rowsXml.get(n) || '')) throw new Error(`шапка (строка ${n}) изменилась`);
  }
  for (let i = 0; i < items.length; i += 1) {
    const row = o.rows.get(FIRST_DATA_ROW + i) || [];
    if (row[0] !== STORE_CELL || row[1] !== items[i].article || (row[2] ?? '') !== '' || row[3] !== items[i].qty) {
      throw new Error(`строка ${FIRST_DATA_ROW + i} записана неверно`);
    }
  }
  const extra = [...o.rows.keys()].filter((n) => n >= FIRST_DATA_ROW + items.length);
  if (extra.length) throw new Error('в файле остались лишние строки данных');
  return true;
}

module.exports = { fillTemplate, verifyFilled, validateTemplate, SHEET_NAME, STORE_CELL };
