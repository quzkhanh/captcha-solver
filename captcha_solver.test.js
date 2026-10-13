const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { solve, Status, ErrorCode, TEST_KEYS } = require('./captcha_solver');

const originalEnv = process.env.NODE_ENV;

function setEnv(value) {
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
}

afterEach(() => setEnv(originalEnv));

describe('solve: type dispatch', () => {
  for (const type of ['audio', 'reCAPTCHA', '', 'constructor', '__proto__', 'toString']) {
    test(`unknown type "${type}" is unsupported`, async () => {
      const result = await solve(type, { challenge: 'What is 1 + 1?' });
      assert.equal(result.status, Status.UNSUPPORTED);
      assert.equal(result.type, type);
      assert.match(result.error, /Unsupported CAPTCHA type/);
      assert.equal(result.value, undefined);
    });
  }

  for (const type of [undefined, null, 42, {}, ['text']]) {
    test(`non-string type ${JSON.stringify(type)} is unsupported`, async () => {
      const result = await solve(type);
      assert.equal(result.status, Status.UNSUPPORTED);
    });
  }
});

async function assertTextSuccess(challenge, expected) {
  assert.deepEqual(await solve('text', { challenge }), {
    status: Status.SUCCESS,
    type: 'text',
    value: expected,
  });
}

async function assertTextFailure(challenge, code, message) {
  const result = await solve('text', { challenge });
  assert.equal(result.status, Status.FAILURE);
  assert.equal(result.type, 'text');
  assert.equal(result.code, code);
  assert.match(result.error, message);
  assert.equal(result.value, undefined);
}

describe('solve: text arithmetic', () => {
  const cases = [
    ['What is 5 + 3?', '8'],
    ['What is 10 - 4?', '6'],
    ['What is 6 * 7?', '42'],
    ['What is 7 / 2?', '3.5'],
    ['What is -2 + 3?', '1'],
    ['What is 5 - -3?', '8'],
    ['  what IS 2+2?  ', '4'],
    ['What is 007 + 1?', '8'],
    // Precedence and associativity
    ['What is 2 + 3 * 4?', '14'],
    ['What is 2 * 3 + 4?', '10'],
    ['What is 10 - 4 - 3?', '3'],
    ['What is 64 / 4 / 2?', '8'],
    ['What is 2 + 12 / 4 * 3?', '11'],
    // Parentheses
    ['What is (2 + 3) * 4?', '20'],
    ['What is 2 * (3 + (4 - 1)) / 3?', '4'],
    ['What is ((((7))))?', '7'],
    ['What is (1 + (2 * (3 + (4 * (5 - 6)))))?', '-1'],
    // Negative numbers
    ['What is 2 * -3?', '-6'],
    ['What is -(2 + 3)?', '-5'],
    ['What is - -3?', '3'],
    ['What is -3 * -3?', '9'],
    ['What is 0 * -1?', '0'],
    // Decimals: exact, no binary floating point drift, no rounding
    ['What is 1.5 + 2?', '3.5'],
    ['What is 0.1 + 0.2?', '0.3'],
    ['What is -2.5 * 2?', '-5'],
    ['What is 1 / 8?', '0.125'],
    ['What is -1 / 4?', '-0.25'],
    ['What is -0.5 + 0.5?', '0'],
    ['What is 1.10 + 0?', '1.1'],
    ['What is 0.000001 * 0.000001?', '0.000000000001'],
    // Large values that stay exact
    ['What is 9007199254740991?', '9007199254740991'],
    ['What is -9007199254740991?', '-9007199254740991'],
    ['What is 9007199254740991 * 2 / 2?', '9007199254740991'],
  ];
  for (const [challenge, expected] of cases) {
    test(`"${challenge}" -> "${expected}"`, () => assertTextSuccess(challenge, expected));
  }

  describe('division by zero', () => {
    for (const challenge of ['What is 5 / 0?', 'What is 0 / 0?', 'What is 1 / (2 - 2)?', 'What is 1 / 0.0?', 'What is 1 / -0?']) {
      test(`"${challenge}" fails`, () => assertTextFailure(challenge, ErrorCode.DIVISION_BY_ZERO, /Division by zero/));
    }
  });

  describe('values outside the safe integer range', () => {
    for (const challenge of ['What is 99999999999999999999 * 2?', 'What is 9007199254740992 - 1?', 'What is 9007199254740991.5 * 0?']) {
      test(`operand in "${challenge}" fails`, () => assertTextFailure(challenge, ErrorCode.OUT_OF_RANGE, /Operand exceeds the safe integer range/));
    }
    for (const challenge of [
      'What is 9007199254740991 * 9007199254740991?',
      'What is 9007199254740991 + 1?',
      'What is -9007199254740991 - 1?',
      'What is 9007199254740991 + 0.5?',
      'What is 1 / 0.0000000000000001?',
    ]) {
      test(`result of "${challenge}" fails`, () => assertTextFailure(challenge, ErrorCode.OUT_OF_RANGE, /Result exceeds the safe integer range/));
    }
  });

  describe('results that cannot be represented exactly', () => {
    for (const challenge of ['What is 1 / 3?', 'What is 2 / 3?', 'What is 10 / 7?', 'What is 1 / 6 * 2?']) {
      test(`"${challenge}" fails instead of rounding`, () => assertTextFailure(challenge, ErrorCode.INEXACT_RESULT, /non-terminating/));
    }
    for (const [challenge, expected] of [['What is 1 / 3 * 3?', '1'], ['What is 1 / 6 * 3?', '0.5']]) {
      test(`non-terminating intermediate in "${challenge}" resolves exactly to "${expected}"`, () => assertTextSuccess(challenge, expected));
    }
  });

  describe('malformed expressions', () => {
    for (const challenge of [
      'What is 2 +?',
      'What is * 3?',
      'What is (2 + 3?',
      'What is 2 + 3)?',
      'What is (2 + 3))?',
      'What is 2 3?',
      'What is 1.2.3?',
      'What is .5 + 1?',
      'What is 5. + 1?',
      'What is 2 ** 3?',
      'What is +3?',
      'What is 1 + + 2?',
      'What is 2 (3)?',
      'What is (1 + 2)(3)?',
    ]) {
      test(`"${challenge}" is rejected`, () => assertTextFailure(challenge, ErrorCode.INVALID_EXPRESSION, /./));
    }
  });
});

