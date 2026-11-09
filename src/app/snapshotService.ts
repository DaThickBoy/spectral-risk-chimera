/**
 * Calculation snapshots and reproducibility (task 12.5; design: Snapshot Service;
 * R32.1 to R32.6, R22.4, R22.5, R30.10, R11.5).
 *
 * - `buildSnapshot` turns a `RiskInput`, its `RiskResult`, the configuration
 *   version, and display-only filing scores into a `CalculationSnapshot`:
 *   positions sorted by ticker with their base-currency value (FR-4), FX rates
 *   sorted by pair (identity rates included), series hashes, the return-matrix
 *   hash, parameters, the adjusted outcome, and the algorithm version.
 * - `inputsCanonical = canonicalJson(snapshot without displayOnly)` and
 *   `hash = SHA-256(inputsCanonical)` (R32.3, R32.4). The calculation timestamp
 *   (`evaluatedAt`) and generated ids are not in the body. Filing scores live only
 *   in `displayOnly`, so they can never change the hash (R11.5, AT-REP-09).
 *   Because the configuration version is in the body, any configuration change
 *   changes the hash as well as the version (R32.5).
 * - `recomputeFromSnapshot` validates a stored snapshot with Zod, reloads every
 *   series by its content hash from the series store (task 9.4), rebuilds the
 *   return matrix with the stored options, checks that it hashes to the stored
 *   `returnsHash`, rebuilds the `RiskInput`, and runs the engine again. The same
 *   snapshot always gives the same Base VaR strings (R32.2). Byte-identical
 *   output is claimed for `inputsCanonical` only (R32.6).
 *
 * `schemaVersion` is 1 (design: FX union, observedAtBasis, and DEMO_DATA were
 * defined before the first snapshot). Changing the body shape increments it.
 */
import { z } from 'zod';
import type { ConfigVersion } from '../config/index.js';
import type { FxRateUsed } from '../fx/index.js';
import type { ReturnsBuilder } from '../marketdata/index.js';
import { ALGORITHM_VERSION, exposureOf } from '../risk/index.js';
import type {
  AdjustmentOutcome,
  RiskEngine,
  RiskInput,
  RiskResult,
  SentimentForRisk,
  TriggeredAsset,
} from '../risk/index.js';
import {
  DecimalStringSchema,
  IsoDate,
  IsoUtcMillis,
  appError,
  canonicalJson,
  err,
  ok,
  sha256Hex,
  toCanonical,
} from '../shared/index.js';
import type { AppError, DecimalString, Result } from '../shared/index.js';
import { cleanResultOf } from './riskInputBuilder.js';
import type { SeriesStore } from './seriesStore.js';

/**
 * Snapshot body version (R32.1). 1: task 12.5 and 14.4 shape (sentiment entries without source).
 * 2: sentiment entries also carry `source` and an optional `aggregatorVersion` (written from
 * `hs-var-2`). Version 1 snapshots are still validated and hash-checked exactly as before.
 */
export const SNAPSHOT_SCHEMA_VERSION = 2 as const;

/** A filing score shown beside a result; display only, never a calculation input (R32.1). */
export interface FilingScoreDisplay {
  readonly ticker: string;
  readonly score: DecimalString | null;
  readonly status: string;
}

export interface DisplayOnly {
  readonly filingScores: readonly FilingScoreDisplay[];
}

export interface SnapshotPosition {
  readonly ticker: string;
  readonly signedQuantity: DecimalString;
  readonly marketPrice: DecimalString;
  readonly currency: string;
  /** `signedQuantity * marketPrice * Rate(X/B)` (FR-4). */
  readonly valueBase: DecimalString;
  readonly fxPair: string;
  readonly historySourceKind: 'REAL' | 'DEMO';
}

export interface SnapshotBody {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly algorithmVersion: string;
  readonly portfolioId: string;
  readonly asOfDate: string;
  readonly configVersion: ConfigVersion;
  readonly baseCurrency: string;
  readonly cash: DecimalString;
  readonly params: {
    readonly confidence: DecimalString;
    readonly lookbackReturns: number;
    readonly minObservations: number;
    readonly maxReturnGapDays: number;
    readonly observations: number;
    readonly horizonDays: 1;
    readonly quantileMethod: 'HYNDMAN_FAN_TYPE_7';
    readonly adjustment: { readonly threshold: DecimalString; readonly multiplier: DecimalString } | null;
  };
  readonly adjustmentConfigMissing: readonly string[];
  readonly marketDataStale: boolean;
  readonly adjustmentOutcome: AdjustmentOutcome;
  readonly positions: readonly SnapshotPosition[];
  readonly seriesHashes: Readonly<Record<string, string>>;
  readonly returnsHash: string;
  readonly fxRates: readonly FxRateUsed[];
  /** Sorted by ticker; exactly the sentiment entries the engine received (task 14.4). */
  readonly sentiment: readonly SentimentForRisk[];
  readonly triggeredAssets: readonly TriggeredAsset[];
}

