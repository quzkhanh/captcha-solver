const Stage = Object.freeze({
  INPUT: 'input',
  PREPROCESSING: 'preprocessing',
  ENGINE: 'engine',
  INTERNAL: 'internal',
});

const OcrErrorCode = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_OPTIONS: 'INVALID_OPTIONS',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  EMPTY_INPUT: 'EMPTY_INPUT',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  CORRUPTED_IMAGE: 'CORRUPTED_IMAGE',
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
  PREPROCESSING_FAILED: 'PREPROCESSING_FAILED',
  ENGINE_UNAVAILABLE: 'ENGINE_UNAVAILABLE',
  ENGINE_TIMEOUT: 'ENGINE_TIMEOUT',
  ENGINE_ERROR: 'ENGINE_ERROR',
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
  PREPROCESSING_FAILED: Stage.PREPROCESSING,
  ENGINE_UNAVAILABLE: Stage.ENGINE,
  ENGINE_TIMEOUT: Stage.ENGINE,
  ENGINE_ERROR: Stage.ENGINE,
  INTERNAL_ERROR: Stage.INTERNAL,
});

// Messages are written for the caller: they never include stack traces, file contents or engine stderr.
class OcrError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.stage = STAGE_BY_CODE[code];
  }
}

module.exports = { OcrError, OcrErrorCode, Stage };
