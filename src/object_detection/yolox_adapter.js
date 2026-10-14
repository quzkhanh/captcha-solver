const fs = require('node:fs/promises');
const sharp = require('sharp');
const { DetectionError, DetectionErrorCode } = require('./errors');
const COCO_CLASSES = require('./coco_classes');
const { MODELS, DEFAULT_MODEL, modelPath: registeredModelPath } = require('./models');
const { anchorGrid, decodeYolox, nonMaxSuppression } = require('./yolox_postprocess');

// YOLOX was trained with OpenCV-style letterboxing: aspect-preserving resize anchored top-left, padded with 114.
const PAD_VALUE = 114;

function loadRuntime() {
  try {
    return require('onnxruntime-node');
  } catch {
    throw new DetectionError(DetectionErrorCode.DEPENDENCY_MISSING, 'onnxruntime-node is not installed. Run: npm install');
  }
}

async function letterbox(image, inputWidth, inputHeight) {
  const scale = Math.min(inputWidth / image.width, inputHeight / image.height);
  const width = Math.max(1, Math.floor(image.width * scale));
  const height = Math.max(1, Math.floor(image.height * scale));
  const data = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: image.channels } })
    .resize(width, height, { fit: 'fill', kernel: 'linear' })
    .extend({ right: inputWidth - width, bottom: inputHeight - height, background: { r: PAD_VALUE, g: PAD_VALUE, b: PAD_VALUE } })
    .raw()
    .toBuffer();
  return { data, scale };
}

/** Interleaved RGB bytes to planar BGR float32 in 0..255, the input layout of the official YOLOX exports. */
function toBgrPlanar(rgb, width, height) {
  const plane = width * height;
  const tensor = new Float32Array(plane * 3);
  for (let pixel = 0; pixel < plane; pixel++) {
    tensor[pixel] = rgb[pixel * 3 + 2];
    tensor[plane + pixel] = rgb[pixel * 3 + 1];
    tensor[plane * 2 + pixel] = rgb[pixel * 3];
  }
  return tensor;
}

function readGeometry(session, numClasses) {
  const input = session.inputMetadata?.[0];
  const output = session.outputMetadata?.[0];
  const [batch, channels, inputHeight, inputWidth] = input?.shape ?? [];
  const valid = input?.type === 'float32' && output?.type === 'float32'
    && batch === 1 && channels === 3 && Number.isInteger(inputHeight) && Number.isInteger(inputWidth)
    && output.shape?.length === 3 && output.shape[2] === 5 + numClasses;
  if (!valid) throw new DetectionError(DetectionErrorCode.MODEL_INVALID, 'The model does not have the YOLOX input/output layout');
  const anchors = anchorGrid(inputWidth, inputHeight);
  if (output.shape[1] !== anchors.length) throw new DetectionError(DetectionErrorCode.MODEL_INVALID, 'The model output does not match the YOLOX anchor grid');
  return { inputWidth, inputHeight, anchors };
}

/**
 * Object detector adapter for YOLOX ONNX models, run on the CPU with onnxruntime-node.
 *
 * An adapter is any object with a `name` and a `detect(image, {scoreThreshold, iouThreshold})` method, where `image`
 * is decoded sRGB `{data, width, height, channels: 3}`. It resolves to
 * `Array<{className: string, confidence: number, box: [x1, y1, x2, y2]}>` in image pixels and rejects with a DetectionError.
 * The model is loaded on the first detect() call and kept until release().
 *
 * @param {{model?: string, modelPath?: string, classNames?: string[], threads?: number}} [options]
 */
function createYoloxAdapter({ model = DEFAULT_MODEL, modelPath, classNames = COCO_CLASSES, threads } = {}) {
  if (modelPath === undefined && !Object.hasOwn(MODELS, model)) {
    throw new TypeError(`model must be one of: ${Object.keys(MODELS).join(', ')}`);
  }
  if (modelPath !== undefined && (typeof modelPath !== 'string' || !modelPath)) throw new TypeError('modelPath must be a non-empty string');
  if (!Array.isArray(classNames) || classNames.length === 0 || !classNames.every((name) => typeof name === 'string' && name)) {
    throw new TypeError('classNames must be a non-empty array of strings');
  }
  if (threads !== undefined && (!Number.isInteger(threads) || threads <= 0)) throw new TypeError('threads must be a positive integer');

  const file = modelPath ?? registeredModelPath(model);
  const name = modelPath === undefined ? model : 'yolox-custom';
  let loading;

  async function load() {
    const ort = loadRuntime();
    try {
      if (!(await fs.stat(file)).isFile()) throw new Error('not a file');
    } catch {
      throw new DetectionError(DetectionErrorCode.MODEL_NOT_FOUND, `Model file for "${name}" not found. Run: npm run od:model`);
    }
    let session;
    try {
      session = await ort.InferenceSession.create(file, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        ...(threads && { intraOpNumThreads: threads }),
      });
    } catch {
      throw new DetectionError(DetectionErrorCode.MODEL_INVALID, `Model file for "${name}" could not be loaded`);
    }
    try {
      return { ort, session, ...readGeometry(session, classNames.length) };
    } catch (error) {
      await session.release();
      throw error;
    }
  }

  async function ensureLoaded() {
    loading ??= load().catch((error) => {
      loading = undefined;
      throw error;
    });
    return loading;
  }

  return Object.freeze({
    name,
    classNames: Object.freeze([...classNames]),
    async load() {
      const { inputWidth, inputHeight } = await ensureLoaded();
      return { inputWidth, inputHeight };
    },
    async detect(image, { scoreThreshold, iouThreshold }) {
      const { ort, session, inputWidth, inputHeight, anchors } = await ensureLoaded();
      const { data, scale } = await letterbox(image, inputWidth, inputHeight);
      let output;
      try {
        const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', toBgrPlanar(data, inputWidth, inputHeight), [1, 3, inputHeight, inputWidth]) };
        output = (await session.run(feeds))[session.outputNames[0]].data;
      } catch {
        throw new DetectionError(DetectionErrorCode.INFERENCE_FAILED, 'The detection model failed to run');
      }
      const candidates = decodeYolox(output, { anchors, numClasses: classNames.length, scoreThreshold });
      return nonMaxSuppression(candidates, iouThreshold).map(({ classId, score, box }) => ({
        className: classNames[classId],
        confidence: score,
        box: [
          Math.min(Math.max(box[0] / scale, 0), image.width),
          Math.min(Math.max(box[1] / scale, 0), image.height),
          Math.min(Math.max(box[2] / scale, 0), image.width),
          Math.min(Math.max(box[3] / scale, 0), image.height),
        ],
      })).filter(({ box }) => box[2] > box[0] && box[3] > box[1]);
    },
    async release() {
      const pending = loading;
      loading = undefined;
      if (pending) await (await pending.catch(() => null))?.session.release();
    },
  });
}

module.exports = { createYoloxAdapter, letterbox, toBgrPlanar };
