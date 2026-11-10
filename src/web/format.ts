/**
 * Display helpers (task 17.3; ui-guidelines 2 and 4). Text only: no value is parsed into a
 * number, rounded, or recalculated here (architecture rule 4). Money text arrives already
 * rounded by the backend (`display`, FR-14); other values are shown exactly as received.
 */

/** Missing values render as an em dash with a status badge, never as "0". */
export const MISSING = '\u2014';

/**
 * Allocation percentage display (design: Allocation rule 5, AT-ALC-11): the canonical
 * value "33.3" is shown as "33.30%". Padding only: a value with more than two decimals is
 * shown unchanged (never truncated or re-rounded).
 */
export function percentText(value: string | null): string {
  if (value === null) {
    return MISSING;
  }
  const match = /^(-?\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) {
    return `${value}%`;
  }
  const [, whole, fraction = ''] = match;
  return `${whole ?? ''}.${fraction.length >= 2 ? fraction : fraction.padEnd(2, '0')}%`;
}

/** A value with its unit, or the em dash. */
export function withUnit(value: string | null, unit: string): string {
  return value === null ? MISSING : `${value} ${unit}`;
}

/** `YYYY-MM-DDTHH:mm:ss.sssZ` as `YYYY-MM-DD HH:mm UTC` (text slicing only). */
export function utcText(timestamp: string | null): string {
  if (timestamp === null) {
    return MISSING;
  }
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(timestamp)
    ? `${timestamp.slice(0, 10)} ${timestamp.slice(11, 16)} UTC`
    : timestamp;
}

/** Confidence as a percentage label: "0.95" -> "95%" by moving the decimal point (text only). */
export function confidencePct(confidence: string | null): string {
  const match = confidence === null ? null : /^0\.(\d{2})$/.exec(confidence);
  return match?.[1] === undefined ? (confidence ?? MISSING) : `${match[1]}%`;
}

/** Status code as a readable label: `FX_STALE` -> `FX STALE`. */
export const codeLabel = (code: string): string => code.replaceAll('_', ' ');
