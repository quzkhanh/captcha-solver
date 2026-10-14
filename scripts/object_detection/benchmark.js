#!/usr/bin/env node
/**
 * Benchmarks object detection models on a prepared split: accuracy, latency and memory.
 *
 *   node scripts/object_detection/benchmark.js [--split test] [--models yolox-tiny,yolox-nano] [--threads N] [--out benchmark-results/object_detection]
 *
 * Each model runs in its own child process, so memory figures are not mixed between models. Per model:
 *   pass 1 (score >= 0.01, max 100 per image) feeds mAP; P/R/F1 at the default threshold are the same detections
 *            filtered, which is exact because greedy NMS never lets a lower score suppress a higher one;
 *   pass 2 (default options) is timed for latency, after 3 warm-up runs.
 * Only image paths reach detectObjects(); labels.json is read for scoring only.
 */
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { MODELS, DEFAULT_OPTIONS } = require('../../src/object_detection');
const { meanAveragePrecision, precisionRecall, boxIou, percentile, mean } = require('../../src/object_detection/evaluator');

const EVAL_THRESHOLD = 0.01;
const SWEEP = [0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6];

function parseArgs(argv) {
  const args = { split: 'test', models: Object.keys(MODELS), threads: undefined, out: 'benchmark-results/object_detection', dataset: 'dataset/object_detection', worker: false };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (flag === '--worker') [args.worker, index] = [true, index - 1];
    else if (flag === '--split' && value) args.split = value;
    else if (flag === '--dataset' && value) args.dataset = value;
    else if (flag === '--out' && value) args.out = value;
    else if (flag === '--threads' && /^[1-9]\d*$/.test(value ?? '')) args.threads = Number(value);
    else if (flag === '--models' && value) args.models = value.split(',');
    else throw new Error(`Unknown or invalid argument: ${flag}`);
  }
  const unknown = args.models.filter((name) => !Object.hasOwn(MODELS, name));
  if (unknown.length) throw new Error(`Unknown model(s): ${unknown.join(', ')}. Available: ${Object.keys(MODELS).join(', ')}`);
  return args;
}

async function loadLabels(args) {
  const splitDir = path.resolve(args.dataset, args.split);
  try {
    return { splitDir, labels: JSON.parse(await fs.readFile(path.join(splitDir, 'labels.json'), 'utf8')) };
  } catch {
    throw new Error(`No dataset at ${splitDir}. Run: npm run od:dataset`);
  }
}

async function worker(args) {
  const rss = () => process.memoryUsage.rss();
  const rssStart = rss();
  const { detectObjects, createYoloxAdapter } = require('../../src/object_detection');
  const { splitDir, labels } = await loadLabels(args);
  const detector = createYoloxAdapter({ model: args.models[0], threads: args.threads });
  const loadStarted = performance.now();
  await detector.load();
  const loadMs = performance.now() - loadStarted;
  const rssAfterLoad = rss();
  let peakRss = rssAfterLoad;
  const run = async (file, options) => {
    const result = await detectObjects(path.join(splitDir, 'images', file), { detector, ...options });
    peakRss = Math.max(peakRss, rss());
    return result;
  };

  const evaluation = [];
  for (const sample of labels.samples) evaluation.push(await run(sample.file, { scoreThreshold: EVAL_THRESHOLD }));
  const warmup = labels.samples.find((sample) => sample.group === 'coco');
  for (let index = 0; index < 3; index++) await run(warmup.file, {});
  const timed = [];
  for (const sample of labels.samples.filter((s) => s.group !== 'invalid')) {
    const { metadata } = await run(sample.file, {});
    timed.push({ group: sample.group, processingTimeMs: metadata.processingTimeMs, inferenceMs: metadata.inferenceMs });
  }
  await detector.release();
  process.stdout.write(JSON.stringify({
    evaluation, timed, loadMs,
    memory: { rssStart, rssAfterLoad, peakRss: Math.max(peakRss, process.resourceUsage().maxRSS * 1024) },
  }));
}

