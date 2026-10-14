const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { boxIou, matchImage, averagePrecision, meanAveragePrecision, precisionRecall, percentile, COCO_IOU_THRESHOLDS } = require('./evaluator');

const box = (x, y, width, height) => ({ x, y, width, height });
const truth = (className, boundingBox, iscrowd = false) => ({ className, boundingBox, iscrowd });
const detection = (className, boundingBox, confidence) => ({ className, boundingBox, confidence });

describe('boxIou', () => {
  test('uses x/y/width/height boxes', () => {
    assert.equal(boxIou(box(0, 0, 10, 10), box(0, 0, 10, 10)), 1);
    assert.equal(boxIou(box(0, 0, 10, 10), box(5, 0, 10, 10)), 50 / 150);
    assert.equal(boxIou(box(0, 0, 10, 10), box(10, 10, 5, 5)), 0);
  });
});

describe('matchImage', () => {
  test('each ground truth is matched once, highest confidence first', () => {
    const matches = matchImage(
      [detection('cat', box(0, 0, 10, 10), 0.5), detection('cat', box(0, 0, 10, 10), 0.9)],
      [truth('cat', box(0, 0, 10, 10))],
      0.5,
    );
    assert.deepEqual(matches, [{ confidence: 0.9, label: 'tp' }, { confidence: 0.5, label: 'fp' }]);
  });

  test('a detection on a crowd region is ignored, not a false positive', () => {
    const matches = matchImage([detection('person', box(0, 0, 10, 10), 0.9)], [truth('person', box(0, 0, 10, 10), true)], 0.5);
    assert.deepEqual(matches, [{ confidence: 0.9, label: 'ignore' }]);
  });

  test('prefers the ground truth with the highest IoU', () => {
    const matches = matchImage(
      [detection('dog', box(0, 0, 10, 10), 0.9), detection('dog', box(4, 0, 10, 10), 0.8)],
      [truth('dog', box(4, 0, 10, 10)), truth('dog', box(0, 0, 10, 10))],
      0.5,
    );
    assert.deepEqual(matches.map((m) => m.label), ['tp', 'tp']);
  });
});

describe('averagePrecision', () => {
  test('perfect ranking gives 1, no positives gives null, no detections gives 0', () => {
    assert.equal(averagePrecision([{ confidence: 0.9, label: 'tp' }], 1), 1);
    assert.equal(averagePrecision([{ confidence: 0.9, label: 'fp' }], 0), null);
    assert.equal(averagePrecision([], 3), 0);
  });

  test('a false positive ranked first lowers precision at every recall level', () => {
    const ap = averagePrecision([{ confidence: 0.9, label: 'fp' }, { confidence: 0.8, label: 'tp' }], 1);
    assert.equal(ap, 0.5);
  });

  test('half recall caps AP near 0.5 (51 of 101 recall points reached)', () => {
    const ap = averagePrecision([{ confidence: 0.9, label: 'tp' }], 2);
    assert.equal(ap, 51 / 101);
  });

  test('ignored detections do not count', () => {
    assert.equal(averagePrecision([{ confidence: 0.95, label: 'ignore' }, { confidence: 0.9, label: 'tp' }], 1), 1);
  });
});

describe('meanAveragePrecision', () => {
  test('averages over classes present in the ground truth', () => {
    const samples = [
      { groundTruth: [truth('cat', box(0, 0, 10, 10)), truth('dog', box(50, 50, 10, 10))], detections: [detection('cat', box(0, 0, 10, 10), 0.9)] },
      { groundTruth: [], detections: [detection('bird', box(0, 0, 10, 10), 0.9)] },
    ];
    const result = meanAveragePrecision(samples);
    assert.equal(result.classes, 2);
    assert.equal(result.perClass.cat.ap50, 1);
    assert.equal(result.perClass.dog.ap50, 0);
    assert.equal(result.map50, 0.5);
    assert.equal(result.perClass.bird, undefined);
  });

  test('mAP@.5:.95 drops for a loosely placed box', () => {
    // IoU 0.6 counts at thresholds 0.50..0.60 only: 3 of 10.
    const samples = [{ groundTruth: [truth('cat', box(0, 0, 10, 10))], detections: [detection('cat', box(0, 0, 10, 6), 0.9)] }];
    const result = meanAveragePrecision(samples);
    assert.equal(result.map50, 1);
    assert.ok(Math.abs(result.map - 0.3) < 1e-9);
    assert.equal(COCO_IOU_THRESHOLDS.length, 10);
  });
});

describe('precisionRecall', () => {
  test('counts TP, FP and FN at a score threshold', () => {
    const samples = [{
      groundTruth: [truth('cat', box(0, 0, 10, 10)), truth('dog', box(50, 50, 10, 10))],
      detections: [detection('cat', box(0, 0, 10, 10), 0.9), detection('cat', box(80, 80, 10, 10), 0.6), detection('dog', box(50, 50, 10, 10), 0.2)],
    }];
    assert.deepEqual(precisionRecall(samples, { scoreThreshold: 0.5 }), { tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5, f1: 0.5 });
    assert.equal(precisionRecall(samples, { scoreThreshold: 0.1 }).tp, 2);
  });

  test('null precision when nothing is detected', () => {
    const result = precisionRecall([{ groundTruth: [truth('cat', box(0, 0, 1, 1))], detections: [] }], { scoreThreshold: 0.5 });
    assert.equal(result.precision, null);
    assert.equal(result.recall, 0);
    assert.equal(result.f1, null);
  });
});

test('percentile uses the nearest-rank method', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 0.95), 5);
  assert.equal(percentile([7], 0), 7);
  assert.equal(percentile([], 0.5), null);
});
