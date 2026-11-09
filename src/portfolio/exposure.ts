/**
 * Exposure measures and NAV (task 11.2; design: Portfolio, Allocation and cash;
 * FR-10, FR-12, R20.6).
 *
 * Definitions (FR-10, FR-12), all in base currency, `E[k]` the signed base
 * market value of position k (`PositionView.marketValueBase`, task 11.1):
 *   LongValue  = sum of E[k] for E[k] > 0
 *   ShortValue = sum of |E[k]| for E[k] < 0
 *   GrossExposure = LongValue + ShortValue
 *   NetExposure   = LongValue - ShortValue
 *   AllocationDenominator = LongValue + max(Cash, 0)
 *   NAV = sum of signed E[k] + Cash
 *
 * Assumptions and rules:
 * - Cash is supplied explicitly by the caller as decimal text in base currency
 *   (A-7). `"0"` and negative values are valid; it is never defaulted.
 * - A position with signed quantity zero has no exposure (FR-9) and contributes
 *   nothing, whatever its valuation status.
 * - Every other position must have a base market value. If any does not (status
 *   other than `VALUED`), no measure is computed: the result is
 *   `EXPOSURE_UNAVAILABLE` listing each such ticker and its valuation status.
 *   A missing value is never treated as zero (financial-rules 10).
 * - `NAV <= 0` is reported with `navStatus: 'NAV_NOT_POSITIVE'`; NAV itself is
 *   still the computed value, and no percentage is derived here (FR-12).
 * - Decimal.js only (40 significant digits, ROUND_HALF_UP per operation); outputs
 *   are Canonical Decimal Strings. No rounding beyond the configuration.
 *
 * Pure. Validates: Requirements 20.1, 20.6, 30.6.
 */
import { d, isDecimalText, toCanonical } from '../shared/index.js';
import type { Decimal, DecimalString } from '../shared/index.js';
import { compareOrdinal } from './ledger.js';
import type { PositionView, ValuationStatus } from './positionView.js';

/** One non-flat position with its signed base market value. */
export interface ExposureLine {
  readonly ticker: string;
  readonly valueBase: DecimalString;
}

export interface ExposureMeasures {
  readonly long: DecimalString;
  readonly short: DecimalString;
  readonly gross: DecimalString;
  readonly net: DecimalString;
  readonly cash: DecimalString;
  readonly nav: DecimalString;
  /** FR-10: LongValue + max(Cash, 0). */
  readonly allocationDenominator: DecimalString;
}

export type ExposureResult =
  | ({
      readonly status: 'OK';
      readonly navStatus: 'NAV_POSITIVE' | 'NAV_NOT_POSITIVE';
      /** Non-flat positions in ascending ticker order. */
      readonly lines: readonly ExposureLine[];
    } & ExposureMeasures)
  | {
      readonly status: 'EXPOSURE_UNAVAILABLE';
      readonly reason: 'VALUATION_INCOMPLETE';
      /** Each non-flat position without a base value, ascending ticker order. */
      readonly unvalued: readonly { readonly ticker: string; readonly valuationStatus: ValuationStatus }[];
      readonly cash: DecimalString;
    };

/** Throws `TypeError` unless `text` is decimal text. */
export function assertDecimalText(text: unknown, name: string): asserts text is DecimalString {
  if (typeof text !== 'string' || !isDecimalText(text)) {
    throw new TypeError(`${name} must be decimal text.`);
  }
}

/**
 * FR-10 and FR-12 measures from complete lines. `lines` must hold the signed base
 * value of every non-flat position; duplicate tickers are a programmer error.
 */
export function exposureMeasures(lines: readonly ExposureLine[], cash: DecimalString): ExposureMeasures {
  assertDecimalText(cash, 'cash');
  const zero = d('0');
  const seen = new Set<string>();
  let long = zero;
  let short = zero;
  for (const line of lines) {
    if (typeof line.ticker !== 'string' || line.ticker.length === 0 || seen.has(line.ticker)) {
      throw new TypeError('every line needs a unique, non-empty ticker.');
    }
    seen.add(line.ticker);
    assertDecimalText(line.valueBase, 'valueBase');
    const value = d(line.valueBase);
    if (value.greaterThan(zero)) {
      long = long.plus(value);
    } else if (value.lessThan(zero)) {
      short = short.plus(value.abs());
    }
  }
  const cashValue = d(cash);
  // max(Cash, 0) by Decimal comparison.
  const positiveCash: Decimal = cashValue.greaterThan(zero) ? cashValue : zero;
  return {
    long: toCanonical(long),
    short: toCanonical(short),
    gross: toCanonical(long.plus(short)),
    net: toCanonical(long.minus(short)),
    cash: toCanonical(cashValue),
    nav: toCanonical(long.minus(short).plus(cashValue)),
    allocationDenominator: toCanonical(long.plus(positiveCash)),
  };
}

/** Task 11.2: exposure measures and NAV of one portfolio's valued positions. */
export function computeExposure(views: readonly PositionView[], cash: DecimalString): ExposureResult {
  assertDecimalText(cash, 'cash');
  if (!Array.isArray(views)) {
    throw new TypeError('views must be an array.');
  }
  const sorted = [...views].sort((a, b) => compareOrdinal(a.ticker, b.ticker));
  const portfolios = new Set(sorted.map((view) => view.portfolioId));
  if (portfolios.size > 1) {
    throw new TypeError('views must belong to one portfolio.');
  }
  const lines: ExposureLine[] = [];
  const unvalued: { ticker: string; valuationStatus: ValuationStatus }[] = [];
  const tickers = new Set<string>();
  for (const view of sorted) {
    if (tickers.has(view.ticker)) {
      throw new TypeError('tickers must be unique.');
    }
    tickers.add(view.ticker);
    assertDecimalText(view.signedQuantity, 'signedQuantity');
    if (d(view.signedQuantity).isZero()) {
      continue; // FR-9: a zero net quantity has no exposure.
    }
    if (view.valuationStatus !== 'VALUED' || view.marketValueBase === null) {
      unvalued.push({ ticker: view.ticker, valuationStatus: view.valuationStatus });
      continue;
    }
    lines.push({ ticker: view.ticker, valueBase: view.marketValueBase });
  }
  if (unvalued.length > 0) {
    return Object.freeze({
      status: 'EXPOSURE_UNAVAILABLE',
      reason: 'VALUATION_INCOMPLETE',
      unvalued: Object.freeze(unvalued.map((entry) => Object.freeze(entry))),
      cash: toCanonical(d(cash)),
    });
  }
  const measures = exposureMeasures(lines, cash);
  return Object.freeze({
    status: 'OK',
    navStatus: d(measures.nav).greaterThan(0) ? 'NAV_POSITIVE' : 'NAV_NOT_POSITIVE',
    lines: Object.freeze(lines.map((line) => Object.freeze(line))),
    ...measures,
  });
}
