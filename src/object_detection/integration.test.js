// Runs the real YOLOX ONNX model; nothing here is stubbed. Tests skip, with the reason printed, when the model file
// (npm run od:model) or the licensed evaluation set (npm run od:dataset) is missing.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { detectObjects, createYoloxAdapter, DetectionErrorCode, MODELS } = require('./index');
const { modelPath } = require('./models');
const { boxIou, meanAveragePrecision } = require('./evaluator');
const { solidImage, noiseImage } = require('./fixtures');

const SPLIT_DIR = path.join(__dirname, '..', '..', 'dataset', 'object_detection', 'dev');
const modelMissing = !fs.existsSync(modelPath('yolox-tiny')) && 'yolox-tiny model not downloaded (run: npm run od:model)';
const datasetMissing = !fs.existsSync(path.join(SPLIT_DIR, 'labels.json')) && 'dev split not prepared (run: npm run od:dataset)';
const samples = datasetMissing ? [] : JSON.parse(fs.readFileSync(path.join(SPLIT_DIR, 'labels.json'), 'utf8')).samples;
const imagePath = (sample) => path.join(SPLIT_DIR, 'images', sample.file);

const detector = createYoloxAdapter();
after(() => detector.release());

const run = (name, body, ...needs) => test(name, async (t) => {
  const reason = [modelMissing, ...needs].find(Boolean);
  if (reason) return t.skip(reason);
  await body();
});

// The largest non-crowd person in the dev photos: a clear, well-sized object for exact geometric checks.
function personPhoto() {
  const candidates = samples.filter((s) => s.group === 'coco').flatMap((sample) => sample.groundTruth
    .filter((t) => t.className === 'person' && !t.iscrowd)
    .map((truth) => ({ sample, truth, area: truth.boundingBox.width * truth.boundingBox.height })));
  return candidates.sort((a, b) => b.area - a.area)[0];
}

function bestMatch(detections, className, target) {
  return detections.filter((d) => d.className === className).sort((a, b) => boxIou(b.boundingBox, target) - boxIou(a.boundingBox, target))[0];
}

describe('integration: real YOLOX-Tiny on self-made images', () => {
  run('finds nothing on blank, noise and gradient images', async () => {
    const inputs = [await solidImage(), await solidImage({ width: 300, height: 900, background: '#808080', format: 'jpeg' }), await noiseImage()];
    for (const input of inputs) {
      const result = await detectObjects(input, { detector });
      assert.equal(result.status, 'success');
      assert.deepEqual(result.detections, []);
      assert.equal(result.metadata.model, 'yolox-tiny');
    }
  });

  run('rejects broken inputs before running the model', async () => {
    const jpeg = await solidImage({ format: 'jpeg', width: 200, height: 200 });
    assert.equal((await detectObjects(jpeg.subarray(0, 100), { detector })).code, DetectionErrorCode.CORRUPTED_IMAGE);
    assert.equal((await detectObjects(await solidImage({ width: 8, height: 8 }), { detector })).code, DetectionErrorCode.IMAGE_TOO_SMALL);
  });

  run('a class list that does not match the model output is MODEL_INVALID', async () => {
    const wrong = createYoloxAdapter({ classNames: ['a', 'b', 'c'] });
    const result = await detectObjects(await solidImage(), { detector: wrong });
    assert.equal(result.code, DetectionErrorCode.MODEL_INVALID);
  });
});

