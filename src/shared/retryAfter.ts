/**
 * `Retry-After` parsing (task 8.2; R25.2; RFC 9110 section 10.2.3).
 *
 * Accepted forms:
 * - delay-seconds: one or more ASCII digits (`120`);
 * - HTTP-date in IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`), and the obsolete
 *   RFC 850 (`Sunday, 06-Nov-94 08:49:37 GMT`) and asctime
 *   (`Sun Nov  6 08:49:37 1994`) forms that recipients must accept.
 * A date is evaluated against the injected wall-clock time; a date in the past
 * means no wait (0). A two-digit RFC 850 year more than 50 years ahead of `now`
 * is taken as the previous century. Calendar and clock fields are validated
 * (no 31 November, hour 00-23, minute 00-59, second 00-60). Anything else,
 * including leading signs, fractions, and surrounding text, is unparseable and
 * returns `undefined`, so the caller falls back to its normal backoff.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const LONG_DAY = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const MONTH = `(${MONTHS.join('|')})`;
const TIME = '(\\d{2}):(\\d{2}):(\\d{2})';

const IMF_FIXDATE = new RegExp(`^${DAY}, (\\d{2}) ${MONTH} (\\d{4}) ${TIME} GMT$`);
const RFC_850 = new RegExp(`^${LONG_DAY}, (\\d{2})-${MONTH}-(\\d{2}) ${TIME} GMT$`);
const ASCTIME = new RegExp(`^${DAY} ${MONTH} ([ \\d]\\d) ${TIME} (\\d{4})$`);
const DELAY_SECONDS = /^\d+$/;

const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

interface DateFields {
  readonly year: number;
  readonly month: number; // 0-11
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function toEpochMs(fields: DateFields): number | undefined {
  const { year, month, day, hour, minute, second } = fields;
  const lastDay = month === 1 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month] ?? 0);
  if (day < 1 || day > lastDay || hour > 23 || minute > 59 || second > 60) {
    return undefined;
  }
  return Date.UTC(year, month, day, hour, minute, second);
}

const int = (text: string | undefined): number => Number.parseInt((text ?? '').trim(), 10);
const monthIndex = (name: string | undefined): number => MONTHS.indexOf(name ?? '');

function parseHttpDate(text: string, now: Date): number | undefined {
  let match = IMF_FIXDATE.exec(text);
  if (match !== null) {
    return toEpochMs({
      day: int(match[1]),
      month: monthIndex(match[2]),
      year: int(match[3]),
      hour: int(match[4]),
      minute: int(match[5]),
      second: int(match[6]),
    });
  }
  match = RFC_850.exec(text);
  if (match !== null) {
    let year = 2000 + int(match[3]);
    if (year > now.getUTCFullYear() + 50) {
      year -= 100;
    }
    return toEpochMs({
      day: int(match[1]),
      month: monthIndex(match[2]),
      year,
      hour: int(match[4]),
      minute: int(match[5]),
      second: int(match[6]),
    });
  }
  match = ASCTIME.exec(text);
  if (match !== null) {
    return toEpochMs({
      month: monthIndex(match[1]),
      day: int(match[2]),
      hour: int(match[3]),
      minute: int(match[4]),
      second: int(match[5]),
      year: int(match[6]),
    });
  }
  return undefined;
}

/** The wait requested by a `Retry-After` value in milliseconds, or `undefined` if unparseable. */
export function parseRetryAfterMs(value: string | undefined, now: Date): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.replace(/^[ \t]+|[ \t]+$/g, '');
  if (DELAY_SECONDS.test(text)) {
    const ms = Number.parseInt(text, 10) * 1000;
    return Number.isSafeInteger(ms) ? ms : Number.MAX_SAFE_INTEGER;
  }
  const at = parseHttpDate(text, now);
  if (at === undefined || Number.isNaN(now.getTime())) {
    return undefined;
  }
  return Math.max(0, at - now.getTime());
}
