/**
 * Historical Simulation Base VaR engine, algorithmVersion "hs-var-1" (task 12.2;
 * design: Risk Engine; FR-4, FR-5, FR-7, FR-12; R14.1 to R14.13, R11.5, R15.8).
 *
 * Method and assumptions (financial-rules 13):
 * - Exposure (FR-4): `E[k] = signedQuantity * marketPrice * fx.rate` (latest
 *   unadjusted price; `Rate(X/B)` held constant across all scenarios, A-9).
 * - Scenario P&L (FR-5): `PnL[k][i] = E[k] * return[k][i]` on the common-date
 *   simple returns of the `ReturnMatrix` (task 9.3; newest `lookbackReturns`,
 *   minimum `minObservations`, no forward fill). Portfolio P&L is the sum over
 *   positions; `Loss[i] = -PortfolioPnL[i]`. Cash contributes no P&L.
 * - VaR (FR-7): Hyndman-Fan Type 7 quantile of the losses at `confidence`
 *   (`risk/quantile.ts`). Reported VaR is `max(raw, 0)`; a negative raw quantile
 *   sets `NO_LOSS_AT_CONFIDENCE` and is kept (R14.8). VaR is a percentile-based
 *   loss estimate, not a maximum drawdown or worst-case loss (R14.13).
 * - Horizon: exactly one trading day, no square-root-of-time scaling (R14.3);
 *   any other `horizonDays` is `INVALID_INPUT`. `confidence` must be strictly
 *   between 0 and 1 (R14.2).
 * - NAV (FR-12): `sum E[k] + cash`. `percentOfNav = VaR / NAV * 100` (unrounded)
 *   when NAV > 0, otherwise `null` with `NAV_NOT_POSITIVE` (R14.9).
 * - Flags: `REDUCED_LOOKBACK` from the return matrix, `MARKET_DATA_STALE` as
 *   decided by the input builder, `DEMO_DATA` when any FX rate or history is DEMO.
 * - Adjusted VaR (tasks 14.1, 14.2; `risk/adjustment.ts`): a configurable
 *   downside stress assumption, not a statistical volatility estimate (R15.11).
 *   It is calculated only when Base VaR is `OK`, every R15.1 setting is present
 *   (`adjustmentConfigMissing` empty), and every position has eligible sentiment
 *   (valid, `REAL`, `CURRENT`, R15.2). Otherwise it is `null` with
 *   `BASE_UNAVAILABLE`, `ADJUSTMENT_CONFIG_MISSING` (keys), or
 *   `SENTIMENT_NOT_CURRENT` (tickers and statuses), and Base VaR is unchanged.
 *   When calculated, triggered positions' negative P&L is multiplied (FR-6), the
 *   losses and the Type 7 quantile are recomputed, and the status is `APPLIED`
 *   or `NONE_TRIGGERED`. The Base figure is never copied into the Adjusted
 *   field (R15.8), and sentiment never changes Base VaR (R15.9). The algorithm
 *   version stays `hs-var-1`: Base VaR is unchanged, and an input without
 *   eligible sentiment gives exactly the earlier result.
 * - All arithmetic is Decimal.js (precision 40, ROUND_HALF_UP); nothing is
 *   rounded. Pure: no I/O, no clock; the result is frozen.
 *
 * Validates: Requirements 14.1, 14.2, 14.3, 14.5 to 14.12, 11.5, 15.2 to 15.12.
 */
import { canonicalJson, d, isDecimalText, sha256Hex, toCanonical } from '../shared/index.js';
import type { Decimal } from '../shared/index.js';
import { adjustScenarios, evaluateEligibility } from './adjustment.js';
import { QUANTILE_METHOD, type7Quantile } from './quantile.js';
import { ALGORITHM_VERSION, CALC_FLAG_ORDER } from './types.js';
import type { AdjustmentOutcome, CalcFlag, EngineStatus, RiskInput, RiskResult, VarFigure } from './types.js';

export interface RiskEngine {
  compute(input: RiskInput): RiskResult;
}

const ZERO = d('0');
const HUNDRED = d('100');
const CURRENCY = /^[A-Z]{3}$/;

type Invalid = { readonly ok: false; readonly reason: string };
type Valid = { readonly ok: true };

const invalid = (reason: string): Invalid => ({ ok: false, reason });
const VALID: Valid = { ok: true };

const isInt = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min;

const decimalText = (value: unknown): value is string => typeof value === 'string' && isDecimalText(value);

