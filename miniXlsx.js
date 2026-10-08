// Минимальный читатель первого листа .xlsx без внешних библиотек. Нужен потому,
// что отчёты Озона собраны нестандартно (ячейки без адресов, русские буквы
// записаны числовыми кодами &#x41D;) — xlsx/exceljs читают их с искажениями.
// Возвращает массив строк (массив значений ячеек: строка | число | '').

const zlib = require('zlib');

function unzipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('это не .xlsx (не найден конец архива)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lhNameLen = buf.readUInt16LE(localOff + 26);
    const lhExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lhNameLen + lhExtraLen;
    const raw = buf.slice(start, start + compSize);
    files[name] = () => (method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function decodeXml(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    out.push(decodeXml([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  }
  return out;
}

function readFirstSheet(buffer) {
  const files = unzipEntries(buffer);
  const sheetName = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheetName) throw new Error('в файле нет листов');
  const shared = readSharedStrings(files['xl/sharedStrings.xml'] ? files['xl/sharedStrings.xml']() : '');
  const xml = files[sheetName]();
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row = [];
    let pos = 0;
    for (const cm of (rm[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const body = cm[2] || '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs);
      const idx = ref ? colIndex(ref[1]) : pos;
      const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
      let val = '';
      if (type === 'inlineStr') {
        val = decodeXml([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
      } else if (v) {
        if (type === 's') val = shared[Number(v[1])] ?? '';
        else if (type === 'str' || type === 'e') val = decodeXml(v[1]);
        else if (type === 'b') val = v[1] === '1';
        else val = v[1] === '' ? '' : Number.isFinite(Number(v[1])) ? Number(v[1]) : decodeXml(v[1]);
      }
      row[idx] = val;
      pos = idx + 1;
    }
    for (let i = 0; i < row.length; i += 1) if (row[i] === undefined) row[i] = '';
    rows.push(row);
  }
  return rows;
}

module.exports = { readFirstSheet };
