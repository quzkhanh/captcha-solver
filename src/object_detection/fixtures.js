// Self-made test images shared by the object_detection test files. They are rendered on the fly, nothing is stored.
const sharp = require('sharp');

const solidImage = ({ width = 320, height = 240, background = '#ffffff', format = 'png' } = {}) =>
  sharp({ create: { width, height, channels: 3, background } }).toFormat(format).toBuffer();

function noiseImage({ width = 320, height = 240, seed = 7 } = {}) {
  let state = seed;
  const data = Buffer.alloc(width * height * 3);
  for (let index = 0; index < data.length; index++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    data[index] = state >>> 23;
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

module.exports = { solidImage, noiseImage };
