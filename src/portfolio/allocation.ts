/**
 * Allocation with the largest-remainder rule (task 11.3; design: Portfolio,
 * Allocation and cash; FR-10, FR-11, FR-14, R20.1 to R20.6, R20.8).
 *
 * Input: the signed base value of every non-flat position (task 11.2 lines) and
 * the explicitly supplied cash. Measures follow FR-10 and FR-12 (`exposure.ts`).
 *
 * Outcomes, in this order of precedence:
 * 1. `ALLOCATION_UNAVAILABLE` (R20.2): `AllocationDenominator <= 0`. No
 *    percentage is calculated; the measures and the reason are returned.
 * 2. `INELIGIBLE` (R20.6): short positions, negative cash, or leverage (gross
 *    exposure greater than NAV). Percentages of the stated denominator are
 *    rounded independently, ROUND_HALF_UP to two decimals (FR-14), and are never
 *    forced to total 100. Short positions carry no percentage and are listed
 *    separately with their values.
 * 3. `ELIGIBLE` (R20.3, FR-11): one line per long position plus a `CASH` line
 *    when cash > 0. `P = Value / Denominator * 100` (each Decimal.js operation
 *    rounded to 40 significant digits, ROUND_HALF_UP); `Floor = P` ROUND_DOWN to
 *    two decimals; the remaining 0.01 units go to the largest remainders, ties by
 *    ascending ticker (ordinal) with `CASH` last. The total is exactly 100.
 *
 * Percentages are Canonical Decimal Strings (for example "33.3" for 33.30);
 * two-decimal display formatting is a presentation concern (R20.7, AT-ALC-11).
 * Raw values are reported separately from percentages (R20.8).
 *
 * Pure; independent of input order. Validates: Requirements 20.1 to 20.6, 20.8.
 */
import { DEC, d, toCanonical } from '../shared/index.js';
import type { Decimal, DecimalString } from '../shared/index.js';
import { exposureMeasures } from './exposure.js';
import type { ExposureLine, ExposureMeasures } from './exposure.js';
import { compareOrdinal } from './ledger.js';
import type { PositionView } from './positionView.js';

export interface AllocationInput {
  /** Every non-flat position with its signed base value (`ExposureResult.lines`). */
  readonly positions: readonly ExposureLine[];
  /** Explicit portfolio cash in base currency; may be "0" or negative. */
  readonly cash: DecimalString;
}

export type AllocationLine =
  | {
      readonly kind: 'POSITION';
      readonly ticker: string;
      readonly valueBase: DecimalString;
      readonly pct: DecimalString;
    }
  | { readonly kind: 'CASH'; readonly valueBase: DecimalString; readonly pct: DecimalString };

export type IneligibleReason = 'SHORT_POSITIONS' | 'NEGATIVE_CASH' | 'LEVERAGE';

export type AllocationResult =
  | {
      readonly status: 'ELIGIBLE';
      readonly measures: ExposureMeasures;
      /** Long positions in ascending ticker order, then `CASH`. */
      readonly lines: readonly AllocationLine[];
      /** Exactly "100". */
      readonly total: DecimalString;
    }
  | {
      readonly status: 'INELIGIBLE';
      readonly reasons: readonly IneligibleReason[];
      readonly measures: ExposureMeasures;
      /** Long positions and `CASH` (when > 0), each rounded independently; not forced to 100. */
      readonly lines: readonly AllocationLine[];
      /** Short positions with their signed values; no percentage. */
      readonly shortPositions: readonly ExposureLine[];
    }
  | {
      readonly status: 'ALLOCATION_UNAVAILABLE';
      readonly reason: 'DENOMINATOR_NOT_POSITIVE';
      readonly measures: ExposureMeasures;
    };

export interface AllocationCalculator {
  allocate(input: AllocationInput): AllocationResult;
}

const HUNDRED = '100';
const UNIT = '0.01';

interface Candidate {
  readonly kind: 'POSITION' | 'CASH';
  readonly ticker: string; // '' for CASH
  readonly value: Decimal;
  readonly exact: Decimal;
}

/** Ascending ticker (ordinal), `CASH` last. */
const byTickerCashLast = (a: Candidate, b: Candidate): number =>
  a.kind === b.kind ? compareOrdinal(a.ticker, b.ticker) : a.kind === 'CASH' ? 1 : -1;

function toLine(candidate: Candidate, pct: Decimal): AllocationLine {
  const valueBase = toCanonical(candidate.value);
  return Object.freeze(
    candidate.kind === 'CASH'
      ? { kind: 'CASH', valueBase, pct: toCanonical(pct) }
      : { kind: 'POSITION', ticker: candidate.ticker, valueBase, pct: toCanonical(pct) },
  );
}