function validateParams(input: RiskInput): Valid | Invalid {
  const { params } = input;
  if (params.horizonDays !== 1) {
    return invalid('HORIZON_NOT_ONE');
  }
  if (
    !decimalText(params.confidence) ||
    !d(params.confidence).greaterThan(0) ||
    !d(params.confidence).lessThan(1)
  ) {
    return invalid('CONFIDENCE_OUT_OF_RANGE');
  }
  if (
    !isInt(params.lookbackReturns, 2) ||
    !isInt(params.minObservations, 2) ||
    params.minObservations > params.lookbackReturns
  ) {
    return invalid('LOOKBACK_INVALID');
  }
  if ((params.adjustment === null) !== input.adjustmentConfigMissing.length > 0) {
    return invalid('ADJUSTMENT_CONFIG_INCONSISTENT');
  }
  if (params.adjustment !== null) {
    const { threshold, multiplier } = params.adjustment;
    if (
      !decimalText(threshold) ||
      d(threshold).lessThan(-1) ||
      d(threshold).greaterThan(1) ||
      !decimalText(multiplier) ||
      d(multiplier).lessThan(1)
    ) {
      return invalid('ADJUSTMENT_PARAMS_INVALID');
    }
  }
  if (!decimalText(input.cash)) {
    return invalid('CASH_INVALID');
  }
  if (!CURRENCY.test(input.baseCurrency)) {
    return invalid('BASE_CURRENCY_INVALID');
  }
  return VALID;
}

function validatePositions(input: RiskInput): Valid | Invalid {
  let previous: string | undefined;
  for (const position of input.positions) {
    if (previous !== undefined && !(previous < position.ticker)) {
      return invalid('POSITIONS_NOT_SORTED_UNIQUE');
    }
    previous = position.ticker;
    if (!decimalText(position.signedQuantity) || d(position.signedQuantity).isZero()) {
      return invalid('QUANTITY_INVALID');
    }
    if (!decimalText(position.marketPrice) || !d(position.marketPrice).greaterThan(0)) {
      return invalid('PRICE_INVALID');
    }
    const { fx } = position;
    const fxKindValid =
      (fx.kind === 'OBSERVED' && (fx.status === 'CURRENT' || fx.status === 'DEMO')) ||
      (fx.kind === 'IDENTITY' && fx.status === 'CURRENT' && position.currency === input.baseCurrency);
    if (!fxKindValid || fx.pair !== `${position.currency}${input.baseCurrency}`) {
      return invalid('FX_RATE_INVALID');
    }
    if (!decimalText(fx.rate) || !d(fx.rate).greaterThan(0)) {
      return invalid('FX_RATE_INVALID');
    }
    if (position.historySourceKind !== 'REAL' && position.historySourceKind !== 'DEMO') {
      return invalid('HISTORY_SOURCE_INVALID');
    }
  }
  return VALID;
}

function validateReturns(input: RiskInput): Valid | Invalid {
  const matrix = input.returns;
  if (matrix === null) {
    return invalid('RETURNS_MISSING');
  }
  const tickers = Object.keys(matrix.returns).sort();
  const expected = input.positions.map((p) => p.ticker);
  if (tickers.length !== expected.length || tickers.some((ticker, i) => ticker !== expected[i])) {
    return invalid('RETURNS_TICKERS_MISMATCH');
  }
  if (!isInt(matrix.n, 0) || matrix.dates.length !== matrix.n || matrix.n > input.params.lookbackReturns) {
    return invalid('RETURNS_SHAPE_INVALID');
  }
  for (const ticker of tickers) {
    const series = matrix.returns[ticker];
    if (series === undefined || series.length !== matrix.n || !series.every((r) => decimalText(r))) {
      return invalid('RETURNS_SHAPE_INVALID');
    }
  }
  const expectedStatus = matrix.n === input.params.lookbackReturns ? 'COMPLETE' : 'REDUCED_LOOKBACK';
  if (matrix.n >= input.params.minObservations && matrix.status !== expectedStatus) {
    return invalid('RETURNS_STATUS_INCONSISTENT');
  }
  return VALID;
}

/** Sentiment entries: one per ticker, with known status and source kind (values are gated later). */
function validateSentiment(input: RiskInput): Valid | Invalid {
  const tickers = new Set<string>();
  for (const entry of input.sentiment) {
    if (typeof entry.ticker !== 'string' || tickers.has(entry.ticker)) {
      return invalid('SENTIMENT_DUPLICATE');
    }
    tickers.add(entry.ticker);
    if (
      !['CURRENT', 'STALE', 'UNAVAILABLE'].includes(entry.status) ||
      !['REAL', 'DEMO'].includes(entry.sourceKind) ||
      typeof entry.source !== 'string' ||
      entry.source.length === 0
    ) {
      return invalid('SENTIMENT_ENTRY_INVALID');
    }
  }
  return VALID;
}

