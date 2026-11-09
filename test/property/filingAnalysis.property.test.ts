// Property 17: Score range validation (filing part, task 21.1)
// Validates: Requirements 21.1, 21.3, 21.4, 7.2
// Traceability: AT-FIL-06
// For any provider output, the analyzer returns a score only when it is decimal text in [0, 1]
// (checked against an independent rational reference), and then exactly as received; any other
// output is NLP_FAILED (NLP_INVALID_OUTPUT) after one attempt, with no score and no clamping.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createFilingAnalyzer } from '../../src/nlp/index.js';
import { FilingText } from '../../src/shared/index.js';
import { drive, harness } from '../helpers/resilience.js';
import { compareFractions, decimalTextArb, fraction, parseDecimalText } from '../helpers/rational.js';

const ZERO = fraction(0n, 1n);
const ONE = fraction(1n, 1n);
const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

const inUnitInterval = (text: string): boolean => {
  if (!DECIMAL.test(text)) {
    return false;
  }
  const value = parseDecimalText(text);
  return compareFractions(value, ZERO) >= 0 && compareFractions(value, ONE) <= 0;
};

const scoreArb: fc.Arbitrary<unknown> = fc.oneof(
  decimalTextArb(3, 8),
  fc
    .tuple(
      fc.constantFrom('0', '-0', '1', '-1'),
      fc.string({ unit: fc.constantFrom('0', '1', '9'), minLength: 1, maxLength: 8 }),
    )
    .map(([whole, frac]) => `${whole}.${frac}`),
  fc.constantFrom('0', '1', '1.0', '0.5', '1.0001', '-0.0001', '1e-1', 'NaN', 'Infinity', ' 0.5', '.5'),
  fc.double(),
  fc.integer(),
  fc.constant(null),
);

describe('Property 17 (filing part): analyzer output scores', () => {
  it('a score is returned only when it is decimal text in [0, 1], unchanged; otherwise no score', async () => {
    await fc.assert(
      fc.asyncProperty(scoreArb, async (score) => {
        const h = harness();
        let calls = 0;
        const analyzer = createFilingAnalyzer({
          provider: {
            name: 'prop-nlp',
            analyzeFiling: () => {
              calls += 1;
              return Promise.resolve({
                ok: true,
                value: { score, categories: [], method: 'prop', methodVersion: '1' },
              });
            },
          },
          resilience: h.rc,
          clock: h.clock,
          settings: { timeoutMs: 60_000, maxRetries: 2 },
        });
        const result = await drive(h.sleeper, analyzer.analyze(FilingText.of('text')));
        const expectedValid = typeof score === 'string' && inUnitInterval(score);
        expect(result.ok).toBe(expectedValid);
        if (result.ok) {
          expect(result.value.analysis.score).toBe(score);
        } else {
          expect(result.error).toMatchObject({
            code: 'NLP_FAILED',
            cause: 'NLP_INVALID_OUTPUT',
            attempts: 1,
          });
          expect('value' in result).toBe(false);
        }
        expect(calls).toBe(1);
      }),
      { numRuns: 500 },
    );
  });
});
