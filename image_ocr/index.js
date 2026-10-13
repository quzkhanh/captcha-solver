/**
 * General-purpose OCR for ordinary text images (documents, screenshots, synthetic test images).
 * It is deliberately separate from captcha_solver.js and is not wired into solve('image').
 *
 * recognizeImage() always resolves and never throws:
 *   { status: 'success', type: 'image_ocr', value, metadata }
 *   { status: 'failure', type: 'image_ocr', code, stage, error, metadata: { processingTimeMs } }
 * An image without readable text is a success with value '' and metadata.textDetected === false.
 */
const { performance } = require('node:perf_hooks');
const { OcrError, OcrErrorCode, Stage } = require('./errors');
const { validateImage, DEFAULT_LIMITS, SUPPORTED_FORMATS } = require('./validator');
const preprocessor = require('./preprocessor');
const { createTesseractAdapter } = require('./tesseract_adapter');
const { normalizeOcrText, summarizeWords } = require('./normalizer');

const RESULT_TYPE = 'image_ocr';

let defaultEngine;

function resolveLimits(limits = {}) {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new OcrError(OcrErrorCode.INVALID_OPTIONS, 'limits must be an object');
  }
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new OcrError(OcrErrorCode.INVALID_OPTIONS, `Unknown limit: ${key}`);
    if (!Number.isSafeInteger(value) || value <= 0) throw new OcrError(OcrErrorCode.INVALID_OPTIONS, `Limit ${key} must be a positive integer`);
  }
  return { ...DEFAULT_LIMITS, ...limits };
}

function resolveEngine(engine) {
  if (engine === undefined) return (defaultEngine ??= createTesseractAdapter());
  if (typeof engine?.recognize !== 'function' || typeof engine.name !== 'string') {
    throw new OcrError(OcrErrorCode.INVALID_OPTIONS, 'engine must be an adapter with a name and a recognize() method');
  }
  return engine;
}

/**
 * @param {Buffer | Uint8Array | string} source - image bytes or a file path
 * @param {{engine?: object, preprocessing?: boolean | object, limits?: object}} [options]
 */
async function recognizeImage(source, options = {}) {
  const started = performance.now();
  const elapsed = () => Math.round((performance.now() - started) * 10) / 10;
  try {
    if (options === null || typeof options !== 'object') throw new OcrError(OcrErrorCode.INVALID_OPTIONS, 'options must be an object');
    const limits = resolveLimits(options.limits);
    const preprocessing = preprocessor.resolvePreprocessing(options.preprocessing);
    const engine = resolveEngine(options.engine);

    const input = await validateImage(source, limits);

    let prepared;
    try {
      prepared = await preprocessor.preprocess(input.image, preprocessing);
    } catch {
      throw new OcrError(OcrErrorCode.PREPROCESSING_FAILED, 'Image preprocessing failed');
    }

    let recognized;
    try {
      recognized = await engine.recognize(prepared.png);
    } catch (error) {
      throw error instanceof OcrError && error.stage === Stage.ENGINE
        ? error
        : new OcrError(OcrErrorCode.ENGINE_ERROR, 'The OCR engine failed');
    }

    const value = normalizeOcrText(recognized?.text);
    const { words, confidence } = summarizeWords(recognized?.words);
    return {
      status: 'success',
      type: RESULT_TYPE,
      value,
      metadata: {
        engine: engine.name,
        textDetected: value.length > 0,
        confidence,
        words,
        image: { format: input.format, width: input.width, height: input.height },
        preprocessing: { applied: prepared.applied, skewAngle: prepared.skewAngle, scale: prepared.scale, noiseSigma: prepared.noiseSigma },
        processingTimeMs: elapsed(),
      },
    };
  } catch (error) {
    const known = error instanceof OcrError && error.stage
      ? error
      : new OcrError(OcrErrorCode.INTERNAL_ERROR, 'Unexpected error while processing the image');
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
  recognizeImage,
  createTesseractAdapter,
  OcrError,
  OcrErrorCode,
  Stage,
  DEFAULT_LIMITS,
  DEFAULT_PREPROCESSING: preprocessor.DEFAULT_PREPROCESSING,
  SUPPORTED_FORMATS,
};
