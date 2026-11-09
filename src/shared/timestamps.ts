/**
 * Canonical UTC timestamp text (R28.18; persistence ports `IsoUtc`).
 *
 * The persisted form is fixed width: `YYYY-MM-DDTHH:mm:ss.sssZ`, exactly as
 * `Date.prototype.toISOString` produces it for years 0000 to 9999. Because every
 * value has the same width and the same UTC designator, ordinal string order is
 * chronological order, which the ledger replay order relies on.
 *
 * `isIsoUtcMillis` checks the shape and the actual calendar and clock values:
 * month 01-12, a day that exists in that month (leap years per the Gregorian
 * rule), hour 00-23, minute 00-59, second 00-59 (no leap second, as
 * `toISOString` never emits one). Offsets, missing or extra fractional digits,
 * lowercase designators, and surrounding whitespace are rejected. No `Date`
 * parsing is involved, so there are no two-digit-year or overflow quirks.
 */
import { z } from 'zod';

/** Shape only; `isIsoUtcMillis` also checks calendar and clock values. */
export const ISO_UTC_MILLIS_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** True when `value` is a canonical fixed-width UTC timestamp naming a real instant. */
export function isIsoUtcMillis(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const match = ISO_UTC_MILLIS_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const part = (index: number): number => Number.parseInt(match[index] ?? '', 10);
  const [year, month, day, hour, minute, second] = [part(1), part(2), part(3), part(4), part(5), part(6)];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const monthDays = DAYS_IN_MONTH[month - 1] ?? 0;
  const lastDay = month === 2 && isLeapYear(year) ? 29 : monthDays;
  return day >= 1 && day <= lastDay;
}

/** Zod schema for the same contract, for boundaries that validate with Zod. */
export const IsoUtcMillis = z.string().refine(isIsoUtcMillis, {
  message: 'expected a UTC timestamp YYYY-MM-DDTHH:mm:ss.sssZ',
});
