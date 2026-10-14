// Test fixtures shared by the image_ocr test files. Images are rendered on the fly, nothing is stored on disk.
const sharp = require('sharp');

async function textImage(text, { size = 40, font = 'DejaVu Sans', foreground = '#000', background = '#fff', format = 'png', rotate = 0 } = {}) {
  const lines = text.split('\n');
  const lineHeight = Math.round(size * 1.5);
  const width = Math.ceil(Math.max(...lines.map((line) => line.length)) * size * 0.75 + size * 2);
  const height = lineHeight * lines.length + size;
  const texts = lines.map((line, index) =>
    `<text x="${size}" y="${size * 1.2 + index * lineHeight}" font-family="${font}" font-size="${size}" fill="${foreground}">${line}</text>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${background}"/>${texts.join('')}</svg>`;
  let image = sharp(Buffer.from(svg));
  if (rotate) image = sharp(await image.png().toBuffer()).rotate(rotate, { background });
  return image.toFormat(format).toBuffer();
}

const solidImage = ({ width = 320, height = 80, background = '#ffffff', format = 'png' } = {}) =>
  sharp({ create: { width, height, channels: 3, background } }).toFormat(format).toBuffer();

async function noisy(buffer, sigma, seed = 7) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const { data, info } = await sharp(buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  for (let index = 0; index < data.length; index++) {
    const gaussian = Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
    data[index] = Math.max(0, Math.min(255, Math.round(data[index] + gaussian * sigma)));
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

/** Decodes a buffer into the {data, width, height, channels} shape the preprocessor expects. */
async function decode(buffer) {
  const { data, info } = await sharp(buffer).flatten({ background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

module.exports = { textImage, solidImage, noisy, decode };
