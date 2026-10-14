#!/usr/bin/env node
/**
 * Downloads the registered object detection models into models/ and verifies their SHA-256.
 *
 *   node scripts/object_detection/download_model.js [--model yolox-tiny|yolox-nano|all]
 *
 * A file that is already present with the right hash is not downloaded again.
 */
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { MODELS, MODELS_DIR, DEFAULT_MODEL, modelPath } = require('../../src/object_detection/models');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function parseArgs(argv) {
  if (argv.length === 0) return [DEFAULT_MODEL];
  if (argv.length !== 2 || argv[0] !== '--model') throw new Error('Usage: download_model.js [--model <name>|all]');
  if (argv[1] === 'all') return Object.keys(MODELS);
  if (!Object.hasOwn(MODELS, argv[1])) throw new Error(`Unknown model "${argv[1]}". Available: ${Object.keys(MODELS).join(', ')}, all`);
  return [argv[1]];
}

async function download(name) {
  const { url, sha256: expected, license } = MODELS[name];
  const target = modelPath(name);
  try {
    if (sha256(await fs.readFile(target)) === expected) return console.log(`${name}: already present, hash OK (${target})`);
    console.log(`${name}: existing file has a different hash, downloading again`);
  } catch {
    // Not downloaded yet.
  }
  console.log(`${name}: downloading ${url} (${license})`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name}: download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`${name}: SHA-256 mismatch (expected ${expected}, got ${actual}); file not saved`);
  await fs.writeFile(`${target}.part`, bytes);
  await fs.rename(`${target}.part`, target);
  console.log(`${name}: saved ${bytes.length} bytes to ${target}`);
}

async function main() {
  const names = parseArgs(process.argv.slice(2));
  await fs.mkdir(MODELS_DIR, { recursive: true });
  for (const name of names) await download(name);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
