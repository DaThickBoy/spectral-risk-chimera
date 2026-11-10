/**
 * Loss-distribution histogram of the Base VaR scenario losses (Kiroween decision A2,
 * approved 2026-11-10). Display support only: it does not change, replace, or re-estimate
 * VaR. The losses are exactly `scenarioLosses(input)` (FR-5, Loss = -PnL) of the input that
 * produced the Base VaR, and the marker is the same Hyndman-Fan Type 7 quantile
 * (`type7Quantile`, FR-7) at the same confidence, unrounded.
 *
 * Bucketing (all arithmetic in Decimal.js, project configuration):
 * - `K = bucketCount` equal-width buckets (production: `LOSS_HISTOGRAM_BUCKETS = 20`; other
 *   counts exist for unit tests only).
 * - `unit = 10^-minorUnits`, the base currency's minor unit (the caller passes
 *   `currencyMinorUnits(currency)`, the project's ISO 4217 definition; never a fixed 2).
 * - `span = max - min`. `width` is the smallest positive multiple of `unit` with
 *   `K * width >= span`: `ceil(span / unit / K) * unit` (Decimal `ceil`, rounding toward
 *   +infinity), verified and corrected with exact multiplication so that a rounded division
 *   can never shift it. When every loss is equal (`span = 0`), `width = unit`.
 * - Edges: `lower[i] = min + i * width`, `upper[i] = min + (i + 1) * width`, unrounded.
 *   Bucket `i < K - 1` holds `lower[i] <= x < upper[i]`; the last bucket also holds
 *   `x = upper[K - 1]`. Since `upper[K - 1] >= max`, every loss lies in exactly one bucket,
 *   and the counts sum to the number of scenarios.
 * - Bucket membership uses `floor((x - min) / width)` as an index only, then exact
 *   comparisons with the edges correct any rounding of that division.
 * - VaR marker: `rawQuantile` = Type 7 quantile of the same losses (may be negative, never
 *   floored); `scenariosAboveVaR` counts losses strictly greater than it; `varBucketIndex` is
 *   the bucket holding it; `markerPosition = (rawQuantile - min) / width` in bucket-width
 *   units, rounded ROUND_HALF_UP to 6 decimals, is a plotting coordinate only.
 * - At least two scenarios are required (as for the quantile); otherwise an explicit error.
 *   No bucket is ever produced for an empty distribution.
 *
 * Counts and indexes are native integers (not financial values). Pure; no I/O.
 */
import { DECIMAL_ROUNDING, appError, d, err, isDecimal, ok } from '../shared/index.js';
import type { AppError, Decimal, Result } from '../shared/index.js';
import { type7Quantile } from './quantile.js';

/** The production bucket count (A2 requirement 1). */
export const LOSS_HISTOGRAM_BUCKETS = 20;

/** Decimal places of `markerPosition` (a plotting coordinate, not a financial value). */
const MARKER_POSITION_DECIMALS = 6;

export type LossHistogramErrorCode = 'NO_SCENARIOS' | 'INSUFFICIENT_SCENARIOS' | 'INVALID_INPUT';
export type LossHistogramError = AppError<LossHistogramErrorCode>;

export interface LossBucket {
  readonly lower: Decimal;
  readonly upper: Decimal;
  /** True only for the last bucket. */
  readonly upperInclusive: boolean;
  /** Number of scenario losses in the bucket (a count). */
  readonly count: number;
}

export interface LossHistogram {
  readonly scenarioCount: number;
  readonly min: Decimal;
  readonly max: Decimal;
  readonly width: Decimal;
  readonly buckets: readonly LossBucket[];
  /** The unrounded Type 7 quantile of the losses at `confidence`. */
  readonly rawQuantile: Decimal;
  readonly varBucketIndex: number;
  /** Losses strictly greater than `rawQuantile`. */
  readonly scenariosAboveVaR: number;
  /** `(rawQuantile - min) / width`, 6 decimals: a plotting coordinate only. */
  readonly markerPosition: Decimal;
}

export interface LossHistogramParams {
  /** Production uses `LOSS_HISTOGRAM_BUCKETS`. */
  readonly bucketCount: number;
  /** The base currency's ISO 4217 minor units (0 to 4). */
  readonly minorUnits: number;
  /** The Base VaR confidence, strictly between 0 and 1. */
  readonly confidence: Decimal;
}

const ONE = d('1');
const TEN = d('10');

