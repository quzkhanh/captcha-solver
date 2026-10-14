const fs = require('node:fs/promises');
const sharp = require('sharp');
const { OcrError, OcrErrorCode } = require('./errors');

const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxDimension: 10_000,
  maxPixels: 25_000_000,
});

// Formats are identified by their magic bytes, never by file extension or caller-supplied MIME type.
// The allowlist is the set sharp decodes in every prebuilt binary; SVG is excluded on purpose because
// rendering it can pull in external resources and arbitrary fonts.
const SIGNATURES = [
  ['png', 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['jpeg', 0, [0xff, 0xd8, 0xff]],
  ['gif', 0, [0x47, 0x49, 0x46, 0x38]],
  ['tiff', 0, [0x49, 0x49, 0x2a, 0x00]],
  ['tiff', 0, [0x4d, 0x4d, 0x00, 0x2a]],
  ['webp', 8, [0x57, 0x45, 0x42, 0x50]],
];

const SUPPORTED_FORMATS = Object.freeze([...new Set(SIGNATURES.map(([format]) => format))]);

function sniffFormat(bytes) {
  const match = SIGNATURES.find(([format, offset, magic]) =>
    (format !== 'webp' || bytes.subarray(0, 4).toString('latin1') === 'RIFF')
    && magic.every((byte, index) => bytes[offset + index] === byte));
  return match?.[0];
}

async function readSource(source, limits) {
  if (source instanceof Uint8Array) return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  if (typeof source !== 'string' || !source) {
    throw new OcrError(OcrErrorCode.INVALID_INPUT, 'Input must be a Buffer, a Uint8Array or a non-empty file path');
  }
  let stat;
  try {
    stat = await fs.stat(source);
  } catch {
    throw new OcrError(OcrErrorCode.FILE_NOT_FOUND, 'The image file does not exist or cannot be accessed');
  }
  if (!stat.isFile()) throw new OcrError(OcrErrorCode.FILE_NOT_FOUND, 'The image path is not a regular file');
  if (stat.size > limits.maxBytes) throw fileTooLarge(limits);
  try {
    return await fs.readFile(source);
  } catch {
    throw new OcrError(OcrErrorCode.FILE_NOT_FOUND, 'The image file does not exist or cannot be accessed');
  }
}

function fileTooLarge(limits) {
  return new OcrError(OcrErrorCode.FILE_TOO_LARGE, `The image file exceeds ${limits.maxBytes} bytes`);
}

/**
 * Checks the input and decodes it once, so later stages work on trusted pixels.
 * EXIF orientation is applied and transparency is flattened onto white.
 *
 * @returns {Promise<{format: string, width: number, height: number,
 *   image: {data: Buffer, width: number, height: number, channels: number}}>}
 */
async function validateImage(source, limits = DEFAULT_LIMITS) {
  const bytes = await readSource(source, limits);
  if (bytes.length === 0) throw new OcrError(OcrErrorCode.EMPTY_INPUT, 'The image is empty');
  if (bytes.length > limits.maxBytes) throw fileTooLarge(limits);

  const format = sniffFormat(bytes);
  if (!format) {
    throw new OcrError(OcrErrorCode.UNSUPPORTED_FORMAT, `The image format is not supported. Supported: ${SUPPORTED_FORMATS.join(', ')}`);
  }

  let metadata;
  try {
    metadata = await sharp(bytes).metadata();
  } catch {
    throw corrupted();
  }
  const { width, height } = metadata;
  if (!width || !height) throw corrupted();
  if (width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels) {
    throw new OcrError(
      OcrErrorCode.IMAGE_TOO_LARGE,
      `The image is ${width}x${height}; the limit is ${limits.maxDimension} pixels per side and ${limits.maxPixels} pixels in total`,
    );
  }

  // metadata() only reads the header, so truncated files are caught here, during the full decode.
  try {
    const { data, info } = await sharp(bytes, { failOn: 'truncated', limitInputPixels: limits.maxPixels })
      .autoOrient()
      .flatten({ background: '#ffffff' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      format,
      width: info.width,
      height: info.height,
      image: { data, width: info.width, height: info.height, channels: info.channels },
    };
  } catch {
    throw corrupted();
  }
}

function corrupted() {
  return new OcrError(OcrErrorCode.CORRUPTED_IMAGE, 'The image data is corrupted or incomplete');
}

module.exports = { validateImage, sniffFormat, DEFAULT_LIMITS, SUPPORTED_FORMATS };
