/**
 * Risk calculation and result service (tasks 12.3, 12.5, 12.6; design: Risk
 * Worker and Scheduler, Snapshot Service, `ResultValidityPolicy`; R13.5, R13.7,
 * R14.12, R14.14, R17.10, R32.1, R32.4).
 *
 * `calculate(portfolioId)`:
 * - builds the input (12.3). A precondition error stores a result row with that
 *   status, the reason details, and no figures; the earlier results stay, so the
 *   last valid one is shown as `LAST_VALID` (R13.5, R14.14).
 * - otherwise runs the engine through the injected `compute` function (the
 *   worker in 12.4, or the engine directly), builds the snapshot (12.5), and
 *   stores snapshot and result together in one unit of work. The result carries
 *   the configuration version and snapshot hash (R14.12).
 *
 * `view(portfolioId)` reads the latest stored result and derives Base and
 * Adjusted validity separately (`deriveValidity`). When a figure is not
 * available, the most recent earlier result with that figure is attached as
 * `lastValid` (validity `LAST_VALID`, with its calculation time); the Base
 * figure is never put into the Adjusted entry (R17.10, R35.6). Stored rows are
 * validated with Zod on every read.
 *
 * `snapshot(portfolioId, hash)` returns the latest stored snapshot with that hash.
 * `recompute(snapshotId)` reruns the engine from a stored snapshot (R32.2).
 * `scenarioLosses(portfolioId)` (Kiroween A2) returns the latest result's Base VaR scenario
 * losses, recomputed from its verified snapshot, for the dashboard loss distribution. Nothing is
 * stored, and the stored result and snapshot are unchanged.
 */
import { z } from 'zod';
import type { ConfigVersion } from '../config/index.js';
import type { ReturnsBuilder } from '../marketdata/index.js';
import { PersistenceError } from '../persistence/ports.js';
import type { RiskResultRecord, SnapshotRecord, UnitOfWork } from '../persistence/ports.js';
import { deriveValidity, scenarioLosses } from '../risk/index.js';
import type {
  AdjustedStatus,
  AdjustmentOutcome,
  CalcFlag,
  CalcStatus,
  TriggeredAsset,
  RiskEngine,
  RiskInput,
  RiskResult,
  Validity,
  VarFigure,
} from '../risk/index.js';
import { DecimalStringSchema, IsoDate, IsoUtcMillis, canonicalJson } from '../shared/index.js';
import type { Clock, Decimal, DecimalString, IdGenerator, Result } from '../shared/index.js';
import type { PriceIssue, RiskInputBuilder, RiskPreconditionError } from './riskInputBuilder.js';
import {
  AdjustmentOutcomeSchema,
  TriggeredAssetSchema,
  buildSnapshot,
  recomputeFromSnapshot,
} from './snapshotService.js';
import type { DisplayOnly, RecomputeError } from './snapshotService.js';
import type { SeriesStore } from './seriesStore.js';

export interface RiskServiceDependencies {
  readonly builder: RiskInputBuilder;
  /** The worker client (12.4) or the pure engine. */
  readonly compute: (input: RiskInput) => Promise<RiskResult>;
  readonly engine: RiskEngine;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly configVersion: ConfigVersion;
  /** `marketData.maxReturnGapDays`, stored in the snapshot for recomputation. */
  readonly maxReturnGapDays: number;
  readonly seriesStore: SeriesStore;
  readonly returns: ReturnsBuilder;
  /** Filing scores shown beside the result (display only). */
  readonly display: (portfolioId: string) => DisplayOnly;
}

export type CalculationOutcome =
  | { readonly status: 'STORED'; readonly resultId: string; readonly calcStatus: CalcStatus }
  | { readonly status: 'PORTFOLIO_NOT_FOUND' }
  | { readonly status: 'COMMIT_FAILED' };

export interface VarEntry {
  readonly validity: Validity;
  readonly value: VarFigure | null;
  readonly status: CalcStatus | AdjustedStatus;
  readonly reason: string | null;
  readonly missingKeys: readonly string[];
  readonly lastValid: {
    readonly value: VarFigure;
    readonly calculatedAt: string;
    readonly snapshotHash: string;
  } | null;
}