/** An integer count or index as exact Decimal text. */
const fromInt = (n: number): Decimal => d(String(n));

/** The bucket index of `x` (min <= x <= min + K * width), exact. */
function bucketIndex(x: Decimal, min: Decimal, width: Decimal, k: number): number {
  // index only, not a financial value
  let i = x.minus(min).dividedBy(width).floor().toNumber();
  if (i > k - 1) i = k - 1;
  // `<= 0`, not `< 0`: a signed-zero offset ("-0" minus "0") floors to -0, which `< 0` misses.
  // Assigning 0 normalizes the index to +0 so it never depends on which zero sorted first.
  if (i <= 0) i = 0;
  // Correct a rounded division with exact comparisons against the edges.
  while (i > 0 && min.plus(width.times(fromInt(i))).greaterThan(x)) i -= 1;
  while (i < k - 1 && min.plus(width.times(fromInt(i + 1))).lessThanOrEqualTo(x)) i += 1;
  return i;
}

/** Smallest positive multiple of `unit` whose `k` multiple covers `span`. */
function bucketWidth(span: Decimal, unit: Decimal, k: number): Decimal {
  if (span.isZero()) {
    return unit;
  }
  const kd = fromInt(k);
  // Explicit rounding rule: ceil (toward +infinity) in minor units.
  let width = span.dividedBy(unit).dividedBy(kd).ceil().times(unit);
  // Exact correction: K * width >= span, and K * (width - unit) < span.
  while (width.times(kd).lessThan(span)) width = width.plus(unit);
  while (width.greaterThan(unit) && width.minus(unit).times(kd).greaterThanOrEqualTo(span)) {
    width = width.minus(unit);
  }
  return width;
}

export function lossHistogram(
  losses: readonly Decimal[],
  params: LossHistogramParams,
): Result<LossHistogram, LossHistogramError> {
  const k = params.bucketCount;
  if (!Number.isSafeInteger(k) || k < 1) {
    return err(appError('INVALID_INPUT', 'bucketCount must be a positive integer.'));
  }
  const m = params.minorUnits;
  if (!Number.isInteger(m) || m < 0 || m > 4) {
    return err(appError('INVALID_INPUT', 'minorUnits must be an integer between 0 and 4.'));
  }
  const first = losses[0];
  if (first === undefined) {
    return err(appError('NO_SCENARIOS', 'There are no scenario losses.'));
  }
  if (!losses.every((x) => isDecimal(x) && x.isFinite())) {
    return err(appError('INVALID_INPUT', 'Scenario losses must be finite decimals.'));
  }
  const quantile = type7Quantile(losses, params.confidence);
  if (!quantile.ok) {
    return quantile.error.code === 'INSUFFICIENT_DATA'
      ? err(appError('INSUFFICIENT_SCENARIOS', 'At least two scenario losses are required.'))
      : err(appError('INVALID_INPUT', quantile.error.message));
  }
  const rawQuantile = quantile.value;

  let min = d(first);
  let max = min;
  for (const x of losses) {
    if (x.lessThan(min)) min = x;
    if (x.greaterThan(max)) max = x;
  }
  const unit = ONE.dividedBy(TEN.pow(m)); // exact: 10^-m, m <= 4
  const width = bucketWidth(max.minus(min), unit, k);

  const counts: number[] = Array.from({ length: k }, () => 0);
  for (const x of losses) {
    const i = bucketIndex(x, min, width, k);
    const current = counts[i];
    if (current === undefined) {
      throw new RangeError('lossHistogram: bucket index out of range.');
    }
    counts[i] = current + 1;
  }
  const buckets: LossBucket[] = counts.map((count, i) => ({
    lower: min.plus(width.times(fromInt(i))),
    upper: min.plus(width.times(fromInt(i + 1))),
    upperInclusive: i === k - 1,
    count,
  }));
  let above = 0;
  for (const x of losses) {
    if (x.greaterThan(rawQuantile)) above += 1;
  }
  return ok({
    scenarioCount: losses.length,
    min,
    max,
    width,
    buckets,
    rawQuantile,
    varBucketIndex: bucketIndex(rawQuantile, min, width, k),
    scenariosAboveVaR: above,
    markerPosition: rawQuantile
      .minus(min)
      .dividedBy(width)
      .toDecimalPlaces(MARKER_POSITION_DECIMALS, DECIMAL_ROUNDING),
  });
}
