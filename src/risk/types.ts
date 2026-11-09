/**
 * Risk engine input and result types (task 12.2; design: Risk Engine; R14,
 * R15.8, R11.5, R32). `RiskInput` has no field for `FilingRiskScore` and must
 * never get one (R11.5). Financial values are Canonical Decimal Strings; counts
 * are native integers (R4.7).
 */
import type { FxRateUsed } from '../fx/index.js';
import type { ReturnMatrix } from '../marketdata/index.js';
import type { DecimalString } from '../shared/index.js';

/**
 * Version of the complete risk calculation (Base and Adjusted VaR). `hs-var-1`: Historical
 * Simulation Base VaR (FR-4, FR-5, FR-7), Adjusted VaR always `null`. `hs-var-2`: the `hs-var-1`
 * Base method unchanged, plus the R15 eligibility gate and the FR-6/FR-9 adjustment (tasks 14.1,
 * 14.2). Recomputation requires an exact match.
 */
export const ALGORITHM_VERSION = 'hs-var-2' as const;

/** Every calculation status (R13.7, R14.11, R14.14, R30.8, R30.11). */
export type CalcStatus =
  | 'OK'
  | 'INSUFFICIENT_DATA'
  | 'NO_POSITIONS'
  | 'INVALID_INPUT'
  | 'FX_UNAVAILABLE'
  | 'FX_STALE'
  | 'FX_DEMO_NOT_ALLOWED'
  | 'DATA_CONFLICT'
  | 'CONFIG_MISSING';

/** Statuses the engine itself can return; the others are builder preconditions. */
export type EngineStatus = 'OK' | 'INSUFFICIENT_DATA' | 'NO_POSITIONS' | 'INVALID_INPUT';

export type CalcFlag =
  | 'REDUCED_LOOKBACK'
  | 'MARKET_DATA_STALE'
  | 'NO_LOSS_AT_CONFIDENCE'
  | 'NAV_NOT_POSITIVE'
  | 'LAST_VALID'
  | 'DEMO_DATA';

/** Fixed reporting order of flags. */
export const CALC_FLAG_ORDER: readonly CalcFlag[] = [
  'REDUCED_LOOKBACK',
  'MARKET_DATA_STALE',
  'NO_LOSS_AT_CONFIDENCE',
  'NAV_NOT_POSITIVE',
  'LAST_VALID',
  'DEMO_DATA',
];

export interface RiskPosition {
  readonly ticker: string;
  /** Non-zero net signed quantity (R5.3). */
  readonly signedQuantity: DecimalString;
  /** Latest unadjusted market price in `currency` (FR-4), > 0. */
  readonly marketPrice: DecimalString;
  readonly currency: string;
  /** `OBSERVED` (CURRENT or DEMO) or `IDENTITY`; never a `StaleFxRate` (R30.8). */
  readonly fx: FxRateUsed;
  /** Source kind of the history behind the returns; `DEMO` sets `DEMO_DATA` (R25.4). */
  readonly historySourceKind: 'REAL' | 'DEMO';
}

export interface SentimentForRisk {
  readonly ticker: string;
  readonly value: DecimalString | null;
  readonly status: 'CURRENT' | 'STALE' | 'UNAVAILABLE';
  readonly sourceKind: 'REAL' | 'DEMO';
  /** Provider of the observation behind the value or status (R32.1); traceability only. */
  readonly source: string;
  /** Version of the aggregation that produced the value (R10.1), when there is one. */
  readonly aggregatorVersion?: string;
  readonly observedAt?: string;
}

export interface RiskParams {
  /** `var.confidence`, strictly between 0 and 1 (R14.2). */
  readonly confidence: DecimalString;
  /** `var.horizonDays`; exactly 1 (R14.3). */
  readonly horizonDays: number;
  readonly lookbackReturns: number;
  readonly minObservations: number;
  /** `null` exactly when `adjustmentConfigMissing` is non-empty (R15.1). */
  readonly adjustment: { readonly threshold: DecimalString; readonly multiplier: DecimalString } | null;
}