function runWorker(model, args) {
  const workerArgs = ['--worker', '--models', model, '--split', args.split, '--dataset', args.dataset, ...(args.threads ? ['--threads', String(args.threads)] : [])];
  return JSON.parse(execFileSync(process.execPath, [__filename, ...workerArgs], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }));
}

function score(labels, { evaluation, timed, loadMs, memory }) {
  const samples = labels.samples.map((sample, index) => ({ ...sample, result: evaluation[index] }));
  const scored = (group) => samples.filter((s) => s.group === group).map((s) => ({ groundTruth: s.groundTruth, detections: s.result.detections ?? [] }));
  const coco = scored('coco');
  const at = (threshold, list) => precisionRecall(list, { scoreThreshold: threshold });
  const compositeHits = samples.filter((s) => s.group === 'composite').map((s) => {
    const truth = s.groundTruth[0];
    const kept = (s.result.detections ?? []).filter((d) => d.confidence >= DEFAULT_OPTIONS.scoreThreshold);
    const best = (list) => Math.max(0, ...list.map((d) => boxIou(d.boundingBox, truth.boundingBox)));
    return { sameClass: best(kept.filter((d) => d.className === truth.className)), anyClass: best(kept) };
  });
  const negatives = samples.filter((s) => s.group === 'negative');
  const invalid = samples.filter((s) => s.group === 'invalid');
  return {
    map: meanAveragePrecision(coco),
    operating: at(DEFAULT_OPTIONS.scoreThreshold, coco),
    sweep: SWEEP.map((threshold) => ({ threshold, ...at(threshold, coco) })),
    composite: {
      n: compositeHits.length,
      recall: compositeHits.filter((h) => h.sameClass >= 0.5).length / compositeHits.length,
      localized: compositeHits.filter((h) => h.anyClass >= 0.5).length / compositeHits.length,
      meanIou: mean(compositeHits.map((h) => h.sameClass)),
    },
    negative: {
      n: negatives.length,
      falsePositives: negatives.reduce((n, s) => n + (s.result.detections ?? []).filter((d) => d.confidence >= DEFAULT_OPTIONS.scoreThreshold).length, 0),
    },
    invalid: invalid.map((s) => ({ file: s.file, expected: s.expectedError, actual: s.result.code ?? 'success' })),
    latency: {
      loadMs,
      meanMs: mean(timed.map((t) => t.processingTimeMs)),
      p50Ms: percentile(timed.map((t) => t.processingTimeMs), 0.5),
      p95Ms: percentile(timed.map((t) => t.processingTimeMs), 0.95),
      meanInferenceMs: mean(timed.map((t) => t.inferenceMs)),
    },
    memory,
  };
}

