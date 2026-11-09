/**
 * Historical series retrieval (task 9.6, the parts specified without OD-13;
 * design: Market Data and FX, Series store and caching; R12.1, R12.5, R12.6,
 * R22.3, R25.2, R25.8, R25.9).
 *
 * `retrieve(ticker, range)` connects the 9.1 port to the 9.4 store for one
 * explicit request; it adds no cache, schedule, or freshness rule of its own:
 * 1. Arguments are checked first (`assertTicker`, `assertDateRange`): an invalid
 *    ticker or range is a programmer error (`TypeError`), and nothing is called.
 * 2. `getDailySeries` runs once through the shared `ResilientCall` under the
 *    provider's circuit key `marketdata:<provider name>` (the key valuation uses)
 *    and operation `getDailySeries`. Provider results are mapped exactly as for
 *    prices (`toPriceAttempt`), so retries, timeouts, the circuit breaker, and
 *    provider status are those of 8.2.
 * 3. Inside the attempt the result is re-validated, as quotes are (Valuation
 *    rule 4a): the strict `ProviderSeries` shape, the requested ticker, every
 *    observation date within `range`, `source` and `sourceKind` equal to the
 *    provider's `name` and `kind`, and the content hash recomputed over
 *    `{ ticker, currency, observations }`. A failure is a non-retryable
 *    `INVALID_RESPONSE` attempt with its reason, counted by the breaker.
 * 4. The accepted series is cleaned by the injected 9.2 `SeriesCleaner`
 *    (discards, duplicates, conflicts; no fill) and stored with
 *    `SeriesStore.put`: provenance (source, source kind, `retrievedAt`) is kept
 *    per retrieval, a conflicting series is refused (`SERIES_CONFLICT`, nothing
 *    written), and a storage failure is `STORE_FAILED`.
 * The risk input builder then reads the stored series through
 * `seriesStoreHistory` (latest retrieval of the provider's source kind), so the
 * common-date intersection, gap rule, and sufficiency rules of 9.3 are unchanged.
 *
 * Not decided, so not implemented: when retrieval runs and with which range,
 * refresh, expiry, de-duplication of concurrent requests, and staleness of
 * stored series (9.6, OD-13). The 9.1 port takes no AbortSignal, so an attempt
 * timeout bounds the wait but not the provider's work; a late result is ignored.
 */
import { z } from 'zod';
import type {
  CleanResult,
  DateRange,
  DiscardCounts,
  MarketDataProvider,
  ProviderSeries,
  SeriesCleaner,
} from '../marketdata/index.js';
import { assertDateRange, assertTicker } from '../marketdata/index.js';
import {
  DecimalStringSchema,
  Iso4217Code,
  IsoDate,
  IsoUtcMillis,
  appError,
  canonicalJson,
  err,
  ok,
  sha256Hex,
} from '../shared/index.js';
import type { AppError, ProviderErrorCode, ResilientCall, Result } from '../shared/index.js';
import { marketDataCircuitKey } from './positionValuation.js';
import { toPriceAttempt } from './priceAttempt.js';
import type { PutOutcome, SeriesStore, SeriesStoreError } from './seriesStore.js';

export const MARKET_DATA_SERIES_OPERATION = 'getDailySeries';

export type SeriesRejectionReason =
  'SCHEMA' | 'TICKER_MISMATCH' | 'OUT_OF_RANGE' | 'PROVENANCE_MISMATCH' | 'HASH_MISMATCH';

export type SeriesRetrievalError =
  | (AppError<'PROVIDER_ERROR'> & { readonly providerCode: ProviderErrorCode })
  | (AppError<'INVALID_RESPONSE'> & { readonly reason: SeriesRejectionReason })
  | Exclude<SeriesStoreError, AppError<'NOT_FOUND'> | AppError<'SERIES_INTEGRITY_ERROR'>>;

export interface SeriesRetrieved {
  readonly ticker: string;
  /** Cleaned content hash: the key under which the store keeps the series. */
  readonly contentHash: string;
  readonly retrieval: PutOutcome['retrieval'];
  readonly contentInserted: boolean;
  readonly retrievalAppended: boolean;
  /** Cleaned observations kept (a count, not a financial value). */
  readonly observations: number;
  readonly discarded: DiscardCounts;
}

export interface SeriesRetrievalService {
  retrieve(ticker: string, range: DateRange): Promise<Result<SeriesRetrieved, SeriesRetrievalError>>;
}

export interface SeriesRetrievalDependencies {
  readonly marketData: MarketDataProvider;
  /** The shared 8.2 instance (the same one valuation and provider status use). */
  readonly resilientCall: ResilientCall;
  /** The 9.2 cleaner with the configured trading calendar. */
  readonly cleaner: SeriesCleaner;
  readonly store: SeriesStore;
}

