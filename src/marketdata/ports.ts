/**
 * Market data port and provider-level types (task 9.1; R12.1, R12.2, R12.3,
 * R12.6, R26.3; design: Market Data and FX).
 *
 * `marketdata/` imports only `shared/` and `config/`. A provider returns a
 * normalized but NOT cleaned `ProviderSeries`: observations in received order,
 * within the requested range, with duplicates, weekend dates, and observation
 * defects kept unchanged. Task 9.2's `SeriesCleaner` turns it into the sorted,
 * cleaned `PriceSeries` (FR-3).
 */
import type { DataSourceKind, DecimalString, ProviderError, Result } from '../shared/index.js';

/** Inclusive date range of `YYYY-MM-DD` exchange dates; `from <= to`. */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

/** Marker text of a non-finite adjusted close. Never converted to a native number. */
export type NonFiniteMarker = 'NaN' | 'Infinity' | '-Infinity';

/**
 * One observation as received. A valid decimal of any sign is kept exactly; a
 * missing or non-finite value is `null` with an explicit defect. Task 9.2
 * discards and counts `MISSING`, `NOT_FINITE`, and non-positive observations.
 */
export type ProviderObservation =
  | { readonly date: string; readonly adjustedClose: DecimalString }
  | { readonly date: string; readonly adjustedClose: null; readonly defect: 'MISSING' }
  | {
      readonly date: string;
      readonly adjustedClose: null;
      readonly defect: 'NOT_FINITE';
      readonly nonFinite: NonFiniteMarker;
    };

export interface ProviderSeries {
  /** Exactly the requested ticker. */
  readonly ticker: string;
  /** ISO 4217 code of the series currency. */
  readonly currency: string;
  /** Provider name. */
  readonly source: string;
  readonly sourceKind: DataSourceKind;
  /** Retrieval time from the injected Clock, `YYYY-MM-DDTHH:mm:ss.sssZ`. */
  readonly retrievedAt: string;
  /** Received order, within the range; duplicates, weekend dates, and defects kept. */
  readonly observations: readonly ProviderObservation[];
  /** `sha256Hex(canonicalJson({ ticker, currency, observations }))`; excludes source and retrievedAt. */
  readonly contentHash: string;
}

export interface ProviderQuote {
  readonly ticker: string;
  readonly currency: string;
  /** Positive decimal, exactly as received. */
  readonly price: DecimalString;
  /** Exchange date of the quote, `YYYY-MM-DD`. */
  readonly asOf: string;
  readonly source: string;
  readonly sourceKind: DataSourceKind;
  readonly retrievedAt: string;
}

export interface MarketDataProvider {
  /** The `source` of every result. */
  readonly name: string;
  readonly kind: DataSourceKind;
  /** Throws `TypeError` for a ticker that is not a non-empty string or an invalid range. */
  getDailySeries(ticker: string, range: DateRange): Promise<Result<ProviderSeries, ProviderError>>;
  /** Throws `TypeError` for a ticker that is not a non-empty string. */
  getLatestPrice(ticker: string): Promise<Result<ProviderQuote, ProviderError>>;
}
