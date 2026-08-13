const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, 'generate_verse_image.py');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';

// Запускает generate_verse_image.py в отдельном процессе (логика наложения
// текста/шрифтов там не трогается) и возвращает готовый PNG в виде Buffer.
function generateVerseImageBuffer(verseNumber) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(os.tmpdir(), `verse-${verseNumber}-${Date.now()}.png`);
    const proc = spawn(PYTHON_BIN, [SCRIPT_PATH, String(verseNumber), outPath]);

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', reject);

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`generate_verse_image.py завершился с кодом ${code}: ${stderr}`));
        return;
      }
      fs.readFile(outPath, (err, buffer) => {
        fs.unlink(outPath, () => {});
        if (err) {
          reject(err);
          return;
        }
        resolve(buffer);
      });
    });
  });
}

module.exports = { generateVerseImageBuffer };
