const Stage = Object.freeze({
  INPUT: 'input',
  MODEL: 'model',
  INFERENCE: 'inference',
  INTERNAL: 'internal',
});

const DetectionErrorCode = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_OPTIONS: 'INVALID_OPTIONS',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  EMPTY_INPUT: 'EMPTY_INPUT',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  CORRUPTED_IMAGE: 'CORRUPTED_IMAGE',
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
  IMAGE_TOO_SMALL: 'IMAGE_TOO_SMALL',
  DEPENDENCY_MISSING: 'DEPENDENCY_MISSING',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  MODEL_INVALID: 'MODEL_INVALID',
  INFERENCE_FAILED: 'INFERENCE_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

const STAGE_BY_CODE = Object.freeze({
  INVALID_INPUT: Stage.INPUT,
  INVALID_OPTIONS: Stage.INPUT,
  FILE_NOT_FOUND: Stage.INPUT,
  EMPTY_INPUT: Stage.INPUT,
  FILE_TOO_LARGE: Stage.INPUT,
  UNSUPPORTED_FORMAT: Stage.INPUT,
  CORRUPTED_IMAGE: Stage.INPUT,
  IMAGE_TOO_LARGE: Stage.INPUT,
  IMAGE_TOO_SMALL: Stage.INPUT,
  DEPENDENCY_MISSING: Stage.MODEL,
  MODEL_NOT_FOUND: Stage.MODEL,
  MODEL_INVALID: Stage.MODEL,
  INFERENCE_FAILED: Stage.INFERENCE,
  INTERNAL_ERROR: Stage.INTERNAL,
});

// Messages are written for the caller: they never include stack traces, file contents or native runtime errors.
class DetectionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.stage = STAGE_BY_CODE[code];
  }
}

module.exports = { DetectionError, DetectionErrorCode, Stage };
