const sharp = require('sharp');
const { OcrError, OcrErrorCode } = require('./errors');

/**
 * Every step can be switched off. Steps always run in the order listed here, each on the output of the previous one.
 * Defaults were chosen on the "dev" split of the synthetic dataset (see README): contrast stretching and Otsu
 * thresholding did not improve accuracy there, so they are off by default.
 * - grayscale: drop colour.
 * - invert: 'auto' negates images whose background is darker than mid-grey; true always negates; false never does.
 * - denoise: 3x3 median filter. 'auto' applies it only when the estimated noise level reaches NOISE_SIGMA_THRESHOLD,
 *   because on clean small text the median filter erases thin strokes.
 * - contrast: stretch the 1st..99th luminance percentiles to the full range.
 * - deskew: undo rotations of up to MAX_SKEW_DEGREES, estimated from the text line projection profile.
 * - upscale: enlarge small text so a text line is about TARGET_LINE_HEIGHT pixels tall (never shrinks).
 * - threshold: false, 'otsu', or a fixed 0..255 cut-off, producing a black-and-white image.
 */
const DEFAULT_PREPROCESSING = Object.freeze({
  grayscale: true,
  invert: 'auto',
  denoise: 'auto',
  contrast: false,
  deskew: true,
  upscale: true,
  threshold: false,
});

const MAX_SKEW_DEGREES = 10;
const MIN_SKEW_DEGREES = 0.5;
const MIN_LINE_ASPECT = 4;
const TARGET_LINE_HEIGHT = 40;
const MAX_UPSCALE = 4;
const MAX_OUTPUT_PIXELS = 40_000_000;
const MAX_SKEW_SAMPLES = 60_000;
const NOISE_SIGMA_THRESHOLD = 16;

const VALIDATORS = {
  grayscale: (value) => typeof value === 'boolean',
  invert: (value) => typeof value === 'boolean' || value === 'auto',
  denoise: (value) => typeof value === 'boolean' || value === 'auto',
  contrast: (value) => typeof value === 'boolean',
  deskew: (value) => typeof value === 'boolean',
  upscale: (value) => typeof value === 'boolean',
  threshold: (value) => value === false || value === 'otsu' || (Number.isInteger(value) && value >= 0 && value <= 255),
};

/** @returns {false | Readonly<typeof DEFAULT_PREPROCESSING>} */
function resolvePreprocessing(config) {
  if (config === undefined || config === true) return DEFAULT_PREPROCESSING;
  if (config === false) return false;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw invalidOptions('preprocessing must be true, false or an object');
  }
  for (const [key, value] of Object.entries(config)) {
    if (!Object.hasOwn(VALIDATORS, key)) throw invalidOptions(`Unknown preprocessing option: ${key}`);
    if (!VALIDATORS[key](value)) throw invalidOptions(`Invalid value for preprocessing option: ${key}`);
  }
  return Object.freeze({ ...DEFAULT_PREPROCESSING, ...config });
}

function invalidOptions(message) {
  return new OcrError(OcrErrorCode.INVALID_OPTIONS, message);
}

// Raw single-channel input would otherwise be written back out as 3-channel sRGB.
function toSharp({ data, width, height, channels }) {
  const pipeline = sharp(data, { raw: { width, height, channels } });
  return channels === 1 ? pipeline.toColourspace('b-w') : pipeline;
}