const pct = (value) => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`);
const num = (value, digits = 0) => (value === null || value === undefined ? '—' : value.toFixed(digits));
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
const row = (cells) => `| ${cells.join(' | ')} |`;
const table = (header, rows) => [row(header), row(header.map(() => '---')), ...rows.map(row)].join('\n');

function report(meta, results) {
  const names = Object.keys(results);
  const counts = Object.entries(meta.groups).map(([group, n]) => `${group} ${n}`).join(', ');
  const classes = Object.entries(results[names[0]].map.perClass).filter(([name]) => meta.gtPerClass[name] >= 15).map(([name]) => name);
  return [
    `# Object detection benchmark: split "${meta.split}"`,
    '',
    `${meta.date}. Node ${meta.node}, onnxruntime-node ${meta.ort}, CPU ${meta.cpu} (${meta.cores} logical cores), threads ${meta.threads}.`,
    `Samples: ${counts}. COCO ground-truth boxes: ${meta.cocoBoxes}. Default thresholds: score ${DEFAULT_OPTIONS.scoreThreshold}, NMS IoU ${DEFAULT_OPTIONS.iouThreshold}.`,
    'mAP uses this repo\'s evaluator (COCO-style 101-point AP, crowd matched by IoU, no area split): close to, not identical with, pycocotools.',
    '',
    '## Accuracy',
    '',
    table(['Model', 'mAP@.5:.95', 'mAP@.5', `Precision@${DEFAULT_OPTIONS.scoreThreshold}`, 'Recall', 'F1', 'Composite recall (class+IoU≥.5)', 'Composite localised (any class)', 'Composite mean IoU', 'FP on negatives', 'Invalid inputs rejected correctly'],
      names.map((name) => {
        const r = results[name];
        return [name, pct(r.map.map), pct(r.map.map50), pct(r.operating.precision), pct(r.operating.recall), pct(r.operating.f1),
          pct(r.composite.recall), pct(r.composite.localized), num(r.composite.meanIou, 3), `${r.negative.falsePositives} / ${r.negative.n} images`,
          `${r.invalid.filter((i) => i.expected === i.actual).length} / ${r.invalid.length}`];
      })),
    '',
    '## Score threshold sweep (COCO group, IoU 0.5)',
    '',
    table(['Threshold', ...names.flatMap((name) => [`P ${name}`, `R ${name}`, `F1 ${name}`])],
      SWEEP.map((threshold, index) => [threshold, ...names.flatMap((name) => {
        const s = results[name].sweep[index];
        return [pct(s.precision), pct(s.recall), pct(s.f1)];
      })])),
    '',
    '## Latency (end-to-end detectObjects: read + decode + letterbox + inference + NMS)',
    '',
    table(['Model', 'Model load ms', 'Mean ms', 'p50 ms', 'p95 ms', 'Mean inference ms'],
      names.map((name) => {
        const l = results[name].latency;
        return [name, num(l.loadMs), num(l.meanMs, 1), num(l.p50Ms, 1), num(l.p95Ms, 1), num(l.meanInferenceMs, 1)];
      })),
    '',
    '## Memory (resident set size of the benchmark process)',
    '',
    table(['Model', 'RSS before load', 'RSS after load', 'Peak RSS'],
      names.map((name) => {
        const m = results[name].memory;
        return [name, mb(m.rssStart), mb(m.rssAfterLoad), mb(m.peakRss)];
      })),
    '',
    `## AP@0.5 per class (classes with ≥ 15 ground-truth boxes in this split)`,
    '',
    table(['Class', 'GT boxes', ...names], classes.map((name) => [name, meta.gtPerClass[name], ...names.map((model) => pct(results[model].map.perClass[name].ap50))])),
    '',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.worker) return worker(args);
  const { labels } = await loadLabels(args);

  const results = {};
  for (const model of args.models) {
    process.stderr.write(`${model}: running ${labels.samples.length} samples...\n`);
    results[model] = score(labels, runWorker(model, args));
  }

  const coco = labels.samples.filter((s) => s.group === 'coco');
  const meta = {
    split: args.split, date: new Date().toISOString(), node: process.version, ort: require('onnxruntime-node/package.json').version,
    cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.availableParallelism(), threads: args.threads ?? 'onnxruntime default',
    groups: Object.fromEntries(Object.entries(Object.groupBy(labels.samples, (s) => s.group)).map(([group, list]) => [group, list.length])),
    cocoBoxes: coco.reduce((n, s) => n + s.groundTruth.length, 0),
    gtPerClass: coco.flatMap((s) => s.groundTruth.filter((t) => !t.iscrowd)).reduce((counts, t) => ({ ...counts, [t.className]: (counts[t.className] ?? 0) + 1 }), {}),
  };
  const markdown = report(meta, results);
  console.log(markdown);
  await fs.mkdir(args.out, { recursive: true });
  const base = path.join(args.out, args.split);
  await fs.writeFile(`${base}.md`, markdown);
  await fs.writeFile(`${base}.json`, `${JSON.stringify({ meta, results }, null, 1)}\n`);
  process.stderr.write(`Saved ${base}.md and ${base}.json\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