export interface RiskView {
  readonly portfolioId: string;
  readonly calculatedAt: string;
  readonly status: CalcStatus;
  readonly flags: readonly CalcFlag[];
  readonly currency: string | null;
  readonly nav: DecimalString | null;
  readonly asOfDate: string | null;
  readonly observations: number;
  readonly lookbackReturns: number | null;
  readonly completeness: 'COMPLETE' | 'REDUCED_LOOKBACK' | null;
  readonly confidence: DecimalString | null;
  readonly horizonDays: 1;
  readonly quantileMethod: 'HYNDMAN_FAN_TYPE_7';
  readonly algorithmVersion: string | null;
  readonly configVersion: ConfigVersion;
  readonly snapshotHash: string | null;
  readonly seriesHashes: Readonly<Record<string, string>>;
  readonly precondition: {
    readonly currencies: readonly string[];
    readonly tickers: readonly string[];
    readonly observations?: number;
    readonly required?: number;
    /** Price failures only: every category with its own sorted tickers. */
    readonly priceIssues?: readonly PriceIssue[];
  } | null;
  readonly baseVaR: VarEntry;
  readonly adjustedVaR: VarEntry;
}

export interface AdjustmentDetail {
  readonly triggeredAssets: readonly TriggeredAsset[];
  readonly ineligible: AdjustmentOutcome['ineligible'];
}

export interface RiskService {
  calculate(portfolioId: string): Promise<CalculationOutcome>;
  view(portfolioId: string): RiskView | undefined;
  /**
   * Task 17.1: adjustment details of the latest stored result (triggered assets
   * with direction and effective sentiment; tickers whose sentiment was not
   * eligible). Empty lists when no calculation ran; `undefined` without a result.
   */
  adjustmentDetail(portfolioId: string): AdjustmentDetail | undefined;
  snapshot(portfolioId: string, hash: string): SnapshotRecord | undefined;
  /**
   * Kiroween A2: the Base VaR scenario losses of the latest stored result, recomputed from its
   * stored snapshot (hash and returns hash verified, R32.4), in date order. `undefined`
   * without a result.
   */
  scenarioLosses(portfolioId: string): ScenarioLossesOutcome | undefined;
  recompute(
    snapshotId: string,
  ): Result<RiskResult, RecomputeError | { readonly code: 'NOT_FOUND'; readonly message: string }>;
}

export type ScenarioLossesOutcome =
  | {
      readonly status: 'OK';
      /** `scenarioLosses(input)` (FR-5), unrounded, in date order. */
      readonly losses: readonly Decimal[];
      /** End dates of the first and last return in the scenario window. */
      readonly firstDate: string;
      readonly lastDate: string;
      readonly confidence: DecimalString;
      /** The recomputed raw Type 7 quantile, for the consistency check with the stored figure. */
      readonly rawQuantile: DecimalString;
      readonly snapshotHash: string;
    }
  /** The latest result has no snapshot (a precondition failure or no return matrix). */
  | { readonly status: 'NO_SNAPSHOT' }
  /** The recomputed result has no Base VaR. */
  | { readonly status: 'BASE_VAR_UNAVAILABLE' }
  | { readonly status: 'SNAPSHOT_RECOMPUTE_FAILED'; readonly code: string };

// ---- Stored body (canonical JSON in risk_results.body) ----

