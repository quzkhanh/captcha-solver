/**
 * CAPTCHA helper for development/staging environments.
 *
 * Every call resolves to { status, type, value } on success or
 * { status, type, error } otherwise; text and image failures also carry an error code in `code`.
 * Results are never fabricated: anything that cannot be handled reports FAILURE or UNSUPPORTED.
 */

const Status = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  UNSUPPORTED: 'unsupported',
});

const ErrorCode = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  UNRECOGNIZED_CHALLENGE: 'UNRECOGNIZED_CHALLENGE',
  INVALID_EXPRESSION: 'INVALID_EXPRESSION',
  DIVISION_BY_ZERO: 'DIVISION_BY_ZERO',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  INEXACT_RESULT: 'INEXACT_RESULT',
  NO_TEXT_DETECTED: 'NO_TEXT_DETECTED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

const MAX_CHALLENGE_LENGTH = 256;

const TEST_ENVIRONMENTS = Object.freeze(['development', 'test', 'staging']);

const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

// Official test keys, copied from the providers' documentation:
// https://developers.google.com/recaptcha/docs/faq
// https://docs.hcaptcha.com/#integration-testing-test-keys
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
// Each site key maps to the outcome its widget produces: { token }, { failure } or { unsupported }.
const TEST_KEYS = deepFreeze({
  recaptcha: {
    secretKey: '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe',
    siteKeys: {
      '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI': {
        unsupported: 'Google publishes no fixed test response token; with the test secret key every siteverify request passes',
      },
    },
  },
  hcaptcha: {
    secretKey: '0x0000000000000000000000000000000000000000',
    siteKeys: {
      '10000000-ffff-ffff-ffff-000000000001': { token: '10000000-aaaa-bbbb-cccc-000000000001' },
      '20000000-ffff-ffff-ffff-000000000002': { token: '20000000-aaaa-bbbb-cccc-000000000002' },
      '30000000-ffff-ffff-ffff-000000000003': { token: '30000000-aaaa-bbbb-cccc-000000000003' },
    },
  },
  turnstile: {
    secretKeys: {
      alwaysPasses: '1x0000000000000000000000000000000AA',
      alwaysFails: '2x0000000000000000000000000000000AA',
      tokenAlreadySpent: '3x0000000000000000000000000000000AA',
    },
    siteKeys: {
      '1x00000000000000000000AA': { token: TURNSTILE_DUMMY_TOKEN },
      '1x00000000000000000000BB': { token: TURNSTILE_DUMMY_TOKEN },
      '2x00000000000000000000AB': { failure: 'Test site key is configured to always fail' },
      '2x00000000000000000000BB': { failure: 'Test site key is configured to always fail' },
      '3x00000000000000000000FF': { unsupported: 'Test site key forces an interactive challenge' },
    },
  },
});

const MATH_CHALLENGE = /^what\s+is\s+(.+?)\s*\?$/i;
// Only bodies made purely of arithmetic characters are parsed; anything else is not an arithmetic challenge.
const ARITHMETIC_BODY = /^[\d.+\-*/()\s]*\d[\d.+\-*/()\s]*$/;
const ARITHMETIC_TOKEN = /\d+(?:\.\d+)?|\S/g;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const REVERSE_CHALLENGE = /^reverse\s+the\s+word\s+(?:'([^']+)'|‘([^’]+)’)\.?$/i;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const HANDLERS = {
  text: solveText,
  image: solveImage,
  recaptcha: (input) => solveWithTestKey('recaptcha', input),
  hcaptcha: (input) => solveWithTestKey('hcaptcha', input),
  turnstile: (input) => solveWithTestKey('turnstile', input),
};

/**
 * @param {string} type - One of: text, image, recaptcha, hcaptcha, turnstile
 * @param {{challenge?: string, siteKey?: string, image?: Buffer | Uint8Array | string}} [input]
 * @returns {Promise<{status: string, type: *, value?: string, code?: string, error?: string}>}
 */
async function solve(type, input) {
  if (typeof type !== 'string' || !Object.hasOwn(HANDLERS, type)) {
    return { status: Status.UNSUPPORTED, type, error: `Unsupported CAPTCHA type: ${String(type)}` };
  }
  const [status, detail, code] = await HANDLERS[type](input);
  if (status === Status.SUCCESS) return { status, type, value: detail };
  return code ? { status, type, code, error: detail } : { status, type, error: detail };
}

function solveText(input) {
  const challenge = input?.challenge;
  if (typeof challenge !== 'string' || !challenge.trim()) {
    return [Status.FAILURE, 'input.challenge must be a non-empty string', ErrorCode.INVALID_INPUT];
  }
  if (challenge.length > MAX_CHALLENGE_LENGTH) {
    return [Status.FAILURE, `input.challenge must be at most ${MAX_CHALLENGE_LENGTH} characters`, ErrorCode.INVALID_INPUT];
  }
  const text = challenge.trim();

  const math = text.match(MATH_CHALLENGE);
  if (math && ARITHMETIC_BODY.test(math[1])) {
    try {
      return [Status.SUCCESS, formatExact(evaluateArithmetic(math[1]))];
    } catch (error) {
      if (error instanceof ChallengeError) return [Status.FAILURE, error.message, error.code];
      throw error;
    }
  }

  const reverse = text.match(REVERSE_CHALLENGE);
  if (reverse) {
    const word = reverse[1] ?? reverse[2];
    return [Status.SUCCESS, Array.from(GRAPHEMES.segment(word), ({ segment }) => segment).reverse().join('')];
  }

  return [Status.FAILURE, 'Unrecognized text challenge', ErrorCode.UNRECOGNIZED_CHALLENGE];
}

class ChallengeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Recursive descent over exact BigInt fractions, so no binary floating point error is introduced:
//   expression := term (('+' | '-') term)*
//   term       := unary (('*' | '/') unary)*
//   unary      := '-' unary | primary
//   primary    := number | '(' expression ')'
function evaluateArithmetic(source) {
  const tokens = source.match(ARITHMETIC_TOKEN) ?? [];
  let position = 0;
  const peek = () => tokens[position];
  const invalid = (message) => new ChallengeError(ErrorCode.INVALID_EXPRESSION, message);

  function expression() {
    let value = term();
    while (peek() === '+' || peek() === '-') {
      const operator = tokens[position++];
      const right = term();
      value = fraction(value.n * right.d + (operator === '+' ? right.n : -right.n) * value.d, value.d * right.d);
    }
    return value;
  }

  function term() {
    let value = unary();
    while (peek() === '*' || peek() === '/') {
      const operator = tokens[position++];
      const right = unary();
      value = operator === '*'
        ? fraction(value.n * right.n, value.d * right.d)
        : fraction(value.n * right.d, value.d * right.n);
    }
    return value;
  }

  function unary() {
    if (peek() !== '-') return primary();
    position++;
    const value = unary();
    return { n: -value.n, d: value.d };
  }

  function primary() {
    const token = tokens[position++];
    if (token === '(') {
      const value = expression();
      if (tokens[position++] !== ')') throw invalid('Missing closing parenthesis');
      return value;
    }
    if (token === undefined) throw invalid('Unexpected end of expression');
    if (!/^\d/.test(token)) throw invalid(`Unexpected token '${token}'`);
    const [whole, decimals = ''] = token.split('.');
    const value = fraction(BigInt(whole + decimals), 10n ** BigInt(decimals.length));
    if (exceedsSafeRange(value)) {
      throw new ChallengeError(ErrorCode.OUT_OF_RANGE, 'Operand exceeds the safe integer range');
    }
    return value;
  }

  const result = expression();
  if (position < tokens.length) throw invalid(`Unexpected token '${peek()}'`);
  if (exceedsSafeRange(result)) {
    throw new ChallengeError(ErrorCode.OUT_OF_RANGE, 'Result exceeds the safe integer range');
  }
  return result;
}

function fraction(n, d) {
  if (d === 0n) throw new ChallengeError(ErrorCode.DIVISION_BY_ZERO, 'Division by zero');
  const sign = d < 0n ? -1n : 1n;
  let [a, b] = [n < 0n ? -n : n, d < 0n ? -d : d];
  while (b) [a, b] = [b, a % b];
  return { n: (sign * n) / a, d: (sign * d) / a };
}

function exceedsSafeRange({ n, d }) {
  return (n < 0n ? -n : n) > MAX_SAFE * d;
}

// Prints the fraction as an exact decimal. Fractions whose denominator has a prime factor other than 2 or 5
// have no finite decimal form, and no rounding rule is defined, so they are rejected.
function formatExact({ n, d }) {
  let rest = d;
  let places = 0;
  for (const factor of [2n, 5n]) {
    let count = 0;
    while (rest % factor === 0n) {
      rest /= factor;
      count++;
    }
    places = Math.max(places, count);
  }
  if (rest !== 1n) {
    throw new ChallengeError(ErrorCode.INEXACT_RESULT, 'Result is a non-terminating decimal and no rounding rule is defined');
  }
  const scaled = (n * 10n ** BigInt(places)) / d;
  const digits = (scaled < 0n ? -scaled : scaled).toString().padStart(places + 1, '0');
  const sign = scaled < 0n ? '-' : '';
  return places ? `${sign}${digits.slice(0, -places)}.${digits.slice(-places)}` : `${sign}${digits}`;
}

// input.image is passed to the OCR module unchanged; it validates the bytes or file path itself.
async function solveImage(input) {
  if (!isTestEnvironment()) return notInTestEnvironment();
  let result;
  try {
    // Required lazily so the other handlers keep working when sharp is not installed.
    result = await require('./image_ocr').recognizeImage(input?.image);
  } catch {
    return [Status.FAILURE, 'The OCR module could not run', ErrorCode.INTERNAL_ERROR];
  }
  if (result.status !== Status.SUCCESS) return [Status.FAILURE, result.error, result.code];
  if (!result.metadata.textDetected) return [Status.FAILURE, 'No text was detected in the image', ErrorCode.NO_TEXT_DETECTED];
  return [Status.SUCCESS, result.value];
}

function solveWithTestKey(provider, input) {
  const siteKey = input?.siteKey;
  if (typeof siteKey !== 'string' || !siteKey) {
    return [Status.FAILURE, 'input.siteKey must be a non-empty string'];
  }
  if (!isTestEnvironment()) return notInTestEnvironment();
  const siteKeys = TEST_KEYS[provider].siteKeys;
  if (!Object.hasOwn(siteKeys, siteKey)) {
    return [Status.UNSUPPORTED, `Only official ${provider} test site keys are supported`];
  }
  const outcome = siteKeys[siteKey];
  if (outcome.token) return [Status.SUCCESS, outcome.token];
  if (outcome.failure) return [Status.FAILURE, outcome.failure];
  return [Status.UNSUPPORTED, outcome.unsupported];
}

function isTestEnvironment() {
  return TEST_ENVIRONMENTS.includes(process.env.NODE_ENV);
}

function notInTestEnvironment() {
  return [Status.UNSUPPORTED, `Only available when NODE_ENV is one of: ${TEST_ENVIRONMENTS.join(', ')}`];
}

function deepFreeze(object) {
  Object.values(object).forEach((value) => {
    if (typeof value === 'object') deepFreeze(value);
  });
  return Object.freeze(object);
}

module.exports = { solve, Status, ErrorCode, TEST_KEYS, TEST_ENVIRONMENTS };
