/**
 * Risk input builder (task 12.3; design: Risk Worker and Scheduler,
 * `RiskInputBuilder`; R13.1 to R13.4, R14.4, R14.14, R30.7, R30.8, R30.11, FR-8).
 *
 * Collects positions, latest prices, FX rates, and the common-date return matrix
 * of one portfolio and returns either a `RiskInput` or a precondition error. The
 * engine is never called for a precondition error. Checks, in this order:
 *
 * 1. Base VaR configuration (`CONFIG_MISSING`, R14.14): every missing or invalid
 *    key of the `baseVaR` feature is listed, sorted. This is decided before any
 *    data is loaded. Missing or invalid adjustment and sentiment settings (R15.1)
 *    are not a precondition: they go into `adjustmentConfigMissing`, and only
 *    Adjusted VaR becomes unavailable.
 * 2. The portfolio must exist (`PORTFOLIO_NOT_FOUND`, not a calculation status).
 * 3. Positions with a non-zero net quantity (`NO_POSITIONS` when none).
 * 4. Valuation (task 11.1, one clock read): a position whose FX rate is
 *    unavailable or stale gives `FX_UNAVAILABLE` or `FX_STALE` (unavailable
 *    first) with the sorted affected currencies (R30.8). Only `FxRateUsed`
 *    values reach the input; a `StaleFxRate` never does. A missing price gives
 *    `INSUFFICIENT_DATA` with reason `PRICE_UNAVAILABLE`, and a price in another
 *    currency than the position gives `INSUFFICIENT_DATA` with reason
 *    `PRICE_CURRENCY_MISMATCH` (R13.2). Both categories are always reported:
 *    `priceIssues` holds one entry per category that occurred, in that fixed
 *    order, each with its own sorted tickers; `tickers` is their sorted union and
 *    `reason` the first entry's reason. No value is substituted and no price is
 *    converted.
 * 5. History through the injected `RiskHistorySource` (a missing series is
 *    `INSUFFICIENT_DATA`, `HISTORY_UNAVAILABLE`), then `ReturnsBuilder` (task
 *    9.3): `DATA_CONFLICT` or `INSUFFICIENT_DATA` (observations, required,
 *    limiting ticker).
 * 6. `marketDataStale` is true when the as-of date is more than
 *    `marketData.maxStalenessDays` calendar days before the calculation date
 *    (FR-8). It is a flag, not a precondition: the result is `STALE`, never
 *    `CURRENT` (R13.4, R13.7).
 *
 * Not implemented: the production-mode refusal of DEMO FX rates
 * (`FX_DEMO_NOT_ALLOWED`) waits for OD-19 (U-16). A DEMO FX rate or DEMO history
 * is passed through and the engine flags the result `DEMO_DATA` (R30.11, R25.4).
 * Sentiment (task 14.1) comes from the optional `RiskSentimentSource` port, one entry per
 * position that has any; the engine applies the eligibility gate (R15.2).
 */
import { z } from 'zod';
import type { ConfigLoadResult } from '../config/index.js';
import { readPath } from '../config/index.js';
import type { CleanResult, ReturnsBuilder } from '../marketdata/index.js';
import type { PositionRecord, UnitOfWork } from '../persistence/ports.js';
import type { Position } from '../portfolio/index.js';
import type { RiskInput, RiskPosition, SentimentForRisk } from '../risk/index.js';
import { d } from '../shared/index.js';
import type { AppError, DecimalString, Result } from '../shared/index.js';
import { IsoUtcMillis, SentimentIndexSchema, appError, err, ok } from '../shared/index.js';
import type { PositionValuationService } from './positionValuation.js';
import type { SeriesStore, StoredSeries } from './seriesStore.js';

/** The configuration view the builder needs: per-feature availability and the loaded values. */
export type RiskConfigView = Pick<ConfigLoadResult, 'features' | 'values'>;

export type HistoryError = AppError<'HISTORY_UNAVAILABLE'>;

/** Outcome of a build; the error is a precondition, not an exception. */
export type BuildOutcome<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

const fail = (
  error: RiskPreconditionError,
): { readonly ok: false; readonly error: RiskPreconditionError } => ({
  ok: false,
  error,
});

/** Port: the cleaned history of one ticker (for example from the 9.4 series store). */
export interface RiskHistorySource {
  history(ticker: string): Result<CleanResult, HistoryError>;
}