/** FR-11 steps 2 to 5 on candidates sorted by ticker (CASH last). */
function largestRemainder(candidates: readonly Candidate[]): AllocationLine[] {
  const unit = d(UNIT);
  const floors = candidates.map((candidate) => candidate.exact.toDecimalPlaces(2, DEC.ROUND_DOWN));
  const floorSum = floors.reduce((sum, floor) => sum.plus(floor), d('0'));
  const remaining = d(HUNDRED).minus(floorSum).dividedBy(unit);
  if (!remaining.isInteger() || remaining.isNegative()) {
    throw new Error('Largest-remainder invariant violated.'); // programmer error
  }
  // index only, not a financial value: the number of 0.01 units to distribute
  const units = remaining.toNumber();
  if (units > candidates.length) {
    throw new Error('Largest-remainder invariant violated.'); // programmer error
  }
  const order = candidates
    .map((candidate, index) => ({
      candidate,
      index,
      remainder: candidate.exact.minus(floors[index] ?? d('0')),
    }))
    .sort((a, b) => b.remainder.comparedTo(a.remainder) || byTickerCashLast(a.candidate, b.candidate));
  const bonus = new Set(order.slice(0, units).map((entry) => entry.index));
  return candidates.map((candidate, index) => {
    const floor = floors[index] ?? d('0');
    return toLine(candidate, bonus.has(index) ? floor.plus(unit) : floor);
  });
}

export function allocate(input: AllocationInput): AllocationResult {
  if (typeof input !== 'object' || input === null || !Array.isArray(input.positions)) {
    throw new TypeError('input must be { positions, cash }.');
  }
  // Validates every line and the cash, and rejects duplicate tickers (TypeError).
  const measures = Object.freeze(exposureMeasures(input.positions, input.cash));
  const denominator = d(measures.allocationDenominator);
  if (!denominator.greaterThan(0)) {
    return Object.freeze({ status: 'ALLOCATION_UNAVAILABLE', reason: 'DENOMINATOR_NOT_POSITIVE', measures });
  }

  const zero = d('0');
  const hundred = d(HUNDRED);
  const cash = d(measures.cash);
  const candidates: Candidate[] = [];
  const shortPositions: ExposureLine[] = [];
  for (const line of input.positions) {
    const value = d(line.valueBase);
    if (value.greaterThan(zero)) {
      candidates.push({
        kind: 'POSITION',
        ticker: line.ticker,
        value,
        exact: value.dividedBy(denominator).times(hundred),
      });
    } else if (value.lessThan(zero)) {
      shortPositions.push(Object.freeze({ ticker: line.ticker, valueBase: toCanonical(value) }));
    }
  }
  if (cash.greaterThan(zero)) {
    candidates.push({
      kind: 'CASH',
      ticker: '',
      value: cash,
      exact: cash.dividedBy(denominator).times(hundred),
    });
  }
  candidates.sort(byTickerCashLast);
  shortPositions.sort((a, b) => compareOrdinal(a.ticker, b.ticker));

  const reasons: IneligibleReason[] = [];
  if (shortPositions.length > 0) {
    reasons.push('SHORT_POSITIONS');
  }
  if (cash.lessThan(zero)) {
    reasons.push('NEGATIVE_CASH');
  }
  if (d(measures.gross).greaterThan(d(measures.nav))) {
    reasons.push('LEVERAGE');
  }

  if (reasons.length > 0) {
    return Object.freeze({
      status: 'INELIGIBLE',
      reasons: Object.freeze(reasons),
      measures,
      lines: Object.freeze(
        candidates.map((candidate) =>
          toLine(candidate, candidate.exact.toDecimalPlaces(2, DEC.ROUND_HALF_UP)),
        ),
      ),
      shortPositions: Object.freeze(shortPositions),
    });
  }
  const lines = largestRemainder(candidates);
  const total = lines.reduce((sum, line) => sum.plus(d(line.pct)), d('0'));
  if (!total.equals(hundred)) {
    throw new Error('Allocation total is not exactly 100.'); // programmer error (FR-11 step 6)
  }
  return Object.freeze({
    status: 'ELIGIBLE',
    measures,
    lines: Object.freeze(lines),
    total: toCanonical(total),
  });
}

export const allocationCalculator: AllocationCalculator = { allocate };

/**
 * Fills `PositionView.allocationPct` (6.2) from an allocation result: the
 * position's line percentage when it has one, otherwise `null` (flat and short
 * positions, `ALLOCATION_UNAVAILABLE`, and positions not in the result). Never "0"
 * in place of a missing allocation.
 */
export function withAllocation(views: readonly PositionView[], result: AllocationResult): PositionView[] {
  const pctByTicker = new Map<string, DecimalString>();
  if (result.status !== 'ALLOCATION_UNAVAILABLE') {
    for (const line of result.lines) {
      if (line.kind === 'POSITION') {
        pctByTicker.set(line.ticker, line.pct);
      }
    }
  }
  return views.map((view) => ({ ...view, allocationPct: pctByTicker.get(view.ticker) ?? null }));
}