const ObservationSchema = z.union([
  z.strictObject({ date: IsoDate, adjustedClose: DecimalStringSchema }),
  z.strictObject({ date: IsoDate, adjustedClose: z.null(), defect: z.literal('MISSING') }),
  z.strictObject({
    date: IsoDate,
    adjustedClose: z.null(),
    defect: z.literal('NOT_FINITE'),
    nonFinite: z.enum(['NaN', 'Infinity', '-Infinity']),
  }),
]);

const ProviderSeriesSchema = z.strictObject({
  ticker: z.string().min(1),
  currency: Iso4217Code,
  source: z.string().min(1),
  sourceKind: z.enum(['REAL', 'DEMO']),
  retrievedAt: IsoUtcMillis,
  observations: z.array(ObservationSchema),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});

const INVALID_ATTEMPT = { ok: false, failure: 'INVALID_RESPONSE' } as const;

/** Rule 3: `undefined` when the series is acceptable, otherwise the rejection reason. */
function rejection(
  value: unknown,
  ticker: string,
  range: DateRange,
  provider: MarketDataProvider,
): { readonly reason: SeriesRejectionReason } | { readonly series: ProviderSeries } {
  const parsed = ProviderSeriesSchema.safeParse(value);
  if (!parsed.success) {
    return { reason: 'SCHEMA' };
  }
  const series = parsed.data;
  if (series.ticker !== ticker) {
    return { reason: 'TICKER_MISMATCH' };
  }
  // Fixed-width YYYY-MM-DD text compares chronologically.
  if (series.observations.some((o) => o.date < range.from || o.date > range.to)) {
    return { reason: 'OUT_OF_RANGE' };
  }
  if (series.source !== provider.name || series.sourceKind !== provider.kind) {
    return { reason: 'PROVENANCE_MISMATCH' };
  }
  const { currency, observations } = series;
  if (sha256Hex(canonicalJson({ ticker, currency, observations })) !== series.contentHash) {
    return { reason: 'HASH_MISMATCH' };
  }
  return { series: Object.freeze({ ...series, observations: Object.freeze([...observations]) }) };
}

export function createSeriesRetrievalService(deps: SeriesRetrievalDependencies): SeriesRetrievalService {
  const { marketData, resilientCall, cleaner, store } = deps;
  if (
    typeof marketData?.getDailySeries !== 'function' ||
    typeof resilientCall?.run !== 'function' ||
    typeof cleaner?.clean !== 'function' ||
    typeof store?.put !== 'function'
  ) {
    throw new TypeError('marketData, resilientCall, cleaner, and store are required.');
  }
  const circuitKey = marketDataCircuitKey(marketData.name);

  return {
    retrieve: async (ticker, range) => {
      assertTicker(ticker);
      assertDateRange(range);
      const requested: DateRange = Object.freeze({ from: range.from, to: range.to });
      let attempts = 0;
      // Rejections by attempt number, so a late result of an abandoned attempt cannot
      // change the reason attributed to the last attempt (as for prices).
      const rejections = new Map<number, SeriesRejectionReason>();
      const called = await resilientCall.run<ProviderSeries>(
        circuitKey,
        MARKET_DATA_SERIES_OPERATION,
        async () => {
          attempts += 1;
          const attempt = attempts; // index only, not a financial value
          const outcome = toPriceAttempt(await marketData.getDailySeries(ticker, requested));
          if (!outcome.ok) {
            return outcome;
          }
          const checked = rejection(outcome.value, ticker, requested, marketData);
          if ('reason' in checked) {
            rejections.set(attempt, checked.reason);
            return INVALID_ATTEMPT;
          }
          return { ok: true, value: checked.series };
        },
      );
      if (!called.ok) {
        const reason = rejections.get(attempts);
        if (called.error.code === 'INVALID_RESPONSE' && reason !== undefined) {
          return err({
            ...appError('INVALID_RESPONSE', `Series from ${marketData.name} was rejected (${reason}).`),
            reason,
          });
        }
        return err({
          ...appError(
            'PROVIDER_ERROR',
            `Series retrieval from ${marketData.name} failed (${called.error.code}).`,
          ),
          providerCode: called.error.code,
        });
      }
      const cleaned: CleanResult = cleaner.clean(called.value);
      const stored = store.put(cleaned);
      if (!stored.ok) {
        // put reports only SERIES_CONFLICT or STORE_FAILED (reads are not involved).
        return err(
          stored.error as Extract<SeriesRetrievalError, { code: 'SERIES_CONFLICT' | 'STORE_FAILED' }>,
        );
      }
      return ok({
        ticker,
        contentHash: stored.value.contentHash,
        retrieval: stored.value.retrieval,
        contentInserted: stored.value.contentInserted,
        retrievalAppended: stored.value.retrievalAppended,
        observations: cleaned.series.observations.length,
        discarded: cleaned.discarded,
      });
    },
  };
}
