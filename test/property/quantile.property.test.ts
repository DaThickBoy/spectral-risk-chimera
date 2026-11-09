// Property 3: Quantile correctness and bounds
// Validates: Requirements 14.2, 14.7
// Traceability: FR-7; AT-VAR-01, AT-VAR-02, AT-VAR-05, AT-VAR-06. Reference: BigInt
// fractions (test/helpers/rational.ts), rounding each operation to 40 significant
// digits half away from zero as FR-14 prescribes (test/helpers/positionReference.ts).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type7Quantile } from '../../src/risk/index.js';
import { d, toCanonical } from '../../src/shared/index.js';
import type { Decimal } from '../../src/shared/index.js';
import { roundSignificant as R } from '../helpers/positionReference.js';
import type { Fraction } from '../helpers/rational.js';
import {
  addFractions,
  compareFractions,
  decimalTextArb,
  equalFractions,
  fraction,
  parseDecimalText,
} from '../helpers/rational.js';

const RUNS = { numRuns: 500 };

const ONE = fraction(1n, 1n);
const add = (a: Fraction, b: Fraction): Fraction => R(addFractions(a, b));
const sub = (a: Fraction, b: Fraction): Fraction => R(addFractions(a, fraction(-b.num, b.den)));
const mul = (a: Fraction, b: Fraction): Fraction => R(fraction(a.num * b.num, a.den * b.den));
/** Floor of a non-negative fraction, as an integer. */
const floor = (a: Fraction): bigint => a.num / a.den;

/** Independent restatement of FR-7 on exact fractions. */
function referenceQuantile(texts: readonly string[], pText: string): Fraction {
  const xs = texts.map(parseDecimalText).sort(compareFractions);
  const n = xs.length;
  const h = add(ONE, mul(fraction(BigInt(n - 1), 1n), parseDecimalText(pText)));
  const j = floor(h);
  const at = (i: bigint): Fraction => {
    const value = xs[Number(i) - 1];
    if (value === undefined) {
      throw new Error('index out of range');
    }
    return value;
  };
  if (j >= BigInt(n)) {
    return at(BigInt(n));
  }
  const gamma = sub(h, fraction(j, 1n));
  if (gamma.num === 0n) {
    return at(j);
  }
  return add(mul(sub(ONE, gamma), at(j)), mul(gamma, at(j + 1n)));
}

function implementation(texts: readonly string[], pText: string): Decimal {
  const result = type7Quantile(
    texts.map((text) => d(text)),
    d(pText),
  );
  if (!result.ok) {
    throw new Error(`unexpected ${result.error.code}`);
  }
  return result.value;
}

const asFraction = (value: Decimal): Fraction => parseDecimalText(toCanonical(value));

/** Probabilities strictly between 0 and 1 with up to 4 decimals. */
const probability = fc.integer({ min: 1, max: 9999 }).map((k) => `0.${String(k).padStart(4, '0')}`);
const lossList = fc.array(decimalTextArb(8, 6), { minLength: 2, maxLength: 300 });

describe('Property 3: quantile correctness and bounds', () => {
  it('equals the rational reference (1 - gamma) * x[j] + gamma * x[j + 1]', () => {
    fc.assert(
      fc.property(lossList, probability, (texts, p) => {
        expect(equalFractions(asFraction(implementation(texts, p)), referenceQuantile(texts, p))).toBe(true);
      }),
      RUNS,
    );
  });

  it('stays within x[1] <= Q(p) <= x[n]', () => {
    fc.assert(
      fc.property(lossList, probability, (texts, p) => {
        const q = asFraction(implementation(texts, p));
        const xs = texts.map(parseDecimalText).sort(compareFractions);
        const [first] = xs;
        const last = xs.at(-1);
        expect(first !== undefined && compareFractions(first, q) <= 0).toBe(true);
        expect(last !== undefined && compareFractions(q, last) <= 0).toBe(true);
      }),
      RUNS,
    );
  });

  it('is non-decreasing in p', () => {
    fc.assert(
      fc.property(lossList, probability, probability, (texts, a, b) => {
        const [low, high] = compareFractions(parseDecimalText(a), parseDecimalText(b)) <= 0 ? [a, b] : [b, a];
        expect(implementation(texts, low).lessThanOrEqualTo(implementation(texts, high))).toBe(true);
      }),
      RUNS,
    );
  });

  it('when h is an integer, Q(p) = x[h] exactly', () => {
    // n - 1 divides 10^6, so p = k / (n - 1) is an exact decimal and h = 1 + k is an integer.
    const divisors = [2, 4, 5, 8, 10, 16, 20, 25, 32, 40, 50, 64, 80, 100, 125, 160, 200, 250];
    const integerCase = fc
      .constantFrom(...divisors)
      .chain((m) =>
        fc.tuple(
          fc.constant(m),
          fc.integer({ min: 1, max: m - 1 }),
          fc.array(decimalTextArb(8, 6), { minLength: m + 1, maxLength: m + 1 }),
        ),
      );
    fc.assert(
      fc.property(integerCase, ([m, k, texts]) => {
        const p = `0.${String(k * (1_000_000 / m)).padStart(6, '0')}`;
        const xs = texts.map(parseDecimalText).sort(compareFractions);
        const expected = xs[k]; // x[h] with h = 1 + k, one-based
        expect(expected).toBeDefined();
        if (expected !== undefined) {
          expect(equalFractions(asFraction(implementation(texts, p)), expected)).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it('does not depend on the input order', () => {
    fc.assert(
      fc.property(
        lossList.chain((texts) =>
          fc.tuple(fc.constant(texts), fc.shuffledSubarray(texts, { minLength: texts.length })),
        ),
        probability,
        ([texts, shuffled], p) => {
          expect(implementation(shuffled, p).equals(implementation(texts, p))).toBe(true);
        },
      ),
      RUNS,
    );
  });
});