export interface CalculationSnapshot extends SnapshotBody {
  readonly displayOnly: DisplayOnly;
}

export interface BuiltSnapshot {
  readonly snapshot: CalculationSnapshot;
  readonly inputsCanonical: string;
  readonly hash: string;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Builds the snapshot of one calculation. Requires an engine run with a return matrix. */
export function buildSnapshot(
  input: RiskInput,
  result: RiskResult,
  configVersion: ConfigVersion,
  maxReturnGapDays: number,
  display: DisplayOnly,
): BuiltSnapshot {
  const matrix = input.returns;
  if (matrix === null || result.returnsHash === null || result.confidence === null) {
    throw new TypeError('buildSnapshot requires a calculation with a return matrix.');
  }
  const fx = new Map<string, FxRateUsed>();
  for (const position of input.positions) {
    fx.set(position.fx.pair, position.fx);
  }
  const body: SnapshotBody = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    algorithmVersion: result.algorithmVersion,
    portfolioId: input.portfolioId,
    asOfDate: matrix.asOfDate,
    configVersion: { seq: configVersion.seq, hash: configVersion.hash },
    baseCurrency: input.baseCurrency,
    cash: input.cash,
    params: {
      confidence: result.confidence,
      lookbackReturns: input.params.lookbackReturns,
      minObservations: input.params.minObservations,
      maxReturnGapDays,
      observations: matrix.n,
      horizonDays: 1,
      quantileMethod: 'HYNDMAN_FAN_TYPE_7',
      adjustment: input.params.adjustment,
    },
    adjustmentConfigMissing: [...input.adjustmentConfigMissing].sort(byText),
    marketDataStale: input.marketDataStale,
    adjustmentOutcome: result.adjustmentOutcome,
    positions: [...input.positions]
      .sort((a, b) => byText(a.ticker, b.ticker))
      .map((p) => ({
        ticker: p.ticker,
        signedQuantity: p.signedQuantity,
        marketPrice: p.marketPrice,
        currency: p.currency,
        valueBase: toCanonical(exposureOf(p)),
        fxPair: p.fx.pair,
        historySourceKind: p.historySourceKind,
      })),
    seriesHashes: { ...matrix.seriesHashes },
    returnsHash: result.returnsHash,
    fxRates: [...fx.values()].sort((a, b) => byText(a.pair, b.pair)),
    sentiment: [...input.sentiment].sort((a, b) => byText(a.ticker, b.ticker)),
    triggeredAssets: [...result.triggeredAssets].sort((a, b) => byText(a.ticker, b.ticker)),
  };
  const inputsCanonical = canonicalJson(body);
  return Object.freeze({
    snapshot: { ...body, displayOnly: { filingScores: [...display.filingScores] } },
    inputsCanonical,
    hash: sha256Hex(inputsCanonical),
  });
}

// ---- Read-back validation (data read back from persistence, financial-rules 8) ----

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Currency = z.string().regex(/^[A-Z]{3}$/);
const Ticker = z.string().min(1);

const FxRateUsedSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('OBSERVED'),
    pair: z.string().regex(/^[A-Z]{6}$/),
    rate: DecimalStringSchema,
    observedAt: IsoUtcMillis,
    observedAtBasis: z.enum(['PROVIDER', 'PUBLICATION_CONVENTION']),
    conventionId: z.string().min(1).optional(),
    source: z.string().min(1),
    sourceKind: z.enum(['REAL', 'DEMO']),
    status: z.enum(['CURRENT', 'DEMO']),
  }),
  z.strictObject({
    kind: z.literal('IDENTITY'),
    pair: z.string().regex(/^[A-Z]{6}$/),
    rate: z.literal('1'),
    observedAt: z.null(),
    source: z.literal('BASE_CURRENCY'),
    sourceKind: z.literal('IDENTITY'),
    status: z.literal('CURRENT'),
  }),
]);

