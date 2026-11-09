// Validates: Requirements 20.1, 20.2, 20.3, 20.5, 20.6, 27.4
// Tasks 11.2 and 11.3 property tests. Reference: BigInt fractions (test/helpers/rational.ts); every
// Decimal.js operation the implementation performs is mirrored by rounding to 40 significant digits,
// half away from zero (test/helpers/positionReference.ts). No Decimal.js in the reference.
// Property 15: Allocation sums to exactly 100.00 and is deterministic. For eligible portfolios the
//   percentages are multiples of 0.01, sum to exactly 100, differ from the exact percentage by less
//   than 0.01, match the FR-11 reference, and are identical for every input order (ties by ascending
//   ticker, CASH last).
// Property 16: Ineligible allocation is not forced. With shorts or negative cash the result is never
//   ELIGIBLE and has no total; a non-positive denominator is ALLOCATION_UNAVAILABLE without lines;
//   otherwise each percentage is the independent ROUND_HALF_UP two-decimal value.
// Exposure (FR-10, FR-12): long, short, gross, net, NAV, and denominator equal exact reference sums.
// Traceability: AT-ALC-02, AT-ALC-04, AT-ALC-05, AT-ALC-06, AT-ALC-07, AT-ALC-08, AT-ALC-09
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocate, exposureMeasures } from '../../src/portfolio/index.js';
import type { AllocationResult, ExposureLine } from '../../src/portfolio/index.js';
import { brandDecimalString } from '../../src/shared/index.js';
import { roundSignificant } from '../helpers/positionReference.js';
import type { Fraction } from '../helpers/rational.js';
import {
  addFractions,
  compareFractions,
  decimalTextArb,
  equalFractions,
  fraction,
  parseDecimalText,
} from '../helpers/rational.js';

const ZERO = fraction(0n, 1n);
const HUNDRED = fraction(100n, 1n);
const R = roundSignificant;
const neg = (a: Fraction): Fraction => fraction(-a.num, a.den);
const sumOf = (values: readonly Fraction[]): Fraction => values.reduce(addFractions, ZERO);
const isPositive = (a: Fraction): boolean => compareFractions(a, ZERO) > 0;

/** Implementation mirror: R(R(v / den) * 100). */
const percentRef = (v: Fraction, den: Fraction): Fraction => {
  const q = R(fraction(v.num * den.den, v.den * den.num));
  return R(fraction(q.num * 100n, q.den));
};
/** ROUND_DOWN to two decimals of a non-negative fraction. */
const floor2 = (f: Fraction): Fraction => fraction((f.num * 100n) / f.den, 100n);
/** ROUND_HALF_UP to two decimals of a non-negative fraction. */
const halfUp2 = (f: Fraction): Fraction => fraction((f.num * 200n + f.den) / (2n * f.den), 100n);

interface RefLine {
  readonly key: string; // ticker, or '\uffff' for CASH so that it sorts last
  readonly value: Fraction;
}

