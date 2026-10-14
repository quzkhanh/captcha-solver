// Integration tests: solve('image') with the real OCR module and the real Tesseract engine, nothing mocked.
// Images are synthetic text rendered in memory, so the ground truth is the rendered string.
// Engine-dependent tests are skipped, with the reason printed, when Tesseract or its English data is missing.
const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { solve, Status, ErrorCode } = require('./captcha_solver');
const { createTesseractAdapter } = require('./image_ocr');
const { textImage, solidImage } = require('./image_ocr/fixtures');

const SUCCESS_KEYS = ['status', 'type', 'value'];
const FAILURE_KEYS = ['code', 'error', 'status', 'type'];
const originalEnv = { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH };

let skip = false;
let directory;

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'solve-image-'));
  try {
    await createTesseractAdapter().version();
  } catch (error) {
    skip = `Tesseract is not available (${error.code})`;
  }
});

after(() => fs.rm(directory, { recursive: true, force: true }));

beforeEach(() => {
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function assertFailure(result, code) {
  assert.deepEqual(Object.keys(result).sort(), FAILURE_KEYS);
  assert.equal(result.status, Status.FAILURE);
  assert.equal(result.type, 'image');
  assert.equal(result.code, code);
  assert.equal(typeof result.error, 'string');
}

async function fakeTesseract(body) {
  const bin = await fs.mkdtemp(path.join(directory, 'bin-'));
  await fs.writeFile(path.join(bin, 'tesseract'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return `${bin}${path.delimiter}${originalEnv.PATH}`;
}

describe('integration: solve("image") with real Tesseract', () => {
  const run = (name, body) => test(name, async (t) => {
    if (skip) return t.skip(skip);
    await body();
  });

  run('recognizes the ground-truth text of a synthetic image, with the solve() schema', async () => {
    for (const [text, options] of [
      ['Invoice 2026 total: 42.50 USD', {}],
      ['K7PX9Q', { size: 48, font: 'DejaVu Sans Mono' }],
      ['Dark theme screenshot', { foreground: '#f0f0f0', background: '#1e1e1e', format: 'jpeg' }],
    ]) {
      const result = await solve('image', { image: await textImage(text, options) });
      assert.deepEqual(Object.keys(result).sort(), SUCCESS_KEYS);
      assert.deepEqual(result, { status: Status.SUCCESS, type: 'image', value: text });
    }
  });

  run('accepts a file path', async () => {
    const file = path.join(directory, 'sample.png');
    await fs.writeFile(file, await textImage('Read from disk'));
    assert.deepEqual(await solve('image', { image: file }), { status: Status.SUCCESS, type: 'image', value: 'Read from disk' });
  });

  run('accepts a Uint8Array', async () => {
    const image = new Uint8Array(await textImage('Plain bytes'));
    assert.equal((await solve('image', { image })).value, 'Plain bytes');
  });

  run('an image without text is NO_TEXT_DETECTED', async () => {
    assertFailure(await solve('image', { image: await solidImage() }), ErrorCode.NO_TEXT_DETECTED);
  });

  run('missing language data is not a success', async () => {
    // An empty data directory means the default English traineddata cannot be loaded.
    process.env.TESSDATA_PREFIX = directory;
    try {
      assertFailure(await solve('image', { image: await textImage('Hello') }), 'ENGINE_UNAVAILABLE');
    } finally {
      delete process.env.TESSDATA_PREFIX;
    }
  });
});

describe('integration: solve("image") rejects bad images', () => {
  test('corrupted, empty and non-image inputs fail with the OCR error code', async () => {
    const png = await textImage('Truncated');
    const cases = [
      [png.subarray(0, Math.floor(png.length / 2)), 'CORRUPTED_IMAGE'],
      [Buffer.concat([png.subarray(0, 8), Buffer.alloc(64, 0xab)]), 'CORRUPTED_IMAGE'],
      [Buffer.alloc(0), 'EMPTY_INPUT'],
      [Buffer.from('this is plain text, not an image'), 'UNSUPPORTED_FORMAT'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'UNSUPPORTED_FORMAT'],
      [path.join(directory, 'missing.png'), 'FILE_NOT_FOUND'],
      [42, 'INVALID_INPUT'],
    ];
    for (const [image, code] of cases) {
      assertFailure(await solve('image', { image }), code);
    }
  });
});

describe('integration: solve("image") when the engine is broken', () => {
  test('Tesseract not installed is ENGINE_UNAVAILABLE', async () => {
    process.env.PATH = await fs.mkdtemp(path.join(directory, 'empty-'));
    assertFailure(await solve('image', { image: await textImage('Hello') }), 'ENGINE_UNAVAILABLE');
  });

  test('Tesseract crashing is ENGINE_ERROR', async () => {
    process.env.PATH = await fakeTesseract('cat > /dev/null; echo "segfault" >&2; exit 139');
    assertFailure(await solve('image', { image: await textImage('Hello') }), 'ENGINE_ERROR');
  });

  test('Tesseract printing text but exiting with an error is not a success', async () => {
    const tsv = '5\\t1\\t1\\t1\\t1\\t1\\t0\\t0\\t10\\t10\\t96\\tFAKE';
    process.env.PATH = await fakeTesseract(`cat > /dev/null; printf 'header\\n${tsv}\\n'; exit 1`);
    const result = await solve('image', { image: await textImage('Hello') });
    assertFailure(result, 'ENGINE_ERROR');
    assert.equal(result.value, undefined);
  });
});
