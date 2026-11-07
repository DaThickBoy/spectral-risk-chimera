/**
 * Shared Zod 4 primitives for external boundaries (R4.6, R21.1 to R21.3, D-3, D-4).
 *
 * - Decimal fields are strings in the fixed decimal grammar. JSON numbers,
 *   exponent notation, `NaN`, and `Infinity` are rejected.
 * - Range checks reject out-of-range values; nothing is clamped, coerced, or
 *   canonicalized. Accepted values are returned unchanged.
 * - `SentimentIndex` (-1 to +1, market mood) and `FilingRiskScore` (0 to 1,
 *   disclosed-risk severity) are distinct branded types and are not assignable
 *   to each other (R11).
 */
import { z } from 'zod';
import { brandDecimalString, d, DECIMAL_TEXT_PATTERN } from './decimal.js';
import type { DecimalString } from './decimal.js';

export const DecimalStringSchema = z
  .string()
  .regex(DECIMAL_TEXT_PATTERN, { message: 'MALFORMED_NUMBER: expected a decimal string without exponent' })
  .transform((text): DecimalString => brandDecimalString(text));

export const PositiveDecimalString = DecimalStringSchema.refine((value) => d(value).greaterThan(0), {
  message: 'must be greater than 0',
});

/** Inclusive range check on validated decimal text. */
export function decimalInRange(min: string, max: string): (value: DecimalString) => boolean {
  return (value) => {
    const x = d(value);
    return x.greaterThanOrEqualTo(min) && x.lessThanOrEqualTo(max);
  };
}

/** FilingRiskScore range: 0 (low) to 1 (high), inclusive. */
export const UnitIntervalDecimalString = DecimalStringSchema.refine(decimalInRange('0', '1'), {
  message: 'must be between 0 and 1 inclusive',
});

/** SentimentIndex range: -1 (bearish) to +1 (bullish), inclusive. */
export const SignedUnitDecimalString = DecimalStringSchema.refine(decimalInRange('-1', '1'), {
  message: 'must be between -1 and 1 inclusive',
});

export type SentimentIndex = DecimalString & { readonly __kind: 'SentimentIndex' };
export type FilingRiskScore = DecimalString & { readonly __kind: 'FilingRiskScore' };

export const SentimentIndexSchema = SignedUnitDecimalString.transform(
  (value): SentimentIndex => value as SentimentIndex,
);

export const FilingRiskScoreSchema = UnitIntervalDecimalString.transform(
  (value): FilingRiskScore => value as FilingRiskScore,
);

function isCalendarDate(text: string): boolean {
  const [y, m, day] = text.split('-').map((part) => Number.parseInt(part, 10));
  if (y === undefined || m === undefined || day === undefined) {
    return false;
  }
  const date = new Date(Date.UTC(y, m - 1, day));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === day;
}

/** Calendar date `YYYY-MM-DD` that exists (for example 2026-02-30 is rejected). */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'expected YYYY-MM-DD' })
  .refine(isCalendarDate, { message: 'not a valid calendar date' });

/** ISO 8601 timestamp with an explicit offset or `Z`. */
export const IsoTimestamp = z.iso.datetime({ offset: true });

const KNOWN_CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));

export function isKnownCurrency(code: string): boolean {
  return KNOWN_CURRENCIES.has(code);
}

/** ISO 4217 alphabetic currency code known to the runtime's ICU data. */
export const Iso4217Code = z
  .string()
  .regex(/^[A-Z]{3}$/, { message: 'expected a three-letter ISO 4217 code' })
  .refine(isKnownCurrency, { message: 'unknown ISO 4217 currency code' });
