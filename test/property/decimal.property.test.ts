// Property 1: Decimal exactness
// Validates: Requirements 4.1, 4.2, 4.5, 30.4
// Property 2: Canonical decimal round trip
// Validates: Requirements 4.3, 4.6, 32.3
// Traceability: AT-DEC-01, AT-DEC-04, AT-DEC-07. Reference: BigInt fractions (test/helpers/rational.ts).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { d, DecimalInputError, toCanonical } from '../../src/shared/index.js';
import {
  addFractions,
  decimalTextArb,
  equalFractions,
  fraction,
  parseDecimalText,
} from '../helpers/rational.js';

const RUNS = { numRuns: 1000 };

describe('Property 1: Decimal exactness', () => {
  it('the sum of any list of decimal strings equals the exact rational sum', () => {
    fc.assert(
      fc.property(fc.array(decimalTextArb(), { maxLength: 50 }), (values) => {
        const total = values.reduce((acc, value) => acc.plus(d(value)), d('0'));
        const reference = values.reduce(
          (acc, value) => addFractions(acc, parseDecimalText(value)),
          fraction(0n, 1n),
        );
        expect(equalFractions(parseDecimalText(toCanonical(total)), reference)).toBe(true);
      }),
      RUNS,
    );
  });

  it('adding "0.1" ten thousand times yields exactly "1000"', () => {
    let total = d('0');
    for (let i = 0; i < 10_000; i += 1) {
      total = total.plus(d('0.1'));
    }
    expect(toCanonical(total)).toBe('1000');
  });
});

describe('Property 2: Canonical decimal round trip', () => {
  const canonicalShape = /^-?(0|[1-9]\d*)(\.\d*[1-9])?$/;

  it('toCanonical(d(toCanonical(x))) equals toCanonical(x), with no exponent, trailing zero, or -0', () => {
    fc.assert(
      fc.property(decimalTextArb(), (text) => {
        const canonical = toCanonical(d(text));
        expect(toCanonical(d(canonical))).toBe(canonical);
        expect(canonical).toMatch(canonicalShape);
        expect(canonical).not.toBe('-0');
        expect(canonical).not.toMatch(/[eE]/);
        expect(equalFractions(parseDecimalText(canonical), parseDecimalText(text))).toBe(true);
      }),
      RUNS,
    );
  });

  it('serializing then parsing a JSON payload preserves the string exactly', () => {
    fc.assert(
      fc.property(fc.array(decimalTextArb(), { maxLength: 20 }), (values) => {
        const payload = { values: values.map((value) => toCanonical(d(value))) };
        const parsed = JSON.parse(JSON.stringify(payload)) as { values: string[] };
        expect(parsed.values).toEqual(payload.values);
      }),
      RUNS,
    );
  });

  it('text containing exponent notation is always rejected', () => {
    fc.assert(
      fc.property(
        decimalTextArb(6, 6),
        fc.constantFrom('e', 'E'),
        fc.integer({ min: -30, max: 30 }),
        (text, marker, exponent) => {
          expect(() => d(`${text}${marker}${exponent}`)).toThrow(DecimalInputError);
        },
      ),
      RUNS,
    );
  });
});
