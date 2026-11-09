// Validates: Requirements 32.2, 32.3, 32.4, 32.5, 15.8
// Property 24: Reproducibility, base and adjusted parts (tasks 12.5, 14.4; design: Correctness Properties).
// For generated portfolios and price histories: recomputing from the stored snapshot gives the
// stored result as identical canonical text; the hash does not depend on the order in which
// positions were stored or on the calculation timestamp; and changing an input (a quantity or a
// price) changes the hash.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { brandDecimalString, canonicalJson } from '../../src/shared/index.js';
import { completeTestConfig, withKey } from '../helpers/config.js';
import { cleanSeries, PF, riskHarness } from '../helpers/riskService.js';
import type { PriceSpec } from '../helpers/riskService.js';

const SMALL = withKey(withKey(completeTestConfig(), 'var.lookbackReturns', 5), 'var.minObservations', 3);
const TICKERS = ['AAA', 'BBB', 'CCC'];

const priceText = fc
  .integer({ min: 1, max: 99_999 })
  .map((cents) => `${Math.floor(cents / 100) + 1}.${String(cents % 100).padStart(2, '0')}`);
const caseArb = fc.record({
  count: fc.integer({ min: 1, max: 3 }),
  quantities: fc.array(
    fc.integer({ min: -500, max: 500 }).filter((q) => q !== 0),
    { minLength: 3, maxLength: 3 },
  ),
  prices: fc.array(priceText, { minLength: 3, maxLength: 3 }),
  paths: fc.array(fc.array(priceText, { minLength: 6, maxLength: 6 }), { minLength: 3, maxLength: 3 }),
  reversed: fc.boolean(),
  at: fc.constantFrom<string>('2026-11-08T12:00:00.000Z', '2026-11-09T01:02:03.456Z'),
  /** Task 14.4: optional CURRENT REAL sentiment per ticker, so Adjusted VaR is calculated too. */
  sentiment: fc.option(
    fc.array(
      fc
        .integer({ min: -100, max: 100 })
        .map((v) => (v < 0 ? `-0.${String(-v).padStart(2, '0')}` : `0.${String(v).padStart(2, '0')}`)),
      { minLength: 3, maxLength: 3 },
    ),
    { nil: undefined },
  ),
});

type Case = typeof caseArb extends fc.Arbitrary<infer T> ? T : never;

async function run(c: Case, change: 'none' | 'quantity' | 'price' = 'none') {
  const tickers = TICKERS.slice(0, c.count);
  const entries = tickers.map((t, i) => [t, ['USD', String(c.quantities[i] ?? 1)]] as const);
  const ordered = c.reversed ? [...entries].reverse() : entries;
  const positions = Object.fromEntries(
    ordered.map(([t, [ccy, q]], i) => [t, [ccy, change === 'quantity' && i === 0 ? `${q}1` : q]] as const),
  );
  const prices: Record<string, PriceSpec> = Object.fromEntries(
    tickers.map((t, i) => [
      t,
      { price: change === 'price' && i === 0 ? `${c.prices[i] ?? '1'}1` : (c.prices[i] ?? '1') },
    ]),
  );
  const values = new Map(tickers.map((t, i) => [t, c.sentiment?.[i]]));
  const sentiment = {
    forRisk: (ticker: string) => {
      const value = values.get(ticker);
      return value === undefined
        ? undefined
        : {
            ticker,
            value: brandDecimalString(value),
            status: 'CURRENT' as const,
            sourceKind: 'REAL' as const,
            source: 'test-sentiment',
          };
    },
  };
  const h = riskHarness(positions, { values: SMALL, prices, at: c.at, sentiment });
  tickers.forEach((t, i) => h.putSeries(cleanSeries(t, c.paths[i] ?? [], { start: '2026-11-01' })));
  await h.service.calculate(PF);
  const record = h.uow.snapshot().snapshots.at(-1);
  const result = h.uow.snapshot().riskResults.at(-1);
  return { h, record, result };
}

describe('Property 24: Reproducibility (base and adjusted)', () => {
  it('recompute reproduces the stored result; hash is order- and timestamp-independent; inputs change it', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async (c) => {
        const base = await run(c);
        if (base.record === undefined || base.result === undefined) {
          throw new Error('expected a calculated snapshot');
        }
        const again = base.h.service.recompute(base.record.id);
        expect(again.ok).toBe(true);
        if (again.ok) {
          expect(canonicalJson({ kind: 'CALCULATED', result: again.value })).toBe(base.result.body);
        }
        const flipped = await run({ ...c, reversed: !c.reversed, at: '2026-11-10T00:00:00.000Z' });
        expect(flipped.record?.hash).toBe(base.record.hash);
        for (const change of ['quantity', 'price'] as const) {
          const changed = await run(c, change);
          expect(changed.record?.hash).not.toBe(base.record.hash);
        }
      }),
      { numRuns: 40 },
    );
  });
});
