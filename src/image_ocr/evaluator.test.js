const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeForComparison, editDistance, compareText, percentile, summarize } = require('./evaluator');

describe('editDistance', () => {
  const cases = [
    ['', '', 0], ['abc', '', 3], ['', 'abc', 3], ['abc', 'abc', 0],
    ['kitten', 'sitting', 3], ['flaw', 'lawn', 2],
  ];
  for (const [a, b, expected] of cases) {
    test(`${a || "''"} vs ${b || "''"} = ${expected}`, () => assert.equal(editDistance(Array.from(a), Array.from(b)), expected));
  }

  test('works on word arrays', () => assert.equal(editDistance(['the', 'cat', 'sat'], ['the', 'bat', 'sat', 'down']), 2));
});

describe('compareText', () => {
  test('whitespace and line breaks are normalised, nothing else', () => {
    assert.equal(normalizeForComparison(' Hello\n  World \t'), 'Hello World');
    assert.ok(compareText('Hello World', 'Hello\nWorld').exact);
  });

  test('case and punctuation differences count as errors', () => {
    const result = compareText('Hello, World.', 'hello World');
    assert.equal(result.exact, false);
    assert.equal(result.charEdits, 3);
    assert.equal(result.wordEdits, 2);
  });

  test('counts characters by code point after NFC', () => {
    const result = compareText('café', 'café');
    assert.ok(result.exact);
    assert.equal(result.refChars, 4);
  });

  test('a missing prediction is a full deletion', () => {
    assert.deepEqual(compareText('two words', ''), { charEdits: 9, refChars: 9, wordEdits: 2, refWords: 2, exact: false });
  });
});

describe('percentile', () => {
  const values = Array.from({ length: 20 }, (_, index) => index + 1);
  test('nearest rank', () => {
    assert.equal(percentile(values, 95), 19);
    assert.equal(percentile(values, 50), 10);
    assert.equal(percentile(values, 100), 20);
    assert.equal(percentile([5], 95), 5);
  });
  test('ignores input order and is null when empty', () => {
    assert.equal(percentile([3, 1, 2], 50), 2);
    assert.equal(percentile([], 95), null);
  });
});

describe('summarize', () => {
  const ok = (value, ms) => ({ status: 'success', value, metadata: { processingTimeMs: ms } });
  const fail = (code, ms) => ({ status: 'failure', code, metadata: { processingTimeMs: ms } });
  const samples = [
    { expectedText: 'hello world', result: ok('hello world', 10) },
    { expectedText: 'good day', result: ok('good dav', 20) },
    { expectedText: 'lost', result: fail('ENGINE_ERROR', 30) },
    { expectedText: '', result: ok('', 5) },
    { expectedText: '', result: ok('noise', 5) },
    { expectedError: 'CORRUPTED_IMAGE', result: fail('CORRUPTED_IMAGE', 1) },
    { expectedError: 'UNSUPPORTED_FORMAT', result: fail('CORRUPTED_IMAGE', 1) },
  ];

  test('computes every metric from totals', () => {
    const summary = summarize(samples);
    assert.equal(summary.samples, 7);
    assert.equal(summary.textSamples, 3);
    assert.equal(summary.cer, (0 + 1 + 4) / (11 + 8 + 4));
    assert.equal(summary.wer, (0 + 1 + 1) / (2 + 2 + 1));
    assert.equal(summary.exactMatch, 1 / 3);
    assert.equal(summary.processingErrorRate, 1 / 5);
    assert.equal(summary.falseTextRate, 1 / 2);
    assert.equal(summary.correctRejectionRate, 1 / 2);
    assert.equal(summary.meanMs, 72 / 7);
    assert.equal(summary.p95Ms, 30);
  });

  test('reports null instead of 0 when a metric has no samples', () => {
    const summary = summarize([]);
    for (const key of ['cer', 'wer', 'exactMatch', 'processingErrorRate', 'falseTextRate', 'correctRejectionRate', 'meanMs', 'p95Ms']) {
      assert.equal(summary[key], null, key);
    }
  });
});