async function apply(pipeline) {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

const toGray = (image) => (image.channels === 1 ? image : apply(toSharp(image).greyscale()));

/**
 * @param {{data: Buffer, width: number, height: number, channels: number}} image - decoded pixels
 * @param {false | object} config - resolved with resolvePreprocessing
 * @returns {Promise<{png: Buffer, applied: string[], skewAngle: number | null, scale: number, noiseSigma: number | null}>}
 */
async function preprocess(image, config) {
  const applied = [];
  let skewAngle = null;
  let scale = 1;
  let noiseSigma = null;
  let current = image;

  if (config) {
    if (config.grayscale || config.threshold !== false) {
      current = await toGray(current);
      applied.push('grayscale');
    }
    if (config.invert === true || (config.invert === 'auto' && medianLevel(histogram(await toGray(current))) < 128)) {
      current = await apply(toSharp(current).negate());
      applied.push('invert');
    }
    if (config.denoise === 'auto') noiseSigma = estimateNoise(await toGray(current));
    if (config.denoise === true || noiseSigma >= NOISE_SIGMA_THRESHOLD) {
      current = await apply(toSharp(current).median(3));
      applied.push('denoise');
    }
    if (config.contrast) {
      current = await apply(toSharp(current).normalise({ lower: 1, upper: 99 }));
      applied.push('contrast');
    }
    if (config.deskew) {
      const gray = await toGray(current);
      skewAngle = estimateSkew(gray);
      if (Math.abs(skewAngle) >= MIN_SKEW_DEGREES) {
        const background = medianLevel(histogram(gray));
        const fill = { r: background, g: background, b: background };
        current = await apply(toSharp(current).rotate(-skewAngle, { background: fill }));
        applied.push('deskew');
      }
    }
    if (config.upscale) {
      const lineHeight = estimateLineHeight(await toGray(current));
      if (lineHeight) {
        const pixelCap = Math.sqrt(MAX_OUTPUT_PIXELS / (current.width * current.height));
        scale = Math.min(TARGET_LINE_HEIGHT / lineHeight, MAX_UPSCALE, pixelCap);
      }
      if (scale > 1.05) {
        const width = Math.round(current.width * scale);
        const height = Math.round(current.height * scale);
        current = await apply(toSharp(current).resize(width, height, { kernel: 'lanczos3', fit: 'fill' }));
        applied.push('upscale');
      } else {
        scale = 1;
      }
    }
    if (config.threshold !== false) {
      const level = config.threshold === 'otsu' ? otsuLevel(histogram(current)) : config.threshold;
      current = await apply(toSharp(current).threshold(level, { grayscale: true }));
      applied.push('threshold');
    }
  }

  const png = await toSharp(current).png({ compressionLevel: 1 }).toBuffer();
  return { png, applied, skewAngle, scale: Math.round(scale * 100) / 100, noiseSigma };
}

/**
 * Standard deviation of Gaussian noise, estimated with Immerkaer's Laplacian-difference method
 * ("Fast Noise Variance Estimation", 1996). Text edges add a little, so clean text measures a few units above zero.
 */
function estimateNoise({ data, width, height }) {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      sum += Math.abs(data[i - width - 1] - 2 * data[i - width] + data[i - width + 1]
        - 2 * data[i - 1] + 4 * data[i] - 2 * data[i + 1]
        + data[i + width - 1] - 2 * data[i + width] + data[i + width + 1]);
    }
  }
  return Math.round((sum * Math.sqrt(Math.PI / 2) / (6 * (width - 2) * (height - 2))) * 10) / 10;
}

function histogram({ data }) {
  const counts = new Float64Array(256);
  for (const level of data) counts[level]++;
  return counts;
}

function medianLevel(counts) {
  const total = counts.reduce((sum, count) => sum + count, 0);
  let seen = 0;
  for (let level = 0; level < 256; level++) {
    seen += counts[level];
    if (seen * 2 >= total) return level;
  }
  return 255;
}

function otsuLevel(counts) {
  const total = counts.reduce((sum, count) => sum + count, 0);
  const weightedTotal = counts.reduce((sum, count, level) => sum + count * level, 0);
  let background = 0;
  let weightedBackground = 0;
  let best = 0;
  let bestLevel = 128;
  for (let level = 0; level < 256; level++) {
    background += counts[level];
    if (!background) continue;
    const foreground = total - background;
    if (!foreground) break;
    weightedBackground += counts[level] * level;
    const meanDifference = weightedBackground / background - (weightedTotal - weightedBackground) / foreground;
    const variance = background * foreground * meanDifference * meanDifference;
    if (variance > best) {
      best = variance;
      bestLevel = level + 1;
    }
  }
  return bestLevel;
}

