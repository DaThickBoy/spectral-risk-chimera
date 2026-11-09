// Test helpers for task 9.4 (series store). Inputs are built with the real 9.2 cleaner, so the
// stored content and hash are exactly what accepted 9.2 produces. `referenceContentHash` is an
// independent hash (node:crypto with hand-ordered keys, not the shared canonicalJson).
import { createHash } from 'node:crypto';
import { createSeriesCleaner, weekendsOnlyCalendar } from '../../src/marketdata/index.js';
import type { CleanResult, ProviderObservation, ProviderSeries } from '../../src/marketdata/index.js';
import type {
  Repositories,
  SeriesContentRecord,
  SeriesRepo,
  SeriesRetrievalRecord,
  UnitOfWork,
} from '../../src/persistence/index.js';
import { brandDecimalString } from '../../src/shared/index.js';

export interface SeriesSpec {
  readonly ticker?: string;
  readonly currency?: string;
  readonly source?: string;
  readonly sourceKind?: 'REAL' | 'DEMO';
  readonly retrievedAt?: string;
  /** `[date, price text]` in received order. */
  readonly prices?: readonly (readonly [string, string])[];
}

/** Weekdays (2026-11-02 is a Monday). */
export const WEEKDAYS = [
  '2026-11-02',
  '2026-11-03',
  '2026-11-04',
  '2026-11-05',
  '2026-11-06',
  '2026-11-09',
  '2026-11-10',
  '2026-11-11',
  '2026-11-12',
  '2026-11-13',
] as const;

export function providerSeries(spec: SeriesSpec = {}): ProviderSeries {
  const prices = spec.prices ?? [
    ['2026-11-02', '100.0'],
    ['2026-11-03', '101.250'],
    ['2026-11-04', '99.5'],
  ];
  const observations: ProviderObservation[] = prices.map(([date, text]) => ({
    date,
    adjustedClose: brandDecimalString(text),
  }));
  return {
    ticker: spec.ticker ?? 'AAA',
    currency: spec.currency ?? 'USD',
    source: spec.source ?? 'fixture',
    sourceKind: spec.sourceKind ?? 'REAL',
    retrievedAt: spec.retrievedAt ?? '2026-11-06T10:00:00.000Z',
    observations,
    // Not used by the cleaner or the store.
    contentHash: '0'.repeat(64),
  };
}

const cleaner = createSeriesCleaner(weekendsOnlyCalendar);

export const cleaned = (spec: SeriesSpec = {}): CleanResult => cleaner.clean(providerSeries(spec));

/** Independent content hash: keys written in code-point order by hand. */
export function referenceContentHash(
  ticker: string,
  currency: string,
  observations: readonly { date: string; adjustedClose: string }[],
): string {
  const obs = observations
    .map((o) => `{"adjustedClose":${JSON.stringify(o.adjustedClose)},"date":${JSON.stringify(o.date)}}`)
    .join(',');
  const json = `{"currency":${JSON.stringify(currency)},"observations":[${obs}],"ticker":${JSON.stringify(ticker)}}`;
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

export interface SeriesTamper {
  readonly content?: (record: SeriesContentRecord | undefined) => unknown;
  readonly retrievals?: (records: readonly SeriesRetrievalRecord[]) => readonly unknown[];
}

/**
 * Wraps a unit of work so that series reads return tampered data, simulating corrupted storage.
 * Writes pass through unchanged.
 */
export function tamperingUnitOfWork(inner: UnitOfWork, tamper: SeriesTamper): UnitOfWork {
  return {
    run: <T>(work: (tx: Repositories) => T): T =>
      inner.run((tx) => {
        const series: SeriesRepo = {
          insertContent: (record) => tx.series.insertContent(record),
          appendRetrieval: (record) => tx.series.appendRetrieval(record),
          getContent: (hash) => {
            const record = tx.series.getContent(hash);
            return (tamper.content === undefined ? record : tamper.content(record)) as
              SeriesContentRecord | undefined;
          },
          listRetrievalsByHash: (hash) => {
            const records = tx.series.listRetrievalsByHash(hash);
            return (
              tamper.retrievals === undefined ? records : tamper.retrievals(records)
            ) as readonly SeriesRetrievalRecord[];
          },
          listRetrievalsByTicker: (ticker, kind) => {
            const records = tx.series.listRetrievalsByTicker(ticker, kind);
            return (
              tamper.retrievals === undefined ? records : tamper.retrievals(records)
            ) as readonly SeriesRetrievalRecord[];
          },
        };
        return work({ ...tx, series });
      }),
  };
}