describe('solve: text reverse', () => {
  const cases = [
    ["Reverse the word 'hello'", 'olleh'],
    ["reverse the word 'Hello'.", 'olleH'],
    ["Reverse the word 'xin chào'", 'oàhc nix'],
    ["Reverse the word 'a😀b'", 'b😀a'],
    ['Reverse the word ‘hello’', 'olleh'],
    ['REVERSE THE WORD ‘Hello’.', 'olleH'],
    ["Reverse the word ‘don't’", "t'nod"],
    ["Reverse the word ' a  b '", ' b  a '],
    // NFC input stays NFC
    ["Reverse the word 'ch\u00e0o'", 'o\u00e0hc'],
    // NFD input stays NFD, combining marks stay on their base letter
    ["Reverse the word 'cafe\u0301'", 'e\u0301fac'],
    ["Reverse the word 'cha\u0300o'", 'oa\u0300hc'],
    ["Reverse the word 'Vie\u0302\u0323t'", 'te\u0302\u0323iV'],
    // ZWJ sequences, skin tones and flags are single graphemes
    ["Reverse the word '👨‍👩‍👧'", '👨‍👩‍👧'],
    ["Reverse the word 'a👨‍👩‍👧b'", 'b👨‍👩‍👧a'],
    ["Reverse the word '👍🏽x'", 'x👍🏽'],
    ["Reverse the word '🇻🇳🇺🇸'", '🇺🇸🇻🇳'],
  ];
  for (const [challenge, expected] of cases) {
    test(`${JSON.stringify(challenge)} -> ${JSON.stringify(expected)}`, () => assertTextSuccess(challenge, expected));
  }
});

describe('solve: text unsupported instructions', () => {
  for (const challenge of [
    'What is 5 % 3?',
    'What is 2 ^ 3?',
    'What is five plus three?',
    'What is ()?',
    'What is ?',
    'What is (1)?(2)?',
    'What is 5 + 3',
    'Please solve: What is 5 + 3? Now',
    'Reverse the word hello',
    "Reverse the word ''",
    'Reverse the word ‘’',
    "Reverse the word 'hello’",
    'Reverse the word ‘hello\'',
    'Reverse the word "hello"',
    "Reverse the word 'it's'",
    'Type the letters you see',
  ]) {
    test(`${JSON.stringify(challenge)} fails without a fake answer`, () =>
      assertTextFailure(challenge, ErrorCode.UNRECOGNIZED_CHALLENGE, /^Unrecognized text challenge$/));
  }
});

describe('solve: text input validation', () => {
  for (const input of [undefined, null, {}, [], { challenge: '' }, { challenge: '   ' }, { challenge: 42 }, { challenge: ['What is 1 + 1?'] }, 'What is 1 + 1?']) {
    test(`malformed input ${JSON.stringify(input)} fails`, async () => {
      const result = await solve('text', input);
      assert.equal(result.status, Status.FAILURE);
      assert.equal(result.code, ErrorCode.INVALID_INPUT);
      assert.match(result.error, /input\.challenge must be a non-empty string/);
    });
  }

  test('overlong challenge fails before parsing', async () => {
    const result = await solve('text', { challenge: `What is ${'1 + '.repeat(100)}1?` });
    assert.equal(result.status, Status.FAILURE);
    assert.equal(result.code, ErrorCode.INVALID_INPUT);
    assert.match(result.error, /at most \d+ characters/);
  });
});

