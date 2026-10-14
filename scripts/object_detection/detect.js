#!/usr/bin/env node
/**
 * Detects objects in one image.
 *
 *   node scripts/object_detection/detect.js <image> [--model yolox-tiny] [--score 0.3] [--json]
 *
 * Prints one line per detection (or the full result with --json). Exits with code 1 when detection fails.
 */
const { detectObjects, createYoloxAdapter, DEFAULT_MODEL, DEFAULT_OPTIONS } = require('../../src/object_detection');

const USAGE = 'Usage: node scripts/object_detection/detect.js <image> [--model yolox-tiny] [--score 0.3] [--json]';

function parseArgs(argv) {
  const args = { image: undefined, model: DEFAULT_MODEL, scoreThreshold: DEFAULT_OPTIONS.scoreThreshold, json: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--json') args.json = true;
    else if (flag === '--model') args.model = argv[++index];
    else if (flag === '--score') args.scoreThreshold = Number(argv[++index]);
    else if (!flag.startsWith('--') && args.image === undefined) args.image = flag;
    else throw new Error(`Unknown argument: ${flag}\n${USAGE}`);
  }
  if (args.image === undefined) throw new Error(USAGE);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const detector = createYoloxAdapter({ model: args.model });
  const result = await detectObjects(args.image, { detector, scoreThreshold: args.scoreThreshold });
  await detector.release();
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (result.status !== 'success') console.error(`${result.code} (${result.stage}): ${result.error}`);
  else if (result.detections.length === 0) console.error('No objects detected.');
  else {
    for (const { className, confidence, boundingBox: { x, y, width, height } } of result.detections) {
      console.log(`${className.padEnd(14)} ${confidence.toFixed(3)}  x=${x} y=${y} w=${width} h=${height}`);
    }
  }
  if (result.status !== 'success') process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
