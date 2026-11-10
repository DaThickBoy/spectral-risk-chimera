// Property: Loss histogram exactness (Kiroween decision A2)
// Validates: Requirements 14.7, 4.4, 35.1
// Kiroween decision A2: binding items two and four to nine.
// Reference: BigInt fractions (test/helpers/rational.ts), no Decimal.js. For random losses,
// bucket counts K and currency minor units m it checks: the width is the smallest multiple of
// 10^-m covering the span in K buckets (one minor unit when the span is 0); each bucket count
// equals the reference count under lower-inclusive / upper-exclusive buckets with a closed last
// bucket; the counts sum to n; the marker is the engine's unrounded Type 7 quantile, its bucket
// and its strict "above" count match the reference; the plotting position is the reference
// ratio rounded half up to 6 decimals; and the result does not depend on the input order.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lossHistogram, type7Quantile } from '../../src/risk/index.js';
import type { LossHistogram } from '../../src/risk/index.js';
import { d, toCanonical } from '../../src/shared/index.js';
import type { Decimal } from '../../src/shared/index.js';
import type { Fraction } from '../helpers/rational.js';
import {
  addFractions,
  compareFractions,
  decimalTextArb,
  equalFractions,
  fraction,
  parseDecimalText,
} from '../helpers/rational.js';

const RUNS = { numRuns: 300 };

const sub = (a: Fraction, b: Fraction): Fraction => addFractions(a, fraction(-b.num, b.den));
const mulInt = (a: Fraction, k: bigint): Fraction => fraction(a.num * k, a.den);
/** Floor of a non-negative fraction. */
const floorNonNeg = (a: Fraction): bigint => a.num / a.den;
/** Ceil of a non-negative fraction. */
const ceilNonNeg = (a: Fraction): bigint => (a.num + a.den - 1n) / a.den;

interface Reference {
  readonly width: Fraction;
  readonly counts: readonly number[];
  readonly bucketOf: (x: Fraction) => number;
  readonly min: Fraction;
}

function reference(texts: readonly string[], k: number, m: number): Reference {
  const xs = texts.map(parseDecimalText);
  const sorted = [...xs].sort(compareFractions);
  const min = sorted[0] ?? fraction(0n, 1n);
  const max = sorted.at(-1) ?? fraction(0n, 1n);
  const scale = 10n ** BigInt(m);
  const span = sub(max, min);
  // width units = ceil(span * 10^m / K); one unit when the span is zero.
  const units = span.num === 0n ? 1n : ceilNonNeg(fraction(span.num * scale, span.den * BigInt(k)));
  const width = fraction(units, scale);
  const bucketOf = (x: Fraction): number => {
    const offset = sub(x, min);
    const i = floorNonNeg(fraction(offset.num * width.den, offset.den * width.num));
    return Number(i > BigInt(k - 1) ? BigInt(k - 1) : i);
  };
  const counts = Array.from({ length: k }, () => 0);
  for (const x of xs) {
    const i = bucketOf(x);
    counts[i] = (counts[i] ?? 0) + 1;
  }
  return { width, counts, bucketOf, min };
}

/** Half-up rounding of a non-negative fraction to 6 decimals, as canonical text. */
function roundHalfUp6(a: Fraction): string {
  const scaled = (2n * a.num * 1_000_000n + a.den) / (2n * a.den);
  return toCanonical(
    d(`${(scaled / 1_000_000n).toString()}.${(scaled % 1_000_000n).toString().padStart(6, '0')}`),
  );
}

const lossesArb = fc.array(decimalTextArb(6, 6), { minLength: 2, maxLength: 60 });
const kArb = fc.integer({ min: 1, max: 25 });
const mArb = fc.integer({ min: 0, max: 4 });
const pArb = fc.constantFrom('0.5', '0.9', '0.95', '0.975', '0.99', '0.01', '0.123');

function compute(texts: readonly string[], k: number, m: number, p: string): LossHistogram {
  const result = lossHistogram(
    texts.map((t) => d(t)),
    { bucketCount: k, minorUnits: m, confidence: d(p) },
  );
  if (!result.ok) throw new Error(`unexpected ${result.error.code}`);
  return result.value;
}

const frac = (x: Decimal): Fraction => parseDecimalText(toCanonical(x));

describe('Property: loss histogram exactness (A2)', () => {
  it('width is the smallest covering multiple of the minor unit; counts match the reference and sum to n', () => {
    fc.assert(
      fc.property(lossesArb, kArb, mArb, (texts, k, m) => {
        const h = compute(texts, k, m, '0.95');
        const ref = reference(texts, k, m);
        expect(equalFractions(frac(h.width), ref.width)).toBe(true);
        expect(h.buckets).toHaveLength(k);
        expect(h.buckets.map((b) => b.count)).toEqual(ref.counts);
        expect(h.buckets.reduce((total, b) => total + b.count, 0)).toBe(texts.length);
        // Edges: lower[i] = min + i * width exactly; only the last bucket is closed; it covers max.
        for (const [i, b] of h.buckets.entries()) {
          expect(equalFractions(frac(b.lower), addFractions(ref.min, mulInt(ref.width, BigInt(i))))).toBe(
            true,
          );
          expect(b.upperInclusive).toBe(i === k - 1);
        }
        const lastUpper = h.buckets.at(-1)?.upper;
        expect(lastUpper !== undefined && compareFractions(frac(lastUpper), frac(h.max)) >= 0).toBe(true);
      }),
      RUNS,
    );
  });

  it('the marker is the unrounded Type 7 quantile; its bucket, strict above-count and position match', () => {
    fc.assert(
      fc.property(lossesArb, kArb, mArb, pArb, (texts, k, m, p) => {
        const h = compute(texts, k, m, p);
        const quantile = type7Quantile(
          texts.map((t) => d(t)),
          d(p),
        );
        expect(quantile.ok && quantile.value.equals(h.rawQuantile)).toBe(true);
        const ref = reference(texts, k, m);
        const raw = frac(h.rawQuantile);
        expect(h.varBucketIndex).toBe(ref.bucketOf(raw));
        const above = texts.filter((t) => compareFractions(parseDecimalText(t), raw) > 0).length;
        expect(h.scenariosAboveVaR).toBe(above);
        const offset = sub(raw, ref.min);
        const ratio = fraction(offset.num * ref.width.den, offset.den * ref.width.num);
        expect(toCanonical(h.markerPosition)).toBe(roundHalfUp6(ratio));
      }),
      RUNS,
    );
  });

  it('does not depend on the input order', () => {
    fc.assert(
      fc.property(
        lossesArb.chain((texts) =>
          fc.tuple(fc.constant(texts), fc.shuffledSubarray(texts, { minLength: texts.length })),
        ),
        kArb,
        mArb,
        ([texts, shuffled], k, m) => {
          const a = compute(texts, k, m, '0.95');
          const b = compute(shuffled, k, m, '0.95');
          const text = (h: LossHistogram) => ({
            width: toCanonical(h.width),
            buckets: h.buckets.map((x) => [toCanonical(x.lower), toCanonical(x.upper), x.count]),
            raw: toCanonical(h.rawQuantile),
            above: h.scenariosAboveVaR,
            idx: h.varBucketIndex,
          });
          expect(text(b)).toEqual(text(a));
        },
      ),
      RUNS,
    );
  });
});