const VarFigureSchema = z.strictObject({
  absolute: DecimalStringSchema,
  rawQuantile: DecimalStringSchema,
  percentOfNav: DecimalStringSchema.nullable(),
});
const FLAGS = [
  'REDUCED_LOOKBACK',
  'MARKET_DATA_STALE',
  'NO_LOSS_AT_CONFIDENCE',
  'NAV_NOT_POSITIVE',
  'LAST_VALID',
  'DEMO_DATA',
] as const;
/** A `RiskResult` read back from storage or from the worker thread. */
export const RiskResultSchema = z.strictObject({
  algorithmVersion: z.string().min(1),
  portfolioId: z.string().min(1),
  status: z.enum(['OK', 'INSUFFICIENT_DATA', 'NO_POSITIONS', 'INVALID_INPUT']),
  invalidReason: z.string().min(1).optional(),
  flags: z.array(z.enum(FLAGS)),
  nav: DecimalStringSchema.nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  asOfDate: IsoDate.nullable(),
  observations: z.int().nonnegative(),
  lookbackReturns: z.int(),
  completeness: z.enum(['COMPLETE', 'REDUCED_LOOKBACK']).nullable(),
  confidence: DecimalStringSchema.nullable(),
  horizonDays: z.literal(1),
  quantileMethod: z.literal('HYNDMAN_FAN_TYPE_7'),
  evaluatedAt: IsoUtcMillis,
  seriesHashes: z.record(z.string(), z.string()),
  returnsHash: z.string().nullable(),
  baseVaR: VarFigureSchema.nullable(),
  sentimentAdjustedVaR: VarFigureSchema.nullable(),
  triggeredAssets: z.array(TriggeredAssetSchema),
  adjustmentOutcome: AdjustmentOutcomeSchema,
});
const CALCULATED = z.strictObject({ kind: z.literal('CALCULATED'), result: RiskResultSchema });
const PRECONDITION = z.strictObject({
  kind: z.literal('PRECONDITION'),
  status: z.enum([
    'CONFIG_MISSING',
    'NO_POSITIONS',
    'FX_UNAVAILABLE',
    'FX_STALE',
    'INSUFFICIENT_DATA',
    'DATA_CONFLICT',
  ]),
  reason: z.string().min(1).nullable(),
  missingKeys: z.array(z.string()),
  currencies: z.array(z.string()),
  tickers: z.array(z.string()),
  observations: z.int().nonnegative().optional(),
  required: z.int().nonnegative().optional(),
  priceIssues: z
    .array(
      z.strictObject({
        reason: z.enum(['PRICE_UNAVAILABLE', 'PRICE_CURRENCY_MISMATCH']),
        tickers: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1)
    .optional(),
});
const StoredBodySchema = z.discriminatedUnion('kind', [CALCULATED, PRECONDITION]);
type StoredBody = z.infer<typeof StoredBodySchema>;

function preconditionBody(
  error: Exclude<RiskPreconditionError, { status: 'PORTFOLIO_NOT_FOUND' }>,
): StoredBody {
  return {
    kind: 'PRECONDITION',
    status: error.status,
    reason: error.status === 'INSUFFICIENT_DATA' ? error.reason : null,
    missingKeys: error.status === 'CONFIG_MISSING' ? [...error.missingKeys] : [],
    currencies: error.status === 'FX_UNAVAILABLE' || error.status === 'FX_STALE' ? [...error.currencies] : [],
    tickers:
      error.status === 'INSUFFICIENT_DATA' || error.status === 'DATA_CONFLICT' ? [...error.tickers] : [],
    ...(error.status === 'INSUFFICIENT_DATA' && error.observations !== undefined
      ? { observations: error.observations }
      : {}),
    ...(error.status === 'INSUFFICIENT_DATA' && error.required !== undefined
      ? { required: error.required }
      : {}),
    ...(error.status === 'INSUFFICIENT_DATA' && error.priceIssues !== undefined
      ? {
          priceIssues: error.priceIssues.map((issue) => ({
            reason: issue.reason,
            tickers: [...issue.tickers],
          })),
        }
      : {}),
  };
}

interface Parsed {
  readonly record: RiskResultRecord;
  readonly body: StoredBody;
}

function parseRecord(record: RiskResultRecord): Parsed {
  const body = StoredBodySchema.safeParse(JSON.parse(record.body)); // our own canonical text; validated
  if (!body.success) {
    throw new TypeError('A stored risk result does not match its schema.');
  }
  return { record, body: body.data };
}

const baseFigure = (p: Parsed): VarFigure | null =>
  p.body.kind === 'CALCULATED' && p.body.result.status === 'OK'
    ? (p.body.result.baseVaR as VarFigure | null)
    : null;
const adjustedFigure = (p: Parsed): VarFigure | null =>
  p.body.kind === 'CALCULATED' ? (p.body.result.sentimentAdjustedVaR as VarFigure | null) : null;

function lastValidOf(
  earlier: readonly Parsed[],
  figure: (p: Parsed) => VarFigure | null,
): VarEntry['lastValid'] {
  for (let i = earlier.length - 1; i >= 0; i -= 1) {
    const candidate = earlier[i];
    const value = candidate === undefined ? null : figure(candidate);
    if (candidate !== undefined && value !== null && candidate.record.snapshotHash !== null) {
      return {
        value,
        calculatedAt: candidate.record.calculatedAt,
        snapshotHash: candidate.record.snapshotHash,
      };
    }
  }
  return null;
}

export function createRiskService(deps: RiskServiceDependencies): RiskService {
  const { unitOfWork, clock, ids } = deps;
  const now = (): string => clock.nowUtc().toISOString();
  const versionFields = {
    configVersionSeq: deps.configVersion.seq,
    configVersionHash: deps.configVersion.hash,
  };

  const store = (records: { result: RiskResultRecord; snapshot?: SnapshotRecord }): CalculationOutcome => {
    try {
      unitOfWork.run((tx) => {
        if (records.snapshot !== undefined) {
          tx.snapshots.insert(records.snapshot);
        }
        tx.riskResults.append(records.result);
      });
    } catch (error) {
      if (error instanceof PersistenceError) {
        return { status: 'COMMIT_FAILED' };
      }
      throw error;
    }
    return { status: 'STORED', resultId: records.result.id, calcStatus: records.result.status as CalcStatus };
  };

  return {
    calculate: async (portfolioId) => {
      const built = await deps.builder.build(portfolioId);
      if (!built.ok) {
        if (built.error.status === 'PORTFOLIO_NOT_FOUND') {
          return { status: 'PORTFOLIO_NOT_FOUND' };
        }
        return store({
          result: {
            id: ids.next(),
            portfolioId,
            calculatedAt: now(),
            status: built.error.status,
            ...versionFields,
            snapshotHash: null,
            snapshotId: null,
            body: canonicalJson(preconditionBody(built.error)),
          },
        });
      }
      const input = built.value;
      const result = await deps.compute(input);
      const body = canonicalJson({ kind: 'CALCULATED', result });
      if (input.returns === null || result.returnsHash === null || result.confidence === null) {
        return store({
          result: {
            id: ids.next(),
            portfolioId,
            calculatedAt: now(),
            status: result.status,
            ...versionFields,
            snapshotHash: null,
            snapshotId: null,
            body,
          },
        });
      }
      const built2 = buildSnapshot(
        input,
        result,
        deps.configVersion,
        deps.maxReturnGapDays,
        deps.display(portfolioId),
      );
      const createdAt = now();
      const snapshotId = ids.next();
      return store({
        snapshot: {
          id: snapshotId,
          portfolioId,
          hash: built2.hash,
          createdAt,
          evaluatedAt: input.evaluatedAt,
          snapshot: canonicalJson(built2.snapshot),
          inputsCanonical: built2.inputsCanonical,
        },
        result: {
          id: ids.next(),
          portfolioId,
          calculatedAt: createdAt,
          status: result.status,
          ...versionFields,
          snapshotHash: built2.hash,
          snapshotId,
          body,
        },
      });
    },

    view: (portfolioId) => {
      const rows = unitOfWork.run((tx) => tx.riskResults.listByPortfolio(portfolioId)).map(parseRecord);
      const latest = rows.at(-1);
      if (latest === undefined) {
        return undefined;
      }
      const earlier = rows.slice(0, -1);
      const { body, record } = latest;
      const calculated = body.kind === 'CALCULATED' ? body.result : null;
      const status: CalcStatus =
        calculated?.status ?? (body.kind === 'PRECONDITION' ? body.status : 'INVALID_INPUT');
      const flags = (calculated?.flags ?? []) as CalcFlag[];
      const adjustedStatus: AdjustedStatus = calculated?.adjustmentOutcome.status ?? 'BASE_UNAVAILABLE';
      const { baseValidity, adjustedValidity } = deriveValidity({
        status,
        flags,
        adjustedStatus,
        retained: false,
      });
      const baseValue = baseValidity === 'UNAVAILABLE' ? null : baseFigure(latest);
      const adjustedValue = adjustedValidity === 'UNAVAILABLE' ? null : adjustedFigure(latest);
      const preconditionReason = body.kind === 'PRECONDITION' ? body.reason : null;
      return {
        portfolioId,
        calculatedAt: record.calculatedAt,
        status,
        flags,
        currency: calculated?.currency ?? null,
        nav: (calculated?.nav ?? null) as DecimalString | null,
        asOfDate: calculated?.asOfDate ?? null,
        observations:
          calculated?.observations ?? (body.kind === 'PRECONDITION' ? (body.observations ?? 0) : 0),
        lookbackReturns: calculated?.lookbackReturns ?? null,
        completeness: calculated?.completeness ?? null,
        confidence: (calculated?.confidence ?? null) as DecimalString | null,
        horizonDays: 1,
        quantileMethod: 'HYNDMAN_FAN_TYPE_7',
        algorithmVersion: calculated?.algorithmVersion ?? null,
        configVersion: { seq: record.configVersionSeq, hash: record.configVersionHash },
        snapshotHash: record.snapshotHash,
        seriesHashes: calculated?.seriesHashes ?? {},
        precondition:
          body.kind === 'PRECONDITION'
            ? {
                currencies: body.currencies,
                tickers: body.tickers,
                ...(body.observations === undefined ? {} : { observations: body.observations }),
                ...(body.required === undefined ? {} : { required: body.required }),
                ...(body.priceIssues === undefined ? {} : { priceIssues: body.priceIssues }),
              }
            : null,
        baseVaR: {
          validity: baseValidity,
          value: baseValue,
          status,
          reason: calculated?.invalidReason ?? preconditionReason,
          missingKeys: body.kind === 'PRECONDITION' ? body.missingKeys : [],
          lastValid: baseValue === null ? lastValidOf(earlier, baseFigure) : null,
        },
        adjustedVaR: {
          validity: adjustedValidity,
          value: adjustedValue,
          status: adjustedStatus,
          reason: adjustedStatus === 'BASE_UNAVAILABLE' || adjustedValue !== null ? null : adjustedStatus,
          missingKeys:
            calculated?.adjustmentOutcome.missingConfigKeys ??
            (body.kind === 'PRECONDITION' ? body.missingKeys : []),
          lastValid: adjustedValue === null ? lastValidOf(earlier, adjustedFigure) : null,
        },
      };
    },

    adjustmentDetail: (portfolioId) => {
      const latest = unitOfWork
        .run((tx) => tx.riskResults.listByPortfolio(portfolioId))
        .map(parseRecord)
        .at(-1);
      if (latest === undefined) {
        return undefined;
      }
      if (latest.body.kind !== 'CALCULATED') {
        return { triggeredAssets: [], ineligible: [] };
      }
      const { triggeredAssets, adjustmentOutcome } = latest.body.result;
      return { triggeredAssets, ineligible: adjustmentOutcome.ineligible } as AdjustmentDetail;
    },

    snapshot: (portfolioId, hash) =>
      unitOfWork.run((tx) =>
        tx.snapshots
          .listByHash(hash)
          .filter((s) => s.portfolioId === portfolioId)
          .at(-1),
      ),

    scenarioLosses: (portfolioId) => {
      const latest = unitOfWork.run((tx) => tx.riskResults.listByPortfolio(portfolioId)).at(-1);
      if (latest === undefined) {
        return undefined;
      }
      const snapshotId = latest.snapshotId;
      const stored = snapshotId === null ? undefined : unitOfWork.run((tx) => tx.snapshots.get(snapshotId));
      if (stored === undefined || latest.snapshotHash === null) {
        return { status: 'NO_SNAPSHOT' };
      }
      const outcome = recomputeFromSnapshot(stored, deps);
      if (!outcome.ok) {
        return { status: 'SNAPSHOT_RECOMPUTE_FAILED', code: outcome.error.code };
      }
      const { input, result } = outcome.value;
      const dates = input.returns?.dates ?? [];
      const firstDate = dates[0];
      const lastDate = dates.at(-1);
      if (
        result.status !== 'OK' ||
        result.baseVaR === null ||
        result.confidence === null ||
        firstDate === undefined ||
        lastDate === undefined
      ) {
        return { status: 'BASE_VAR_UNAVAILABLE' };
      }
      return {
        status: 'OK',
        losses: scenarioLosses(input),
        firstDate,
        lastDate,
        confidence: result.confidence,
        rawQuantile: result.baseVaR.rawQuantile,
        snapshotHash: latest.snapshotHash,
      };
    },

    recompute: (snapshotId) => {
      const stored = unitOfWork.run((tx) => tx.snapshots.get(snapshotId));
      if (stored === undefined) {
        return { ok: false, error: { code: 'NOT_FOUND', message: 'The snapshot was not found.' } };
      }
      const outcome = recomputeFromSnapshot(stored, deps);
      return outcome.ok ? { ok: true, value: outcome.value.result } : outcome;
    },
  };
}
