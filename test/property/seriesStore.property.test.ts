// Validates: Requirements 12.6, 12.7, 22.3, 25.4
// Task 9.4 series-store properties (not numbered design properties):
// 1. Round trip: any cleaned, non-conflicting series and any provenance list is stored and read
//    back with the exact price text, a content hash reproduced by an independent reference
//    (node:crypto with hand-ordered keys), every retrieval in seq order with its own label
//    (REAL -> CACHED, DEMO -> DEMO), and never CURRENT.
// 2. Order independence: the same set of puts in any order gives the same stored content, the same
//    set of retrievals (ignoring seq), and the same latestFor selection, provided retrievedAt is
//    unique per ticker and source kind (a tie is broken by seq, which depends on order).
// Traceability: AT-MD-18, AT-AUD-03
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createSeriesStore } from '../../src/app/index.js';
import type { SeriesStore } from '../../src/app/index.js';
import type { CleanResult } from '../../src/marketdata/index.js';
import { InMemoryUnitOfWork } from '../../src/persistence/index.js';
import { WEEKDAYS, cleaned, referenceContentHash } from '../helpers/seriesStore.js';

/** Positive decimal text, including trailing zeros and leading-zero fractions (exact text matters). */
const priceArb = fc
  .tuple(
    fc.oneof(fc.constant('0'), fc.integer({ min: 1, max: 99999 }).map(String)),
    fc.option(fc.string({ unit: fc.constantFrom('0', '1', '5', '9'), minLength: 1, maxLength: 6 }), {
      nil: undefined,
    }),
  )
  .map(([int, frac]) => (frac === undefined ? int : `${int}.${frac}`))
  .filter((text) => /[1-9]/.test(text));

const pricesArb = fc
  .subarray([...WEEKDAYS], { minLength: 0 })
  .chain((dates) => fc.tuple(...dates.map((date) => priceArb.map((p) => [date, p] as const))));

const timestampArb = fc
  .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2030, 0, 1) })
  .map((ms) => new Date(ms).toISOString());

const provenanceArb = fc.record({
  source: fc.constantFrom('vendor-a', 'vendor-b', 'demo'),
  sourceKind: fc.constantFrom('REAL' as const, 'DEMO' as const),
  retrievedAt: timestampArb,
});

const newStore = (): { uow: InMemoryUnitOfWork; store: SeriesStore } => {
  const uow = new InMemoryUnitOfWork();
  return { uow, store: createSeriesStore({ unitOfWork: uow }) };
};

const mustPut = (store: SeriesStore, input: CleanResult): string => {
  const put = store.put(input);
  if (!put.ok) {
    throw new Error(`put failed: ${put.error.code}`);
  }
  return put.value.contentHash;
};

describe('series store properties', () => {
  it('round trip keeps exact text, a reproducible hash, and per-retrieval labels', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('AAA', 'BBB'),
        fc.constantFrom('USD', 'EUR'),
        pricesArb,
        fc.array(provenanceArb, { minLength: 1, maxLength: 6 }),
        (ticker, currency, prices, provenances) => {
          const { store } = newStore();
          const inputs = provenances.map((p) => cleaned({ ticker, currency, prices, ...p }));
          const hashes = inputs.map((input) => mustPut(store, input));
          const hash = hashes[0] ?? '';
          expect(new Set(hashes).size).toBe(1);

          const read = store.getByHash(hash);
          if (!read.ok) {
            throw new Error(read.error.code);
          }
          const expectedObservations = [...prices]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([date, adjustedClose]) => ({ date, adjustedClose }));
          expect(read.value.series.observations).toEqual(expectedObservations);
          expect(referenceContentHash(ticker, currency, expectedObservations)).toBe(hash);

          // Distinct provenance in first-put order; repeats are idempotent.
          const distinct = provenances.filter(
            (p, i) =>
              provenances.findIndex(
                (q) =>
                  q.source === p.source && q.sourceKind === p.sourceKind && q.retrievedAt === p.retrievedAt,
              ) === i,
          );
          expect(read.value.retrievals).toEqual(
            distinct.map((p, i) => ({
              seq: i + 1,
              ...p,
              label: p.sourceKind === 'REAL' ? 'CACHED' : 'DEMO',
            })),
          );
          for (const r of read.value.retrievals) {
            expect(r.label).not.toBe('CURRENT');
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('the same puts in any order give the same content, retrievals, and latestFor selection', () => {
    const putArb = fc.record({
      ticker: fc.constantFrom('AAA', 'BBB'),
      prices: pricesArb,
      source: fc.constantFrom('vendor-a', 'demo'),
      sourceKind: fc.constantFrom('REAL' as const, 'DEMO' as const),
    });
    fc.assert(
      fc.property(
        fc
          .uniqueArray(timestampArb, { minLength: 1, maxLength: 8 })
          .chain((times) =>
            fc.tuple(...times.map((retrievedAt) => putArb.map((p) => ({ ...p, retrievedAt })))),
          )
          .chain((puts) =>
            fc.tuple(
              fc.constant(puts),
              fc.shuffledSubarray(puts, { minLength: puts.length, maxLength: puts.length }),
            ),
          ),
        ([puts, shuffled]) => {
          type Put = (typeof puts)[number];
          const run = (order: readonly Put[]) => {
            const { uow, store } = newStore();
            for (const p of order) {
              mustPut(store, cleaned(p));
            }
            const snapshot = uow.snapshot();
            const content = [...snapshot.seriesContent].sort((a, b) =>
              a.contentHash < b.contentHash ? -1 : 1,
            );
            const withoutSeq = <R extends { seq: number }>(record: R): Omit<R, 'seq'> => {
              const copy: Partial<R> = { ...record };
              delete copy.seq;
              return copy as Omit<R, 'seq'>;
            };
            const retrievals = snapshot.seriesRetrievals.map((r) => JSON.stringify(withoutSeq(r))).sort();
            const latest = (['AAA', 'BBB'] as const).flatMap((ticker) =>
              (['REAL', 'DEMO'] as const).map((kind) => {
                const result = store.latestFor(ticker, kind);
                if (!result.ok) {
                  return result.error.code;
                }
                return {
                  hash: result.value.series.contentHash,
                  retrieval: withoutSeq(result.value.retrieval),
                };
              }),
            );
            return { content, retrievals, latest };
          };
          expect(run(shuffled)).toEqual(run(puts));
        },
      ),
      { numRuns: 200 },
    );
  });
});
