/**
 * Shared sliding-window rate limiter for SEC requests (task 19.2; R6.7; design:
 * URL Guard and Client, Rate limiter).
 *
 * Guarantee: at most `maxPerWindow` request starts in any half-open window
 * `[s, s + windowMs)` of monotonic time, across all concurrent callers of one
 * instance. `acquire` reserves its start time synchronously, before any `await`,
 * so two concurrent callers can never take the same slot. The slot is
 *   max(now, latest reservation, reservation[n - maxPerWindow] + windowMs)
 * over the reservations in order (or `now` while fewer than `maxPerWindow`
 * exist). A slot at or after the caller's deadline returns `DEADLINE` without
 * reserving. An abandoned (aborted) reservation is kept: it can only delay later
 * callers and never lets the window be exceeded. Only the newest
 * `maxPerWindow` reservations are retained.
 *
 * Time and waiting are injected (`Clock`, `Sleeper`).
 */
import type { Clock, Sleeper } from '../shared/index.js';

export type SecRateLimitOutcome = 'GRANTED' | 'DEADLINE' | 'ABORTED';

export interface SecRateLimiter {
  acquire(deadlineMonotonicMs: number, signal: AbortSignal): Promise<SecRateLimitOutcome>;
}

export interface SecRateLimiterOptions {
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  /** `sec.maxRequestsPerSecond` (1 to 10). */
  readonly maxPerWindow: number;
  /** Window length in milliseconds (1000 for "per second"). */
  readonly windowMs: number;
}

export function createSecRateLimiter(options: SecRateLimiterOptions): SecRateLimiter {
  const { clock, sleeper, maxPerWindow, windowMs } = options;
  if (!Number.isSafeInteger(maxPerWindow) || maxPerWindow < 1 || maxPerWindow > 10) {
    throw new RangeError('maxPerWindow must be an integer from 1 to 10.');
  }
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new RangeError('windowMs must be a positive integer.');
  }
  // Reservation start times, nondecreasing; at most maxPerWindow entries.
  const reservations: number[] = [];

  const nextSlot = (now: number): number => {
    let slot = now;
    const latest = reservations[reservations.length - 1];
    if (latest !== undefined && latest > slot) {
      slot = latest;
    }
    if (reservations.length >= maxPerWindow) {
      const anchor = reservations[reservations.length - maxPerWindow];
      if (anchor !== undefined && anchor + windowMs > slot) {
        slot = anchor + windowMs;
      }
    }
    return slot;
  };

  return {
    acquire: async (deadlineMonotonicMs, signal) => {
      if (signal.aborted) {
        return 'ABORTED';
      }
      const now = clock.monotonicMs();
      const slot = nextSlot(now);
      if (slot >= deadlineMonotonicMs) {
        return 'DEADLINE';
      }
      // Synchronous reservation: no await between computing and recording the slot.
      reservations.push(slot);
      if (reservations.length > maxPerWindow) {
        reservations.splice(0, reservations.length - maxPerWindow);
      }
      const wait = slot - now;
      if (wait <= 0) {
        return 'GRANTED';
      }
      const slept = await sleeper.sleep(wait, signal);
      return slept === 'ELAPSED' ? 'GRANTED' : 'ABORTED';
    },
  };
}