describe('solve: image', () => {
  for (const input of [undefined, { image: Buffer.from('png') }, 'captcha.png']) {
    test(`is unsupported for input ${JSON.stringify(input)}`, async () => {
      const result = await solve('image', input);
      assert.equal(result.status, Status.UNSUPPORTED);
      assert.match(result.error, /not implemented/);
    });
  }
});

describe('solve: widget providers', () => {
  beforeEach(() => setEnv('development'));

  test('hCaptcha test site keys return the documented response tokens', async () => {
    for (const [siteKey, { token }] of Object.entries(TEST_KEYS.hcaptcha.siteKeys)) {
      assert.deepEqual(await solve('hcaptcha', { siteKey }), {
        status: Status.SUCCESS,
        type: 'hcaptcha',
        value: token,
      });
    }
  });

  test('Turnstile passing test site keys return the dummy token', async () => {
    for (const siteKey of ['1x00000000000000000000AA', '1x00000000000000000000BB']) {
      const result = await solve('turnstile', { siteKey });
      assert.equal(result.status, Status.SUCCESS);
      assert.equal(result.value, 'XXXX.DUMMY.TOKEN.XXXX');
    }
  });

  test('Turnstile always-fail test site keys fail', async () => {
    for (const siteKey of ['2x00000000000000000000AB', '2x00000000000000000000BB']) {
      const result = await solve('turnstile', { siteKey });
      assert.equal(result.status, Status.FAILURE);
      assert.match(result.error, /always fail/);
    }
  });

  test('Turnstile interactive test site key is unsupported', async () => {
    const result = await solve('turnstile', { siteKey: '3x00000000000000000000FF' });
    assert.equal(result.status, Status.UNSUPPORTED);
    assert.match(result.error, /interactive/);
  });

  test('reCAPTCHA test site key is unsupported because no test token exists', async () => {
    const result = await solve('recaptcha', { siteKey: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI' });
    assert.equal(result.status, Status.UNSUPPORTED);
    assert.match(result.error, /no fixed test response token/);
    assert.equal(result.value, undefined);
  });

  for (const type of ['recaptcha', 'hcaptcha', 'turnstile']) {
    test(`${type}: real or unknown site key is unsupported`, async () => {
      for (const siteKey of ['6Lc_real_production_key', '__proto__', 'constructor']) {
        const result = await solve(type, { siteKey });
        assert.equal(result.status, Status.UNSUPPORTED);
        assert.match(result.error, /official .* test site keys/);
      }
    });

    test(`${type}: another provider's test key is unsupported`, async () => {
      const other = type === 'hcaptcha' ? '1x00000000000000000000AA' : '10000000-ffff-ffff-ffff-000000000001';
      const result = await solve(type, { siteKey: other });
      assert.equal(result.status, Status.UNSUPPORTED);
    });

    test(`${type}: malformed input fails`, async () => {
      for (const input of [undefined, null, {}, { siteKey: '' }, { siteKey: 123 }, 'site-key']) {
        const result = await solve(type, input);
        assert.equal(result.status, Status.FAILURE);
        assert.match(result.error, /input\.siteKey/);
      }
    });

    test(`${type}: test keys are refused outside test environments`, async () => {
      const siteKey = Object.keys(TEST_KEYS[type].siteKeys)[0];
      for (const env of ['production', 'Development', '', undefined]) {
        setEnv(env);
        const result = await solve(type, { siteKey });
        assert.equal(result.status, Status.UNSUPPORTED);
        assert.match(result.error, /NODE_ENV/);
      }
    });
  }

  test('works in every allowed environment', async () => {
    for (const env of ['development', 'test', 'staging']) {
      setEnv(env);
      const result = await solve('turnstile', { siteKey: '1x00000000000000000000AA' });
      assert.equal(result.status, Status.SUCCESS);
    }
  });
});

describe('TEST_KEYS', () => {
  test('is deeply frozen', () => {
    assert.ok(Object.isFrozen(TEST_KEYS));
    assert.ok(Object.isFrozen(TEST_KEYS.hcaptcha.siteKeys));
    assert.ok(Object.isFrozen(TEST_KEYS.turnstile.secretKeys));
  });

  test('exposes the documented secret keys for server-side configuration', () => {
    assert.equal(TEST_KEYS.recaptcha.secretKey, '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe');
    assert.equal(TEST_KEYS.hcaptcha.secretKey, '0x0000000000000000000000000000000000000000');
    assert.equal(TEST_KEYS.turnstile.secretKeys.alwaysPasses, '1x0000000000000000000000000000000AA');
  });
});
