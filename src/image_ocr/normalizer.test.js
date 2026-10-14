const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOcrText, summarizeWords } = require('./normalizer');

describe('normalizeOcrText', () => {
  const cases = [
    ['Hello world', 'Hello world'],
    ['  Hello   world  \n', 'Hello world'],
    ['Hello\tworld', 'Hello world'],
    ['Hello world', 'Hello world'],
    ['line one\r\nline two\rline three', 'line one\nline two\nline three'],
    ['first\n\n\n  \nsecond', 'first\nsecond'],
    ['page text\n\f', 'page text'],
    ['café', 'café'],
    ['Case, Punctuation! 42.50?', 'Case, Punctuation! 42.50?'],
    ['', ''],
    [' \n\f ', ''],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => assert.equal(normalizeOcrText(input), expected));
  }

  for (const input of [undefined, null, 42, {}]) {
    test(`non-string ${JSON.stringify(input)} becomes ''`, () => assert.equal(normalizeOcrText(input), ''));
  }
});

describe('summarizeWords', () => {
  test('keeps word confidences untouched and averages them', () => {
    assert.deepEqual(summarizeWords([{ text: 'a', confidence: 90.5 }, { text: 'b', confidence: 80 }]), {
      words: [{ text: 'a', confidence: 90.5 }, { text: 'b', confidence: 80 }],
      confidence: 85.25,
    });
  });

  test('ignores missing scores in the mean and reports them as null', () => {
    const result = summarizeWords([{ text: 'a', confidence: 60 }, { text: 'b' }, { text: 'c', confidence: Number.NaN }]);
    assert.equal(result.confidence, 60);
    assert.deepEqual(result.words.map((word) => word.confidence), [60, null, null]);
  });

  test('never invents a score when the engine gives none', () => {
    assert.equal(summarizeWords([{ text: 'a' }]).confidence, null);
    assert.deepEqual(summarizeWords([]), { words: [], confidence: null });
    assert.deepEqual(summarizeWords(undefined), { words: [], confidence: null });
  });

  test('drops empty or malformed words', () => {
    assert.deepEqual(summarizeWords([{ text: ' ', confidence: 10 }, null, { confidence: 5 }, { text: 'ok', confidence: 70 }]), {
      words: [{ text: 'ok', confidence: 70 }],
      confidence: 70,
    });
  });
});
