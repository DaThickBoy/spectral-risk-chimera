/**
 * Sentiment freshness policy (task 13.3; FR-8; R9.7, R10.6, R15.2, R15.13).
 *
 * `CURRENT` when `now - observedAt <= sentiment.maxAgeSeconds`, otherwise
 * `STALE` (strictly older than the maximum age); never received or invalid is
 * `UNAVAILABLE`. An observation stamped slightly in the future (within the
 * accepted skew, R9.9) has a negative age and is `CURRENT`. `DEMO` is a separate
 * source flag: demo data is never eligible for the adjustment, whatever its
 * freshness (FR-8). Ages are integer milliseconds, not financial values.
 */
export type SentimentStatus = 'CURRENT' | 'STALE' | 'UNAVAILABLE';

export function sentimentFreshness(
  observedAt: string | null,
  now: string,
  maxAgeSeconds: number,
): SentimentStatus {
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new TypeError('maxAgeSeconds must be a positive integer.');
  }
  if (observedAt === null) {
    return 'UNAVAILABLE';
  }
  const observed = Date.parse(observedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(observed) || !Number.isFinite(current)) {
    return 'UNAVAILABLE';
  }
  return current - observed <= maxAgeSeconds * 1000 ? 'CURRENT' : 'STALE';
}
