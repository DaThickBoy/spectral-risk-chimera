/**
 * Hyndman-Fan Type 7 quantile for Historical Simulation VaR (task 12.1; FR-7;
 * design: Risk Engine, `Type7Quantile`; R14.7).
 *
 * Method (FR-7), on scenario losses (Loss = -PnL), one-based order statistics:
 * 1. Sort ascending, numerically exact (Decimal `comparedTo`) and stable:
 *    `x[1] <= x[2] <= ... <= x[n]`.
 * 2. `h = 1 + (n - 1) * p` in Decimal; `j = floor(h)`; `gamma = h - j`.
 * 3. `gamma = 0`: `Q(p) = x[j]` (x[j + 1] is not used).
 *    Otherwise `Q(p) = (1 - gamma) * x[j] + gamma * x[j + 1]`.
 * 4. Endpoint guard: `j >= n` gives `Q(p) = x[n]`. With `0 < p < 1` and `n >= 2`,
 *    `1 < h < n`, so the guard is defensive only.
 * Worked indices: n = 250, p = 0.95 gives `0.45 * x[237] + 0.55 * x[238]`;
 * n = 250, p = 0.99 gives `0.49 * x[247] + 0.51 * x[248]`.
 *
 * Assumptions and limits:
 * - Arithmetic is Decimal.js under FR-14 (precision 40, ROUND_HALF_UP); the
 *   result is not rounded further. `j` is a native integer used only as an
 *   array index (R4.7), derived from `h.floor()`.
 * - Input validation: `p` must be a finite Decimal strictly between 0 and 1,
 *   otherwise `INVALID_INPUT`; every value must be a finite Decimal, otherwise
 *   `INVALID_INPUT`; `n < 2` is `INSUFFICIENT_DATA` (FR-7.4). No value is
 *   clamped, defaulted, or replaced.
 * - This module computes only the quantile (the raw quantile, which may be
 *   negative). Flooring at zero, `NO_LOSS_AT_CONFIDENCE`, percentages of NAV,
 *   lookback selection, and loss construction belong to the VaR engine (task 12.2).
 *
 * Pure; no I/O. Validates: Requirements 14.7 (FR-7), 27.6.
 */
import { appError, d, err, isDecimal, ok } from '../shared/index.js';
import type { AppError, Decimal, Result } from '../shared/index.js';

export type QuantileErrorCode = 'INSUFFICIENT_DATA' | 'INVALID_INPUT';
export type QuantileError = AppError<QuantileErrorCode>;

/** The method identifier reported with VaR results (R14.12). */
export const QUANTILE_METHOD = 'HYNDMAN_FAN_TYPE_7';

const ONE = d('1');

/** Ascending, numerically exact, stable sort (FR-7.8). The input is not modified. */
export function sortAscending(values: readonly Decimal[]): Decimal[] {
  // Array.prototype.sort is stable (ES2019); comparedTo is an exact comparison.
  return [...values].sort((a, b) => a.comparedTo(b));
}

/**
 * Type 7 interpolation at position `h` on an ascending, non-empty list
 * (FR-7 steps 2 to 4, including the `j >= n` guard). Module-internal: it is not
 * part of the `risk/` public API (`index.ts`) and is exported from this file
 * only so the unit test can reach the defensive guard, which `type7Quantile`
 * never triggers for a valid `p`. Precondition: `h >= 1` and finite.
 */
export function type7AtPosition(sortedAsc: readonly Decimal[], h: Decimal): Decimal {
  const n = sortedAsc.length; // count, not a financial value
  if (n < 1 || !h.isFinite() || h.lessThan(ONE)) {
    throw new RangeError('type7AtPosition requires a non-empty list and a finite position h >= 1.');
  }
  // index only, not a financial value
  const j = h.floor().toNumber();
  if (j >= n) {
    // Defensive endpoint guard (FR-7.4): Q(p) = x[n].
    return requireValue(sortedAsc[n - 1]);
  }
  const xj = requireValue(sortedAsc[j - 1]);
  const gamma = h.minus(h.floor());
  if (gamma.isZero()) {
    return xj;
  }
  const xj1 = requireValue(sortedAsc[j]);
  return ONE.minus(gamma).times(xj).plus(gamma.times(xj1));
}

function requireValue(value: Decimal | undefined): Decimal {
  if (value === undefined) {
    throw new RangeError('Order statistic out of range.');
  }
  return value;
}

/** True for a Decimal strictly between 0 and 1. */
function isOpenUnitInterval(p: unknown): p is Decimal {
  return isDecimal(p) && p.isFinite() && p.greaterThan(0) && p.lessThan(ONE);
}

/**
 * The Type 7 quantile `Q(p)` of `values` (sorted internally; the input order
 * does not matter). Returns the raw quantile, which may be negative.
 */
export function type7Quantile(values: readonly Decimal[], p: Decimal): Result<Decimal, QuantileError> {
  if (!isOpenUnitInterval(p)) {
    return err(appError('INVALID_INPUT', 'Quantile probability must be strictly between 0 and 1.'));
  }
  if (!values.every((value) => isDecimal(value) && value.isFinite())) {
    return err(appError('INVALID_INPUT', 'Quantile values must be finite decimals.'));
  }
  if (values.length < 2) {
    return err(appError('INSUFFICIENT_DATA', 'At least two observations are required for the quantile.'));
  }
  const sorted = sortAscending(values);
  // `n - 1` is a count; it enters Decimal arithmetic as exact integer text.
  const h = ONE.plus(d(String(values.length - 1)).times(p));
  return ok(type7AtPosition(sorted, h));
}
