// Runs the real Tesseract engine. Skipped, with the reason printed, when Tesseract or its English data is missing.
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { recognizeImage, createTesseractAdapter, OcrErrorCode } = require('./index');
const { textImage, solidImage, noisy } = require('./fixtures');

const engine = createTesseractAdapter();
let skip = false;

before(async () => {
  try {
    await engine.version();
    const probe = await recognizeImage(await solidImage(), { engine });
    if (probe.status !== 'success') skip = `Tesseract is installed but failed: ${probe.code}`;
  } catch (error) {
    skip = `Tesseract is not available (${error.code})`;
  }
});

describe('integration: real Tesseract', () => {
  const run = (name, body) => test(name, async (t) => {
    if (skip) return t.skip(skip);
    await body();
  });

  run('reads clean printed text in every supported format', async () => {
    for (const format of ['png', 'jpeg', 'webp', 'tiff', 'gif']) {
      const result = await recognizeImage(await textImage('Invoice 2026 total: 42.50 USD', { format }), { engine });
      assert.equal(result.status, 'success', format);
      assert.equal(result.value, 'Invoice 2026 total: 42.50 USD', format);
      assert.equal(result.metadata.engine, 'tesseract');
      assert.ok(result.metadata.confidence > 0 && result.metadata.confidence <= 100, format);
      assert.equal(result.metadata.words.length, 5);
    }
  });

  run('reads multiple lines', async () => {
    const result = await recognizeImage(await textImage('First line here\nSecond line here', { size: 32 }), { engine });
    assert.equal(result.value, 'First line here\nSecond line here');
  });

  run('reads light text on a dark background', async () => {
    const result = await recognizeImage(await textImage('Dark theme screenshot', { foreground: '#f0f0f0', background: '#1e1e1e' }), { engine });
    assert.equal(result.value, 'Dark theme screenshot');
  });

  run('default preprocessing straightens rotated text', async () => {
    const source = await textImage('Slightly rotated scan of a printed page', { size: 26, rotate: 7 });
    const result = await recognizeImage(source, { engine });
    assert.ok(result.metadata.preprocessing.applied.includes('deskew'));
    assert.equal(result.value, 'Slightly rotated scan of a printed page');
  });

  run('default preprocessing cleans heavy noise', async () => {
    const result = await recognizeImage(await noisy(await textImage('Noisy photocopy text', { size: 32 }), 45), { engine });
    assert.ok(result.metadata.preprocessing.applied.includes('denoise'));
    assert.equal(result.value, 'Noisy photocopy text');
  });

  run('an image without text is a success with no text detected', async () => {
    for (const background of ['#ffffff', '#202020']) {
      const result = await recognizeImage(await solidImage({ background }), { engine });
      assert.equal(result.status, 'success');
      assert.equal(result.value, '');
      assert.equal(result.metadata.textDetected, false);
      assert.equal(result.metadata.confidence, null);
    }
  });

  run('repeated and concurrent calls return the same text', async () => {
    const source = await textImage('Repeatable result', { size: 30 });
    const results = [await recognizeImage(source, { engine }), ...await Promise.all([1, 2, 3].map(() => recognizeImage(source, { engine })))];
    for (const result of results) {
      assert.equal(result.value, 'Repeatable result');
      assert.equal(result.metadata.confidence, results[0].metadata.confidence);
    }
  });

  run('missing language data is ENGINE_UNAVAILABLE', async () => {
    const result = await recognizeImage(await textImage('Hello'), { engine: createTesseractAdapter({ language: 'zzz' }) });
    assert.equal(result.status, 'failure');
    assert.equal(result.code, OcrErrorCode.ENGINE_UNAVAILABLE);
  });
});
