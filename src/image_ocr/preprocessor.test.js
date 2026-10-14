const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
  preprocess, resolvePreprocessing, estimateSkew, estimateNoise, otsuLevel, DEFAULT_PREPROCESSING,
} = require('./preprocessor');
const { OcrErrorCode } = require('./errors');
const { textImage, solidImage, noisy, decode } = require('./fixtures');

const ALL_OFF = { grayscale: false, invert: false, denoise: false, contrast: false, deskew: false, upscale: false, threshold: false };

// sharp converts to sRGB on output unless told otherwise, so single-channel PNGs are read back as 'b-w'.
async function pixels(png) {
  const { channels } = await sharp(png).metadata();
  const pipeline = channels === 1 ? sharp(png).toColourspace('b-w') : sharp(png);
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, ...info };
}

const run = async (buffer, config) => preprocess(await decode(buffer), resolvePreprocessing(config));

describe('resolvePreprocessing', () => {
  test('undefined and true use the defaults', () => {
    assert.equal(resolvePreprocessing(undefined), DEFAULT_PREPROCESSING);
    assert.equal(resolvePreprocessing(true), DEFAULT_PREPROCESSING);
  });

  test('false disables preprocessing', () => assert.equal(resolvePreprocessing(false), false));

  test('partial objects are merged over the defaults and frozen', () => {
    const resolved = resolvePreprocessing({ threshold: 'otsu', deskew: false });
    assert.deepEqual(resolved, { ...DEFAULT_PREPROCESSING, threshold: 'otsu', deskew: false });
    assert.ok(Object.isFrozen(resolved));
  });

  for (const config of [null, 'yes', 1, [], { sharpen: true }, { deskew: 'yes' }, { threshold: 256 }, { threshold: 1.5 },
    { invert: 'always' }, { denoise: 3 }]) {
    test(`rejects ${JSON.stringify(config)}`, () => {
      assert.throws(() => resolvePreprocessing(config), (error) => error.code === OcrErrorCode.INVALID_OPTIONS);
    });
  }
});