export const AdjustmentOutcomeSchema = z.strictObject({
  status: z.enum([
    'APPLIED',
    'NONE_TRIGGERED',
    'ADJUSTMENT_CONFIG_MISSING',
    'SENTIMENT_NOT_CURRENT',
    'BASE_UNAVAILABLE',
  ]),
  missingConfigKeys: z.array(z.string().min(1)),
  ineligible: z.array(
    z.strictObject({
      ticker: Ticker,
      sentimentStatus: z.enum(['STALE', 'UNAVAILABLE', 'INVALID', 'DEMO', 'ABSENT']),
    }),
  ),
});

export const TriggeredAssetSchema = z.strictObject({
  ticker: Ticker,
  direction: z.enum(['LONG', 'SHORT']),
  rawSentiment: DecimalStringSchema,
  effectiveSentiment: DecimalStringSchema,
  multiplier: DecimalStringSchema,
});

const snapshotShape = {
  algorithmVersion: z.string().min(1),
  portfolioId: z.string().min(1),
  asOfDate: IsoDate,
  configVersion: z.strictObject({ seq: z.int().positive(), hash: Hash }),
  baseCurrency: Currency,
  cash: DecimalStringSchema,
  params: z.strictObject({
    confidence: DecimalStringSchema,
    lookbackReturns: z.int().min(2),
    minObservations: z.int().min(2),
    maxReturnGapDays: z.int().min(1),
    observations: z.int().nonnegative(),
    horizonDays: z.literal(1),
    quantileMethod: z.literal('HYNDMAN_FAN_TYPE_7'),
    adjustment: z
      .strictObject({ threshold: DecimalStringSchema, multiplier: DecimalStringSchema })
      .nullable(),
  }),
  adjustmentConfigMissing: z.array(z.string().min(1)),
  marketDataStale: z.boolean(),
  adjustmentOutcome: AdjustmentOutcomeSchema,
  positions: z.array(
    z.strictObject({
      ticker: Ticker,
      signedQuantity: DecimalStringSchema,
      marketPrice: DecimalStringSchema,
      currency: Currency,
      valueBase: DecimalStringSchema,
      fxPair: z.string().regex(/^[A-Z]{6}$/),
      historySourceKind: z.enum(['REAL', 'DEMO']),
    }),
  ),
  seriesHashes: z.record(Ticker, Hash),
  returnsHash: Hash,
  fxRates: z.array(FxRateUsedSchema),
  triggeredAssets: z.array(TriggeredAssetSchema),
  displayOnly: z.strictObject({
    filingScores: z.array(
      z.strictObject({ ticker: Ticker, score: DecimalStringSchema.nullable(), status: z.string().min(1) }),
    ),
  }),
};

const sentimentEntryV1 = {
  ticker: Ticker,
  value: z.string().min(1).max(64).nullable(),
  status: z.enum(['CURRENT', 'STALE', 'UNAVAILABLE']),
  sourceKind: z.enum(['REAL', 'DEMO']),
  observedAt: IsoUtcMillis.optional(),
};

/** Version 1 (tasks 12.5, 14.4): unchanged, so stored version 1 snapshots validate and hash as before. */
export const CalculationSnapshotV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  ...snapshotShape,
  sentiment: z.array(z.strictObject(sentimentEntryV1)),
});

/** Version 2: every sentiment entry also records its source and, when there is one, the aggregator version. */
export const CalculationSnapshotV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  ...snapshotShape,
  sentiment: z.array(
    z.strictObject({
      ...sentimentEntryV1,
      source: z.string().min(1).max(128),
      aggregatorVersion: z.string().min(1).max(64).optional(),
    }),
  ),
});

export const CalculationSnapshotSchema = z.discriminatedUnion('schemaVersion', [
  CalculationSnapshotV1Schema,
  CalculationSnapshotV2Schema,
]);

export type RecomputeError =
  | AppError<'SNAPSHOT_INVALID'>
  | AppError<'SERIES_UNAVAILABLE'>
  | AppError<'RETURNS_MISMATCH'>
  | AppError<'ALGORITHM_VERSION_MISMATCH'>
  | AppError<'SCHEMA_VERSION_UNSUPPORTED'>;

export interface RecomputeDependencies {
  readonly seriesStore: SeriesStore;
  readonly returns: ReturnsBuilder;
  readonly engine: RiskEngine;
}

