#!/usr/bin/env node
/**
 * Builds the object detection evaluation set under dataset/object_detection/<split>/ (git-ignored).
 *
 *   node scripts/od_prepare_dataset.js [--out dataset/object_detection] [--dev 60] [--test 200] [--composites 20]
 *
 * Groups per split:
 *   coco      - COCO val2017 photos whose Flickr licence allows reuse and adaptation (CC BY 2.0, CC BY-SA 2.0,
 *               "No known copyright restrictions"); NonCommercial and NoDerivs images are never downloaded.
 *               Boxes come from the COCO annotations (CC BY 4.0). Attribution is written to ATTRIBUTION.md.
 *   composite - self-made images: one annotated object cropped from a coco-group photo, rescaled and pasted
 *               on a plain canvas, so its exact box is known. Checks coordinate mapping on odd aspect ratios.
 *   negative  - self-made images with no objects (solid, gradient, noise, stripes); every detection is a false positive.
 *   invalid   - inputs that must be rejected with a specific error code.
 * dev and test use disjoint photos; tune thresholds on dev, report on test.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const COCO_CLASSES = require('../object_detection/coco_classes');

const ANNOTATIONS_ZIP = 'http://images.cocodataset.org/annotations/annotations_trainval2017.zip';
const ALLOWED_LICENSE_URLS = new Set([
  'http://creativecommons.org/licenses/by/2.0/',
  'http://creativecommons.org/licenses/by-sa/2.0/',
  'http://flickr.com/commons/usage/',
  'http://www.usa.gov/copyright.shtml',
]);
const CANVASES = [[640, 480], [480, 640], [800, 400], [416, 416], [1024, 768]];
const FORMATS = ['jpeg', 'png', 'webp'];

function parseArgs(argv) {
  const args = { out: 'dataset/object_detection', dev: 60, test: 200, composites: 20 };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (flag === '--out' && value) args.out = value;
    else if (['--dev', '--test', '--composites'].includes(flag) && /^\d+$/.test(value ?? '')) args[flag.slice(2)] = Number(value);
    else throw new Error(`Unknown or invalid argument: ${flag}`);
  }
  return args;
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, next) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

async function loadAnnotations(cacheDir) {
  const json = path.join(cacheDir, 'instances_val2017.json');
  try {
    return JSON.parse(await fs.readFile(json, 'utf8'));
  } catch {
    const zip = path.join(cacheDir, 'annotations_trainval2017.zip');
    try {
      await fs.access(zip);
    } catch {
      console.log(`Downloading ${ANNOTATIONS_ZIP} (~253 MB, once)`);
      const response = await fetch(ANNOTATIONS_ZIP);
      if (!response.ok) throw new Error(`Annotation download failed with HTTP ${response.status}`);
      await fs.writeFile(zip, Buffer.from(await response.arrayBuffer()));
    }
    await fs.writeFile(json, execFileSync('unzip', ['-p', zip, 'annotations/instances_val2017.json'], { maxBuffer: 64 * 1024 * 1024 }));
    await fs.rm(zip);
    return JSON.parse(await fs.readFile(json, 'utf8'));
  }
}

async function fetchImage(url, cacheDir) {
  const cached = path.join(cacheDir, 'images', path.basename(url));
  try {
    return await fs.readFile(cached);
  } catch {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        await sharp(bytes, { failOn: 'truncated' }).stats();
        await fs.writeFile(cached, bytes);
        return bytes;
      } catch (error) {
        if (attempt === 3) throw new Error(`Could not download ${url}: ${error.message}`);
      }
    }
  }
}

function cocoSamples(coco, images) {
  const licenses = new Map(coco.licenses.map((license) => [license.id, license]));
  const categories = new Map(coco.categories.map((category) => [category.id, category.name]));
  const byImage = Map.groupBy(coco.annotations, (annotation) => annotation.image_id);
  return images.map((image) => ({
    file: image.file_name,
    group: 'coco',
    width: image.width,
    height: image.height,
    source: { cocoId: image.id, license: licenses.get(image.license).name, licenseUrl: licenses.get(image.license).url, flickrUrl: image.flickr_url, cocoUrl: image.coco_url },
    groundTruth: (byImage.get(image.id) ?? []).map((annotation) => ({
      className: categories.get(annotation.category_id),
      boundingBox: { x: annotation.bbox[0], y: annotation.bbox[1], width: annotation.bbox[2], height: annotation.bbox[3] },
      iscrowd: annotation.iscrowd === 1,
    })),
  }));
}

async function composites(samples, count, splitDir, next) {
  const pool = shuffle(samples.flatMap((sample) => sample.groundTruth
    .filter((truth) => !truth.iscrowd && truth.boundingBox.width >= 64 && truth.boundingBox.height >= 64)
    .map((truth) => ({ sample, truth }))), next).slice(0, count);
  const result = [];
  for (const [index, { sample, truth }] of pool.entries()) {
    const [canvasWidth, canvasHeight] = CANVASES[index % CANVASES.length];
    const crop = {
      left: Math.floor(truth.boundingBox.x),
      top: Math.floor(truth.boundingBox.y),
      width: Math.min(sample.width, Math.ceil(truth.boundingBox.x + truth.boundingBox.width)) - Math.floor(truth.boundingBox.x),
      height: Math.min(sample.height, Math.ceil(truth.boundingBox.y + truth.boundingBox.height)) - Math.floor(truth.boundingBox.y),
    };
    const fit = Math.min((canvasWidth * 0.8) / crop.width, (canvasHeight * 0.8) / crop.height);
    const scale = Math.min(fit, 0.5 + next() * 1.0);
    const width = Math.max(1, Math.round(crop.width * scale));
    const height = Math.max(1, Math.round(crop.height * scale));
    const left = Math.floor(next() * (canvasWidth - width + 1));
    const top = Math.floor(next() * (canvasHeight - height + 1));
    const object = await sharp(path.join(splitDir, 'images', sample.file)).extract(crop).resize(width, height).toBuffer();
    const shade = 60 + Math.floor(next() * 140);
    const format = FORMATS[index % FORMATS.length];
    const file = `composite_${String(index).padStart(3, '0')}.${format === 'jpeg' ? 'jpg' : format}`;
    await sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 3, background: { r: shade, g: shade, b: shade } } })
      .composite([{ input: object, left, top }])
      .toFormat(format, format === 'jpeg' ? { quality: 92 } : {})
      .toFile(path.join(splitDir, 'images', file));
    result.push({
      file, group: 'composite', width: canvasWidth, height: canvasHeight,
      source: { derivedFrom: sample.file, ...sample.source, modification: 'object cropped, rescaled and pasted on a plain background' },
      groundTruth: [{ className: truth.className, boundingBox: { x: left, y: top, width, height }, iscrowd: false }],
    });
  }
  return result;
}

async function negatives(splitDir, next) {
  const noise = Buffer.from(Array.from({ length: 320 * 240 * 3 }, () => Math.floor(next() * 256)));
  const gradient = Buffer.from(Array.from({ length: 512 * 256 * 3 }, (_, index) => Math.floor((Math.floor(index / 3) % 512) / 2)));
  const stripes = Buffer.from(Array.from({ length: 400 * 400 * 3 }, (_, index) => (Math.floor((Math.floor(index / 3) % 400) / 25) % 2 ? 230 : 40)));
  const images = {
    'blank_white.png': sharp({ create: { width: 640, height: 480, channels: 3, background: '#ffffff' } }),
    'blank_gray.jpg': sharp({ create: { width: 300, height: 900, channels: 3, background: '#808080' } }),
    'gradient.png': sharp(gradient, { raw: { width: 512, height: 256, channels: 3 } }),
    'noise.png': sharp(noise, { raw: { width: 320, height: 240, channels: 3 } }),
    'stripes.webp': sharp(stripes, { raw: { width: 400, height: 400, channels: 3 } }),
  };
  const result = [];
  for (const [file, image] of Object.entries(images)) {
    await image.toFile(path.join(splitDir, 'images', file));
    const { width, height } = await sharp(path.join(splitDir, 'images', file)).metadata();
    result.push({ file, group: 'negative', width, height, groundTruth: [] });
  }
  return result;
}

async function invalids(splitDir, photo) {
  const files = {
    'invalid_empty.jpg': [Buffer.alloc(0), 'EMPTY_INPUT'],
    'invalid_text.jpg': [Buffer.from('this is not an image\n'), 'UNSUPPORTED_FORMAT'],
    'invalid_truncated.jpg': [photo.subarray(0, Math.floor(photo.length / 2)), 'CORRUPTED_IMAGE'],
    'invalid_tiny.png': [await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toBuffer(), 'IMAGE_TOO_SMALL'],
    'invalid_vector.svg': [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>'), 'UNSUPPORTED_FORMAT'],
  };
  for (const [file, [bytes]] of Object.entries(files)) await fs.writeFile(path.join(splitDir, 'images', file), bytes);
  return Object.entries(files).map(([file, [, expectedError]]) => ({ file, group: 'invalid', expectedError, groundTruth: [] }));
}

function attribution(samples) {
  const lines = samples.filter((sample) => sample.group === 'coco').map((sample) =>
    `| ${sample.file} | [${sample.source.license}](${sample.source.licenseUrl}) | ${sample.source.flickrUrl} |`);
  return [
    '# Attribution',
    '',
    'Photos: COCO 2017 validation set (https://cocodataset.org), originally from Flickr, used under the licence listed per image.',
    'Annotations: COCO Consortium, CC BY 4.0. composite_* files are adaptations of the listed photos (see labels.json `source`).',
    '',
    '| File | Licence | Flickr source |',
    '| --- | --- | --- |',
    ...lines,
    '',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cacheDir = path.join(args.out, 'cache');
  await fs.mkdir(path.join(cacheDir, 'images'), { recursive: true });
  const coco = await loadAnnotations(cacheDir);

  const unknown = coco.categories.filter((category) => !COCO_CLASSES.includes(category.name));
  if (unknown.length) throw new Error(`COCO categories missing from coco_classes.js: ${unknown.map((c) => c.name).join(', ')}`);

  const allowed = new Set(coco.licenses.filter((license) => ALLOWED_LICENSE_URLS.has(license.url)).map((license) => license.id));
  const eligible = shuffle(coco.images.filter((image) => allowed.has(image.license)).sort((a, b) => a.id - b.id), random(2017));
  if (eligible.length < args.dev + args.test) throw new Error(`Only ${eligible.length} licensed images available`);
  const splits = { dev: [eligible.slice(0, args.dev), 11], test: [eligible.slice(args.dev, args.dev + args.test), 22] };

  for (const [split, [images, seed]] of Object.entries(splits)) {
    const splitDir = path.join(args.out, split);
    await fs.rm(splitDir, { recursive: true, force: true });
    await fs.mkdir(path.join(splitDir, 'images'), { recursive: true });
    const next = random(seed);
    for (let index = 0; index < images.length; index += 8) {
      process.stderr.write(`\r${split}: downloading ${Math.min(index + 8, images.length)}/${images.length}   `);
      await Promise.all(images.slice(index, index + 8).map(async (image) =>
        fs.writeFile(path.join(splitDir, 'images', image.file_name), await fetchImage(image.coco_url, cacheDir))));
    }
    process.stderr.write('\n');
    const photos = cocoSamples(coco, images);
    const samples = [
      ...photos,
      ...(await composites(photos, args.composites, splitDir, next)),
      ...(await negatives(splitDir, next)),
      ...(await invalids(splitDir, await fs.readFile(path.join(splitDir, 'images', photos[0].file)))),
    ];
    await fs.writeFile(path.join(splitDir, 'labels.json'), `${JSON.stringify({ split, classes: COCO_CLASSES, samples }, null, 1)}\n`);
    await fs.writeFile(path.join(splitDir, 'ATTRIBUTION.md'), attribution(samples));
    const counts = Object.entries(Object.groupBy(samples, (sample) => sample.group)).map(([group, list]) => `${group}=${list.length}`);
    console.log(`${split}: ${counts.join(', ')}, ${photos.reduce((n, s) => n + s.groundTruth.length, 0)} COCO boxes -> ${splitDir}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
