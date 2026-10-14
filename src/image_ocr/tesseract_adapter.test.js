const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTesseractAdapter, parseTsv } = require('./tesseract_adapter');
const { OcrErrorCode } = require('./errors');

const HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const word = (block, par, line, index, conf, text) => `5\t1\t${block}\t${par}\t${line}\t${index}\t0\t0\t10\t10\t${conf}\t${text}`;

describe('parseTsv', () => {
  test('rebuilds lines from word rows and keeps raw confidences', () => {
    const tsv = [
      HEADER,
      '1\t1\t0\t0\t0\t0\t0\t0\t100\t50\t-1\t',
      '4\t1\t1\t1\t1\t0\t0\t0\t100\t20\t-1\t',
      word(1, 1, 1, 1, '96.5', 'Hello'),
      word(1, 1, 1, 2, '91', 'world'),
      word(1, 1, 2, 1, '-1', 'next'),
      word(2, 1, 1, 1, '88.25', 'block'),
      word(2, 1, 1, 2, '50', ' '),
      '',
    ].join('\n');
    assert.deepEqual(parseTsv(tsv), {
      text: 'Hello world\nnext\nblock',
      words: [
        { text: 'Hello', confidence: 96.5 },
        { text: 'world', confidence: 91 },
        { text: 'next', confidence: null },
        { text: 'block', confidence: 88.25 },
      ],
    });
  });

  test('empty output means no text', () => {
    assert.deepEqual(parseTsv(''), { text: '', words: [] });
    assert.deepEqual(parseTsv(`${HEADER}\n1\t1\t0\t0\t0\t0\t0\t0\t10\t10\t-1\t\n`), { text: '', words: [] });
  });
});

describe('createTesseractAdapter: options', () => {
  for (const options of [{ language: 'eng; rm -rf /' }, { language: '' }, { language: '-l' }, { psm: 14 }, { psm: 1.5 },
    { timeoutMs: 0 }, { binary: '' }]) {
    test(`rejects ${JSON.stringify(options)}`, () => assert.throws(() => createTesseractAdapter(options), TypeError));
  }

  test('accepts combined languages', () => {
    assert.equal(createTesseractAdapter({ language: 'eng+vie' }).language, 'eng+vie');
  });
});

describe('createTesseractAdapter: process handling', () => {
  let directory;
  const script = async (name, body, mode = 0o755) => {
    const file = path.join(directory, name);
    await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode });
    return file;
  };
  const assertCode = (promise, code) => assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.stage, 'engine');
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });

  before(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-ocr-adapter-'));
  });
  after(() => fs.rm(directory, { recursive: true, force: true }));

  test('missing binary is ENGINE_UNAVAILABLE', () =>
    assertCode(createTesseractAdapter({ binary: path.join(os.tmpdir(), 'no-such-tesseract-binary') }).recognize(Buffer.from('x')), OcrErrorCode.ENGINE_UNAVAILABLE));

  test('non-executable binary is ENGINE_UNAVAILABLE', async () => {
    const binary = await script('not-executable', 'exit 0', 0o644);
    await assertCode(createTesseractAdapter({ binary }).recognize(Buffer.from('x')), OcrErrorCode.ENGINE_UNAVAILABLE);
  });

  test('missing language data is ENGINE_UNAVAILABLE', async () => {
    const binary = await script('no-language', 'cat > /dev/null; echo "Failed loading language \'xyz\' from /secret/tessdata" >&2; exit 1');
    await assertCode(createTesseractAdapter({ binary }).recognize(Buffer.from('x')), OcrErrorCode.ENGINE_UNAVAILABLE);
  });

  test('a crash is ENGINE_ERROR and stderr is not exposed', async () => {
    const binary = await script('crash', 'cat > /dev/null; echo "secret internal path /home/user" >&2; exit 3');
    await assertCode(createTesseractAdapter({ binary }).recognize(Buffer.from('x')), OcrErrorCode.ENGINE_ERROR);
  });

  test('exiting before reading stdin is still reported as ENGINE_ERROR', async () => {
    const binary = await script('early-exit', 'exit 2');
    await assertCode(createTesseractAdapter({ binary }).recognize(Buffer.alloc(4 * 1024 * 1024)), OcrErrorCode.ENGINE_ERROR);
  });

  test('a hung process is killed after timeoutMs', async () => {
    const binary = await script('hang', 'exec sleep 10');
    const started = Date.now();
    await assertCode(createTesseractAdapter({ binary, timeoutMs: 200 }).recognize(Buffer.from('x')), OcrErrorCode.ENGINE_TIMEOUT);
    assert.ok(Date.now() - started < 5000);
  });

  test('passes the image on stdin and reads TSV from stdout, without file paths', async () => {
    const binary = await script('echo-args', [
      'bytes=$(wc -c)',
      `printf '${HEADER}\\n'`,
      `printf '5\\t1\\t1\\t1\\t1\\t1\\t0\\t0\\t1\\t1\\t77\\t%s\\n' "$1-$2-$3-$4-$5-$6-$7"`,
      `printf '5\\t1\\t1\\t1\\t1\\t2\\t0\\t0\\t1\\t1\\t88\\t%s\\n' "$bytes"`,
    ].join('\n'));
    const result = await createTesseractAdapter({ binary, language: 'eng', psm: 6 }).recognize(Buffer.from('12345'));
    assert.equal(result.text, 'stdin-stdout--l-eng---psm-6-tsv 5');
    assert.deepEqual(result.words.map((w) => w.confidence), [77, 88]);
  });

  test('version() parses the engine version', async () => {
    const binary = await script('version', 'echo "tesseract 5.5.0"; echo " leptonica-1.86.0"');
    assert.equal(await createTesseractAdapter({ binary }).version(), '5.5.0');
  });
});