export type RiskPreconditionError =
  | { readonly status: 'CONFIG_MISSING'; readonly missingKeys: readonly string[] }
  | { readonly status: 'PORTFOLIO_NOT_FOUND' }
  | { readonly status: 'NO_POSITIONS' }
  | { readonly status: 'FX_UNAVAILABLE' | 'FX_STALE'; readonly currencies: readonly string[] }
  | {
      readonly status: 'INSUFFICIENT_DATA';
      readonly reason:
        'PRICE_UNAVAILABLE' | 'PRICE_CURRENCY_MISMATCH' | 'HISTORY_UNAVAILABLE' | 'OBSERVATIONS';
      /** Sorted; for price failures the union of every issue's tickers. */
      readonly tickers: readonly string[];
      readonly observations?: number;
      readonly required?: number;
      /**
       * Price failures only (additive, task 12.3 review): one entry per category that
       * occurred, in the fixed order `PRICE_UNAVAILABLE`, `PRICE_CURRENCY_MISMATCH`,
       * each with its own sorted tickers. `reason` is the first entry's reason.
       */
      readonly priceIssues?: readonly PriceIssue[];
    }
  | { readonly status: 'DATA_CONFLICT'; readonly tickers: readonly string[] };

export interface PriceIssue {
  readonly reason: 'PRICE_UNAVAILABLE' | 'PRICE_CURRENCY_MISMATCH';
  readonly tickers: readonly string[];
}

/** A stored series as a clean, conflict-free `CleanResult` (the store refuses conflicting series). */
export function cleanResultOf(stored: {
  readonly series: StoredSeries;
  readonly retrieval: {
    readonly source: string;
    readonly sourceKind: 'REAL' | 'DEMO';
    readonly retrievedAt: string;
  };
}): CleanResult {
  return {
    series: {
      ticker: stored.series.ticker,
      currency: stored.series.currency,
      source: stored.retrieval.source,
      sourceKind: stored.retrieval.sourceKind,
      retrievedAt: stored.retrieval.retrievedAt,
      observations: stored.series.observations,
      contentHash: stored.series.contentHash,
    },
    discarded: {
      missing: 0,
      nonFinite: 0,
      nonPositive: 0,
      nonTradingDate: 0,
      duplicateCollapsed: 0,
      conflicting: 0,
    },
    conflict: false,
    conflictDates: [],
  };
}

/**
 * `RiskHistorySource` over the 9.4 series store: the latest stored series of the
 * given source kind. The caller chooses the kind explicitly; there is no fallback
 * from one kind to the other. Stored data is labelled `CACHED` or `DEMO`, never
 * `CURRENT`; staleness of the result is decided by its as-of date (FR-8).
 */
export function seriesStoreHistory(store: SeriesStore, sourceKind: 'REAL' | 'DEMO'): RiskHistorySource {
  return {
    history: (ticker) => {
      const latest = store.latestFor(ticker, sourceKind);
      return latest.ok
        ? ok(cleanResultOf(latest.value))
        : err(appError('HISTORY_UNAVAILABLE', 'No stored history.'));
    },
  };
}

export interface RiskInputBuilder {
  build(portfolioId: string): Promise<BuildOutcome<RiskInput, RiskPreconditionError>>;
}

export interface RiskInputBuilderDependencies {
  readonly config: RiskConfigView;
  readonly unitOfWork: UnitOfWork;
  readonly valuation: PositionValuationService;
  readonly history: RiskHistorySource;
  readonly returns: ReturnsBuilder;
  /**
   * Task 14.1: the per-ticker sentiment the engine gates (for example the 13.3
   * `SentimentState`). Without it every position is `ABSENT` and Adjusted VaR is
   * unavailable (`SENTIMENT_NOT_CURRENT`); nothing is assumed.
   */
  readonly sentiment?: RiskSentimentSource;
}

const SentimentEntrySchema = z.strictObject({
  ticker: z.string().min(1),
  value: SentimentIndexSchema.nullable(),
  status: z.enum(['CURRENT', 'STALE', 'UNAVAILABLE']),
  sourceKind: z.enum(['REAL', 'DEMO']),
  source: z.string().min(1).max(128),
  aggregatorVersion: z.string().min(1).max(64).optional(),
  observedAt: IsoUtcMillis.optional(),
});

/**
 * Task 14.5 (AT-VAL-01): a sentiment entry from the port is validated before it
 * enters `RiskInput`. An entry for another ticker, or one whose value is not a
 * valid SentimentIndex, never reaches the engine: it is replaced by an
 * `UNAVAILABLE` entry without a value, so the position is ineligible and the
 * invalid text is not carried into the input or the snapshot.
 */