// Ink is the minority side of the Otsu split, which handles both dark-on-light and light-on-dark text.
function inkMask(gray) {
  const counts = histogram(gray);
  const level = otsuLevel(counts);
  const below = counts.slice(0, level).reduce((sum, count) => sum + count, 0);
  const inkIsDark = below * 2 <= gray.data.length;
  const mask = new Uint8Array(gray.data.length);
  let ink = 0;
  gray.data.forEach((value, index) => {
    if ((value < level) === inkIsDark) {
      mask[index] = 1;
      ink++;
    }
  });
  return { mask, ratio: ink / gray.data.length };
}

const hasUsableInk = (ratio) => ratio > 0.0005 && ratio < 0.4;

/**
 * Returns the text direction in degrees (positive = clockwise, as sharp rotates), or 0 when it cannot be measured.
 * Text lines are the direction along which ink projects onto the sharpest histogram.
 */
function estimateSkew(gray) {
  const { mask, ratio } = inkMask(gray);
  if (!hasUsableInk(ratio)) return 0;
  const inkCount = Math.round(ratio * mask.length);
  const stride = Math.max(1, Math.ceil(inkCount / MAX_SKEW_SAMPLES));
  const xs = [];
  const ys = [];
  for (let index = 0, seen = 0; index < mask.length; index++) {
    if (mask[index] && seen++ % stride === 0) {
      xs.push(index % gray.width);
      ys.push(Math.floor(index / gray.width));
    }
  }

  const offset = gray.width + gray.height;
  const bins = new Float64Array(2 * offset + 1);
  const score = (degrees) => {
    const radians = (degrees * Math.PI) / 180;
    const sin = Math.sin(radians);
    const cos = Math.cos(radians);
    bins.fill(0);
    for (let i = 0; i < xs.length; i++) bins[Math.round(ys[i] * cos - xs[i] * sin) + offset]++;
    return bins.reduce((sum, count) => sum + count * count, 0);
  };
  const search = (from, to, step, start) => {
    let best = { angle: start, value: score(start) };
    for (let angle = from; angle <= to + 1e-9; angle += step) {
      const value = score(angle);
      if (value > best.value) best = { angle, value };
    }
    return best.angle;
  };

  const coarse = search(-MAX_SKEW_DEGREES, MAX_SKEW_DEGREES, 0.5, 0);
  const angle = Math.round(search(coarse - 0.5, coarse + 0.5, 0.1, coarse) * 10) / 10;

  // A word or two does not define a line direction: rotating it can sharpen the profile as much as real skew does.
  score(angle);
  const occupied = bins.findIndex((count) => count > 0);
  const lineHeight = medianBand(bins.subarray(occupied, bins.findLastIndex((count) => count > 0) + 1));
  const radians = (angle * Math.PI) / 180;
  const along = xs.map((x, i) => x * Math.cos(radians) + ys[i] * Math.sin(radians)).sort((a, b) => a - b);
  const lineLength = along[Math.floor(along.length * 0.98)] - along[Math.floor(along.length * 0.02)];
  return lineHeight && lineLength >= MIN_LINE_ASPECT * lineHeight ? angle : 0;
}

/** Median height in pixels of the horizontal ink bands (text lines), or null when there is no measurable text. */
function estimateLineHeight(gray) {
  const { mask, ratio } = inkMask(gray);
  if (!hasUsableInk(ratio)) return null;
  const rows = new Float64Array(gray.height);
  mask.forEach((value, index) => {
    rows[Math.floor(index / gray.width)] += value;
  });
  return medianBand(rows);
}

/** Median length of the runs where an ink profile rises clearly above its background level, or null. */
function medianBand(profile) {
  const sorted = [...profile].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const cutoff = floor + (sorted[sorted.length - 1] - floor) * 0.15;

  const bands = [];
  let run = 0;
  for (const count of [...profile, 0]) {
    if (count > cutoff) {
      run++;
    } else {
      if (run >= 3) bands.push(run);
      run = 0;
    }
  }
  if (!bands.length) return null;
  bands.sort((a, b) => a - b);
  return bands[Math.floor(bands.length / 2)];
}

module.exports = {
  preprocess,
  resolvePreprocessing,
  estimateSkew,
  estimateNoise,
  otsuLevel,
  DEFAULT_PREPROCESSING,
};