/** Validates stored snapshot text and hash, reloads the series by hash, and runs the engine again. */
export function recomputeFromSnapshot(
  stored: {
    readonly snapshot: string;
    readonly inputsCanonical: string;
    readonly hash: string;
    readonly evaluatedAt: string;
  },
  deps: RecomputeDependencies,
): Result<{ readonly input: RiskInput; readonly result: RiskResult }, RecomputeError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored.snapshot); // our own canonical text; validated below
  } catch {
    return err(appError('SNAPSHOT_INVALID', 'The stored snapshot is not valid JSON.'));
  }
  const checked = CalculationSnapshotSchema.safeParse(parsed);
  if (!checked.success) {
    return err(appError('SNAPSHOT_INVALID', 'The stored snapshot does not match the snapshot schema.'));
  }
  // Hash verification is the same for every schema version (R32.4).
  const body = Object.fromEntries(Object.entries(checked.data).filter(([key]) => key !== 'displayOnly'));
  const inputsCanonical = canonicalJson(body);
  if (inputsCanonical !== stored.inputsCanonical || sha256Hex(inputsCanonical) !== stored.hash) {
    return err(appError('SNAPSHOT_INVALID', 'The stored snapshot does not match its hash.'));
  }
  // Recomputation requires the exact algorithm version, then the current schema version.
  if (checked.data.algorithmVersion !== ALGORITHM_VERSION) {
    return err(
      appError('ALGORITHM_VERSION_MISMATCH', 'The snapshot was produced by another algorithm version.'),
    );
  }
  if (checked.data.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    return err(appError('SCHEMA_VERSION_UNSUPPORTED', 'The snapshot schema version cannot be recomputed.'));
  }
  const snapshot = checked.data as CalculationSnapshot;
  const cleaned = [];
  for (const [ticker, hash] of Object.entries(snapshot.seriesHashes)) {
    const series = deps.seriesStore.getByHash(hash);
    const retrieval = series.ok ? series.value.retrievals[0] : undefined;
    if (!series.ok || retrieval === undefined || series.value.series.ticker !== ticker) {
      return err(appError('SERIES_UNAVAILABLE', 'A series of the snapshot is not available by its hash.'));
    }
    cleaned.push(cleanResultOf({ series: series.value.series, retrieval }));
  }
  const matrix = deps.returns.build(cleaned, {
    lookbackReturns: snapshot.params.lookbackReturns,
    minObservations: snapshot.params.minObservations,
    maxReturnGapDays: snapshot.params.maxReturnGapDays,
  });
  if (!matrix.ok) {
    return err(appError('RETURNS_MISMATCH', 'The return matrix could not be rebuilt from the snapshot.'));
  }
  const fx = new Map(snapshot.fxRates.map((rate) => [rate.pair, rate]));
  const positions = snapshot.positions.map((p) => {
    const rate = fx.get(p.fxPair);
    if (rate === undefined) {
      return undefined;
    }
    return {
      ticker: p.ticker,
      signedQuantity: p.signedQuantity,
      marketPrice: p.marketPrice,
      currency: p.currency,
      fx: rate,
      historySourceKind: p.historySourceKind,
    };
  });
  if (positions.some((p) => p === undefined)) {
    return err(appError('SNAPSHOT_INVALID', 'A position of the snapshot has no FX rate.'));
  }
  const input: RiskInput = {
    portfolioId: snapshot.portfolioId,
    baseCurrency: snapshot.baseCurrency,
    positions: positions.filter((p) => p !== undefined),
    cash: snapshot.cash,
    returns: matrix.value,
    sentiment: snapshot.sentiment,
    params: {
      confidence: snapshot.params.confidence,
      horizonDays: snapshot.params.horizonDays,
      lookbackReturns: snapshot.params.lookbackReturns,
      minObservations: snapshot.params.minObservations,
      adjustment: snapshot.params.adjustment,
    },
    adjustmentConfigMissing: snapshot.adjustmentConfigMissing,
    marketDataStale: snapshot.marketDataStale,
    evaluatedAt: stored.evaluatedAt,
  };
  const result = deps.engine.compute(input);
  if (result.returnsHash !== snapshot.returnsHash) {
    return err(appError('RETURNS_MISMATCH', 'The rebuilt return matrix differs from the snapshot.'));
  }
  return ok({ input, result });
}