function checkedSentiment(ticker: string, entry: unknown): SentimentForRisk {
  const parsed = SentimentEntrySchema.safeParse(entry);
  if (parsed.success && parsed.data.ticker === ticker) {
    const { observedAt, aggregatorVersion, ...rest } = parsed.data;
    return {
      ...rest,
      ...(aggregatorVersion === undefined ? {} : { aggregatorVersion }),
      ...(observedAt === undefined ? {} : { observedAt }),
    };
  }
  const raw = (entry ?? {}) as { sourceKind?: unknown; source?: unknown };
  const source = typeof raw.source === 'string' && /^\S{1,128}$/.test(raw.source) ? raw.source : 'UNKNOWN';
  return {
    ticker,
    value: null,
    status: 'UNAVAILABLE',
    sourceKind: raw.sourceKind === 'DEMO' ? 'DEMO' : 'REAL',
    source,
  };
}

/** Port: sentiment for one ticker, or `undefined` when none was ever received. */
export interface RiskSentimentSource {
  forRisk(ticker: string): SentimentForRisk | undefined;
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

const toPosition = (record: PositionRecord): Position => ({
  id: record.id,
  portfolioId: record.portfolioId,
  ticker: record.ticker,
  currency: record.currency,
  signedQuantity: record.signedQuantity,
  averagePrice: record.averagePrice,
  isShort: record.isShort,
  updatedAt: record.updatedAt,
  source: record.source,
});

/** Days since 1970-01-01 of a `YYYY-MM-DD` date (UTC); a day count, not a financial value. */
const dayNumber = (date: string): number =>
  Date.UTC(
    Number.parseInt(date.slice(0, 4), 10),
    Number.parseInt(date.slice(5, 7), 10) - 1,
    Number.parseInt(date.slice(8, 10), 10),
  ) / 86_400_000;

/** FR-8: stale when the as-of date is more than `maxStalenessDays` calendar days before the calculation date. */
export function isMarketDataStale(asOfDate: string, evaluatedAt: string, maxStalenessDays: number): boolean {
  return dayNumber(evaluatedAt.slice(0, 10)) - dayNumber(asOfDate) > maxStalenessDays;
}

function requireValue<T>(values: unknown, key: string): T {
  const value = readPath(values, key);
  if (value === undefined) {
    // Unreachable when the feature is available: its keys are valid.
    throw new TypeError(`Configuration value ${key} is missing although its feature is available.`);
  }
  return value as T;
}

export function createRiskInputBuilder(deps: RiskInputBuilderDependencies): RiskInputBuilder {
  const { config, unitOfWork, valuation, history, returns } = deps;
  return {
    build: async (portfolioId) => {
      // 1. Configuration gate, before any data is loaded.
      const base = config.features.baseVaR;
      if (!base.available) {
        return fail({
          status: 'CONFIG_MISSING',
          missingKeys: sorted([...base.missingKeys, ...base.invalidKeys]),
        });
      }
      const adjusted = config.features.adjustedVaR;
      const adjustmentConfigMissing = sorted([...adjusted.missingKeys, ...adjusted.invalidKeys]);
      const { values } = config;
      const params: RiskInput['params'] = {
        confidence: requireValue<DecimalString>(values, 'var.confidence'),
        horizonDays: requireValue<number>(values, 'var.horizonDays'),
        lookbackReturns: requireValue<number>(values, 'var.lookbackReturns'),
        minObservations: requireValue<number>(values, 'var.minObservations'),
        adjustment:
          adjustmentConfigMissing.length > 0
            ? null
            : {
                threshold: requireValue<DecimalString>(values, 'adjustment.bearishThreshold'),
                multiplier: requireValue<DecimalString>(values, 'adjustment.multiplier'),
              },
      };
      const maxStalenessDays = requireValue<number>(values, 'marketData.maxStalenessDays');
      const maxReturnGapDays = requireValue<number>(values, 'marketData.maxReturnGapDays');

      // 2 and 3. Portfolio and non-zero positions.
      const loaded = unitOfWork.run((tx) => {
        const portfolio = tx.portfolios.get(portfolioId);
        return portfolio === undefined
          ? undefined
          : { portfolio, positions: tx.positions.listByPortfolio(portfolioId).map(toPosition) };
      });
      if (loaded === undefined) {
        return fail({ status: 'PORTFOLIO_NOT_FOUND' });
      }
      const open = loaded.positions
        .filter((p) => !d(p.signedQuantity).isZero())
        .sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
      if (open.length === 0) {
        return fail({ status: 'NO_POSITIONS' });
      }

      // 4. Prices and FX rates (one clock read inside the valuation).
      const valued = await valuation.value(portfolioId, open);
      const fxUnavailable: string[] = [];
      const fxStale: string[] = [];
      const priceMissing: string[] = [];
      const priceMismatch: string[] = [];
      const positions: Omit<RiskPosition, 'historySourceKind'>[] = [];
      for (const entry of valued.positions) {
        switch (entry.status) {
          case 'VALUED':
            positions.push({
              ticker: entry.view.ticker,
              signedQuantity: entry.view.signedQuantity,
              marketPrice: entry.price.price,
              currency: entry.view.currency,
              fx: entry.fx,
            });
            break;
          case 'FX_UNAVAILABLE':
            fxUnavailable.push(entry.view.currency);
            break;
          case 'FX_STALE':
            fxStale.push(entry.view.currency);
            break;
          case 'PRICE_CURRENCY_MISMATCH':
            priceMismatch.push(entry.view.ticker);
            break;
          case 'PRICE_UNAVAILABLE':
            priceMissing.push(entry.view.ticker);
            break;
        }
      }
      if (fxUnavailable.length > 0) {
        return fail({ status: 'FX_UNAVAILABLE', currencies: sorted(fxUnavailable) });
      }
      if (fxStale.length > 0) {
        return fail({ status: 'FX_STALE', currencies: sorted(fxStale) });
      }
      const priceIssues: PriceIssue[] = [];
      if (priceMissing.length > 0) {
        priceIssues.push({ reason: 'PRICE_UNAVAILABLE', tickers: sorted(priceMissing) });
      }
      if (priceMismatch.length > 0) {
        priceIssues.push({ reason: 'PRICE_CURRENCY_MISMATCH', tickers: sorted(priceMismatch) });
      }
      const [firstIssue] = priceIssues;
      if (firstIssue !== undefined) {
        return fail({
          status: 'INSUFFICIENT_DATA',
          reason: firstIssue.reason,
          tickers: sorted([...priceMissing, ...priceMismatch]),
          priceIssues,
        });
      }

      // 5. History and the common-date return matrix.
      const cleaned: CleanResult[] = [];
      const historyMissing: string[] = [];
      for (const position of positions) {
        const series = history.history(position.ticker);
        if (series.ok && series.value.series.ticker === position.ticker) {
          cleaned.push(series.value);
        } else {
          historyMissing.push(position.ticker);
        }
      }
      if (historyMissing.length > 0) {
        return fail({
          status: 'INSUFFICIENT_DATA',
          reason: 'HISTORY_UNAVAILABLE',
          tickers: sorted(historyMissing),
        });
      }
      const matrix = returns.build(cleaned, {
        lookbackReturns: params.lookbackReturns,
        minObservations: params.minObservations,
        maxReturnGapDays,
      });
      if (!matrix.ok) {
        const e = matrix.error;
        return e.code === 'DATA_CONFLICT'
          ? fail({ status: 'DATA_CONFLICT', tickers: e.tickers })
          : fail({
              status: 'INSUFFICIENT_DATA',
              reason: 'OBSERVATIONS',
              tickers: [e.limitingTicker],
              observations: e.observations,
              required: e.required,
            });
      }
      const kinds = new Map(cleaned.map((c) => [c.series.ticker, c.series.sourceKind]));

      // 6. Staleness flag and the input.
      return ok(
        Object.freeze({
          portfolioId,
          baseCurrency: loaded.portfolio.baseCurrency,
          positions: positions.map((p) => {
            const historySourceKind = kinds.get(p.ticker);
            if (historySourceKind === undefined) {
              throw new TypeError('Risk input builder internal error: history of a position is missing.');
            }
            return { ...p, historySourceKind };
          }),
          cash: loaded.portfolio.cash,
          returns: matrix.value,
          sentiment: positions.flatMap((p) => {
            const entry = deps.sentiment?.forRisk(p.ticker);
            return entry === undefined ? [] : [checkedSentiment(p.ticker, entry)];
          }),
          params,
          adjustmentConfigMissing,
          marketDataStale: isMarketDataStale(matrix.value.asOfDate, valued.at, maxStalenessDays),
          evaluatedAt: valued.at,
        }),
      );
    },
  };
}