const orderedFlags = (flags: ReadonlySet<CalcFlag>): CalcFlag[] =>
  CALC_FLAG_ORDER.filter((flag) => flags.has(flag));

const NO_ADJUSTMENT = { missingConfigKeys: [], ineligible: [] };

/** The gate outcome when Adjusted VaR cannot be calculated (R15.8), or undefined when it can. */
function unavailableAdjustment(input: RiskInput, status: EngineStatus): AdjustmentOutcome | undefined {
  if (status !== 'OK') {
    return { status: 'BASE_UNAVAILABLE', ...NO_ADJUSTMENT };
  }
  if (input.adjustmentConfigMissing.length > 0) {
    return {
      status: 'ADJUSTMENT_CONFIG_MISSING',
      missingConfigKeys: [...input.adjustmentConfigMissing].sort(),
      ineligible: [],
    };
  }
  const eligibility = evaluateEligibility(input);
  return eligibility.ok
    ? undefined
    : { status: 'SENTIMENT_NOT_CURRENT', missingConfigKeys: [], ineligible: eligibility.ineligible };
}
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}

/** Exposure `E[k]` per position, in base currency (FR-4). */
export function exposureOf(position: RiskInput['positions'][number]): Decimal {
  return d(position.signedQuantity).times(d(position.marketPrice)).times(d(position.fx.rate));
}

/** Position scenario P&L `PnL[k][i] = E[k] * r[k][i]` (FR-5), aligned with `input.positions`. */
export function positionPnl(input: RiskInput): Decimal[][] {
  const matrix = input.returns;
  if (matrix === null) {
    return [];
  }
  return input.positions.map((p) => {
    const e = exposureOf(p);
    const returns = matrix.returns[p.ticker];
    if (returns === undefined || returns.length !== matrix.n) {
      throw new TypeError('positionPnl: return matrix does not match the positions.');
    }
    return returns.map((r) => e.times(d(r)));
  });
}

/** Portfolio losses `Loss[i] = -sum_k PnL[k][i]` (FR-5), in date order. */
function lossesOf(pnl: readonly (readonly Decimal[])[], n: number): Decimal[] {
  const losses: Decimal[] = [];
  for (let i = 0; i < n; i += 1) {
    let total = ZERO;
    for (const row of pnl) {
      const value = row[i];
      if (value === undefined) {
        throw new TypeError('lossesOf: ragged P&L matrix.');
      }
      total = total.plus(value);
    }
    losses.push(total.negated());
  }
  return losses;
}

/** Portfolio scenario losses `Loss[i] = -sum_k E[k] * r[k][i]` (FR-5), in date order. */
export function scenarioLosses(input: RiskInput): Decimal[] {
  return input.returns === null ? [] : lossesOf(positionPnl(input), input.returns.n);
}

/** Reported VaR from a raw quantile: floored at zero, percentage of NAV when NAV > 0 (FR-7, FR-12). */
function varFigure(raw: Decimal, nav: Decimal): VarFigure {
  const absolute = raw.lessThan(0) ? ZERO : raw;
  return {
    absolute: toCanonical(absolute),
    rawQuantile: toCanonical(raw),
    percentOfNav: nav.greaterThan(0) ? toCanonical(absolute.dividedBy(nav).times(HUNDRED)) : null,
  };
}

