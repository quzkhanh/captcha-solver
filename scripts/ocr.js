#!/usr/bin/env node
/**
 * Recognises the text in one image.
 *
 *   node scripts/ocr.js <image> [--no-preprocess] [--lang eng] [--psm 3] [--json]
 *
 * Prints the text (or the full result with --json). Exits with code 1 when recognition fails.
 */
const { recognizeImage, createTesseractAdapter } = require('../image_ocr');

const USAGE = 'Usage: node scripts/ocr.js <image> [--no-preprocess] [--lang eng] [--psm 3] [--json]';

function parseArgs(argv) {
  const args = { image: undefined, preprocessing: true, language: 'eng', psm: 3, json: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--no-preprocess') args.preprocessing = false;
    else if (flag === '--json') args.json = true;
    else if (flag === '--lang') args.language = argv[++index];
    else if (flag === '--psm') args.psm = Number(argv[++index]);
    else if (!flag.startsWith('--') && args.image === undefined) args.image = flag;
    else throw new Error(`Unknown argument: ${flag}\n${USAGE}`);
  }
  if (args.image === undefined) throw new Error(USAGE);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const engine = createTesseractAdapter({ language: args.language, psm: args.psm });
  const result = await recognizeImage(args.image, { engine, preprocessing: args.preprocessing });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (result.status === 'success' && !result.metadata.textDetected) console.error('No text detected.');
  else if (result.status === 'success') console.log(result.value);
  else console.error(`${result.code} (${result.stage}): ${result.error}`);
  if (result.status !== 'success') process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
