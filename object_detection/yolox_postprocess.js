/**
 * Pure post-processing for YOLOX ONNX exports (decode_in_inference=False, the official release format).
 * Each anchor row is [dx, dy, log w, log h, objectness, class_0 .. class_{C-1}] where objectness and class
 * scores are already sigmoid-activated, and anchors are laid out stride by stride, row-major (y, then x).
 */
const DEFAULT_STRIDES = Object.freeze([8, 16, 32]);

function anchorGrid(inputWidth, inputHeight, strides = DEFAULT_STRIDES) {
  const anchors = [];
  for (const stride of strides) {
    const columns = Math.floor(inputWidth / stride);
    const rows = Math.floor(inputHeight / stride);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) anchors.push({ x, y, stride });
    }
  }
  return anchors;
}

/**
 * @param {Float32Array} output - flattened [1, anchors, 5 + numClasses] tensor data
 * @returns {Array<{classId: number, score: number, box: number[]}>} boxes as [x1, y1, x2, y2] in model input pixels
 */
function decodeYolox(output, { anchors, numClasses, scoreThreshold }) {
  const rowLength = 5 + numClasses;
  if (output.length !== anchors.length * rowLength) {
    throw new RangeError(`Expected ${anchors.length * rowLength} values, got ${output.length}`);
  }
  const candidates = [];
  for (let index = 0; index < anchors.length; index++) {
    const offset = index * rowLength;
    const objectness = output[offset + 4];
    // Class scores are at most 1, so objectness alone bounds the final score.
    if (!(objectness >= scoreThreshold)) continue;
    let classId = 0;
    for (let c = 1; c < numClasses; c++) {
      if (output[offset + 5 + c] > output[offset + 5 + classId]) classId = c;
    }
    const score = objectness * output[offset + 5 + classId];
    if (!(score >= scoreThreshold)) continue;
    const { x, y, stride } = anchors[index];
    const centerX = (output[offset] + x) * stride;
    const centerY = (output[offset + 1] + y) * stride;
    const width = Math.exp(output[offset + 2]) * stride;
    const height = Math.exp(output[offset + 3]) * stride;
    if (!Number.isFinite(centerX + centerY + width + height)) continue;
    candidates.push({ classId, score, box: [centerX - width / 2, centerY - height / 2, centerX + width / 2, centerY + height / 2] });
  }
  return candidates;
}

function iou(a, b) {
  const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const height = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (width <= 0 || height <= 0) return 0;
  const intersection = width * height;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection;
  return union > 0 ? intersection / union : 0;
}

/** Greedy non-maximum suppression, applied separately per class. Returns survivors by descending score. */
function nonMaxSuppression(candidates, iouThreshold) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const candidate of sorted) {
    if (kept.every((other) => other.classId !== candidate.classId || iou(other.box, candidate.box) <= iouThreshold)) {
      kept.push(candidate);
    }
  }
  return kept;
}

module.exports = { anchorGrid, decodeYolox, nonMaxSuppression, iou };
