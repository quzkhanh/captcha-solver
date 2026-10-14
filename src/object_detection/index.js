/**
 * General-purpose object detection for ordinary photos. Independent of image_ocr and captcha_solver.
 *
 * detectObjects() always resolves and never throws:
 *   { status: 'success', type: 'object_detection', detections: [{ className, boundingBox, confidence }], metadata }
 *   { status: 'failure', type: 'object_detection', code, stage, error, metadata: { processingTimeMs } }
 * boundingBox is { x, y, width, height } in pixels of the (EXIF-oriented) input image, origin top-left.
 * An image with nothing recognised is a success with an empty detections array.
 */
const { performance } = require('node:perf_hooks');
const { DetectionError, DetectionErrorCode, Stage } = require('./errors');
const { validateImage, DEFAULT_LIMITS, SUPPORTED_FORMATS } = require('./validator');
const { createYoloxAdapter } = require('./yolox_adapter');
const { MODELS, DEFAULT_MODEL } = require('./models');

const RESULT_TYPE = 'object_detection';

const DEFAULT_OPTIONS = Object.freeze({
  scoreThreshold: 0.3,
  iouThreshold: 0.45,
  maxDetections: 100,
});

let defaultDetector;

const invalidOptions = (message) => new DetectionError(DetectionErrorCode.INVALID_OPTIONS, message);
const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

function resolveLimits(limits = {}) {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) throw invalidOptions('limits must be an object');
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw invalidOptions(`Unknown limit: ${key}`);
    if (!Number.isSafeInteger(value) || value <= 0) throw invalidOptions(`Limit ${key} must be a positive integer`);
  }
  return { ...DEFAULT_LIMITS, ...limits };
}

function resolveOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw invalidOptions('options must be an object');
  const { scoreThreshold, iouThreshold, maxDetections } = { ...DEFAULT_OPTIONS, ...options };
  for (const [key, value] of Object.entries({ scoreThreshold, iouThreshold })) {
    if (typeof value !== 'number' || !(value > 0 && value <= 1)) throw invalidOptions(`${key} must be a number in (0, 1]`);
  }
  if (!Number.isSafeInteger(maxDetections) || maxDetections <= 0) throw invalidOptions('maxDetections must be a positive integer');
  return { scoreThreshold, iouThreshold, maxDetections, limits: resolveLimits(options.limits), detector: resolveDetector(options.detector) };
}

function resolveDetector(detector) {
  if (detector === undefined) return (defaultDetector ??= createYoloxAdapter());
  if (typeof detector?.detect !== 'function' || typeof detector.name !== 'string') {
    throw invalidOptions('detector must be an adapter with a name and a detect() method');
  }
  return detector;
}

function toDetection(raw, image) {
  const box = raw?.box;
  const valid = typeof raw?.className === 'string' && raw.className
    && typeof raw.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1
    && Array.isArray(box) && box.length === 4 && box.every(Number.isFinite)
    && box[0] >= 0 && box[1] >= 0 && box[2] <= image.width && box[3] <= image.height && box[2] > box[0] && box[3] > box[1];
  if (!valid) throw new DetectionError(DetectionErrorCode.INFERENCE_FAILED, 'The detector returned a malformed detection');
  return {
    className: raw.className,
    boundingBox: { x: round(box[0], 1), y: round(box[1], 1), width: round(box[2] - box[0], 1), height: round(box[3] - box[1], 1) },
    confidence: round(raw.confidence, 4),
  };
}

/**
 * @param {Buffer | Uint8Array | string} source - image bytes or a file path
 * @param {{detector?: object, scoreThreshold?: number, iouThreshold?: number, maxDetections?: number, limits?: object}} [options]
 */
async function detectObjects(source, options = {}) {
  const started = performance.now();
  const elapsed = (from = started) => round(performance.now() - from, 1);
  try {
    const { detector, limits, ...thresholds } = resolveOptions(options);
    const { format, image } = await validateImage(source, limits);

    const inferenceStarted = performance.now();
    let raw;
    try {
      raw = await detector.detect(image, thresholds);
    } catch (error) {
      throw error instanceof DetectionError && [Stage.MODEL, Stage.INFERENCE].includes(error.stage)
        ? error
        : new DetectionError(DetectionErrorCode.INFERENCE_FAILED, 'The detector failed');
    }
    const inferenceMs = elapsed(inferenceStarted);
    if (!Array.isArray(raw)) throw new DetectionError(DetectionErrorCode.INFERENCE_FAILED, 'The detector returned a malformed result');

    const detections = raw
      .map((item) => toDetection(item, image))
      .filter(({ confidence }) => confidence >= thresholds.scoreThreshold)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, thresholds.maxDetections);
    return {
      status: 'success',
      type: RESULT_TYPE,
      detections,
      metadata: {
        model: detector.name,
        image: { format, width: image.width, height: image.height },
        scoreThreshold: thresholds.scoreThreshold,
        iouThreshold: thresholds.iouThreshold,
        inferenceMs,
        processingTimeMs: elapsed(),
      },
    };
  } catch (error) {
    const known = error instanceof DetectionError && error.stage
      ? error
      : new DetectionError(DetectionErrorCode.INTERNAL_ERROR, 'Unexpected error while processing the image');
    return {
      status: 'failure',
      type: RESULT_TYPE,
      code: known.code,
      stage: known.stage,
      error: known.message,
      metadata: { processingTimeMs: elapsed() },
    };
  }
}

module.exports = {
  detectObjects,
  createYoloxAdapter,
  DetectionError,
  DetectionErrorCode,
  Stage,
  MODELS,
  DEFAULT_MODEL,
  DEFAULT_OPTIONS,
  DEFAULT_LIMITS,
  SUPPORTED_FORMATS,
};
