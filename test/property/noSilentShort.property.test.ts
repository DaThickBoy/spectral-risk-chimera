// Validates: Requirements 28.18, 28.20, 28.21
// Property 22: No silent short positions (task 7.6; design: Correctness Properties).
// Under oversellPolicy REJECT, for any sequence of transactions imported in one or more files
// (including back-dated files), the net quantity of every instrument is never negative at any
// point of the R28.18 replay order, no position is short, and only SELL rows are rejected with
// OVERSELL. In time order without back-dating, the accepted rows equal an independent greedy
// BigInt reference. Under ALLOW_SHORT every row is accepted and a negative net quantity (BigInt
// reference) is flagged short.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareLedgerOrder } from '../../src/portfolio/index.js';
import { fileOf, lineOf, tradeArb } from '../helpers/importArbs.js';
import type { TradeLine } from '../helpers/importArbs.js';
import { useCaseHarness } from '../helpers/importService.js';

type Harness = ReturnType<typeof useCaseHarness>;

const usdTrades = fc.array(tradeArb(['USD']), { minLength: 1, maxLength: 20 });
/** Distinct, increasing timestamps in list order. */
const timed = (trades: readonly TradeLine[], day = 2): TradeLine[] =>
  trades.map((t, i) => ({
    ...t,
    externalId: '',
    time: `2026-11-${String(day).padStart(2, '0')}T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
  }));
const signed = (t: { type: string; quantity: string }): bigint =>
  t.type === 'BUY' ? BigInt(t.quantity) : -BigInt(t.quantity);

function assertNeverNegative(h: Harness): void {
  const ledger = [...h.inner.snapshot().transactions].sort(compareLedgerOrder);
  const running = new Map<string, bigint>();
  for (const tx of ledger) {
    const next = (running.get(tx.ticker) ?? 0n) + signed(tx);
    expect(next >= 0n, `${tx.ticker} negative at ${tx.tradeTimestamp}`).toBe(true);
    running.set(tx.ticker, next);
  }
  for (const position of h.inner.snapshot().positions) {
    expect(position.isShort).toBe(false);
    expect(position.signedQuantity.startsWith('-')).toBe(false);
  }
}

describe('Property 22: No silent short positions', () => {
  it('REJECT: no instrument is ever negative across files, including back-dated ones', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(usdTrades, fc.integer({ min: 1, max: 9 })), { minLength: 1, maxLength: 3 }),
        async (files) => {
          const h = useCaseHarness({ policy: 'REJECT' });
          for (const [trades, day] of files) {
            const lines = timed(trades, day);
            await h.runCsv(fileOf(lines.map(lineOf)));
            assertNeverNegative(h);
          }
          for (const q of h.inner.snapshot().quarantine) {
            if (q.reasonCode === 'OVERSELL') {
              expect(q.rawExcerpt).toContain(',SELL,');
            }
          }
        },
      ),
      { numRuns: 80 },
    );
  });

  it('REJECT in time order: accepted rows equal the greedy reference', async () => {
    await fc.assert(
      fc.asyncProperty(usdTrades, async (trades) => {
        const lines = timed(trades);
        const h = useCaseHarness({ policy: 'REJECT' });
        await h.runCsv(fileOf(lines.map(lineOf)));
        const held = new Map<string, bigint>();
        const expected: number[] = [];
        lines.forEach((line, index) => {
          const next = (held.get(line.ticker) ?? 0n) + signed(line);
          if (next >= 0n) {
            held.set(line.ticker, next);
            expected.push(index + 1);
          }
        });
        expect(
          h.inner
            .snapshot()
            .transactions.map((t) => t.sourceSequence)
            .sort((a, b) => a - b),
        ).toEqual(expected);
        const rejected = h.inner.snapshot().quarantine;
        expect(rejected.every((q) => q.reasonCode === 'OVERSELL')).toBe(true);
        expect(rejected).toHaveLength(lines.length - expected.length);
      }),
      { numRuns: 100 },
    );
  });

  it('ALLOW_SHORT: every row is accepted and a negative net quantity is flagged short', async () => {
    await fc.assert(
      fc.asyncProperty(usdTrades, async (trades) => {
        const lines = timed(trades);
        const h = useCaseHarness({ policy: 'ALLOW_SHORT' });
        const result = await h.runCsv(fileOf(lines.map(lineOf)));
        expect(result.status === 'DONE' && result.summary.accepted).toBe(lines.length);
        const net = new Map<string, bigint>();
        for (const line of lines) {
          net.set(line.ticker, (net.get(line.ticker) ?? 0n) + signed(line));
        }
        const positions = h.inner.snapshot().positions;
        expect(positions.map((p) => p.ticker).sort()).toEqual([...net.keys()].sort());
        for (const position of positions) {
          const expected = net.get(position.ticker) ?? 0n;
          expect(position.signedQuantity).toBe(expected.toString());
          expect(position.isShort).toBe(expected < 0n);
        }
      }),
      { numRuns: 100 },
    );
  });
});
