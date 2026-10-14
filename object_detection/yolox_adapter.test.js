// Adapter behaviour that needs no model file: argument checks, input preparation and model/dependency failures.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createYoloxAdapter, letterbox, toBgrPlanar } = require('./yolox_adapter');
const { DetectionErrorCode } = require('./errors');

const raw = (width, height, rgb) => ({ data: Buffer.alloc(width * height * 3).map((_, index) => rgb[index % 3]), width, height, channels: 3 });
const detectOptions = { scoreThreshold: 0.3, iouThreshold: 0.45 };

describe('createYoloxAdapter: options', () => {
  test('rejects unknown models and malformed options', () => {
    assert.throws(() => createYoloxAdapter({ model: 'yolov99' }), TypeError);
    assert.throws(() => createYoloxAdapter({ modelPath: '' }), TypeError);
    assert.throws(() => createYoloxAdapter({ classNames: [] }), TypeError);
    assert.throws(() => createYoloxAdapter({ classNames: ['cat', ''] }), TypeError);
    assert.throws(() => createYoloxAdapter({ threads: 0 }), TypeError);
  });

  test('names the adapter after the registered model or as custom', () => {
    assert.equal(createYoloxAdapter().name, 'yolox-tiny');
    assert.equal(createYoloxAdapter({ model: 'yolox-nano' }).name, 'yolox-nano');
    assert.equal(createYoloxAdapter({ modelPath: '/models/mine.onnx' }).name, 'yolox-custom');
    assert.equal(createYoloxAdapter().classNames.length, 80);
  });
});

describe('createYoloxAdapter: model and dependency failures', () => {
  test('a missing model file is MODEL_NOT_FOUND, and a later call retries', async () => {
    const adapter = createYoloxAdapter({ modelPath: path.join(os.tmpdir(), 'no-such-model.onnx') });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(adapter.detect(raw(32, 32, [0, 0, 0]), detectOptions), { code: DetectionErrorCode.MODEL_NOT_FOUND, stage: 'model' });
    }
  });

  test('a file that is not an ONNX model is MODEL_INVALID', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'od-adapter-'));
    try {
      await fs.writeFile(path.join(dir, 'broken.onnx'), 'not a model');
      const adapter = createYoloxAdapter({ modelPath: path.join(dir, 'broken.onnx') });
      await assert.rejects(adapter.load(), { code: DetectionErrorCode.MODEL_INVALID, stage: 'model' });
      await adapter.release();
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  test('a missing onnxruntime-node is DEPENDENCY_MISSING through detectObjects', () => {
    // A child process hides the package from require(), so the real dependency check runs end to end.
    const script = `
      const Module = require('node:module');
      const resolve = Module._resolveFilename;
      Module._resolveFilename = function (request, ...rest) {
        if (request === 'onnxruntime-node') throw Object.assign(new Error('missing'), { code: 'MODULE_NOT_FOUND' });
        return resolve.call(this, request, ...rest);
      };
      const sharp = require('sharp');
      const { detectObjects } = require(${JSON.stringify(path.join(__dirname, 'index.js'))});
      sharp({ create: { width: 32, height: 32, channels: 3, background: '#fff' } }).png().toBuffer()
        .then((png) => detectObjects(png)).then((result) => process.stdout.write(JSON.stringify(result)));`;
    const result = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: __dirname }).toString());
    assert.equal(result.status, 'failure');
    assert.equal(result.code, DetectionErrorCode.DEPENDENCY_MISSING);
    assert.equal(result.stage, 'model');
  });
});

describe('letterbox', () => {
  test('keeps the aspect ratio, anchors top-left and pads with 114', async () => {
    const { data, scale } = await letterbox(raw(200, 100, [10, 20, 30]), 64, 64);
    assert.equal(scale, 64 / 200);
    assert.equal(data.length, 64 * 64 * 3);
    const pixel = (x, y) => [...data.subarray((y * 64 + x) * 3, (y * 64 + x) * 3 + 3)];
    assert.deepEqual(pixel(0, 0), [10, 20, 30]);
    assert.deepEqual(pixel(63, 31), [10, 20, 30]);
    assert.deepEqual(pixel(0, 32), [114, 114, 114]);
    assert.deepEqual(pixel(63, 63), [114, 114, 114]);
  });

  test('upscales small images and pads on the right for tall images', async () => {
    const { data, scale } = await letterbox(raw(16, 32, [200, 100, 0]), 64, 64);
    assert.equal(scale, 2);
    assert.deepEqual([...data.subarray((10 * 64 + 31) * 3, (10 * 64 + 31) * 3 + 3)], [200, 100, 0]);
    assert.deepEqual([...data.subarray((10 * 64 + 32) * 3, (10 * 64 + 32) * 3 + 3)], [114, 114, 114]);
  });
});

test('toBgrPlanar reorders interleaved RGB into B, G and R planes', () => {
  const tensor = toBgrPlanar(Buffer.from([1, 2, 3, 4, 5, 6]), 2, 1);
  assert.deepEqual([...tensor], [3, 6, 2, 5, 1, 4]);
});