export function computeRisk(input: RiskInput): RiskResult {
  const flags = new Set<CalcFlag>();
  const matrix = input.returns;
  const base = {
    algorithmVersion: ALGORITHM_VERSION,
    portfolioId: input.portfolioId,
    currency: input.baseCurrency,
    horizonDays: 1 as const,
    quantileMethod: QUANTILE_METHOD as 'HYNDMAN_FAN_TYPE_7',
    evaluatedAt: input.evaluatedAt,
    lookbackReturns: input.params.lookbackReturns,
    confidence: decimalText(input.params.confidence) ? toCanonical(d(input.params.confidence)) : null,
  };
  type Core = Omit<
    RiskResult,
    keyof typeof base | 'adjustmentOutcome' | 'flags' | 'triggeredAssets' | 'sentimentAdjustedVaR'
  >;
  const finish = (
    result: Core,
    adjusted?: Pick<RiskResult, 'adjustmentOutcome' | 'triggeredAssets' | 'sentimentAdjustedVaR'>,
  ): RiskResult =>
    deepFreeze({
      ...base,
      ...result,
      flags: orderedFlags(flags),
      ...(adjusted ?? {
        adjustmentOutcome: unavailableAdjustment(input, result.status) ?? {
          status: 'BASE_UNAVAILABLE',
          ...NO_ADJUSTMENT,
        },
        triggeredAssets: [],
        sentimentAdjustedVaR: null,
      }),
    });
  const empty = {
    asOfDate: null,
    observations: 0,
    completeness: null,
    seriesHashes: {},
    returnsHash: null,
    baseVaR: null,
  };

  const checks = [validateParams(input), validatePositions(input), validateSentiment(input)];
  for (const check of checks) {
    if (!check.ok) {
      return finish({ ...empty, status: 'INVALID_INPUT', invalidReason: check.reason, nav: null });
    }
  }
  if (input.positions.length === 0) {
    return finish({ ...empty, status: 'NO_POSITIONS', nav: toCanonical(d(input.cash)) });
  }
  const returnsCheck = validateReturns(input);
  if (!returnsCheck.ok || matrix === null) {
    return finish({
      ...empty,
      status: 'INVALID_INPUT',
      invalidReason: returnsCheck.ok ? 'RETURNS_MISSING' : returnsCheck.reason,
      nav: null,
    });
  }

  const nav = input.positions.reduce((acc, p) => acc.plus(exposureOf(p)), d(input.cash));
  if (input.positions.some((p) => p.fx.status === 'DEMO' || p.historySourceKind === 'DEMO')) {
    flags.add('DEMO_DATA');
  }
  if (input.marketDataStale) {
    flags.add('MARKET_DATA_STALE');
  }
  const meta = {
    asOfDate: matrix.asOfDate,
    observations: matrix.n,
    seriesHashes: { ...matrix.seriesHashes },
    returnsHash: sha256Hex(canonicalJson({ dates: matrix.dates, returns: matrix.returns })),
    nav: toCanonical(nav),
  };
  if (matrix.n < input.params.minObservations) {
    return finish({ ...meta, status: 'INSUFFICIENT_DATA', completeness: null, baseVaR: null });
  }
  if (matrix.status === 'REDUCED_LOOKBACK') {
    flags.add('REDUCED_LOOKBACK');
  }
  const pnl = positionPnl(input);
  const confidence = d(input.params.confidence);
  const quantile = type7Quantile(lossesOf(pnl, matrix.n), confidence);
  if (!quantile.ok) {
    return finish({
      ...meta,
      status: quantile.error.code,
      ...(quantile.error.code === 'INVALID_INPUT' ? { invalidReason: 'QUANTILE_INPUT_INVALID' } : {}),
      completeness: matrix.status,
      baseVaR: null,
    });
  }
  const raw = quantile.value;
  if (raw.lessThan(0)) {
    flags.add('NO_LOSS_AT_CONFIDENCE');
  }
  if (!nav.greaterThan(0)) {
    flags.add('NAV_NOT_POSITIVE');
  }
  const core: Core = { ...meta, status: 'OK', completeness: matrix.status, baseVaR: varFigure(raw, nav) };

  // Adjusted VaR (R15.8): calculated only when every setting and every position's sentiment is eligible.
  const unavailable = unavailableAdjustment(input, 'OK');
  const adjustment = input.params.adjustment;
  const eligibility = evaluateEligibility(input);
  if (unavailable !== undefined || adjustment === null || !eligibility.ok) {
    return finish(core);
  }
  const adjusted = adjustScenarios(
    input,
    pnl,
    eligibility.values,
    d(adjustment.threshold),
    d(adjustment.multiplier),
  );
  const adjustedQuantile = type7Quantile(adjusted.losses, confidence);
  if (!adjustedQuantile.ok) {
    throw new TypeError('computeRisk: adjusted losses are invalid although base losses were valid.');
  }
  return finish(core, {
    adjustmentOutcome: {
      status: adjusted.triggered.length > 0 ? 'APPLIED' : 'NONE_TRIGGERED',
      ...NO_ADJUSTMENT,
    },
    triggeredAssets: adjusted.triggered,
    sentimentAdjustedVaR: varFigure(adjustedQuantile.value, nav),
  });
}
export const riskEngine: RiskEngine = { compute: computeRisk };
