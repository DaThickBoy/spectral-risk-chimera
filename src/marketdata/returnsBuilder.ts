/**
 * Returns builder (task 9.3; FR-2, FR-3.3 to FR-3.8; R12.4, R12.8, R13.1,
 * R13.2, R13.3, R13.6, R14.4; design: `ReturnsBuilder.build` algorithm).
 *
 * Method: daily simple returns `Adj[t] / Adj[t-1] - 1` between consecutive
 * Common Trading Dates (the intersection of every asset's cleaned dates; no
 * forward fill, no interpolation), computed with the project Decimal
 * configuration (40 significant digits, ROUND_HALF_UP; a non-terminating quotient
 * is rounded once by that configuration) and serialized with `toCanonical()`.
 *
 * 0. Inputs are `CleanResult`s already selected by the caller (assets with
 *    non-zero net quantity). Empty inputs, duplicate tickers, or options outside
 *    the configuration rules throw `TypeError`. Pure; the result is frozen.
 * 1. Any `conflict = true` gives `DATA_CONFLICT` with the sorted conflicting
 *    tickers, before alignment or any return; no partial returns.
 * 3. A return whose calendar-day gap exceeds `maxReturnGapDays` is discarded and
 *    does not count towards sufficiency.
 * 5. `count < minObservations` -> INSUFFICIENT_DATA (count, required, limiting
 *    ticker); `count < lookbackReturns` -> REDUCED_LOOKBACK; otherwise COMPLETE
 *    with only the newest `lookbackReturns` returns.
 * 6. `multiDayReturnCount`: kept-window returns for which some asset has a valid
 *    observation strictly between the two common dates.
 * 7. `asOfDate` is the latest common date, even if its return was discarded;
 *    `dates[i]` is the end date of return `i`.
 * 8. Limiting ticker: latest first cleaned observation date (an asset with no
 *    observations starts latest), then fewer cleaned observations, then the
 *    lexicographically smaller ticker.
 *
 * Assumptions and limits: one-day horizon data only; no exchange holidays
 * (weekends-only calendar, OD-3); FX is not involved here (A-9). Stale data
 * (`MARKET_DATA_STALE`) and `NO_POSITIONS` are decided by the risk input builder.
 */
import { appError, d, err, ok, toCanonical } from '../shared/index.js';
import type { AppError, DecimalString, Result } from '../shared/index.js';
import type { CleanResult, PriceSeries } from './seriesCleaner.js';

export interface ReturnsOptions {
  /** `var.lookbackReturns`. */
  readonly lookbackReturns: number;
  /** `var.minObservations`. */
  readonly minObservations: number;
  /** `marketData.maxReturnGapDays`. */
  readonly maxReturnGapDays: number;
}

export interface ReturnMatrix {
  /** The latest Common Trading Date. */
  readonly asOfDate: string;
  /** End date of each return, ascending; length `n`. */
  readonly dates: readonly string[];
  /** Ticker -> `n` simple returns (canonical decimal strings), aligned with `dates`. */
  readonly returns: Readonly<Record<string, readonly DecimalString[]>>;
  readonly n: number;
  readonly status: 'COMPLETE' | 'REDUCED_LOOKBACK';
  readonly limitingTicker: string;
  readonly multiDayReturnCount: number;
  /** Ticker -> cleaned `PriceSeries.contentHash`. */
  readonly seriesHashes: Readonly<Record<string, string>>;
}

export type MarketDataError =
  | (AppError<'DATA_CONFLICT'> & { readonly tickers: readonly string[] })
  | (AppError<'INSUFFICIENT_DATA'> & {
      readonly observations: number;
      readonly required: number;
      readonly limitingTicker: string;
    });

export interface ReturnsBuilder {
  build(inputs: readonly CleanResult[], opts: ReturnsOptions): Result<ReturnMatrix, MarketDataError>;
}

const isInteger = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min;

