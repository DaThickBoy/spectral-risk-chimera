/**
 * Trading calendar (task 9.2; FR-3.1; A-14; design U-9).
 *
 * Version 1 treats only weekends as non-trading days: no exchange holidays
 * (OD-3, task 9.5). The weekday of a `YYYY-MM-DD` date is computed with integer
 * arithmetic on the proleptic Gregorian calendar (Sakamoto's method), which is the
 * weekday of that date in UTC; no `Date` object or local time zone is involved.
 */
import { IsoDate } from '../shared/index.js';

export interface TradingCalendar {
  /** Throws `TypeError` for a value that is not a valid `YYYY-MM-DD` date. */
  isTradingDay(date: string): boolean;
}

const MONTH_OFFSETS = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4] as const;

/** Day of the week (0 = Sunday ... 6 = Saturday) of a valid `YYYY-MM-DD` date, in UTC. */
export function utcWeekday(date: string): number {
  if (!IsoDate.safeParse(date).success) {
    throw new TypeError('date must be a valid YYYY-MM-DD date.');
  }
  // Integer calendar arithmetic only (index and day counts, not financial values).
  const month = Number.parseInt(date.slice(5, 7), 10);
  const day = Number.parseInt(date.slice(8, 10), 10);
  const year = Number.parseInt(date.slice(0, 4), 10) - (month < 3 ? 1 : 0);
  const offset = MONTH_OFFSETS[month - 1] ?? 0;
  const value = year + Math.floor(year / 4) - Math.floor(year / 100) + Math.floor(year / 400) + offset + day;
  return value % 7;
}

/** Weekends (Saturday and Sunday, UTC weekday) are the only non-trading days (A-14). */
export const weekendsOnlyCalendar: TradingCalendar = Object.freeze({
  isTradingDay: (date: string): boolean => {
    const weekday = utcWeekday(date);
    return weekday !== 0 && weekday !== 6;
  },
});