/** FR-11 reference on fractions. Returns key -> percentage. */
function largestRemainderRef(lines: readonly RefLine[], den: Fraction): Map<string, Fraction> {
  const entries = lines.map((line) => {
    const p = percentRef(line.value, den);
    const floor = floor2(p);
    return { key: line.key, floor, remainder: addFractions(p, neg(floor)) };
  });
  const floorSum = sumOf(entries.map((entry) => entry.floor));
  const unitsFraction = addFractions(HUNDRED, neg(floorSum));
  const units = Number((unitsFraction.num * 100n) / unitsFraction.den); // index only
  const order = [...entries].sort(
    (a, b) => compareFractions(b.remainder, a.remainder) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const bonus = new Set(order.slice(0, units).map((entry) => entry.key));
  return new Map(
    entries.map((entry) => [
      entry.key,
      bonus.has(entry.key) ? addFractions(entry.floor, fraction(1n, 100n)) : entry.floor,
    ]),
  );
}

const pctMap = (result: AllocationResult): Map<string, string> =>
  result.status === 'ALLOCATION_UNAVAILABLE'
    ? new Map()
    : new Map(result.lines.map((line) => [line.kind === 'CASH' ? '\uffff' : line.ticker, line.pct]));

const TICKERS = ['AAA', 'AAB', 'BBB', 'CASH', 'MSFT', 'Z', 'ZZZ', 'aaa'];
const positiveArb = decimalTextArb(8, 6).filter((text) => !text.startsWith('-') && /[1-9]/.test(text));
const signedNonZeroArb = decimalTextArb(8, 6).filter((text) => /[1-9]/.test(text));
const nonNegativeArb = decimalTextArb(8, 6).filter((text) => !text.startsWith('-'));

const linesArb = (valueArb: fc.Arbitrary<string>, minLength: number): fc.Arbitrary<ExposureLine[]> =>
  fc
    .uniqueArray(fc.constantFrom(...TICKERS), { minLength, maxLength: TICKERS.length })
    .chain((tickers) =>
      fc
        .tuple(...tickers.map(() => valueArb))
        .map((values) =>
          tickers.map((ticker, index) => ({ ticker, valueBase: brandDecimalString(values[index] ?? '1') })),
        ),
    );

describe('Property 15: Allocation sums to exactly 100.00 and is deterministic', () => {
  it('eligible portfolios: exact total, 0.01 multiples, within 0.01 of exact, FR-11 reference, order-independent', () => {
    fc.assert(
      fc.property(linesArb(positiveArb, 1), nonNegativeArb, (positions, cashText) => {
        const cash = brandDecimalString(cashText);
        const result = allocate({ positions, cash });
        expect(result.status).toBe('ELIGIBLE');
        if (result.status !== 'ELIGIBLE') {
          return;
        }
        const cashValue = parseDecimalText(cashText);
        const refLines: RefLine[] = positions.map((line) => ({
          key: line.ticker,
          value: parseDecimalText(line.valueBase),
        }));
        if (isPositive(cashValue)) {
          refLines.push({ key: '\uffff', value: cashValue });
        }
        const den = sumOf(refLines.map((line) => line.value));
        const expected = largestRemainderRef(refLines, den);
        const actual = pctMap(result);
        expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
        let total = ZERO;
        for (const line of refLines) {
          const pct = parseDecimalText(actual.get(line.key) ?? 'x');
          total = addFractions(total, pct);
          expect(equalFractions(pct, expected.get(line.key) ?? ZERO)).toBe(true);
          // A multiple of 0.01.
          expect((pct.num * 100n) % pct.den).toBe(0n);
          // Within 0.01 of the exact (unrounded) percentage.
          const exact = fraction(line.value.num * den.den * 100n, line.value.den * den.num);
          const diff = addFractions(pct, neg(exact));
          const absDiff = diff.num < 0n ? neg(diff) : diff;
          expect(compareFractions(absDiff, fraction(1n, 100n))).toBeLessThan(0);
        }
        expect(equalFractions(total, HUNDRED)).toBe(true);
        expect(result.total).toBe('100');
        // Identical for other input orders.
        expect(allocate({ positions: [...positions].reverse(), cash })).toEqual(result);
        expect(allocate({ positions: [...positions.slice(1), ...positions.slice(0, 1)], cash })).toEqual(
          result,
        );
      }),
      { numRuns: 400 },
    );
  });
});

describe('Property 16: Ineligible allocation is not forced', () => {
  it('shorts or negative cash never give ELIGIBLE; percentages are independent ROUND_HALF_UP values', () => {
    const ineligibleArb = fc
      .tuple(linesArb(signedNonZeroArb, 0), decimalTextArb(8, 6))
      .filter(([positions, cash]) =>
        cash.startsWith('-') && /[1-9]/.test(cash)
          ? true
          : positions.some((line) => line.valueBase.startsWith('-')),
      );
    fc.assert(
      fc.property(ineligibleArb, ([positions, cashText]) => {
        const cash = brandDecimalString(cashText);
        const result = allocate({ positions, cash });
        expect(result.status).not.toBe('ELIGIBLE');
        expect('total' in result).toBe(false);
        const cashValue = parseDecimalText(cashText);
        const longs = positions
          .map((line) => ({ key: line.ticker, value: parseDecimalText(line.valueBase) }))
          .filter((line) => isPositive(line.value));
        const den = addFractions(
          sumOf(longs.map((line) => line.value)),
          isPositive(cashValue) ? cashValue : ZERO,
        );
        if (!isPositive(den)) {
          expect(result.status).toBe('ALLOCATION_UNAVAILABLE');
          expect('lines' in result).toBe(false);
          return;
        }
        expect(result.status).toBe('INELIGIBLE');
        const actual = pctMap(result);
        const refLines = isPositive(cashValue) ? [...longs, { key: '\uffff', value: cashValue }] : longs;
        expect(actual.size).toBe(refLines.length);
        for (const line of refLines) {
          const expected = halfUp2(percentRef(line.value, den));
          expect(equalFractions(parseDecimalText(actual.get(line.key) ?? 'x'), expected)).toBe(true);
        }
        if (result.status === 'INELIGIBLE') {
          const shorts = positions.filter((line) => line.valueBase.startsWith('-')).length;
          expect(result.shortPositions).toHaveLength(shorts);
        }
      }),
      { numRuns: 400 },
    );
  });
});

describe('Exposure measures (FR-10, FR-12)', () => {
  it('long, short, gross, net, NAV, and denominator equal exact reference sums', () => {
    fc.assert(
      fc.property(linesArb(signedNonZeroArb, 0), decimalTextArb(8, 6), (positions, cashText) => {
        const measures = exposureMeasures(positions, brandDecimalString(cashText));
        const values = positions.map((line) => parseDecimalText(line.valueBase));
        const long = sumOf(values.filter(isPositive));
        const short = sumOf(values.filter((v) => compareFractions(v, ZERO) < 0).map(neg));
        const cash = parseDecimalText(cashText);
        const eq = (text: string, f: Fraction): boolean => equalFractions(parseDecimalText(text), f);
        expect(eq(measures.long, long)).toBe(true);
        expect(eq(measures.short, short)).toBe(true);
        expect(eq(measures.gross, addFractions(long, short))).toBe(true);
        expect(eq(measures.net, addFractions(long, neg(short)))).toBe(true);
        expect(eq(measures.nav, addFractions(sumOf(values), cash))).toBe(true);
        expect(eq(measures.allocationDenominator, addFractions(long, isPositive(cash) ? cash : ZERO))).toBe(
          true,
        );
      }),
      { numRuns: 400 },
    );
  });
});
