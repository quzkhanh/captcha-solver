#!/usr/bin/env node
/**
 * Generates a small synthetic OCR dataset that can be rebuilt byte for byte from fixed seeds.
 *
 *   node scripts/generate_dataset.js [--out dataset] [--split dev|test|all] [--per-group N]
 *
 * Layout: <out>/<split>/images/* holds only images; the ground truth lives separately in <out>/<split>/labels.json.
 * The "dev" split (its own seed) is for choosing preprocessing defaults; report accuracy on "test" only.
 * Rendering depends on the installed fonts (fontconfig), so exact pixels can differ between machines.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');

const SPLITS = { dev: { seed: 1001, perGroup: 8 }, test: { seed: 2002, perGroup: 20 } };
const FONTS = ['DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono', 'Liberation Sans', 'Liberation Serif',
  'Liberation Mono', 'Noto Sans', 'Noto Serif', 'Noto Sans Mono'];
const VOCABULARY = `the of and to in is you that it he was for on are as with his they at be this have from or one had
by word but not what all were we when your can said there use an each which she do how their if will up other about out
many then them these so some her would make like him into time has look two more write go see number no way could people
my than first water been call who oil its now find long down day did get come made may part over new sound take only little
work know place year live me back give most very after thing our just name good sentence man think say great where help
through much before line right too mean old any same tell boy follow came want show also around form three small set put
end does another well large must big even such because turn here why ask went men read need land different home us move
try kind hand picture again change off play spell air away animal house point page letter mother answer found study still
learn should America world Monday Paris Hanoi Tuesday December`.split(/\s+/);
const PUNCTUATION = ['.', ',', '!', '?', ':', ';'];
const FORMATS = ['png', 'jpeg', 'webp', 'tiff', 'gif'];

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRandom(seed) {
  const next = mulberry32(seed);
  const random = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    float: (min, max) => min + next() * (max - min),
    pick: (items) => items[Math.floor(next() * items.length)],
    gaussian: () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()),
  };
  return random;
}

function sentence(random, minWords, maxWords) {
  const tokens = Array.from({ length: random.int(minWords, maxWords) }, () => {
    const roll = random.next();
    if (roll < 0.08) return String(random.int(1, 9999));
    if (roll < 0.12) return `${random.int(1, 999)}.${String(random.int(0, 99)).padStart(2, '0')}`;
    return random.pick(VOCABULARY);
  });
  tokens[0] = tokens[0][0].toUpperCase() + tokens[0].slice(1);
  if (random.next() < 0.3) tokens[random.int(0, tokens.length - 2)] += ',';
  return tokens.join(' ') + (random.next() < 0.7 ? random.pick(PUNCTUATION) : '');
}

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const gray = (level) => ({ r: level, g: level, b: level });
const css = ({ r, g, b }) => `rgb(${r},${g},${b})`;

async function renderText(lines, { font, size, foreground, background }) {
  const width = Math.ceil(Math.max(...lines.map((line) => line.length)) * size * 0.8 + size * 2);
  const lineHeight = Math.round(size * 1.45);
  const height = lineHeight * lines.length + size;
  const texts = lines.map((line, index) =>
    `<text x="${size}" y="${size + index * lineHeight}" font-family="${font}" font-size="${size}" fill="${css(foreground)}" xml:space="preserve">${escapeXml(line)}</text>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect width="100%" height="100%" fill="${css(background)}"/>${texts.join('')}</svg>`;
  const trimmed = await sharp(Buffer.from(svg)).trim({ background: css(background), threshold: 10 }).png().toBuffer();
  const pad = Math.max(8, Math.round(size * 0.6));
  return sharp(trimmed).extend({ top: pad, bottom: pad, left: pad, right: pad, background }).png().toBuffer();
}

async function addNoise(png, sigma, random) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index += info.channels) {
    const delta = random.gaussian() * sigma;
    for (let channel = 0; channel < info.channels; channel++) {
      data[index + channel] = Math.max(0, Math.min(255, Math.round(data[index + channel] + delta)));
    }
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

const encode = (png, format) => sharp(png).toFormat(format, format === 'jpeg' ? { quality: 90 } : {}).toBuffer();

const pickColors = (random) => ({
  foreground: random.pick([gray(0), gray(40), { r: 20, g: 30, b: 110 }, { r: 120, g: 10, b: 10 }]),
  background: random.pick([gray(255), gray(248), { r: 255, g: 250, b: 230 }]),
});

// Each text group returns { text, params, png, format }.
const TEXT_GROUPS = {
  clean: async (random, index) => {
    const style = { font: random.pick(FONTS), size: random.int(18, 40), ...pickColors(random) };
    const text = sentence(random, 3, 7);
    return { text, style, png: await renderText([text], style), format: FORMATS[index % FORMATS.length] };
  },
  small_text: async (random) => {
    const style = { font: random.pick(FONTS), size: random.int(8, 13), ...pickColors(random) };
    const text = sentence(random, 3, 7);
    return { text, style, png: await renderText([text], style) };
  },
  multiline: async (random) => {
    const style = { font: random.pick(FONTS), size: random.int(18, 28), ...pickColors(random) };
    const lines = Array.from({ length: random.int(2, 4) }, () => sentence(random, 3, 6));
    return { text: lines.join('\n'), style, png: await renderText(lines, style) };
  },
  dark_background: async (random, index) => {
    const style = { font: random.pick(FONTS), size: random.int(20, 36), foreground: gray(random.int(210, 255)), background: gray(random.int(0, 50)) };
    const text = sentence(random, 3, 7);
    return { text, style, png: await renderText([text], style), format: index % 2 ? 'jpeg' : 'png' };
  },
  low_contrast: async (random) => {
    const backgroundLevel = random.int(150, 220);
    const contrast = random.int(12, 50);
    const style = { font: random.pick(FONTS), size: random.int(20, 36), foreground: gray(backgroundLevel - contrast), background: gray(backgroundLevel) };
    const text = sentence(random, 3, 7);
    return { text, style, params: { contrast }, png: await renderText([text], style) };
  },
  noise_moderate: async (random) => {
    const style = { font: random.pick(FONTS), size: random.int(20, 36), ...pickColors(random) };
    const sigma = random.int(10, 20);
    const text = sentence(random, 3, 7);
    return { text, style, params: { sigma }, png: await addNoise(await renderText([text], style), sigma, random) };
  },
  noise_heavy: async (random) => {
    const style = { font: random.pick(FONTS), size: random.int(22, 36), ...pickColors(random) };
    const sigma = random.int(30, 65);
    const text = sentence(random, 3, 7);
    return { text, style, params: { sigma }, png: await addNoise(await renderText([text], style), sigma, random) };
  },
  blur: async (random) => {
    const style = { font: random.pick(FONTS), size: random.int(22, 34), ...pickColors(random) };
    const sigma = Math.round(random.float(0.8, 2.8) * 10) / 10;
    const text = sentence(random, 3, 7);
    return { text, style, params: { sigma }, png: await sharp(await renderText([text], style)).blur(sigma).png().toBuffer() };
  },
  rotated: async (random) => {
    const style = { font: random.pick(FONTS), size: random.int(20, 34), ...pickColors(random) };
    const angle = Math.round(random.float(1.5, 9) * 10) / 10 * (random.next() < 0.5 ? -1 : 1);
    const text = sentence(random, 3, 6);
    const png = await sharp(await renderText([text], style)).rotate(angle, { background: style.background }).png().toBuffer();
    return { text, style, params: { angle }, png };
  },
};

const BLANK_KINDS = [
  ['white', () => sharp({ create: { width: 480, height: 120, channels: 3, background: gray(255) } }).png().toBuffer()],
  ['dark', () => sharp({ create: { width: 400, height: 100, channels: 3, background: gray(30) } }).png().toBuffer()],
  ['noise', async (random) => addNoise(await sharp({ create: { width: 480, height: 120, channels: 3, background: gray(230) } }).png().toBuffer(), 20, random)],
  ['gradient', () => sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#777"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>')).png().toBuffer()],
];

function bmp(width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const buffer = Buffer.alloc(54 + rowSize * height, 0xff);
  buffer.write('BM', 0, 'latin1');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(0, 30);
  buffer.writeUInt32LE(rowSize * height, 34);
  return buffer;
}

async function invalidCases(random) {
  const sample = await renderText(['Invalid input sample'], { font: 'DejaVu Sans', size: 28, foreground: gray(0), background: gray(255) });
  const jpeg = await encode(sample, 'jpeg');
  const garbage = Buffer.from(Array.from({ length: 512 }, () => random.int(0, 255)));
  const blankCanvas = (width, height) => sharp({ create: { width, height, channels: 3, background: gray(255) } }).png().toBuffer();
  return [
    ['empty.png', Buffer.alloc(0), 'EMPTY_INPUT'],
    ['truncated.png', sample.subarray(0, Math.floor(sample.length / 2)), 'CORRUPTED_IMAGE'],
    ['truncated.jpg', jpeg.subarray(0, Math.floor(jpeg.length / 2)), 'CORRUPTED_IMAGE'],
    ['png-signature-then-garbage.png', Buffer.concat([sample.subarray(0, 8), garbage]), 'CORRUPTED_IMAGE'],
    ['bitmap.bmp', bmp(64, 32), 'UNSUPPORTED_FORMAT'],
    ['vector.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50"><text x="5" y="35">Hello</text></svg>'), 'UNSUPPORTED_FORMAT'],
    ['document.pdf', Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'), 'UNSUPPORTED_FORMAT'],
    ['text-with-png-extension.png', Buffer.from('This is a plain text file, not an image.\n'), 'UNSUPPORTED_FORMAT'],
    ['modern-format.avif', await sharp(sample).avif().toBuffer(), 'UNSUPPORTED_FORMAT'],
    ['too-wide-12000x200.png', await blankCanvas(12_000, 200), 'IMAGE_TOO_LARGE'],
    ['too-many-pixels-6000x5000.png', await blankCanvas(6000, 5000), 'IMAGE_TOO_LARGE'],
  ];
}

async function generateSplit(outRoot, split, { seed, perGroup }) {
  const random = makeRandom(seed);
  const splitDir = path.join(outRoot, split);
  const imageDir = path.join(splitDir, 'images');
  await fs.rm(splitDir, { recursive: true, force: true });
  await fs.mkdir(imageDir, { recursive: true });

  const samples = [];
  const save = async (name, bytes, label) => {
    await fs.writeFile(path.join(imageDir, name), bytes);
    samples.push({ file: `images/${name}`, ...label });
  };

  for (const [group, make] of Object.entries(TEXT_GROUPS)) {
    for (let index = 0; index < perGroup; index++) {
      const { text, style, params, png, format = 'png' } = await make(random, index);
      const extension = format === 'jpeg' ? 'jpg' : format === 'tiff' ? 'tif' : format;
      await save(`${group}-${String(index + 1).padStart(3, '0')}.${extension}`, await encode(png, format), {
        group, text, font: style.font, fontSize: style.size, ...(params && { params }),
      });
    }
  }
  for (let index = 0; index < Math.max(4, Math.round(perGroup / 2)); index++) {
    const [kind, make] = BLANK_KINDS[index % BLANK_KINDS.length];
    await save(`blank-${String(index + 1).padStart(3, '0')}.png`, await make(random), { group: 'blank', text: '', params: { kind } });
  }
  for (const [name, bytes, expectedError] of await invalidCases(random)) {
    await save(`invalid-${name}`, bytes, { group: 'invalid', expectedError });
  }

  const labels = { split, seed, perGroup, generator: { sharp: sharp.versions.sharp, vips: sharp.versions.vips }, samples };
  await fs.writeFile(path.join(splitDir, 'labels.json'), `${JSON.stringify(labels, null, 2)}\n`);
  return samples.length;
}

function parseArgs(argv) {
  const args = { out: 'dataset', split: 'all', perGroup: undefined };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (flag === '--out' && value) args.out = value;
    else if (flag === '--split' && ['dev', 'test', 'all'].includes(value)) args.split = value;
    else if (flag === '--per-group' && Number.parseInt(value, 10) > 0) args.perGroup = Number.parseInt(value, 10);
    else throw new Error(`Unknown or invalid argument: ${flag}. Usage: generate_dataset.js [--out dir] [--split dev|test|all] [--per-group N]`);
  }
  return args;
}

function missingFonts() {
  try {
    const installed = new Set(execFileSync('fc-list', [':', 'family'], { encoding: 'utf8' }).split('\n').flatMap((line) => line.split(',')));
    return FONTS.filter((font) => !installed.has(font));
  } catch {
    return [];
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const missing = missingFonts();
  if (missing.length) console.warn(`Warning: fonts not installed, fontconfig will substitute them: ${missing.join(', ')}`);
  const splits = args.split === 'all' ? Object.keys(SPLITS) : [args.split];
  for (const split of splits) {
    const config = { ...SPLITS[split], ...(args.perGroup && { perGroup: args.perGroup }) };
    const count = await generateSplit(path.resolve(args.out), split, config);
    console.log(`${split}: ${count} files in ${path.join(args.out, split)}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
