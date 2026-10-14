const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { anchorGrid, decodeYolox, nonMaxSuppression, iou } = require('./yolox_postprocess');

const NUM_CLASSES = 3;

function tensor(anchors, rows) {
  const data = new Float32Array(anchors.length * (5 + NUM_CLASSES));
  for (const [index, values] of Object.entries(rows)) data.set(values, Number(index) * (5 + NUM_CLASSES));
  return data;
}

describe('anchorGrid', () => {
  test('has one anchor per cell of every stride, row-major', () => {
    const anchors = anchorGrid(416, 416);
    assert.equal(anchors.length, 52 * 52 + 26 * 26 + 13 * 13);
    assert.deepEqual(anchors[0], { x: 0, y: 0, stride: 8 });
    assert.deepEqual(anchors[1], { x: 1, y: 0, stride: 8 });
    assert.deepEqual(anchors[52], { x: 0, y: 1, stride: 8 });
    assert.deepEqual(anchors[52 * 52], { x: 0, y: 0, stride: 16 });
    assert.deepEqual(anchors.at(-1), { x: 12, y: 12, stride: 32 });
  });

  test('supports non-square inputs', () => {
    const anchors = anchorGrid(640, 320);
    assert.equal(anchors.length, 80 * 40 + 40 * 20 + 20 * 10);
    assert.deepEqual(anchors[80], { x: 0, y: 1, stride: 8 });
  });
});

describe('decodeYolox', () => {
  const anchors = anchorGrid(64, 64);

  test('decodes offsets and log sizes relative to the anchor cell', () => {
    // Anchor 9 is x=1, y=1 at stride 8: centre (1.5 + 1) * 8 = 20, size e^0 * 8 = 8.
    const output = tensor(anchors, { 9: [1.5, 1.5, 0, 0, 0.9, 0.1, 0.8, 0.2] });
    const [candidate, ...rest] = decodeYolox(output, { anchors, numClasses: NUM_CLASSES, scoreThreshold: 0.1 });
    assert.equal(rest.length, 0);
    assert.equal(candidate.classId, 1);
    assert.ok(Math.abs(candidate.score - 0.72) < 1e-6);
    assert.deepEqual(candidate.box, [16, 16, 24, 24]);
  });

  test('uses the stride of the anchor level', () => {
    // First stride-16 anchor follows the 8x8 stride-8 grid; log size ln 2 doubles the stride.
    const output = tensor(anchors, { 64: [0.5, 0.5, Math.LN2, Math.LN2, 1, 1, 0, 0] });
    const [candidate] = decodeYolox(output, { anchors, numClasses: NUM_CLASSES, scoreThreshold: 0.5 });
    assert.equal(candidate.classId, 0);
    candidate.box.forEach((value, index) => assert.ok(Math.abs(value - [-8, -8, 24, 24][index]) < 1e-4));
  });

  test('drops candidates whose objectness times class score is below the threshold', () => {
    const output = tensor(anchors, { 0: [0, 0, 0, 0, 0.6, 0.5, 0, 0], 1: [0, 0, 0, 0, 0.2, 1, 0, 0], 2: [0, 0, 0, 0, 0.9, 0.9, 0, 0] });
    const candidates = decodeYolox(output, { anchors, numClasses: NUM_CLASSES, scoreThreshold: 0.35 });
    assert.equal(candidates.length, 1);
    assert.ok(Math.abs(candidates[0].score - 0.81) < 1e-6);
  });

  test('skips rows with non-finite values', () => {
    const output = tensor(anchors, { 0: [Number.NaN, 0, 0, 0, 0.9, 0.9, 0, 0], 1: [0, 0, 1000, 0, 0.9, 0.9, 0, 0] });
    assert.deepEqual(decodeYolox(output, { anchors, numClasses: NUM_CLASSES, scoreThreshold: 0.1 }), []);
  });

  test('rejects an output whose size does not match the grid', () => {
    assert.throws(() => decodeYolox(new Float32Array(10), { anchors, numClasses: NUM_CLASSES, scoreThreshold: 0.1 }), RangeError);
  });
});

describe('iou', () => {
  test('identical, disjoint, touching and partial overlap', () => {
    assert.equal(iou([0, 0, 10, 10], [0, 0, 10, 10]), 1);
    assert.equal(iou([0, 0, 10, 10], [20, 20, 30, 30]), 0);
    assert.equal(iou([0, 0, 10, 10], [10, 0, 20, 10]), 0);
    assert.equal(iou([0, 0, 10, 10], [5, 0, 15, 10]), 50 / 150);
  });

  test('degenerate boxes give 0', () => {
    assert.equal(iou([0, 0, 0, 0], [0, 0, 0, 0]), 0);
  });
});

describe('nonMaxSuppression', () => {
  const box = (classId, score, coords) => ({ classId, score, box: coords });

  test('keeps the highest score among overlapping boxes of the same class', () => {
    const kept = nonMaxSuppression([box(0, 0.6, [1, 1, 11, 11]), box(0, 0.9, [0, 0, 10, 10]), box(0, 0.5, [50, 50, 60, 60])], 0.45);
    assert.deepEqual(kept.map((k) => k.score), [0.9, 0.5]);
  });

  test('does not suppress across classes', () => {
    const kept = nonMaxSuppression([box(0, 0.9, [0, 0, 10, 10]), box(1, 0.8, [0, 0, 10, 10])], 0.45);
    assert.equal(kept.length, 2);
  });

  test('keeps boxes whose overlap equals the threshold exactly', () => {
    const kept = nonMaxSuppression([box(0, 0.9, [0, 0, 10, 10]), box(0, 0.8, [5, 0, 15, 10])], 50 / 150);
    assert.equal(kept.length, 2);
  });

  test('does not mutate its input', () => {
    const input = [box(0, 0.1, [0, 0, 1, 1]), box(0, 0.9, [5, 5, 6, 6])];
    nonMaxSuppression(input, 0.5);
    assert.equal(input[0].score, 0.1);
  });
});
