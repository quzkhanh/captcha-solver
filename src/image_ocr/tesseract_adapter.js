const { spawn } = require('node:child_process');
const { OcrError, OcrErrorCode } = require('./errors');

const LANGUAGE = /^[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*$/;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/**
 * OCR engine adapter for the Tesseract command line program.
 * The image is piped through stdin and the result read from stdout, so no temporary files are created.
 *
 * An adapter is any object with a `name` and a `recognize(png: Buffer)` method that resolves to
 * `{ text: string, words?: Array<{ text: string, confidence: number | null }> }` and rejects with an OcrError.
 *
 * @param {{binary?: string, language?: string, psm?: number, timeoutMs?: number}} [options]
 */
function createTesseractAdapter({ binary = 'tesseract', language = 'eng', psm = 3, timeoutMs = 30_000 } = {}) {
  if (typeof binary !== 'string' || !binary) throw new TypeError('binary must be a non-empty string');
  if (typeof language !== 'string' || !LANGUAGE.test(language)) throw new TypeError('language must look like "eng" or "eng+vie"');
  if (!Number.isInteger(psm) || psm < 0 || psm > 13) throw new TypeError('psm must be an integer from 0 to 13');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive integer');

  const args = ['stdin', 'stdout', '-l', language, '--psm', String(psm), 'tsv'];
  return Object.freeze({
    name: 'tesseract',
    language,
    psm,
    async recognize(png) {
      return parseTsv(await run(binary, args, png, timeoutMs));
    },
    async version() {
      const output = await run(binary, ['--version'], Buffer.alloc(0), timeoutMs);
      return output.match(/tesseract\s+v?(\S+)/i)?.[1] ?? null;
    },
  });
}

function run(binary, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const stdout = [];
    let stdoutBytes = 0;
    let stderr = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        child.kill('SIGKILL');
        finish(new OcrError(OcrErrorCode.ENGINE_ERROR, 'The OCR engine produced more output than allowed'));
      } else {
        stdout.push(chunk);
      }
    });
    // stderr is only inspected to classify failures; it is never returned because it can contain paths.
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString('utf8');
    });
    // The process can exit before reading all of stdin; the exit status reports the real problem.
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      finish(error.code === 'ENOENT' || error.code === 'EACCES'
        ? new OcrError(OcrErrorCode.ENGINE_UNAVAILABLE, 'The Tesseract OCR engine is not installed or not executable')
        : new OcrError(OcrErrorCode.ENGINE_ERROR, 'The OCR engine could not be started'));
    });
    child.on('close', (code) => {
      if (timedOut) return finish(new OcrError(OcrErrorCode.ENGINE_TIMEOUT, `The OCR engine did not finish within ${timeoutMs} ms`));
      if (code === 0) return finish(null, Buffer.concat(stdout).toString('utf8'));
      if (/Failed loading language|Error opening data file/i.test(stderr)) {
        return finish(new OcrError(OcrErrorCode.ENGINE_UNAVAILABLE, 'The requested OCR language data is not installed'));
      }
      return finish(new OcrError(OcrErrorCode.ENGINE_ERROR, `The OCR engine failed with exit code ${code}`));
    });

    child.stdin.end(input);
  });
}

// Tesseract TSV columns: level page_num block_num par_num line_num word_num left top width height conf text.
// Level 5 rows are words; conf is Tesseract's 0..100 word confidence (-1 when it has none).
function parseTsv(tsv) {
  const lines = new Map();
  const words = [];
  for (const row of tsv.split('\n').slice(1)) {
    const columns = row.split('\t');
    if (columns.length < 12 || columns[0] !== '5') continue;
    const text = columns.slice(11).join('\t').trim();
    if (!text) continue;
    const confidence = Number.parseFloat(columns[10]);
    words.push({ text, confidence: Number.isFinite(confidence) && confidence >= 0 ? confidence : null });
    const key = columns.slice(1, 5).join('.');
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(text);
  }
  return { text: [...lines.values()].map((line) => line.join(' ')).join('\n'), words };
}

module.exports = { createTesseractAdapter, parseTsv };