describe('preprocess', () => {
  test('false only re-encodes the decoded pixels as PNG', async () => {
    const source = await textImage('Hello', { foreground: '#c00' });
    const result = await run(source, false);
    assert.deepEqual(result.applied, []);
    assert.equal(result.skewAngle, null);
    assert.equal(result.scale, 1);
    const output = await pixels(result.png);
    const input = await decode(source);
    assert.deepEqual([output.width, output.height, output.channels], [input.width, input.height, 3]);
    assert.ok(output.data.equals(input.data));
  });

  test('every step switched off applies nothing', async () => {
    const result = await run(await textImage('Hello'), ALL_OFF);
    assert.deepEqual(result.applied, []);
  });

  test('defaults on clean, large, straight text only convert to grayscale', async () => {
    const result = await run(await textImage('Plain text', { size: 64 }));
    assert.deepEqual(result.applied, ['grayscale']);
    assert.equal((await pixels(result.png)).channels, 1);
    assert.ok(Math.abs(result.skewAngle) < 0.5);
    assert.ok(result.noiseSigma < 16);
  });

  describe('invert', () => {
    const dark = () => textImage('Dark mode', { foreground: '#eee', background: '#111' });

    test("'auto' turns light-on-dark into dark-on-light", async () => {
      const result = await run(await dark(), { ...ALL_OFF, invert: 'auto' });
      assert.deepEqual(result.applied, ['invert']);
      const { data } = await pixels(result.png);
      assert.ok(data.filter((value) => value > 128).length > data.length / 2);
    });

    test("'auto' leaves dark-on-light alone", async () => {
      const result = await run(await textImage('Light mode'), { ...ALL_OFF, invert: 'auto' });
      assert.deepEqual(result.applied, []);
    });

    test('false never inverts', async () => {
      const result = await run(await dark(), { ...ALL_OFF, invert: false });
      assert.deepEqual(result.applied, []);
    });
  });

  describe('denoise', () => {
    test("'auto' filters heavily noisy images", async () => {
      const result = await run(await noisy(await textImage('Noisy text'), 40), { ...ALL_OFF, denoise: 'auto' });
      assert.ok(result.noiseSigma >= 16, `noiseSigma ${result.noiseSigma}`);
      assert.deepEqual(result.applied, ['denoise']);
    });

    test("'auto' leaves clean small text alone", async () => {
      const result = await run(await textImage('Small clean text', { size: 11 }), { ...ALL_OFF, denoise: 'auto' });
      assert.ok(result.noiseSigma < 16, `noiseSigma ${result.noiseSigma}`);
      assert.deepEqual(result.applied, []);
    });

    test('true always filters, false never measures', async () => {
      const image = await textImage('Text');
      assert.deepEqual((await run(image, { ...ALL_OFF, denoise: true })).applied, ['denoise']);
      const off = await run(image, { ...ALL_OFF, denoise: false });
      assert.deepEqual(off.applied, []);
      assert.equal(off.noiseSigma, null);
    });
  });

  test('contrast stretches a low-contrast image to the full range', async () => {
    const result = await run(await textImage('Faint', { foreground: '#a0a0a0', background: '#c8c8c8' }), { ...ALL_OFF, contrast: true });
    assert.deepEqual(result.applied, ['contrast']);
    const { data } = await pixels(result.png);
    assert.ok(Math.min(...data) < 20 && Math.max(...data) > 235);
  });

  describe('threshold', () => {
    for (const threshold of ['otsu', 128]) {
      test(`${JSON.stringify(threshold)} produces a pure black-and-white grayscale image`, async () => {
        const result = await run(await textImage('Binary', { foreground: '#555', background: '#ddd' }), { ...ALL_OFF, threshold });
        assert.deepEqual(result.applied, ['grayscale', 'threshold']);
        const { data, channels } = await pixels(result.png);
        assert.equal(channels, 1);
        assert.ok(data.every((value) => value === 0 || value === 255));
        assert.ok(data.includes(0) && data.includes(255));
      });
    }
  });

  describe('deskew', () => {
    for (const angle of [5, -4, 8]) {
      test(`detects and undoes a ${angle} degree rotation`, async () => {
        const result = await run(await textImage('Rotated line of text, for deskew', { size: 30, rotate: angle }), { ...ALL_OFF, deskew: true });
        assert.ok(Math.abs(result.skewAngle - angle) <= 0.6, `estimated ${result.skewAngle}`);
        assert.deepEqual(result.applied, ['deskew']);
        const straightened = await pixels(await sharp(result.png).greyscale().toColourspace('b-w').png().toBuffer());
        assert.equal(straightened.channels, 1);
        assert.ok(Math.abs(estimateSkew(straightened)) <= 0.6);
      });
    }

    test('does not rotate straight text', async () => {
      const result = await run(await textImage('Straight line of text', { size: 30 }), { ...ALL_OFF, deskew: true });
      assert.ok(Math.abs(result.skewAngle) < 0.5);
      assert.deepEqual(result.applied, []);
    });

    test('skips images without text', async () => {
      const result = await run(await solidImage(), { ...ALL_OFF, deskew: true });
      assert.equal(result.skewAngle, 0);
      assert.deepEqual(result.applied, []);
    });
  });

  describe('upscale', () => {
    test('enlarges small text, keeping the aspect ratio', async () => {
      const source = await textImage('Tiny text', { size: 10 });
      const input = await decode(source);
      const result = await run(source, { ...ALL_OFF, upscale: true });
      assert.deepEqual(result.applied, ['upscale']);
      assert.ok(result.scale > 1 && result.scale <= 4, `scale ${result.scale}`);
      const output = await pixels(result.png);
      assert.ok(Math.abs(output.width / output.height - input.width / input.height) < 0.05);
    });

    test('never shrinks large text', async () => {
      const result = await run(await textImage('Large', { size: 80 }), { ...ALL_OFF, upscale: true });
      assert.equal(result.scale, 1);
      assert.deepEqual(result.applied, []);
    });

    test('leaves images without text unchanged', async () => {
      const result = await run(await solidImage({ width: 40, height: 10 }), { ...ALL_OFF, upscale: true });
      assert.equal(result.scale, 1);
    });
  });
});

describe('helpers', () => {
  test('estimateNoise is zero on a flat image and grows with noise', async () => {
    const flat = await decode(await solidImage());
    const gray = (image) => ({ ...image, data: image.data.filter((_, index) => index % 3 === 0), channels: 1 });
    assert.equal(estimateNoise(gray(flat)), 0);
    // Mid-grey background so the added noise is not clipped at 0 or 255.
    const midGrey = () => solidImage({ background: '#808080' });
    const light = estimateNoise(gray(await decode(await noisy(await midGrey(), 10))));
    const heavy = estimateNoise(gray(await decode(await noisy(await midGrey(), 40))));
    assert.ok(light > 5 && light < 15, `light ${light}`);
    assert.ok(heavy > 30, `heavy ${heavy}`);
  });

  test('otsuLevel splits a bimodal histogram between the modes', () => {
    const counts = new Float64Array(256);
    counts[40] = 500;
    counts[200] = 1500;
    const level = otsuLevel(counts);
    assert.ok(level > 40 && level <= 200, `level ${level}`);
  });
});
