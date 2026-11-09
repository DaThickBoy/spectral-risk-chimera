// Property 13: Data sufficiency and status
// Property 14: No fabricated market data
// Validates: Requirements 12.4, 12.8, 13.1, 13.3, 13.6, 14.4
// Traceability: FR-2, FR-3.4 to FR-3.8; AT-MD-01, AT-MD-03, AT-MD-07, AT-MD-08, AT-MD-09, AT-MD-10,
// AT-VAR-08 to AT-VAR-12.
// The reference is independent of the implementation: dates and gaps use Date's UTC day arithmetic
// (not the builder's integer day numbers), alignment is a plain filter, and every return is checked
// exactly with BigInt fractions (not Decimal.js). Prices are drawn from a set whose quotients all
// terminate, so (return + 1) * previous == current holds exactly, with no tolerance.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createReturnsBuilder,
  createSeriesCleaner,
  weekendsOnlyCalendar,
} from '../../src/marketdata/index.js';
import type { CleanResult, ProviderObservation } from '../../src/marketdata/index.js';
import { brandDecimalString } from '../../src/shared/index.js';
import { addFractions, equalFractions, fraction, parseDecimalText } from '../helpers/rational.js';
import type { Fraction } from '../helpers/rational.js';

const builder = createReturnsBuilder();
const cleaner = createSeriesCleaner(weekendsOnlyCalendar);
const DAY = 86_400_000;

/** Weekdays from Monday 2026-01-05 on, as YYYY-MM-DD. */
const CALENDAR: string[] = [];
for (let t = Date.UTC(2026, 0, 5); CALENDAR.length < 400; t += DAY) {
  const day = new Date(t).getUTCDay();
  if (day !== 0 && day !== 6) {
    CALENDAR.push(new Date(t).toISOString().slice(0, 10));
  }
}

const cleanedOf = (ticker: string, cells: readonly (readonly [string, string])[]): CleanResult => {
  const observations: ProviderObservation[] = cells.map(([date, price]) => ({
    date,
    adjustedClose: brandDecimalString(price),
  }));
  return cleaner.clean({
    ticker,
    currency: 'USD',
    source: 'prop',
    sourceKind: 'DEMO',
    retrievedAt: '2026-11-08T00:00:00.000Z',
    observations,
    contentHash: 'x',
  });
};

describe('Property 13: data sufficiency and status (baseline 200 / 250)', () => {
  const opts = { lookbackReturns: 250, minObservations: 200, maxReturnGapDays: 5 };

  it('n < 200 is INSUFFICIENT_DATA; 200..249 REDUCED_LOOKBACK; >= 250 COMPLETE with exactly the newest 250', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 320 }), (returns) => {
        const dates = CALENDAR.slice(0, returns + 1);
        const series = cleanedOf(
          'ACME',
          dates.map((date, i) => [date, String(100 + i)] as const),
        );
        const result = builder.build([series], opts);
        if (returns < 200) {
          expect(result.ok).toBe(false);
          expect(!result.ok && result.error).toMatchObject({
            code: 'INSUFFICIENT_DATA',
            observations: returns,
            required: 200,
          });
          expect('value' in result).toBe(false);
          return;
        }
        if (!result.ok) {
          throw new Error('expected success');
        }
        expect(result.value.status).toBe(returns >= 250 ? 'COMPLETE' : 'REDUCED_LOOKBACK');
        expect(result.value.n).toBe(Math.min(returns, 250));
        expect(result.value.dates).toEqual(dates.slice(1).slice(-250));
      }),
      { numRuns: 300 },
    );
  });
});

/** Prices whose ratios always terminate: 2^a * 5^b scaled by powers of ten. */
const PRICES = [
  '1',
  '2',
  '4',
  '5',
  '8',
  '10',
  '16',
  '20',
  '25',
  '40',
  '50',
  '0.5',
  '1.25',
  '2.5',
  '12.5',
  '0.8',
];

const dayGap = (from: string, to: string): number =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY;

/** Independent reference for Property 14. */
function reference(
  assets: readonly { ticker: string; cells: readonly (readonly [string, string])[] }[],
  maxGap: number,
  lookback: number,
) {
  const common = CALENDAR.filter((date) => assets.every((a) => a.cells.some(([d]) => d === date)));
  const pairs: { from: string; to: string }[] = [];
  for (let i = 1; i < common.length; i += 1) {
    const from = common[i - 1] as string;
    const to = common[i] as string;
    if (dayGap(from, to) <= maxGap) {
      pairs.push({ from, to });
    }
  }
  const window = pairs.slice(-lookback);
  const multiDay = window.filter(({ from, to }) =>
    assets.some((a) => a.cells.some(([d]) => d > from && d < to)),
  ).length;
  return { common, window, count: pairs.length, multiDay };
}

