/**
 * Result validity policy (task 12.3; design: Risk Worker and Scheduler,
 * `ResultValidityPolicy`; R13.5, R13.7, R14.14, FR-8).
 *
 * Two validities per result, never one combined value (R13.7):
 * - `baseValidity`: `LAST_VALID` for a retained earlier result; otherwise
 *   `CURRENT` only for status `OK` without `MARKET_DATA_STALE`, `STALE` for `OK`
 *   with that flag, and `UNAVAILABLE` for every other status. A Reduced Lookback
 *   `OK` result may be `CURRENT` (its `REDUCED_LOOKBACK` flag is shown).
 * - `adjustedValidity`: `UNAVAILABLE` when the adjusted status is
 *   `ADJUSTMENT_CONFIG_MISSING`, `SENTIMENT_NOT_CURRENT`, or `BASE_UNAVAILABLE`;
 *   otherwise equal to `baseValidity`.
 * The view model builder and the alert evaluator both use this one policy.
 * Pure. Validates: Requirements 13.5, 13.7, 14.14.
 */
import type { AdjustedStatus, CalcFlag, CalcStatus } from './types.js';

export type Validity = 'CURRENT' | 'STALE' | 'LAST_VALID' | 'UNAVAILABLE';

export interface ValidityInput {
  readonly status: CalcStatus;
  readonly flags: readonly CalcFlag[];
  readonly adjustedStatus: AdjustedStatus;
  /** True when this result is shown as a retained earlier result (R13.5). */
  readonly retained: boolean;
}

export interface Validities {
  readonly baseValidity: Validity;
  readonly adjustedValidity: Validity;
}

const ADJUSTED_UNAVAILABLE: ReadonlySet<AdjustedStatus> = new Set([
  'ADJUSTMENT_CONFIG_MISSING',
  'SENTIMENT_NOT_CURRENT',
  'BASE_UNAVAILABLE',
]);

export function deriveValidity(input: ValidityInput): Validities {
  let baseValidity: Validity;
  if (input.status !== 'OK') {
    baseValidity = 'UNAVAILABLE';
  } else if (input.retained) {
    baseValidity = 'LAST_VALID';
  } else {
    baseValidity = input.flags.includes('MARKET_DATA_STALE') ? 'STALE' : 'CURRENT';
  }
  const adjustedValidity = ADJUSTED_UNAVAILABLE.has(input.adjustedStatus) ? 'UNAVAILABLE' : baseValidity;
  return { baseValidity, adjustedValidity };
}
