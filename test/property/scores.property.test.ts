// Property 17: Score range validation (schema part; applied to RiskInput, alerts, and views in phases 4 and 7)
// Validates: Requirements 10.7, 21.1, 21.2, 21.3, 21.4
// Traceability: AT-FIL-06, AT-VAL-01, AT-SEN-10
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FilingRiskScoreSchema, SentimentIndexSchema } from '../../src/shared/index.js';
import { compareFractions, decimalTextArb, fraction, parseDecimalText } from '../helpers/rational.js';

const ZERO = fraction(0n, 1n);
const ONE = fraction(1n, 1n);
const MINUS_ONE = fraction(-1n, 1n);

const within = (text: string, min: typeof ZERO, max: typeof ZERO): boolean => {
  const value = parseDecimalText(text);
  return compareFractions(value, min) >= 0 && compareFractions(value, max) <= 0;
};

/** Values concentrated around the score boundaries, plus general decimal text. */
const scoreTextArb = fc.oneof(
  decimalTextArb(3, 8),
  fc
    .tuple(
      fc.constantFrom('0', '-0', '1', '-1'),
      fc.string({ unit: fc.constantFrom('0', '1', '9'), minLength: 1, maxLength: 8 }),
    )
    .map(([whole, frac]) => `${whole}.${frac}`),
  fc.constantFrom('0', '1', '-1', '1.0', '-1.000', '1.0001', '-1.0000001', '0.5', '-0.6001'),
);

const invalidTextArb = fc.oneof(
  fc.constantFrom(
    'NaN',
    'Infinity',
    '-Infinity',
    '1e-1',
    '5E-1',
    '',
    ' 0.5',
    '0.5 ',
    '+0.5',
    '.5',
    '1.',
    '0,5',
  ),
  fc.string().filter((s) => !/^-?(0|[1-9]\d*)(\.\d+)?$/.test(s)),
);

describe('Property 17: Score range validation', () => {
  it('FilingRiskScore accepts exactly the decimals in [0, 1], unchanged', () => {
    fc.assert(
      fc.property(scoreTextArb, (text) => {
        const parsed = FilingRiskScoreSchema.safeParse(text);
        expect(parsed.success).toBe(within(text, ZERO, ONE));
        if (parsed.success) {
          expect(parsed.data).toBe(text);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('SentimentIndex accepts exactly the decimals in [-1, 1], unchanged', () => {
    fc.assert(
      fc.property(scoreTextArb, (text) => {
        const parsed = SentimentIndexSchema.safeParse(text);
        expect(parsed.success).toBe(within(text, MINUS_ONE, ONE));
        if (parsed.success) {
          expect(parsed.data).toBe(text);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('non-decimal text and JSON numbers are always rejected', () => {
    fc.assert(
      fc.property(fc.oneof(invalidTextArb, fc.double(), fc.integer()), (value) => {
        expect(FilingRiskScoreSchema.safeParse(value).success).toBe(false);
        expect(SentimentIndexSchema.safeParse(value).success).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });
});
