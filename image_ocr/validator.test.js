const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { validateImage, sniffFormat, DEFAULT_LIMITS, SUPPORTED_FORMATS } = require('./validator');
const { OcrErrorCode } = require('./errors');
const { textImage, solidImage } = require('./fixtures');

async function assertRejects(source, code, limits = DEFAULT_LIMITS) {
  await assert.rejects(validateImage(source, limits), (error) => {
    assert.equal(error.code, code);
    assert.equal(error.stage, 'input');
    return true;
  });
}

describe('validateImage: supported formats', () => {
  for (const format of SUPPORTED_FORMATS) {
    test(`decodes ${format}`, async () => {
      const result = await validateImage(await solidImage({ width: 64, height: 32, format }));
      assert.equal(result.format, format);
      assert.equal(result.width, 64);
      assert.equal(result.height, 32);
      assert.equal(result.image.data.length, 64 * 32 * result.image.channels);
    });
  }

  test('accepts a Uint8Array that is not a Buffer', async () => {
    const png = await solidImage();
    const result = await validateImage(new Uint8Array(png));
    assert.equal(result.format, 'png');
  });

  test('flattens transparency onto white', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const { image } = await validateImage(png);
    assert.equal(image.channels, 3);
    assert.ok(image.data.every((value) => value === 255));
  });

  test('applies EXIF orientation', async () => {
    const jpeg = await sharp(await solidImage({ width: 80, height: 20 })).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const result = await validateImage(jpeg);
    assert.deepEqual([result.width, result.height], [20, 80]);
  });
});

describe('validateImage: file paths', () => {
  let directory;
  before(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-ocr-validator-'));
  });
  after(() => fs.rm(directory, { recursive: true, force: true }));

  test('reads an image file', async () => {
    const file = path.join(directory, 'ok.png');
    await fs.writeFile(file, await solidImage());
    assert.equal((await validateImage(file)).format, 'png');
  });

  test('missing file', () => assertRejects(path.join(directory, 'missing.png'), OcrErrorCode.FILE_NOT_FOUND));

  test('directory instead of a file', () => assertRejects(directory, OcrErrorCode.FILE_NOT_FOUND));

  test('empty file', async () => {
    const file = path.join(directory, 'empty.png');
    await fs.writeFile(file, Buffer.alloc(0));
    await assertRejects(file, OcrErrorCode.EMPTY_INPUT);
  });

  test('file over maxBytes is rejected from its size, before it is decoded', async () => {
    const file = path.join(directory, 'big.png');
    await fs.writeFile(file, Buffer.alloc(2048));
    await assertRejects(file, OcrErrorCode.FILE_TOO_LARGE, { ...DEFAULT_LIMITS, maxBytes: 1024 });
  });

  test('the extension is ignored: a text file named .png is unsupported', async () => {
    const file = path.join(directory, 'fake.png');
    await fs.writeFile(file, 'not an image');
    await assertRejects(file, OcrErrorCode.UNSUPPORTED_FORMAT);
  });
});

describe('validateImage: invalid input', () => {
  for (const source of [undefined, null, 42, {}, [], '', true]) {
    test(`rejects ${JSON.stringify(source)}`, () => assertRejects(source, OcrErrorCode.INVALID_INPUT));
  }

  test('empty buffer', () => assertRejects(Buffer.alloc(0), OcrErrorCode.EMPTY_INPUT));

  test('buffer over maxBytes', async () => {
    await assertRejects(await solidImage(), OcrErrorCode.FILE_TOO_LARGE, { ...DEFAULT_LIMITS, maxBytes: 10 });
  });
});

describe('validateImage: unsupported formats', () => {
  const cases = {
    bmp: Buffer.concat([Buffer.from('BM'), Buffer.alloc(60)]),
    svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
    pdf: Buffer.from('%PDF-1.4\n%%EOF\n'),
    text: Buffer.from('hello world'),
    'RIFF without WEBP': Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(16)]),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    test(name, () => assertRejects(bytes, OcrErrorCode.UNSUPPORTED_FORMAT));
  }

  test('avif is decodable by sharp but not on the allowlist', async () => {
    await assertRejects(await sharp(await solidImage()).avif().toBuffer(), OcrErrorCode.UNSUPPORTED_FORMAT);
  });
});

describe('validateImage: corrupted images', () => {
  test('truncated png (header intact, data cut)', async () => {
    const png = await textImage('Truncated');
    await assertRejects(png.subarray(0, Math.floor(png.length / 2)), OcrErrorCode.CORRUPTED_IMAGE);
  });

  test('truncated jpeg', async () => {
    const jpeg = await textImage('Truncated', { format: 'jpeg' });
    await assertRejects(jpeg.subarray(0, Math.floor(jpeg.length / 2)), OcrErrorCode.CORRUPTED_IMAGE);
  });

  test('png signature followed by garbage', () =>
    assertRejects(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]), OcrErrorCode.CORRUPTED_IMAGE));

  test('webp container without image data', () =>
    assertRejects(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]), OcrErrorCode.CORRUPTED_IMAGE));
});

describe('validateImage: size limits', () => {
  test('width over maxDimension', async () => {
    await assertRejects(await solidImage({ width: 300, height: 10 }), OcrErrorCode.IMAGE_TOO_LARGE, { ...DEFAULT_LIMITS, maxDimension: 200 });
  });

  test('pixel count over maxPixels', async () => {
    await assertRejects(await solidImage({ width: 100, height: 100 }), OcrErrorCode.IMAGE_TOO_LARGE, { ...DEFAULT_LIMITS, maxPixels: 9999 });
  });

  test('default limits reject a 12000 px wide image', async () => {
    await assertRejects(await solidImage({ width: 12_000, height: 10 }), OcrErrorCode.IMAGE_TOO_LARGE);
  });

  test('exactly at the limits is accepted', async () => {
    const result = await validateImage(await solidImage({ width: 100, height: 100 }), { maxBytes: 1e6, maxDimension: 100, maxPixels: 10_000 });
    assert.equal(result.width, 100);
  });
});

test('sniffFormat recognises magic bytes only', () => {
  assert.equal(sniffFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(sniffFormat(Buffer.from('GIF89a')), 'gif');
  assert.equal(sniffFormat(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])), 'tiff');
  assert.equal(sniffFormat(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(sniffFormat(Buffer.from('BM')), undefined);
  assert.equal(sniffFormat(Buffer.alloc(0)), undefined);
});
