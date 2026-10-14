/**
 * Cleans engine output for callers: Unicode NFC, unified line breaks, runs of horizontal whitespace
 * collapsed to one space, lines trimmed, blank lines dropped. Characters, case and punctuation are kept.
 */
function normalizeOcrText(text) {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFC')
    .split(/\r\n|[\r\n\f\v\u2028\u2029]/)
    .map((line) => line.replace(/[\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Keeps the engine's per-word confidence untouched and adds its arithmetic mean.
 * The mean is null when the engine reports no word confidences: a score is never invented.
 */
function summarizeWords(words) {
  const kept = (Array.isArray(words) ? words : [])
    .filter((word) => typeof word?.text === 'string' && word.text.trim())
    .map((word) => ({ text: word.text, confidence: Number.isFinite(word.confidence) ? word.confidence : null }));
  const scores = kept.map((word) => word.confidence).filter((score) => score !== null);
  const confidence = scores.length ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 100) / 100 : null;
  return { words: kept, confidence };
}

module.exports = { normalizeOcrText, summarizeWords };
