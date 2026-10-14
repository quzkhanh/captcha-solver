const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { validateImage, sniffFormat, DEFAULT_LIMITS, SUPPORTED_FORMATS } = require('./validator');
const { DetectionErrorCode } = require('./errors');
const { solidImage } = require('./fixtures');

const rejects = (promise, code) => assert.rejects(promise, (error) => {
  assert.equal(error.code, code);
  assert.equal(error.stage, 'input');
  return true;
});

describe('validateImage: accepted inputs', () => {
  test('decodes every supported format to 3-channel sRGB', async () => {
    for (const format of SUPPORTED_FORMATS) {
      const result = await validateImage(await solidImage({ width: 40, height: 30, background: '#ff0000', format }));
      assert.equal(result.format, format);
      assert.deepEqual([result.image.width, result.image.height, result.image.channels], [40, 30, 3]);
      assert.equal(result.image.data.length, 40 * 30 * 3);
      assert.ok(result.image.data[0] > 200 && result.image.data[1] < 50, format);
    }
  });

  test('greyscale input is expanded to three channels', async () => {
    const grey = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#808080' } }).toColourspace('b-w').png().toBuffer();
    assert.equal((await sharp(grey).metadata()).channels, 1);
    const { image } = await validateImage(grey);
    assert.equal(image.channels, 3);
    assert.equal(image.data.length, 20 * 20 * 3);
  });

  test('transparency is flattened onto white', async () => {
    const transparent = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const { image } = await validateImage(transparent);
    assert.deepEqual([...image.data.subarray(0, 3)], [255, 255, 255]);
  });

  test('EXIF orientation is applied, so boxes refer to the upright image', async () => {
    const rotated = await sharp(await solidImage({ width: 60, height: 20 })).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const { image } = await validateImage(rotated);
    assert.deepEqual([image.width, image.height], [20, 60]);
  });

  test('reads from a file path and from a Uint8Array view', async () => {
    const bytes = await solidImage({ format: 'jpeg' });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'od-validator-'));
    try {
      await fs.writeFile(path.join(dir, 'image.bin'), bytes);
      assert.equal((await validateImage(path.join(dir, 'image.bin'))).format, 'jpeg');
    } finally {
      await fs.rm(dir, { recursive: true });
    }
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 4);
    assert.equal((await validateImage(padded.subarray(4, 4 + bytes.length))).format, 'jpeg');
  });

  test('exactly at the size limits is accepted', async () => {
    const limits = { ...DEFAULT_LIMITS, maxDimension: 64, maxPixels: 64 * 16, minDimension: 16 };
    assert.equal((await validateImage(await solidImage({ width: 64, height: 16 }), limits)).image.width, 64);
  });
});

describe('validateImage: rejected inputs', () => {
  test('non-image input types', async () => {
    for (const source of [undefined, null, 42, '', {}, []]) await rejects(validateImage(source), DetectionErrorCode.INVALID_INPUT);
  });

  test('missing file and directory', async () => {
    await rejects(validateImage(path.join(os.tmpdir(), 'does-not-exist-od.png')), DetectionErrorCode.FILE_NOT_FOUND);
    await rejects(validateImage(os.tmpdir()), DetectionErrorCode.FILE_NOT_FOUND);
  });

  test('empty buffer', async () => {
    await rejects(validateImage(Buffer.alloc(0)), DetectionErrorCode.EMPTY_INPUT);
  });

  test('unknown bytes, SVG and a WEBP tag without RIFF header', async () => {
    await rejects(validateImage(Buffer.from('hello world, not an image')), DetectionErrorCode.UNSUPPORTED_FORMAT);
    await rejects(validateImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>')), DetectionErrorCode.UNSUPPORTED_FORMAT);
    await rejects(validateImage(Buffer.from('XXXX0000WEBPVP8 ')), DetectionErrorCode.UNSUPPORTED_FORMAT);
  });

  test('truncated and garbage bodies behind a valid signature', async () => {
    const jpeg = await solidImage({ width: 200, height: 200, format: 'jpeg' });
    await rejects(validateImage(jpeg.subarray(0, Math.floor(jpeg.length / 2))), DetectionErrorCode.CORRUPTED_IMAGE);
    await rejects(validateImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)])), DetectionErrorCode.CORRUPTED_IMAGE);
  });

  test('file size over maxBytes, for buffers and paths', async () => {
    const bytes = await solidImage();
    const limits = { ...DEFAULT_LIMITS, maxBytes: bytes.length - 1 };
    await rejects(validateImage(bytes, limits), DetectionErrorCode.FILE_TOO_LARGE);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'od-validator-'));
    try {
      await fs.writeFile(path.join(dir, 'big.png'), bytes);
      await rejects(validateImage(path.join(dir, 'big.png'), limits), DetectionErrorCode.FILE_TOO_LARGE);
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });

  test('dimensions over maxDimension or maxPixels', async () => {
    await rejects(validateImage(await solidImage({ width: 65, height: 20 }), { ...DEFAULT_LIMITS, maxDimension: 64 }), DetectionErrorCode.IMAGE_TOO_LARGE);
    await rejects(validateImage(await solidImage({ width: 50, height: 50 }), { ...DEFAULT_LIMITS, maxPixels: 2499 }), DetectionErrorCode.IMAGE_TOO_LARGE);
  });

  test('a side under minDimension', async () => {
    await rejects(validateImage(await solidImage({ width: 15, height: 200 })), DetectionErrorCode.IMAGE_TOO_SMALL);
    await rejects(validateImage(await solidImage({ width: 200, height: 8 })), DetectionErrorCode.IMAGE_TOO_SMALL);
  });
});

test('sniffFormat ignores extensions and only trusts magic bytes', () => {
  assert.equal(sniffFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(sniffFormat(Buffer.from('RIFF\0\0\0\0WEBP')), 'webp');
  assert.equal(sniffFormat(Buffer.from('BM')), undefined);
});