export interface RiskInput {
  readonly portfolioId: string;
  readonly baseCurrency: string;
  /** Sorted by ticker, unique; zero net quantities excluded. */
  readonly positions: readonly RiskPosition[];
  /** Explicit cash (A-7). */
  readonly cash: DecimalString;
  /** `null` only when there are no positions. */
  readonly returns: ReturnMatrix | null;
  /** Empty until sentiment ingestion exists (tasks 13.x, 14.1). */
  readonly sentiment: readonly SentimentForRisk[];
  readonly params: RiskParams;
  /** Keys of R15.1 that are missing or invalid; sorted. */
  readonly adjustmentConfigMissing: readonly string[];
  /** Decided by the input builder from `marketData.maxStalenessDays` (FR-8). */
  readonly marketDataStale: boolean;
  /** `YYYY-MM-DDTHH:mm:ss.sssZ`. Not part of the snapshot hash (R32.4). */
  readonly evaluatedAt: string;
}

export interface VarFigure {
  /** Reported VaR, floored at zero (R14.8). */
  readonly absolute: DecimalString;
  /** The raw Type 7 quantile of losses; may be negative. */
  readonly rawQuantile: DecimalString;
  /** `absolute / NAV * 100`, unrounded; `null` when NAV <= 0 (R14.9). */
  readonly percentOfNav: DecimalString | null;
}

export type AdjustedStatus =
  'APPLIED' | 'NONE_TRIGGERED' | 'ADJUSTMENT_CONFIG_MISSING' | 'SENTIMENT_NOT_CURRENT' | 'BASE_UNAVAILABLE';

export type IneligibleSentimentStatus = 'STALE' | 'UNAVAILABLE' | 'INVALID' | 'DEMO' | 'ABSENT';

export interface AdjustmentOutcome {
  readonly status: AdjustedStatus;
  readonly missingConfigKeys: readonly string[];
  readonly ineligible: readonly {
    readonly ticker: string;
    readonly sentimentStatus: IneligibleSentimentStatus;
  }[];
}

export interface TriggeredAsset {
  readonly ticker: string;
  readonly direction: 'LONG' | 'SHORT';
  readonly rawSentiment: DecimalString;
  readonly effectiveSentiment: DecimalString;
  readonly multiplier: DecimalString;
}

/** Engine result (R14.12 metadata except the configuration version and snapshot hash, added on storage). */
export interface RiskResult {
  readonly algorithmVersion: typeof ALGORITHM_VERSION;
  readonly portfolioId: string;
  readonly status: EngineStatus;
  /** Present for `INVALID_INPUT`: a fixed reason code, never input text. */
  readonly invalidReason?: string;
  readonly flags: readonly CalcFlag[];
  /** `null` for `INVALID_INPUT`. */
  readonly nav: DecimalString | null;
  readonly currency: string;
  readonly asOfDate: string | null;
  readonly observations: number;
  readonly lookbackReturns: number;
  readonly completeness: 'COMPLETE' | 'REDUCED_LOOKBACK' | null;
  /** `null` when the configured confidence is not a valid decimal. */
  readonly confidence: DecimalString | null;
  readonly horizonDays: 1;
  readonly quantileMethod: 'HYNDMAN_FAN_TYPE_7';
  readonly evaluatedAt: string;
  readonly seriesHashes: Readonly<Record<string, string>>;
  /** SHA-256 of the canonical return matrix (dates and returns); `null` without returns. */
  readonly returnsHash: string | null;
  /** `null` unless status is `OK`. */
  readonly baseVaR: VarFigure | null;
  /** Never a copy of `baseVaR` (R15.8). `null` in this phase. */
  readonly sentimentAdjustedVaR: VarFigure | null;
  readonly triggeredAssets: readonly TriggeredAsset[];
  readonly adjustmentOutcome: AdjustmentOutcome;
}
