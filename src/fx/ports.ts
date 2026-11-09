/**
 * FX port and provider-level types (task 10.1; R30.3, R30.4, R30.5; design:
 * Market Data and FX, `FxService` and FX rules).
 *
 * `fx/` imports only `shared/` and `config/`. A provider returns its latest rate
 * for a currency pair observed no later than the end of the requested as-of date
 * (UTC) and no later than the calculation timestamp `at`. `rate` is the number of units of `to` per one unit of `from`. A provider
 * may answer `getRate(X, B)` with the inverse orientation `(B, X)`; `FxService`
 * converts it. Every value is validated again by `FxService` (FX rule 5): the
 * declared type is a contract, not a guarantee.
 */
import type { DataSourceKind, DecimalString, ProviderError, Result } from '../shared/index.js';

/**
 * Source kind of an FX rate used in a calculation. Local to `fx/`: the shared
 * `DataSourceKind` stays `'REAL' | 'DEMO'` (provider provenance); `IDENTITY` marks
 * the base-currency rate, which has no provider and no observation (R30.5).
 */
export type FxSourceKind = DataSourceKind | 'IDENTITY';

/**
 * How `observedAt` was obtained (task 10.4; R30.5, R30.13). `PROVIDER`: the
 * provider supplied the timestamp, and there is no `conventionId`.
 * `PUBLICATION_CONVENTION`: a documented, versioned publication-time convention
 * assigned it, named by `conventionId` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`); it
 * is never a measured observation.
 */
export type ObservedAtBasis = 'PROVIDER' | 'PUBLICATION_CONVENTION';

export interface ProviderFxRate {
  /** ISO 4217 code. */
  readonly from: string;
  /** ISO 4217 code. */
  readonly to: string;
  /** Units of `to` per one `from`; positive decimal text (fixed grammar). */
  readonly rate: DecimalString;
  /** `YYYY-MM-DDTHH:mm:ss.sssZ` (`IsoUtcMillis`). */
  readonly observedAt: string;
  /** How `observedAt` was obtained (FX rule 5, task 10.4). */
  readonly observedAtBasis: ObservedAtBasis;
  /** Present exactly for `PUBLICATION_CONVENTION`. */
  readonly conventionId?: string;
  /** OD-20: the provider's reference date `YYYY-MM-DD`, when it publishes one (the ECB does). */
  readonly referenceDate?: string;
  /** Must equal the provider's `name` (FX rule 5). */
  readonly source: string;
  /** Must equal the provider's `kind` (FX rule 5). */
  readonly sourceKind: DataSourceKind;
}

export interface FxProvider {
  /** The `source` of every rate this provider returns. */
  readonly name: string;
  readonly kind: DataSourceKind;
  /**
   * The latest rate for `(from, to)`, or its inverse `(to, from)`, with
   * `observedAt <= min(end of asOf in UTC, at)`. `asOf` is a `YYYY-MM-DD` date and
   * `at` the calculation timestamp in `IsoUtcMillis` form. No rate is
   * `HTTP_CLIENT_ERROR` 404. `FxService` validates the bound again (FX rule 6).
   *
   * `signal` is the `ResilientCall` attempt signal (U9, task 10.2): a provider that
   * does I/O passes it to its transport so a timed-out or cancelled attempt stops
   * its work. An in-code provider may ignore it.
   */
  getRate(
    from: string,
    to: string,
    asOf: string,
    at: string,
    signal: AbortSignal,
  ): Promise<Result<ProviderFxRate, ProviderError>>;
}
