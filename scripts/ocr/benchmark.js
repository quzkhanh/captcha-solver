#!/usr/bin/env node
/**
 * Runs the OCR module over a generated split and reports accuracy and latency per preprocessing configuration.
 *
 *   node scripts/ocr/benchmark.js [--split test] [--configs raw,default] [--psm 3] [--out benchmark-results/ocr]
 *
 * Only the image path is passed to recognizeImage(); labels.json is read separately and used for scoring only.
 * Images run one at a time so latency figures are not distorted by parallel Tesseract processes.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { recognizeImage, createTesseractAdapter, DEFAULT_PREPROCESSING } = require('../../src/image_ocr');
const { summarize } = require('../../src/image_ocr/evaluator');

const CONFIGS = {
  raw: false,
  default: DEFAULT_PREPROCESSING,
  'no-denoise': { denoise: false },
  'always-denoise': { denoise: true },
  'no-deskew': { deskew: false },
  'no-upscale': { upscale: false },
  'with-contrast': { contrast: true },
  'with-otsu': { threshold: 'otsu' },
};

function parseArgs(argv) {
  const args = { split: 'test', configs: ['raw', 'default'], psm: 3, out: 'benchmark-results/ocr', dataset: 'dataset/ocr' };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (flag === '--split' && value) args.split = value;
    else if (flag === '--dataset' && value) args.dataset = value;
    else if (flag === '--out' && value) args.out = value;
    else if (flag === '--psm' && /^\d+$/.test(value ?? '')) args.psm = Number(value);
    else if (flag === '--configs' && value) args.configs = value === 'all' ? Object.keys(CONFIGS) : value.split(',');
    else throw new Error(`Unknown or invalid argument: ${flag}`);
  }
  const unknown = args.configs.filter((name) => !Object.hasOwn(CONFIGS, name));
  if (unknown.length) throw new Error(`Unknown config(s): ${unknown.join(', ')}. Available: ${Object.keys(CONFIGS).join(', ')}`);
  return args;
}

const pct = (value) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);
const ms = (value) => (value === null ? '—' : value.toFixed(0));
const row = (cells) => `| ${cells.join(' | ')} |`;
const table = (header, rows) => [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n');

function report(meta, configs, runs) {
  const groups = [...new Set(runs[configs[0]].map((sample) => sample.group))];
  const overall = table(
    ['Config', 'CER', 'WER', 'Exact match', 'Processing errors', 'False text on blank', 'Correct rejections', 'Mean ms', 'p95 ms'],
    configs.map((name) => {
      const s = summarize(runs[name]);
      return [name, pct(s.cer), pct(s.wer), pct(s.exactMatch), pct(s.processingErrorRate), pct(s.falseTextRate),
        pct(s.correctRejectionRate), ms(s.meanMs), ms(s.p95Ms)];
    }),
  );
  const byGroup = table(
    ['Group', 'n', ...configs.flatMap((name) => [`CER ${name}`, `Exact ${name}`]), ...configs.map((name) => `p95 ms ${name}`)],
    groups.filter((group) => !['blank', 'invalid'].includes(group)).map((group) => {
      const summaries = configs.map((name) => summarize(runs[name].filter((sample) => sample.group === group)));
      return [group, summaries[0].samples, ...summaries.flatMap((s) => [pct(s.cer), pct(s.exactMatch)]), ...summaries.map((s) => ms(s.p95Ms))];
    }),
  );
  const invalid = table(
    ['File', 'Expected', ...configs],
    runs[configs[0]].filter((sample) => sample.expectedError).map((sample, index) =>
      [sample.file, sample.expectedError, ...configs.map((name) => runs[name].filter((s) => s.expectedError)[index].result.code ?? 'success')]),
  );
  return [
    `# OCR benchmark: split "${meta.split}"`,
    '',
    `Engine: Tesseract ${meta.engineVersion} (lang ${meta.language}, psm ${meta.psm}). Node ${meta.node}. ${meta.date}.`,
    `Samples: ${meta.samples} (${meta.textSamples} with text, ${meta.blankSamples} blank, ${meta.invalidSamples} invalid).`,
    'CER/WER = total edit distance / total reference length after NFC + whitespace collapsing; case and punctuation count.',
    '',
    '## Overall',
    '',
    overall,
    '',
    '## By group',
    '',
    byGroup,
    '',
    '## Invalid inputs (returned error code)',
    '',
    invalid,
    '',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const splitDir = path.resolve(args.dataset, args.split);
  let labels;
  try {
    labels = JSON.parse(await fs.readFile(path.join(splitDir, 'labels.json'), 'utf8'));
  } catch {
    throw new Error(`No dataset at ${splitDir}. Run: npm run dataset`);
  }

  const engine = createTesseractAdapter({ psm: args.psm });
  let engineVersion;
  try {
    engineVersion = await engine.version();
  } catch (error) {
    throw new Error(`Tesseract is not available (${error.code}). Install it first, see README.`);
  }

  const runs = {};
  for (const name of args.configs) {
    runs[name] = [];
    for (const [index, sample] of labels.samples.entries()) {
      process.stderr.write(`\r${name}: ${index + 1}/${labels.samples.length}   `);
      const result = await recognizeImage(path.join(splitDir, sample.file), { engine, preprocessing: CONFIGS[name] });
      runs[name].push({
        file: sample.file,
        group: sample.group,
        ...(sample.expectedError ? { expectedError: sample.expectedError } : { expectedText: sample.text }),
        result,
      });
    }
  }
  process.stderr.write('\n');

  const first = summarize(runs[args.configs[0]]);
  const meta = {
    split: args.split, engineVersion, language: engine.language, psm: engine.psm, node: process.version,
    date: new Date().toISOString(), samples: first.samples, textSamples: first.textSamples,
    blankSamples: first.blankSamples, invalidSamples: first.invalidSamples,
  };
  const markdown = report(meta, args.configs, runs);
  console.log(markdown);

  await fs.mkdir(args.out, { recursive: true });
  const base = path.join(args.out, `${args.split}-psm${args.psm}`);
  const summaries = Object.fromEntries(args.configs.map((name) => [name, summarize(runs[name])]));
  const predictions = Object.fromEntries(args.configs.map((name) => [name, runs[name].map(({ result, ...sample }) => ({
    ...sample, status: result.status, value: result.value, code: result.code, confidence: result.metadata.confidence,
    applied: result.metadata.preprocessing?.applied, processingTimeMs: result.metadata.processingTimeMs,
  }))]));
  await fs.writeFile(`${base}.json`, `${JSON.stringify({ meta, configs: Object.fromEntries(args.configs.map((n) => [n, CONFIGS[n]])), summaries, predictions }, null, 2)}\n`);
  await fs.writeFile(`${base}.md`, markdown);
  console.error(`Saved ${base}.md and ${base}.json`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
