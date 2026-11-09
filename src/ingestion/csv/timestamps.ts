/**
 * Trade timestamp normalization (task 7.2; R28.1, R28.7, R28.18, AT-CSV-23).
 *
 * Accepted input, exactly (no trimming, no case folding):
 * - ISO 8601 with a zone: `YYYY-MM-DDTHH:mm`, optionally `:ss` and `.f` to
 *   `.fff`, followed by `Z` or `±HH:MM`. More than three fractional digits are
 *   rejected (never rounded).
 * - A date only, `YYYY-MM-DD`, interpreted as local midnight in the explicitly
 *   configured `import.defaultTimezone`. Without that setting it is
 *   `INVALID_DATE`; nothing is assumed. A midnight that does not exist in the
 *   zone (a daylight-saving gap) is `INVALID_DATE`; an ambiguous midnight takes
 *   the earlier instant.
 *
 * Calendar and clock values are checked (month, real day, hour 0–23, minute and
 * second 0–59, offset hour 0–23 and minute 0–59). The result is the fixed UTC
 * form `YYYY-MM-DDTHH:mm:ss.sssZ` (years 0000–9999), so ordinal comparison is
 * chronological (R28.18). Integer arithmetic only; these are times, not
 * financial values.
 */
import { isIsoUtcMillis } from '../../shared/index.js';

const WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOUR_MS = 3_600_000;

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const validDate = (y: number, m: number, d: number): boolean =>
  m >= 1 && m <= 12 && d >= 1 && d <= (m === 2 && isLeap(y) ? 29 : (DAYS[m - 1] ?? 0));

/** UTC milliseconds for the given wall time (years 0–99 are not shifted to 19xx). */
function utcMs(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, ms);
  return date.getTime();
}

const toIso = (ms: number): string | undefined => {
  if (!Number.isFinite(ms)) {
    return undefined;
  }
  const text = new Date(ms).toISOString();
  return isIsoUtcMillis(text) ? text : undefined;
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** The wall-clock fields of `instant` in `zone`. */
function wallTime(instant: number, zone: string): [number, number, number, number, number, number] {
  const parts = formatterFor(zone).formatToParts(new Date(instant));
  const get = (type: string): number =>
    Number.parseInt(parts.find((p) => p.type === type)?.value ?? 'NaN', 10);
  return [get('year'), get('month'), get('day'), get('hour'), get('minute'), get('second')];
}

/** UTC instant of local midnight on `y-m-d` in `zone`, or undefined when it does not exist. */
function localMidnight(y: number, m: number, d: number, zone: string): number | undefined {
  const wall = utcMs(y, m, d);
  const candidates = new Set<number>();
  for (const probe of [wall - 12 * HOUR_MS, wall + 12 * HOUR_MS]) {
    const [py, pm, pd, ph, pmi, ps] = wallTime(probe, zone);
    const offset = utcMs(py, pm, pd, ph, pmi, ps) - (probe - (((probe % 1000) + 1000) % 1000));
    const instant = wall - offset;
    const [cy, cm, cd, ch, cmi, cs] = wallTime(instant, zone);
    if (cy === y && cm === m && cd === d && ch === 0 && cmi === 0 && cs === 0) {
      candidates.add(instant);
    }
  }
  // The earlier instant for an ambiguous midnight (integer comparison; not a financial value).
  let earliest: number | undefined;
  for (const instant of candidates) {
    if (earliest === undefined || instant < earliest) {
      earliest = instant;
    }
  }
  return earliest;
}

/** The normalized UTC timestamp, or undefined for `INVALID_DATE`. */
export function normalizeTradeTimestamp(
  text: string,
  defaultTimezone: string | undefined,
): string | undefined {
  const zoned = WITH_ZONE.exec(text);
  if (zoned !== null) {
    const [, ys, mos, ds, hs, mis, ss, fs, zone] = zoned;
    const [y, mo, d, h, mi] = [ys, mos, ds, hs, mis].map((v) => Number.parseInt(v ?? 'NaN', 10)) as [
      number,
      number,
      number,
      number,
      number,
    ];
    const s = ss === undefined ? 0 : Number.parseInt(ss, 10);
    const ms = fs === undefined ? 0 : Number.parseInt(fs.padEnd(3, '0'), 10);
    if (!validDate(y, mo, d) || h > 23 || mi > 59 || s > 59) {
      return undefined;
    }
    let offsetMinutes = 0;
    if (zone !== undefined && zone !== 'Z') {
      const oh = Number.parseInt(zone.slice(1, 3), 10);
      const om = Number.parseInt(zone.slice(4, 6), 10);
      if (oh > 23 || om > 59) {
        return undefined;
      }
      offsetMinutes = (zone.startsWith('-') ? -1 : 1) * (oh * 60 + om);
    }
    return toIso(utcMs(y, mo, d, h, mi, s, ms) - offsetMinutes * 60_000);
  }
  const dateOnly = DATE_ONLY.exec(text);
  if (dateOnly === null || defaultTimezone === undefined) {
    return undefined;
  }
  const [y, m, d] = dateOnly.slice(1, 4).map((v) => Number.parseInt(v, 10)) as [number, number, number];
  if (!validDate(y, m, d)) {
    return undefined;
  }
  const instant = localMidnight(y, m, d, defaultTimezone);
  return instant === undefined ? undefined : toIso(instant);
}
