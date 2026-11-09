/**
 * Position view with valuation fields (task 6.2, extended by task 11.1; design:
 * Portfolio, Valuation rules; FR-4, R5.2, R30.6).
 *
 * View only; never persisted. `toPositionView` (6.2, unchanged) returns the view
 * before valuation: every valuation field `null`, status `NOT_VALUED`.
 * `toValuedPositionView` (11.1) fills the market fields from inputs that
 * `app/positionValuation.ts` has already resolved and validated:
 *
 * - `marketPrice = toCanonical(price)`;
 * - `marketValueInstrument = signedQuantity × price` (signed: a short is negative);
 * - `marketValueBase = signedQuantity × price × Rate(X/B)` (R30.4, R30.6).
 *
 * Arithmetic uses Decimal.js only; the only rounding is the project
 * configuration (40 significant digits, ROUND_HALF_UP) per operation. A
 * zero-quantity position is valued normally and gives `"0"`: a real value, not a
 * placeholder. A field that cannot be computed stays `null` with its status and
 * is never `"0"` (R5.2). `allocationPct` stays `null` (task 11.3).
 *
 * Pure: no I/O, no clock. Validates: Requirements 5.2, 30.4, 30.6.
 */
import { assertNever, d, isDecimalText, toCanonical } from '../shared/index.js';
import type { Decimal, DecimalString } from '../shared/index.js';
import { positionFields } from './position.js';
import type { Position } from './position.js';

/** Task 11.1. `NOT_VALUED` is the 6.2 status of a view that has not been valued. */
export type ValuationStatus =
  'NOT_VALUED' | 'VALUED' | 'PRICE_UNAVAILABLE' | 'PRICE_CURRENCY_MISMATCH' | 'FX_UNAVAILABLE' | 'FX_STALE';

export interface PositionView extends Position {
  readonly marketPrice: DecimalString | null;
  readonly marketValueInstrument: DecimalString | null;
  readonly marketValueBase: DecimalString | null;
  readonly allocationPct: DecimalString | null;
  readonly valuationStatus: ValuationStatus;
}

/** Task 11.1: inputs already resolved and validated by `app/positionValuation.ts`. */
export type ValuationInput =
  | { readonly status: 'VALUED'; readonly price: DecimalString; readonly rate: DecimalString }
  | { readonly status: 'FX_UNAVAILABLE' | 'FX_STALE'; readonly price: DecimalString }
  | { readonly status: 'PRICE_UNAVAILABLE' | 'PRICE_CURRENCY_MISMATCH' };

/** The view of a position before valuation: all valuation fields `null`, status `NOT_VALUED`. */
export function toPositionView(position: Position): PositionView {
  return {
    ...positionFields(position),
    marketPrice: null,
    marketValueInstrument: null,
    marketValueBase: null,
    allocationPct: null,
    valuationStatus: 'NOT_VALUED',
  };
}

/** A positive decimal from validated text; anything else is a programmer error. */
function positiveDecimal(text: unknown, name: string): Decimal {
  if (typeof text !== 'string' || !isDecimalText(text)) {
    throw new TypeError(`${name} must be decimal text.`);
  }
  const value = d(text);
  if (!value.greaterThan(0)) {
    throw new TypeError(`${name} must be greater than 0.`);
  }
  return value;
}

/**
 * The view of a valued (or not valuable) position. Throws `TypeError` for a
 * `price` or `rate` that is not a positive decimal; an invalid `signedQuantity`
 * throws `DecimalInputError` (both programmer errors).
 */
export function toValuedPositionView(position: Position, input: ValuationInput): PositionView {
  const view = toPositionView(position);
  switch (input.status) {
    case 'VALUED': {
      const price = positiveDecimal(input.price, 'price');
      const rate = positiveDecimal(input.rate, 'rate');
      const instrument = d(position.signedQuantity).times(price);
      return {
        ...view,
        marketPrice: toCanonical(price),
        marketValueInstrument: toCanonical(instrument),
        marketValueBase: toCanonical(instrument.times(rate)),
        valuationStatus: 'VALUED',
      };
    }
    case 'FX_UNAVAILABLE':
    case 'FX_STALE': {
      // The price is valid, but no usable rate exists: the base value stays null.
      const price = positiveDecimal(input.price, 'price');
      return {
        ...view,
        marketPrice: toCanonical(price),
        marketValueInstrument: toCanonical(d(position.signedQuantity).times(price)),
        valuationStatus: input.status,
      };
    }
    case 'PRICE_UNAVAILABLE':
    case 'PRICE_CURRENCY_MISMATCH':
      return { ...view, valuationStatus: input.status };
    default:
      return assertNever(input);
  }
}
