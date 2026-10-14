// API contract of detectObjects(). The stub detector below returns fixed boxes so result shaping, option handling and
// error mapping can be checked exactly; it says nothing about model accuracy, which integration.test.js covers.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { detectObjects, DetectionError, DetectionErrorCode, DEFAULT_OPTIONS } = require('./index');
const { solidImage } = require('./fixtures');

const SUCCESS_KEYS = ['detections', 'metadata', 'status', 'type'];
const METADATA_KEYS = ['image', 'inferenceMs', 'iouThreshold', 'model', 'processingTimeMs', 'scoreThreshold'];
const FAILURE_KEYS = ['code', 'error', 'metadata', 'stage', 'status', 'type'];

function stubDetector(respond) {
  const calls = [];
  return {
    name: 'stub',
    calls,
    async detect(image, options) {
      calls.push({ image, options });
      return respond(image, options);
    },
  };
}

function assertFailure(result, code, stage) {
  assert.deepEqual(Object.keys(result).sort(), FAILURE_KEYS);
  assert.equal(result.status, 'failure');
  assert.equal(result.type, 'object_detection');
  assert.equal(result.code, code);
  assert.equal(result.stage, stage);
  assert.equal(typeof result.error, 'string');
  assert.deepEqual(Object.keys(result.metadata), ['processingTimeMs']);
  assert.equal(result.detections, undefined);
}

describe('detectObjects: success schema', () => {
  test('converts corner boxes to x/y/width/height, rounds and sorts by confidence', async () => {
    const detector = stubDetector(() => [
      { className: 'cat', confidence: 0.512345, box: [10.04, 20.06, 50.55, 80.01] },
      { className: 'dog', confidence: 0.9, box: [0, 0, 320, 240] },
    ]);
    const result = await detectObjects(await solidImage(), { detector });
    assert.deepEqual(Object.keys(result).sort(), SUCCESS_KEYS);
    assert.deepEqual(Object.keys(result.metadata).sort(), METADATA_KEYS);
    assert.equal(result.status, 'success');
    assert.equal(result.type, 'object_detection');
    assert.deepEqual(result.detections, [
      { className: 'dog', boundingBox: { x: 0, y: 0, width: 320, height: 240 }, confidence: 0.9 },
      { className: 'cat', boundingBox: { x: 10, y: 20.1, width: 40.5, height: 60 }, confidence: 0.5123 },
    ]);
    assert.equal(result.metadata.model, 'stub');
    assert.deepEqual(result.metadata.image, { format: 'png', width: 320, height: 240 });
    assert.equal(result.metadata.scoreThreshold, DEFAULT_OPTIONS.scoreThreshold);
  });

  test('passes decoded pixels and thresholds to the detector', async () => {
    const detector = stubDetector(() => []);
    await detectObjects(await solidImage({ width: 64, height: 48, format: 'jpeg' }), { detector, scoreThreshold: 0.6, iouThreshold: 0.5 });
    const [{ image, options }] = detector.calls;
    assert.deepEqual([image.width, image.height, image.channels, image.data.length], [64, 48, 3, 64 * 48 * 3]);
    assert.deepEqual(options, { scoreThreshold: 0.6, iouThreshold: 0.5, maxDetections: DEFAULT_OPTIONS.maxDetections });
  });

  test('nothing found is a success with an empty list', async () => {
    const result = await detectObjects(await solidImage(), { detector: stubDetector(() => []) });
    assert.equal(result.status, 'success');
    assert.deepEqual(result.detections, []);
  });

  test('drops detections under the score threshold and caps the count', async () => {
    const detector = stubDetector(() => Array.from({ length: 10 }, (_, index) => ({ className: 'cup', confidence: index / 10, box: [0, 0, 10, 10] })));
    const result = await detectObjects(await solidImage(), { detector, scoreThreshold: 0.35, maxDetections: 3 });
    assert.deepEqual(result.detections.map((d) => d.confidence), [0.9, 0.8, 0.7]);
  });
});

