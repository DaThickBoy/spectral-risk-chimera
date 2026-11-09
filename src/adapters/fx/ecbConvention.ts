/**
 * Publication-time convention `ECB-PUB-1600-FRANKFURT-v1` (task 10.2; R30.13;
 * design: ECB adapter rule 2).
 *
 * The ECB euro reference rate for reference date D is treated as available at
 * D 16:00 Europe/Frankfurt local time: 14:00:00.000Z under CEST (UTC+2) and
 * 15:00:00.000Z under CET (UTC+1). CEST runs from the last Sunday of March
 * 01:00 UTC to the last Sunday of October 01:00 UTC (EU summer-time rule), so at
 * 16:00 local time a date D is in CEST exactly when
 * lastSunday(March) <= D < lastSunday(October).
 *
 * Integer calendar arithmetic only (Sakamoto's weekday method); no time-zone
 * database and no `Date` parsing. This is a conservative availability time, never
 * the fixing time or a measured observation; a change of the rule gets a new id.
 * The rule is the EU summer-time rule in force since 1996 (Directive 2000/84/EC
 * and its predecessor); the ECB reference rates start in 1999, so earlier dates
 * never occur. Before 1996 summer time ended in September; this convention does
 * not describe those years.
 */
import { isIsoDate } from '../../fx/index.js';

export const ECB_CONVENTION_ID = 'ECB-PUB-1600-FRANKFURT-v1';

const SAKAMOTO = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4] as const;

/** Day of week, 0 = Sunday, for a proleptic Gregorian date (integers only). */
function weekday(year: number, month: number, day: number): number {
  const y = month < 3 ? year - 1 : year;
  const offset = SAKAMOTO[month - 1] ?? 0;
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + offset + day) % 7;
}

/** Day of month of the last Sunday of a 31-day month (March or October). */
function lastSunday(year: number, month: 3 | 10): number {
  return 31 - weekday(year, month, 31);
}

/** True when 16:00 Frankfurt time on the date falls in CEST. */
export function isCentralEuropeanSummerTime(date: string): boolean {
  const year = Number.parseInt(date.slice(0, 4), 10); // calendar integers, not financial values
  const month = Number.parseInt(date.slice(5, 7), 10);
  const day = Number.parseInt(date.slice(8, 10), 10);
  if (month > 3 && month < 10) {
    return true;
  }
  if (month === 3) {
    return day >= lastSunday(year, 3);
  }
  if (month === 10) {
    return day < lastSunday(year, 10);
  }
  return false;
}

/** The convention instant of reference date `date` (`YYYY-MM-DD`), as `IsoUtcMillis`. */
export function ecbPublicationInstant(date: string): string {
  if (!isIsoDate(date)) {
    throw new TypeError('date must be a valid YYYY-MM-DD date.');
  }
  return `${date}T${isCentralEuropeanSummerTime(date) ? '14' : '15'}:00:00.000Z`;
}
