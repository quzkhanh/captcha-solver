/**
 * Metric normalisation: Unicode NFC, every whitespace run (including line breaks) becomes one space, ends trimmed.
 * Case, punctuation, digits and diacritics are compared exactly.
 */
function normalizeForComparison(text) {
  return String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

function editDistance(reference, hypothesis) {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let i = 1; i <= reference.length; i++) {
    const current = [i];
    for (let j = 1; j <= hypothesis.length; j++) {
      const substitution = previous[j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j] + 1, current[j - 1] + 1, substitution));
    }
    previous = current;
  }
  return previous[hypothesis.length];
}

const characters = (text) => Array.from(text);
const words = (text) => (text ? text.split(' ') : []);

/** Edit counts for one sample; CER and WER are computed from the totals so long texts weigh more. */
function compareText(reference, hypothesis) {
  const ref = normalizeForComparison(reference);
  const hyp = normalizeForComparison(hypothesis);
  return {
    charEdits: editDistance(characters(ref), characters(hyp)),
    refChars: characters(ref).length,
    wordEdits: editDistance(words(ref), words(hyp)),
    refWords: words(ref).length,
    exact: ref === hyp,
  };
}

/** Nearest-rank percentile. */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const ratio = (part, whole) => (whole ? part / whole : null);
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

/**
 * @param {Array<{expectedText?: string, expectedError?: string, result: object}>} samples
 *   expectedText for images that contain text ('' for images without text), expectedError for invalid inputs.
 */
function summarize(samples) {
  const textSamples = samples.filter((sample) => typeof sample.expectedText === 'string' && sample.expectedText);
  const blankSamples = samples.filter((sample) => sample.expectedText === '');
  const invalidSamples = samples.filter((sample) => sample.expectedError);
  const validSamples = [...textSamples, ...blankSamples];

  const scored = textSamples.map((sample) => compareText(sample.expectedText, sample.result.status === 'success' ? sample.result.value : ''));
  const sum = (key) => scored.reduce((total, score) => total + score[key], 0);
  const timings = samples.map((sample) => sample.result.metadata?.processingTimeMs).filter(Number.isFinite);

  return {
    samples: samples.length,
    textSamples: textSamples.length,
    cer: ratio(sum('charEdits'), sum('refChars')),
    wer: ratio(sum('wordEdits'), sum('refWords')),
    exactMatch: ratio(scored.filter((score) => score.exact).length, scored.length),
    processingErrorRate: ratio(validSamples.filter((sample) => sample.result.status !== 'success').length, validSamples.length),
    blankSamples: blankSamples.length,
    falseTextRate: ratio(blankSamples.filter((sample) => sample.result.status === 'success' && sample.result.value).length, blankSamples.length),
    invalidSamples: invalidSamples.length,
    correctRejectionRate: ratio(invalidSamples.filter((sample) => sample.result.code === sample.expectedError).length, invalidSamples.length),
    meanMs: mean(timings),
    p95Ms: percentile(timings, 95),
  };
}

module.exports = { normalizeForComparison, editDistance, compareText, percentile, summarize };