const assetArb = (ticker: string) =>
  fc
    .uniqueArray(fc.integer({ min: 0, max: 40 }), { minLength: 0, maxLength: 30 })
    .chain((indices) =>
      fc.tuple(
        ...indices
          .sort((a, b) => a - b)
          .map((i) => fc.constantFrom(...PRICES).map((p) => [CALENDAR[i] as string, p] as const)),
      ),
    )
    .map((cells) => ({ ticker, cells: cells as readonly (readonly [string, string])[] }));

describe('Property 14: no fabricated market data', () => {
  const opts = { lookbackReturns: 12, minObservations: 2, maxReturnGapDays: 4 };

  it('every return is exactly Adj[t]/Adj[t-1]-1 of two real observations on consecutive common dates', () => {
    fc.assert(
      fc.property(fc.tuple(assetArb('AAA'), assetArb('BBB'), assetArb('CCC')), (assets) => {
        const result = builder.build(
          assets.map((a) => cleanedOf(a.ticker, a.cells)),
          opts,
        );
        const expected = reference(assets, opts.maxReturnGapDays, opts.lookbackReturns);
        if (expected.count < opts.minObservations) {
          expect(!result.ok && result.error).toMatchObject({
            code: 'INSUFFICIENT_DATA',
            observations: expected.count,
          });
          return;
        }
        if (!result.ok) {
          throw new Error(`unexpected ${result.error.code}`);
        }
        const matrix = result.value;
        expect(matrix.dates).toEqual(expected.window.map((p) => p.to));
        expect(matrix.asOfDate).toBe(expected.common[expected.common.length - 1]);
        expect(matrix.multiDayReturnCount).toBe(expected.multiDay);
        // Output dates are a subset of the intersection of input dates.
        expect(matrix.dates.every((date) => expected.common.includes(date))).toBe(true);
        for (const asset of assets) {
          const price = new Map(asset.cells);
          const values = matrix.returns[asset.ticker] ?? [];
          expect(values).toHaveLength(expected.window.length);
          expected.window.forEach(({ from, to }, i) => {
            const previous = parseDecimalText(price.get(from) as string);
            const current = parseDecimalText(price.get(to) as string);
            const r: Fraction = parseDecimalText(values[i] as string);
            // (r + 1) * previous == current, exactly.
            const lhs = addFractions(r, fraction(1n, 1n));
            expect(equalFractions(fraction(lhs.num * previous.num, lhs.den * previous.den), current)).toBe(
              true,
            );
          });
        }
      }),
      { numRuns: 500 },
    );
  });

  it('the gap rule matches the reference for any single-asset date pattern and any limit', () => {
    fc.assert(
      fc.property(
        assetArb('ACME'),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 2, max: 12 }),
        (asset, maxGap, lookback) => {
          const opts2 = { lookbackReturns: lookback, minObservations: 2, maxReturnGapDays: maxGap };
          const result = builder.build([cleanedOf('ACME', asset.cells)], opts2);
          const expected = reference([asset], maxGap, lookback);
          if (expected.count < 2) {
            expect(!result.ok && result.error).toMatchObject({
              code: 'INSUFFICIENT_DATA',
              observations: expected.count,
            });
            return;
          }
          if (!result.ok) {
            throw new Error(`unexpected ${result.error.code}`);
          }
          expect(result.value.dates).toEqual(expected.window.map((p) => p.to));
          expect(result.value.status).toBe(expected.count >= lookback ? 'COMPLETE' : 'REDUCED_LOOKBACK');
        },
      ),
      { numRuns: 500 },
    );
  });

  it('removing an observation from one asset removes that date for all assets instead of filling it', () => {
    fc.assert(
      fc.property(fc.tuple(assetArb('AAA'), assetArb('BBB')), fc.nat(), ([a, b], pick) => {
        const before = reference([a, b], 1_000, 1_000).common;
        if (before.length === 0) {
          return;
        }
        const removed = before[pick % before.length] as string;
        const reduced = { ticker: 'AAA', cells: a.cells.filter(([d]) => d !== removed) };
        const opts2 = { lookbackReturns: 1_000, minObservations: 2, maxReturnGapDays: 1_000 };
        const result = builder.build([cleanedOf('AAA', reduced.cells), cleanedOf('BBB', b.cells)], opts2);
        if (result.ok) {
          expect(result.value.dates).not.toContain(removed);
          expect(
            Object.values(result.value.returns).every((values) => values.length === result.value.n),
          ).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
