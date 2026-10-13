const { test, describe, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { recognizeImage, createTesseractAdapter, OcrError, OcrErrorCode, DEFAULT_PREPROCESSING } = require('./index');
const preprocessor = require('./preprocessor');
const { textImage, solidImage } = require('./fixtures');

const SUCCESS_KEYS = ['metadata', 'status', 'type', 'value'];
const SUCCESS_METADATA_KEYS = ['confidence', 'engine', 'image', 'preprocessing', 'processingTimeMs', 'textDetected', 'words'];
const FAILURE_KEYS = ['code', 'error', 'metadata', 'stage', 'status', 'type'];

function mockEngine(respond = () => ({ text: 'Hello world', words: [{ text: 'Hello', confidence: 90 }, { text: 'world', confidence: 80 }] })) {
  const calls = [];
  return {
    name: 'mock',
    calls,
    async recognize(png) {
      calls.push(png);
      return respond(png);
    },
  };
}

function assertFailure(result, code, stage) {
  assert.deepEqual(Object.keys(result).sort(), FAILURE_KEYS);
  assert.equal(result.status, 'failure');
  assert.equal(result.type, 'image_ocr');
  assert.equal(result.code, code);
  assert.equal(result.stage, stage);
  assert.equal(typeof result.error, 'string');
  assert.deepEqual(Object.keys(result.metadata), ['processingTimeMs']);
  assert.equal(result.value, undefined);
}

afterEach(() => mock.restoreAll());

describe('recognizeImage: success', () => {
  test('returns the stable success schema', async () => {
    const engine = mockEngine();
    const result = await recognizeImage(await textImage('Hello world'), { engine });
    assert.deepEqual(Object.keys(result).sort(), SUCCESS_KEYS);
    assert.deepEqual(Object.keys(result.metadata).sort(), SUCCESS_METADATA_KEYS);
    assert.equal(result.status, 'success');
    assert.equal(result.type, 'image_ocr');
    assert.equal(result.value, 'Hello world');
    assert.equal(result.metadata.engine, 'mock');
    assert.equal(result.metadata.textDetected, true);
    assert.equal(result.metadata.confidence, 85);
    assert.deepEqual(result.metadata.words, [{ text: 'Hello', confidence: 90 }, { text: 'world', confidence: 80 }]);
    assert.equal(result.metadata.image.format, 'png');
    assert.deepEqual(Object.keys(result.metadata.preprocessing).sort(), ['applied', 'noiseSigma', 'scale', 'skewAngle']);
    assert.ok(result.metadata.processingTimeMs >= 0);
  });

  test('the engine receives a PNG', async () => {
    const engine = mockEngine();
    await recognizeImage(await textImage('Hello', { format: 'jpeg' }), { engine });
    assert.equal(engine.calls.length, 1);
    assert.deepEqual([...engine.calls[0].subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });

  test('normalises the engine text', async () => {
    const engine = mockEngine(() => ({ text: '  Hello   world \n\n second\tline \f' }));
    const result = await recognizeImage(await textImage('x'), { engine });
    assert.equal(result.value, 'Hello world\nsecond line');
  });

  test('no recognised text is a success with an empty value, not an error', async () => {
    const result = await recognizeImage(await solidImage(), { engine: mockEngine(() => ({ text: '', words: [] })) });
    assert.equal(result.status, 'success');
    assert.equal(result.value, '');
    assert.equal(result.metadata.textDetected, false);
    assert.equal(result.metadata.confidence, null);
  });

  test('confidence is null when the engine reports none', async () => {
    const result = await recognizeImage(await textImage('x'), { engine: mockEngine(() => ({ text: 'x' })) });
    assert.equal(result.metadata.confidence, null);
    assert.deepEqual(result.metadata.words, []);
  });

  test('preprocessing: false sends the original pixels', async () => {
    const engine = mockEngine();
    const source = await textImage('Tiny', { size: 10 });
    const result = await recognizeImage(source, { engine, preprocessing: false });
    assert.deepEqual(result.metadata.preprocessing.applied, []);
    const [sent, original] = await Promise.all([sharp(engine.calls[0]).metadata(), sharp(source).metadata()]);
    assert.deepEqual([sent.width, sent.height], [original.width, original.height]);
  });

  test('preprocessing options change what is applied', async () => {
    const source = await textImage('Tiny', { size: 10 });
    const defaults = await recognizeImage(source, { engine: mockEngine() });
    const custom = await recognizeImage(source, { engine: mockEngine(), preprocessing: { upscale: false, threshold: 'otsu' } });
    assert.ok(defaults.metadata.preprocessing.applied.includes('upscale'));
    assert.deepEqual(custom.metadata.preprocessing.applied, ['grayscale', 'threshold']);
  });

  test('accepts a file path', async (t) => {
    const fs = require('node:fs/promises');
    const os = require('node:os');
    const path = require('node:path');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-ocr-index-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'sample.webp');
    await fs.writeFile(file, await textImage('Hello', { format: 'webp' }));
    const result = await recognizeImage(file, { engine: mockEngine() });
    assert.equal(result.status, 'success');
    assert.equal(result.metadata.image.format, 'webp');
  });
});

describe('recognizeImage: input errors never reach the engine', () => {
  const cases = [
    ['empty buffer', () => Buffer.alloc(0), OcrErrorCode.EMPTY_INPUT],
    ['not an image', () => Buffer.from('plain text'), OcrErrorCode.UNSUPPORTED_FORMAT],
    ['truncated png', async () => (await textImage('cut')).subarray(0, 60), OcrErrorCode.CORRUPTED_IMAGE],
    ['missing file', () => '/definitely/not/here.png', OcrErrorCode.FILE_NOT_FOUND],
    ['number', () => 42, OcrErrorCode.INVALID_INPUT],
    ['undefined', () => undefined, OcrErrorCode.INVALID_INPUT],
  ];
  for (const [name, make, code] of cases) {
    test(name, async () => {
      const engine = mockEngine();
      assertFailure(await recognizeImage(await make(), { engine }), code, 'input');
      assert.equal(engine.calls.length, 0);
    });
  }

  test('oversized image', async () => {
    const engine = mockEngine();
    const result = await recognizeImage(await solidImage({ width: 500, height: 500 }), { engine, limits: { maxPixels: 1000 } });
    assertFailure(result, OcrErrorCode.IMAGE_TOO_LARGE, 'input');
    assert.equal(engine.calls.length, 0);
  });
});

describe('recognizeImage: invalid options', () => {
  const cases = [
    ['options is not an object', null],
    ['unknown preprocessing key', { preprocessing: { sharpen: true } }],
    ['bad threshold', { preprocessing: { threshold: 300 } }],
    ['unknown limit', { limits: { maxFrames: 1 } }],
    ['negative limit', { limits: { maxBytes: -1 } }],
    ['engine without recognize()', { engine: { name: 'broken' } }],
  ];
  for (const [name, options] of cases) {
    test(name, async () => assertFailure(await recognizeImage(await solidImage(), options), OcrErrorCode.INVALID_OPTIONS, 'input'));
  }
});

describe('recognizeImage: preprocessing and engine errors', () => {
  test('a preprocessing crash is PREPROCESSING_FAILED and hides the cause', async () => {
    mock.method(preprocessor, 'preprocess', async () => {
      throw new Error('vips internal failure at /secret/path');
    });
    const engine = mockEngine();
    const result = await recognizeImage(await solidImage(), { engine });
    assertFailure(result, OcrErrorCode.PREPROCESSING_FAILED, 'preprocessing');
    assert.doesNotMatch(JSON.stringify(result), /secret|vips/);
    assert.equal(engine.calls.length, 0);
  });

  test('an engine exception is ENGINE_ERROR without message or stack', async () => {
    const engine = mockEngine(() => {
      throw new Error('segfault in /secret/libtesseract.so');
    });
    const result = await recognizeImage(await solidImage(), { engine });
    assertFailure(result, OcrErrorCode.ENGINE_ERROR, 'engine');
    assert.doesNotMatch(JSON.stringify(result), /secret|segfault|at /);
  });

  test('engine OcrErrors keep their code', async () => {
    for (const code of [OcrErrorCode.ENGINE_UNAVAILABLE, OcrErrorCode.ENGINE_TIMEOUT]) {
      const engine = mockEngine(() => {
        throw new OcrError(code, 'engine said no');
      });
      assertFailure(await recognizeImage(await solidImage(), { engine }), code, 'engine');
    }
  });

  test('an engine cannot disguise its failure as an input error', async () => {
    const engine = mockEngine(() => {
      throw new OcrError(OcrErrorCode.CORRUPTED_IMAGE, 'not my fault');
    });
    assertFailure(await recognizeImage(await solidImage(), { engine }), OcrErrorCode.ENGINE_ERROR, 'engine');
  });

  test('a missing Tesseract binary is ENGINE_UNAVAILABLE', async () => {
    const engine = createTesseractAdapter({ binary: '/nonexistent/bin/tesseract' });
    assertFailure(await recognizeImage(await solidImage(), { engine }), OcrErrorCode.ENGINE_UNAVAILABLE, 'engine');
  });
});

describe('recognizeImage: behaviour across calls', () => {
  test('repeated and concurrent calls give identical results', async () => {
    const engine = mockEngine();
    const source = await textImage('Same input', { rotate: 3 });
    const results = [
      await recognizeImage(source, { engine }),
      await recognizeImage(source, { engine }),
      ...await Promise.all([1, 2, 3].map(() => recognizeImage(source, { engine }))),
    ];
    const comparable = results.map(({ metadata: { processingTimeMs, ...rest }, ...result }) => ({ ...result, metadata: rest }));
    for (const result of comparable.slice(1)) assert.deepEqual(result, comparable[0]);
    assert.equal(engine.calls.length, 5);
    for (const png of engine.calls.slice(1)) assert.ok(png.equals(engine.calls[0]));
  });

  test('the caller cannot mutate the defaults', () => {
    assert.ok(Object.isFrozen(DEFAULT_PREPROCESSING));
  });

  test('nothing is logged, on success or failure', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((name) => mock.method(console, name, () => {}));
    await recognizeImage(await textImage('quiet'), { engine: mockEngine() });
    await recognizeImage(Buffer.from('bad'), { engine: mockEngine() });
    await recognizeImage(await solidImage(), { engine: mockEngine(() => { throw new Error('x'); }) });
    for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
  });
});
