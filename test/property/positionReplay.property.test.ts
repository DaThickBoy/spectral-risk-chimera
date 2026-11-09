// Property 23: Position replay determinism
// Validates: Requirements 5.1, 5.3, 5.6, 28.18, 28.19
//
// Also checks the FR-13 fold against an independent BigInt-fraction reference that
// applies FR-14 rounding (40 significant digits, ROUND_HALF_UP) to every operation.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createPositionService } from '../../src/app/index.js';
import { InMemoryUnitOfWork } from '../../src/persistence/index.js';
import type { PositionRecord, TransactionRecord } from '../../src/persistence/index.js';
import { replayPositions } from '../../src/portfolio/index.js';
import type { PositionsChanged } from '../../src/portfolio/index.js';
import { FakeClock, brandDecimalString, createLogger } from '../../src/shared/index.js';
import { transaction } from '../helpers/persistence.js';
import { referenceReplay } from '../helpers/positionReference.js';
import { compareFractions, equalFractions, fraction, parseDecimalText } from '../helpers/rational.js';

const PF = 'pf-1';
const TICKERS = ['AAA', 'BBB', 'CCC'] as const;
const CURRENCY: Record<(typeof TICKERS)[number], string> = { AAA: 'USD', BBB: 'EUR', CCC: 'JPY' };
const TIMESTAMPS = ['2026-11-02T14:30:00.000Z', '2026-11-02T14:30:00.001Z', '2026-11-03T09:00:00.000Z'];
const SOURCES = [`CSV:${'a'.repeat(64)}`, `CSV:${'b'.repeat(64)}`, `FIX:${'c'.repeat(64)}`];

/** Positive canonical decimal text with up to 2 fractional digits. */
const positiveDecimal = fc
  .tuple(fc.integer({ min: 0, max: 999 }), fc.integer({ min: 0, max: 99 }))
  .filter(([whole, frac]) => whole > 0 || frac > 0)
  .map(([whole, frac]) => {
    const fracText = String(frac).padStart(2, '0').replace(/0+$/, '');
    return fracText === '' ? String(whole) : `${whole}.${fracText}`;
  });

const entryArb = fc.record({
  ticker: fc.constantFrom(...TICKERS),
  type: fc.constantFrom('BUY' as const, 'SELL' as const),
  quantity: positiveDecimal,
  price: positiveDecimal,
  tradeTimestamp: fc.constantFrom(...TIMESTAMPS),
  sourceId: fc.constantFrom(...SOURCES),
  sourceSequence: fc.integer({ min: 1, max: 12 }),
});

/** A ledger of unique transactions (unique ids and keys). */
const ledgerArb = fc.array(entryArb, { maxLength: 40 }).map((entries) =>
  entries.map((entry, index): TransactionRecord =>
    transaction({
      ...entry,
      id: `tx-${index}`,
      transactionKey: `key-${String(index).padStart(4, '0')}`,
      currency: CURRENCY[entry.ticker],
      source: `source ${entry.sourceId.slice(0, 5)}`,
      importId: `imp-${entry.sourceId.slice(0, 3)}`,
      quantity: brandDecimalString(entry.quantity),
      price: brandDecimalString(entry.price),
    }),
  ),
);

function rebuildService(uow: InMemoryUnitOfWork, events: PositionsChanged[]) {
  return createPositionService({
    unitOfWork: uow,
    publisher: { publish: (event) => events.push(event) },
    logger: createLogger({ clock: new FakeClock('2026-11-07T00:00:00.000Z'), sink: () => undefined }),
  });
}

const byTicker = (positions: readonly PositionRecord[]): PositionRecord[] =>
  [...positions].sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));

describe('Property 23: position replay determinism', () => {
  it('replay is independent of input order', () => {
    fc.assert(
      fc.property(
        ledgerArb.chain((ledger) =>
          fc.tuple(fc.constant(ledger), fc.shuffledSubarray(ledger, { minLength: ledger.length })),
        ),
        ([ledger, shuffled]) => {
          expect(replayPositions(PF, shuffled)).toEqual(replayPositions(PF, ledger));
        },
      ),
    );
  });

  it('rebuild gives identical positions for any batch import order, and a second rebuild changes nothing', () => {
    // Batches are the sources (files); they are imported in two different orders.
    const batchOrders = fc.tuple(
      fc.shuffledSubarray(SOURCES, { minLength: SOURCES.length }),
      fc.shuffledSubarray(SOURCES, { minLength: SOURCES.length }),
    );
    fc.assert(
      fc.property(ledgerArb, batchOrders, (ledger, [orderOne, orderTwo]) => {
        const results = [orderOne, orderTwo].map((order) => {
          const uow = new InMemoryUnitOfWork();
          const events: PositionsChanged[] = [];
          const service = rebuildService(uow, events);
          for (const sourceId of order) {
            const batch = ledger.filter((entry) => entry.sourceId === sourceId);
            uow.run((tx) => batch.forEach((entry) => tx.transactions.insert(entry)));
            service.rebuild(PF); // positions after every batch, as after each import
          }
          const positions = byTicker(uow.snapshot().positions);
          const eventCount = events.length;
          expect(service.rebuild(PF)).toEqual({ status: 'REBUILT', changes: [], published: false });
          expect(events).toHaveLength(eventCount);
          return positions;
        });
        expect(results[0]).toEqual(results[1]);
        const replayed = replayPositions(PF, ledger);
        expect(replayed.ok && replayed.value).toEqual(results[0]);
      }),
      { numRuns: 60 },
    );
  });

  it('every position satisfies the zero and short invariants', () => {
    fc.assert(
      fc.property(ledgerArb, (ledger) => {
        const result = replayPositions(PF, ledger);
        expect(result.ok).toBe(true);
        for (const p of result.ok ? result.value : []) {
          const sign = compareFractions(parseDecimalText(p.signedQuantity), fraction(0n, 1n));
          expect(p.averagePrice === null).toBe(sign === 0);
          expect(p.isShort).toBe(sign < 0);
        }
      }),
    );
  });
});

describe('FR-13 replay equals the rational reference', () => {
  it('signed quantity and average price match exactly', () => {
    fc.assert(
      fc.property(ledgerArb, (ledger) => {
        const result = replayPositions(PF, ledger);
        expect(result.ok).toBe(true);
        const positions = result.ok ? result.value : [];
        const reference = referenceReplay(ledger);
        expect(positions.map((p) => p.ticker)).toEqual([...reference.keys()].sort());
        for (const p of positions) {
          const expected = reference.get(p.ticker);
          expect(expected).toBeDefined();
          if (expected === undefined) {
            continue;
          }
          expect(equalFractions(parseDecimalText(p.signedQuantity), expected.qty)).toBe(true);
          if (expected.avg === null) {
            expect(p.averagePrice).toBeNull();
          } else {
            expect(p.averagePrice).not.toBeNull();
            expect(equalFractions(parseDecimalText(p.averagePrice ?? ''), expected.avg)).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