function assertOptions(opts: ReturnsOptions): void {
  if (
    typeof opts !== 'object' ||
    opts === null ||
    !isInteger(opts.lookbackReturns, 2) ||
    !isInteger(opts.minObservations, 2) ||
    opts.minObservations > opts.lookbackReturns ||
    !isInteger(opts.maxReturnGapDays, 1)
  ) {
    throw new TypeError(
      'ReturnsBuilder options: lookbackReturns and minObservations must be integers >= 2 with ' +
        'minObservations <= lookbackReturns, and maxReturnGapDays an integer >= 1.',
    );
  }
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Days since 1970-01-01 of a `YYYY-MM-DD` date (proleptic Gregorian; integer
 * arithmetic, days-from-civil). Day counts are integers, not financial values.
 */
function dayNumber(date: string): number {
  const y0 = Number.parseInt(date.slice(0, 4), 10);
  const m = Number.parseInt(date.slice(5, 7), 10);
  const day = Number.parseInt(date.slice(8, 10), 10);
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** Step 8: latest first observation date, then fewer observations, then smaller ticker. */
function limitingTickerOf(series: readonly PriceSeries[]): string {
  const ranked = [...series].sort((a, b) => {
    const firstA = a.observations[0]?.date;
    const firstB = b.observations[0]?.date;
    if (firstA !== firstB) {
      // No observations: no history, so it starts latest.
      if (firstA === undefined) {
        return -1;
      }
      if (firstB === undefined) {
        return 1;
      }
      return compareText(firstB, firstA);
    }
    if (a.observations.length !== b.observations.length) {
      return a.observations.length - b.observations.length;
    }
    return compareText(a.ticker, b.ticker);
  });
  const [limiting] = ranked;
  if (limiting === undefined) {
    throw new TypeError('ReturnsBuilder requires at least one input.');
  }
  return limiting.ticker;
}

interface Indexed {
  readonly series: PriceSeries;
  /** date -> position in the sorted cleaned observations. */
  readonly position: ReadonlyMap<string, number>;
}

export function createReturnsBuilder(): ReturnsBuilder {
  return {
    build: (inputs, opts) => {
      assertOptions(opts);
      if (!Array.isArray(inputs) || inputs.length === 0) {
        throw new TypeError('ReturnsBuilder requires at least one CleanResult.');
      }
      const tickers = inputs.map((input) => input.series.ticker);
      if (new Set(tickers).size !== tickers.length) {
        throw new TypeError('ReturnsBuilder inputs must have unique tickers.');
      }

      // Step 1: conflicts first; nothing is calculated or exposed.
      const conflicting = inputs.filter((input) => input.conflict).map((input) => input.series.ticker);
      if (conflicting.length > 0) {
        return err({
          ...appError('DATA_CONFLICT', 'Market data conflict (DATA_CONFLICT).'),
          tickers: Object.freeze([...conflicting].sort(compareText)),
        });
      }

      const series = inputs.map((input) => input.series);
      const limitingTicker = limitingTickerOf(series);
      const indexed: Indexed[] = series.map((s) => ({
        series: s,
        position: new Map<string, number>(
          s.observations.map((o: { readonly date: string }, i: number): [string, number] => [o.date, i]),
        ),
      }));

      // Step 2: the intersection of dates (each series is sorted ascending).
      const [first, ...others] = indexed;
      const common = (first?.series.observations ?? [])
        .map((o) => o.date)
        .filter((date) => others.every((entry) => entry.position.has(date)));

      // Steps 3 and 6: walk consecutive common dates; discard gap returns; note multi-day spans.
      const kept: { readonly date: string; readonly from: string; readonly multiDay: boolean }[] = [];
      for (let i = 1; i < common.length; i += 1) {
        const from = common[i - 1];
        const to = common[i];
        if (from === undefined || to === undefined) {
          continue;
        }
        if (dayNumber(to) - dayNumber(from) > opts.maxReturnGapDays) {
          continue;
        }
        const multiDay = indexed.some(
          (entry) => (entry.position.get(to) ?? 0) - (entry.position.get(from) ?? 0) > 1,
        );
        kept.push({ date: to, from, multiDay });
      }

      // Step 5: sufficiency and the lookback window.
      const count = kept.length;
      if (count < opts.minObservations) {
        return err({
          ...appError('INSUFFICIENT_DATA', 'Market data insufficient (INSUFFICIENT_DATA).'),
          observations: count,
          required: opts.minObservations,
          limitingTicker,
        });
      }
      const window = kept.slice(-opts.lookbackReturns);
      const status = count >= opts.lookbackReturns ? 'COMPLETE' : 'REDUCED_LOOKBACK';

      // Step 4: Decimal returns, canonical text.
      const returns: Record<string, readonly DecimalString[]> = {};
      const seriesHashes: Record<string, string> = {};
      for (const entry of indexed) {
        const prices = new Map(entry.series.observations.map((o) => [o.date, o.adjustedClose]));
        const values = window.map(({ date, from }) => {
          const current = prices.get(date);
          const previous = prices.get(from);
          if (current === undefined || previous === undefined) {
            // Unreachable: both dates are common dates of every asset.
            throw new TypeError('ReturnsBuilder internal error: missing common observation.');
          }
          return toCanonical(d(current).dividedBy(d(previous)).minus(1));
        });
        returns[entry.series.ticker] = Object.freeze(values);
        seriesHashes[entry.series.ticker] = entry.series.contentHash;
      }

      const asOfDate = common[common.length - 1];
      if (asOfDate === undefined) {
        // Unreachable: count >= minObservations >= 2 implies common dates exist.
        throw new TypeError('ReturnsBuilder internal error: no common dates.');
      }
      return ok(
        Object.freeze({
          asOfDate,
          dates: Object.freeze(window.map((r) => r.date)),
          returns: Object.freeze(returns),
          n: window.length,
          status,
          limitingTicker,
          multiDayReturnCount: window.filter((r) => r.multiDay).length,
          seriesHashes: Object.freeze(seriesHashes),
        }),
      );
    },
  };
}
