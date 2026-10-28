// Штрихкод с фото программно: zbarimg (пакет zbar-tools в Dockerfile).
// Фото на диск не сохраняется: временная папка удаляется сразу после чтения.
// Если на оригинале не нашлось — пробуем варианты (контраст, увеличение,
// повороты) через Pillow; vision-модель — отдельный запасной шаг выше.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const run = (cmd, args, timeout = 20000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    // zbarimg: код 1 — «ничего не найдено», это не ошибка
    if (err && err.code === 'ENOENT') return resolve({ missing: true, out: '' });
    resolve({ out: String(stdout || '') });
  });
});

// Приведение к ключу сравнения: цифры без ведущих нулей, остальное — верхний регистр.
function normBarcode(raw) {
  const s = String(raw || '').replace(/\s+/g, '').toUpperCase();
  if (!s) return '';
  return /^\d+$/.test(s) ? s.replace(/^0+/, '') || '0' : s;
}

function parseZbar(out) {
  const codes = [];
  for (const line of String(out).split('\n')) {
    const v = line.trim();
    if (v && !codes.includes(v)) codes.push(v);
  }
  return codes;
}

// buffer → { codes: [строки], tried: n, available: bool }
async function decode(buffer, { ext = 'jpg' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foto-bc-'));
  try {
    const file = path.join(dir, `in.${ext}`);
    fs.writeFileSync(file, buffer);
    const first = await run('zbarimg', ['--quiet', '--raw', file]);
    if (first.missing) return { codes: [], tried: 0, available: false };
    let codes = parseZbar(first.out);
    let tried = 1;
    if (!codes.length) {
      const vdir = path.join(dir, 'v');
      fs.mkdirSync(vdir);
      const gen = await run('python3', [path.join(__dirname, 'barcode_variants.py'), file, vdir], 30000);
      if (gen.out.trim()) {
        for (const f of fs.readdirSync(vdir).sort()) {
          tried += 1;
          codes = parseZbar((await run('zbarimg', ['--quiet', '--raw', path.join(vdir, f)])).out);
          if (codes.length) break;
        }
      }
    }
    return { codes, tried, available: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { decode, normBarcode, parseZbar };