describe('detectObjects: options', () => {
  test('rejects invalid options before reading the image', async () => {
    const detector = stubDetector(() => []);
    const cases = [
      null, [], { scoreThreshold: 0 }, { scoreThreshold: 1.5 }, { scoreThreshold: '0.5' }, { iouThreshold: -1 },
      { maxDetections: 0 }, { maxDetections: 2.5 }, { limits: [] }, { limits: { maxWidth: 10 } }, { limits: { maxBytes: -1 } },
      { detector: {} }, { detector: { name: 'x' } },
    ];
    for (const options of cases) {
      const result = await detectObjects(Buffer.alloc(0), options && typeof options === 'object' && !Array.isArray(options) ? { detector, ...options } : options);
      assertFailure(result, DetectionErrorCode.INVALID_OPTIONS, 'input');
    }
    assert.equal(detector.calls.length, 0);
  });

  test('limits are applied to the input check', async () => {
    const result = await detectObjects(await solidImage({ width: 100, height: 100 }), { detector: stubDetector(() => []), limits: { maxDimension: 99 } });
    assertFailure(result, DetectionErrorCode.IMAGE_TOO_LARGE, 'input');
  });
});

describe('detectObjects: failures', () => {
  test('input errors never reach the detector', async () => {
    const detector = stubDetector(() => []);
    assertFailure(await detectObjects(Buffer.from('not an image'), { detector }), DetectionErrorCode.UNSUPPORTED_FORMAT, 'input');
    assertFailure(await detectObjects(await solidImage({ width: 10, height: 10 }), { detector }), DetectionErrorCode.IMAGE_TOO_SMALL, 'input');
    assertFailure(await detectObjects('/no/such/file.jpg', { detector }), DetectionErrorCode.FILE_NOT_FOUND, 'input');
    assert.equal(detector.calls.length, 0);
  });

  test('model and inference errors from the detector are passed through', async () => {
    for (const code of [DetectionErrorCode.MODEL_NOT_FOUND, DetectionErrorCode.DEPENDENCY_MISSING, DetectionErrorCode.INFERENCE_FAILED]) {
      const detector = stubDetector(() => {
        throw new DetectionError(code, 'detector said so');
      });
      const result = await detectObjects(await solidImage(), { detector });
      assertFailure(result, code, code === DetectionErrorCode.INFERENCE_FAILED ? 'inference' : 'model');
      assert.equal(result.error, 'detector said so');
    }
  });

  test('unknown detector errors are hidden behind INFERENCE_FAILED', async () => {
    const detector = stubDetector(() => {
      throw new Error('/secret/path segfault');
    });
    const result = await detectObjects(await solidImage(), { detector });
    assertFailure(result, DetectionErrorCode.INFERENCE_FAILED, 'inference');
    assert.doesNotMatch(result.error, /secret/);
  });

  test('a detector input-stage error is not trusted as an input error', async () => {
    const detector = stubDetector(() => {
      throw new DetectionError(DetectionErrorCode.CORRUPTED_IMAGE, 'nope');
    });
    assertFailure(await detectObjects(await solidImage(), { detector }), DetectionErrorCode.INFERENCE_FAILED, 'inference');
  });

  test('malformed detector output is INFERENCE_FAILED', async () => {
    const malformed = [
      null, {}, [{}], [{ className: '', confidence: 0.5, box: [0, 0, 1, 1] }], [{ className: 'cat', confidence: 2, box: [0, 0, 1, 1] }],
      [{ className: 'cat', confidence: 0.5, box: [0, 0, 1] }], [{ className: 'cat', confidence: 0.5, box: [5, 5, 1, 1] }],
      [{ className: 'cat', confidence: 0.5, box: [-1, 0, 1, 1] }], [{ className: 'cat', confidence: 0.5, box: [0, 0, 321, 1] }],
      [{ className: 'cat', confidence: 0.5, box: [0, 0, Number.NaN, 1] }],
    ];
    for (const output of malformed) {
      const result = await detectObjects(await solidImage(), { detector: stubDetector(() => output) });
      assertFailure(result, DetectionErrorCode.INFERENCE_FAILED, 'inference');
    }
  });
});