describe('integration: real YOLOX-Tiny on licensed COCO photos', () => {
  let photo;
  before(() => {
    if (!datasetMissing) photo = personPhoto();
  });

  run('locates the largest person close to the COCO box', async () => {
    const result = await detectObjects(imagePath(photo.sample), { detector });
    assert.equal(result.status, 'success');
    const match = bestMatch(result.detections, 'person', photo.truth.boundingBox);
    assert.ok(match, 'no person detected');
    assert.ok(boxIou(match.boundingBox, photo.truth.boundingBox) >= 0.7, `IoU ${boxIou(match.boundingBox, photo.truth.boundingBox)}`);
    assert.ok(match.confidence >= 0.5);
  }, datasetMissing);

  run('boxes follow the object when the photo is padded and when it is mirrored', async () => {
    const bytes = fs.readFileSync(imagePath(photo.sample));
    const { width } = photo.sample;
    const [dx, dy] = [137, 61];
    const padded = await sharp(bytes).extend({ left: dx, top: dy, right: 40, bottom: 300, background: '#777777' }).png().toBuffer();
    const mirrored = await sharp(bytes).flop().png().toBuffer();
    const { x, y, width: w, height: h } = photo.truth.boundingBox;
    const shiftedTruth = { x: x + dx, y: y + dy, width: w, height: h };
    const mirroredTruth = { x: width - x - w, y, width: w, height: h };
    for (const [input, truth] of [[padded, shiftedTruth], [mirrored, mirroredTruth]]) {
      const result = await detectObjects(input, { detector });
      const match = bestMatch(result.detections, 'person', truth);
      assert.ok(match && boxIou(match.boundingBox, truth) >= 0.7, `IoU ${match && boxIou(match.boundingBox, truth)}`);
    }
  }, datasetMissing);

  run('gives the same detections for PNG, JPEG and WebP encodings of a photo', async () => {
    const bytes = fs.readFileSync(imagePath(photo.sample));
    const reference = (await detectObjects(bytes, { detector })).detections.filter((d) => d.confidence >= 0.5);
    for (const format of ['png', 'webp']) {
      const result = await detectObjects(await sharp(bytes).toFormat(format, { lossless: true }).toBuffer(), { detector });
      for (const expected of reference) {
        assert.ok(result.detections.some((d) => d.className === expected.className && boxIou(d.boundingBox, expected.boundingBox) >= 0.9), `${format}: ${expected.className}`);
      }
    }
  }, datasetMissing);

  run('concurrent calls on one adapter match sequential calls', async () => {
    const files = samples.filter((s) => s.group === 'coco').slice(0, 4).map(imagePath);
    const sequential = [];
    for (const file of files) sequential.push((await detectObjects(file, { detector })).detections);
    const concurrent = (await Promise.all(files.map((file) => detectObjects(file, { detector })))).map((r) => r.detections);
    assert.deepEqual(concurrent, sequential);
  }, datasetMissing);

  run('reaches a sane accuracy floor on the dev split (regression guard, not a published metric)', async () => {
    const coco = samples.filter((s) => s.group === 'coco');
    const scored = [];
    for (const sample of coco) {
      const result = await detectObjects(imagePath(sample), { detector, scoreThreshold: 0.01 });
      assert.equal(result.status, 'success', sample.file);
      scored.push({ groundTruth: sample.groundTruth, detections: result.detections });
    }
    const { map50 } = meanAveragePrecision(scored);
    assert.ok(map50 >= 0.45, `mAP@0.5 on dev was ${map50}`);
  }, datasetMissing);

  run('every invalid sample of the split fails with its expected code', async () => {
    for (const sample of samples.filter((s) => s.group === 'invalid')) {
      assert.equal((await detectObjects(imagePath(sample), { detector })).code, sample.expectedError, sample.file);
    }
  }, datasetMissing);
});

describe('integration: model lifecycle', () => {
  run('release() frees the session and the next call loads it again', async () => {
    const adapter = createYoloxAdapter();
    assert.deepEqual(await adapter.load(), { inputWidth: 416, inputHeight: 416 });
    await adapter.release();
    assert.equal((await detectObjects(await solidImage(), { detector: adapter })).status, 'success');
    await adapter.release();
  });

  for (const name of Object.keys(MODELS)) {
    const missing = !fs.existsSync(modelPath(name)) && `${name} not downloaded (run: npm run od:model -- --model all)`;
    run(`${name} loads and reports its input size`, async () => {
      const adapter = createYoloxAdapter({ model: name });
      assert.deepEqual(await adapter.load(), { inputWidth: 416, inputHeight: 416 });
      await adapter.release();
    }, missing);
  }
});
