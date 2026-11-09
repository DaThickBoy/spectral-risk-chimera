/**
 * Decimal helper: the only module that constructs Decimal.js values.
 *
 * Assumptions and rules (R4, FR-14, financial-rules 1 to 7):
 * - Decimal.js is configured once here: precision 40 significant digits,
 *   rounding ROUND_HALF_UP. No other module calls `Decimal.set` or `Decimal.clone`.
 * - Construction is exact; results are not rounded except at defined output
 *   points (`roundMoney` for display money).
 * - Accepted text follows the fixed decimal grammar: optional `-`, digits
 *   (no leading zeros), optional `.` and digits. Exponent notation, `NaN`,
 *   `Infinity`, thousands separators, and JavaScript numbers are rejected (R4.6).
 * - `toCanonical` produces Canonical Decimal Strings: no exponent, no trailing
 *   fractional zeros, no negative zero (R4.3).
 * - `toChartNumber` is the only conversion to a native number. It exists for the
 *   dashboard chart adapter (`src/web/chartAdapter.ts`) and must never feed a
 *   calculation (R4.4).
 *
 * Validates: Requirements 4.1, 4.3, 4.5, 4.6, 4.7, 30.4.
 */
// Named import: decimal.js ships one CommonJS-style declaration file for both
// entry points, so only the named export types correctly under NodeNext.
import { Decimal as DecimalJs } from 'decimal.js';

/** A decimal value held as text in the fixed grammar (for example "1000", "-12.5"). */
export type DecimalString = string & { readonly __brand: 'DecimalString' };

/** A Decimal.js instance created by the project configuration. */
export type Decimal = DecimalJs;

/** Fixed decimal grammar (R4.6). Exponent notation never matches. */
export const DECIMAL_TEXT_PATTERN = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** Fixed Decimal.js configuration (R4.5). Not configurable in version 1. */
export const DECIMAL_PRECISION = 40;
export const DECIMAL_ROUNDING = DecimalJs.ROUND_HALF_UP;

/** The project Decimal constructor. Use `d()` instead of constructing directly. */
export const DEC = DecimalJs.clone({
  precision: DECIMAL_PRECISION,
  rounding: DECIMAL_ROUNDING,
});

export type DecimalErrorCode = 'MALFORMED_NUMBER' | 'NOT_A_DECIMAL_INPUT' | 'NON_FINITE';

/** Thrown for programmer errors: `d()` must only receive validated decimal text. */
export class DecimalInputError extends Error {
  readonly code: DecimalErrorCode;

  constructor(code: DecimalErrorCode, message: string) {
    super(message);
    this.name = 'DecimalInputError';
    this.code = code;
  }
}

/** True when `value` is a Decimal.js instance (of any Decimal.js configuration). */
export function isDecimal(value: unknown): value is Decimal {
  return DecimalJs.isDecimal(value);
}

/** True when `text` matches the fixed decimal grammar. */
export function isDecimalText(text: string): boolean {
  return DECIMAL_TEXT_PATTERN.test(text);
}

/**
 * Brands validated decimal text without changing it. Used by the shared Zod
 * schemas, so a schema accepts in-range values unchanged (no canonicalization).
 */
export function brandDecimalString(text: string): DecimalString {
  if (!isDecimalText(text)) {
    throw new DecimalInputError('MALFORMED_NUMBER', 'Value does not match the fixed decimal grammar.');
  }
  return text as DecimalString;
}

/**
 * Creates a Decimal from validated decimal text or an existing Decimal.
 * JavaScript numbers, `NaN`, `Infinity`, and exponent notation are rejected.
 */
export function d(value: string | Decimal): Decimal {
  if (typeof value === 'string') {
    if (!isDecimalText(value)) {
      throw new DecimalInputError('MALFORMED_NUMBER', 'Value does not match the fixed decimal grammar.');
    }
    return new DEC(value);
  }
  if (DecimalJs.isDecimal(value)) {
    if (!value.isFinite()) {
      throw new DecimalInputError('NON_FINITE', 'Decimal value is not finite.');
    }
    return value instanceof DEC ? value : new DEC(value);
  }
  throw new DecimalInputError(
    'NOT_A_DECIMAL_INPUT',
    `d() accepts only decimal strings or Decimal values, received ${typeof value}.`,
  );
}

/** Serializes a Decimal as a Canonical Decimal String (R4.3). */
export function toCanonical(x: Decimal): DecimalString {
  if (!x.isFinite()) {
    throw new DecimalInputError('NON_FINITE', 'Only finite Decimal values can be serialized.');
  }
  if (x.isZero()) {
    return '0' as DecimalString;
  }
  // toFixed() without arguments returns normal notation without rounding.
  let text = x.toFixed();
  if (text.includes('.')) {
    text = text.replace(/0+$/, '').replace(/\.$/, '');
  }
  return text as DecimalString;
}

/**
 * Rounds a monetary value for display only: ROUND_HALF_UP to the currency's
 * minor units (2 by default, 0 for JPY), per FR-14. Never round intermediate results.
 */
export function roundMoney(x: Decimal, minorUnits: number): Decimal {
  if (!Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 4) {
    throw new RangeError('minorUnits must be an integer between 0 and 4.');
  }
  return x.toDecimalPlaces(minorUnits, DECIMAL_ROUNDING);
}

/**
 * Display text of a monetary value (FR-14, task 17.3): `roundMoney` to the
 * currency's minor units, written with exactly that many decimals (`"1000.00"`).
 * Display only: the canonical value stays the reported value and is never replaced.
 */
export function formatMoneyDisplay(value: DecimalString, minorUnits: number): string {
  // toFixed on the already rounded Decimal only pads; it does not round again.
  return roundMoney(d(value), minorUnits).toFixed(minorUnits);
}

/**
 * ISO 4217 minor units of a currency (2 for EUR, USD, GBP; 0 for JPY), from the
 * runtime's ICU currency data. A count of decimal places, not a financial value.
 */
export function currencyMinorUnits(currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError('currency must be a three-letter ISO 4217 code.');
  }
  const digits: unknown = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits;
  if (typeof digits !== 'number' || !Number.isInteger(digits) || digits < 0 || digits > 4) {
    throw new RangeError(`No minor-unit information for ${currency}.`);
  }
  return digits;
}

/**
 * The only conversion from a financial value to a native number (R4.4).
 * For chart pixel and axis values in `src/web/chartAdapter.ts` only; the result
 * is display-only and must never be used in a calculation, sent to the API, or stored.
 */
export function toChartNumber(x: DecimalString): number {
  return d(x).toNumber();
}
