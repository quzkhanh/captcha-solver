/**
 * Detection metrics in the style of the COCO evaluation, written in plain JS so no Python tooling is needed.
 * A sample is { groundTruth: [{className, boundingBox, iscrowd?}], detections: [{className, boundingBox, confidence}] }.
 *
 * Differences from pycocotools: crowd regions are matched by IoU (not intersection over detection area) and area
 * ranges are not split. On the 200-image test split the two agreed within 0.3 points (README, "Kết quả thực tế").
 */
const COCO_IOU_THRESHOLDS = Object.freeze(Array.from({ length: 10 }, (_, index) => Math.round((0.5 + index * 0.05) * 100) / 100));
const RECALL_POINTS = Array.from({ length: 101 }, (_, index) => index / 100);

const toCorners = ({ x, y, width, height }) => [x, y, x + width, y + height];

function boxIou(a, b) {
  const [ax1, ay1, ax2, ay2] = toCorners(a);
  const [bx1, by1, bx2, by2] = toCorners(b);
  const width = Math.min(ax2, bx2) - Math.max(ax1, bx1);
  const height = Math.min(ay2, by2) - Math.max(ay1, by1);
  if (width <= 0 || height <= 0) return 0;
  const intersection = width * height;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Greedy matching of one image's detections of one class, highest confidence first.
 * Each detection is labelled 'tp', 'fp' or 'ignore' (matched a crowd region).
 */
function matchImage(detections, groundTruth, iouThreshold) {
  const used = new Set();
  return [...detections].sort((a, b) => b.confidence - a.confidence).map((detection) => {
    let best = -1;
    let bestIou = iouThreshold;
    for (const [index, truth] of groundTruth.entries()) {
      if (truth.iscrowd || used.has(index)) continue;
      const overlap = boxIou(detection.boundingBox, truth.boundingBox);
      if (overlap >= bestIou) [best, bestIou] = [index, overlap];
    }
    if (best >= 0) {
      used.add(best);
      return { confidence: detection.confidence, label: 'tp' };
    }
    const crowd = groundTruth.some((truth) => truth.iscrowd && boxIou(detection.boundingBox, truth.boundingBox) >= iouThreshold);
    return { confidence: detection.confidence, label: crowd ? 'ignore' : 'fp' };
  });
}

/** COCO 101-point interpolated average precision. Returns null when the class has no positives. */
function averagePrecision(matches, positives) {
  if (positives === 0) return null;
  const ranked = matches.filter(({ label }) => label !== 'ignore').sort((a, b) => b.confidence - a.confidence);
  const precision = [];
  const recall = [];
  let tp = 0;
  for (const [index, { label }] of ranked.entries()) {
    if (label === 'tp') tp++;
    precision.push(tp / (index + 1));
    recall.push(tp / positives);
  }
  for (let index = precision.length - 2; index >= 0; index--) precision[index] = Math.max(precision[index], precision[index + 1]);
  let sum = 0;
  let cursor = 0;
  for (const point of RECALL_POINTS) {
    while (cursor < recall.length && recall[cursor] < point) cursor++;
    if (cursor < recall.length) sum += precision[cursor];
  }
  return sum / RECALL_POINTS.length;
}

function byClass(items, className) {
  return items.filter((item) => item.className === className);
}

function classesOf(samples) {
  return [...new Set(samples.flatMap((sample) => sample.groundTruth.filter((truth) => !truth.iscrowd).map((truth) => truth.className)))].sort();
}

function classAp(samples, className, iouThreshold) {
  const matches = samples.flatMap((sample) => matchImage(byClass(sample.detections, className), byClass(sample.groundTruth, className), iouThreshold));
  const positives = samples.reduce((count, sample) => count + byClass(sample.groundTruth, className).filter((truth) => !truth.iscrowd).length, 0);
  return averagePrecision(matches, positives);
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** mAP@0.5, mAP@0.5:0.95 and per-class AP@0.5 over classes that have at least one non-crowd ground truth box. */
function meanAveragePrecision(samples) {
  const classes = classesOf(samples);
  const perClass = Object.fromEntries(classes.map((className) => [className, {
    ap50: classAp(samples, className, 0.5),
    ap: mean(COCO_IOU_THRESHOLDS.map((threshold) => classAp(samples, className, threshold))),
  }]));
  return {
    classes: classes.length,
    map50: mean(classes.map((className) => perClass[className].ap50)),
    map: mean(classes.map((className) => perClass[className].ap)),
    perClass,
  };
}

/** Precision, recall and F1 of the detections at or above scoreThreshold, matched per class at one IoU threshold. */
function precisionRecall(samples, { scoreThreshold, iouThreshold = 0.5 }) {
  let tp = 0;
  let fp = 0;
  let positives = 0;
  for (const sample of samples) {
    const detections = sample.detections.filter(({ confidence }) => confidence >= scoreThreshold);
    for (const className of new Set([...detections, ...sample.groundTruth].map((item) => item.className))) {
      const groundTruth = byClass(sample.groundTruth, className);
      positives += groundTruth.filter((truth) => !truth.iscrowd).length;
      for (const { label } of matchImage(byClass(detections, className), groundTruth, iouThreshold)) {
        if (label === 'tp') tp++;
        else if (label === 'fp') fp++;
      }
    }
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = positives ? tp / positives : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return { tp, fp, fn: positives - tp, precision, recall, f1 };
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

module.exports = { boxIou, matchImage, averagePrecision, meanAveragePrecision, precisionRecall, percentile, mean, COCO_IOU_THRESHOLDS };
