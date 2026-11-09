// Task 19.2, AT-SEC-16: the shared sliding-window limiter under FakeClock and FakeSleeper.
// Validates: Requirements 6.7
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createSecRateLimiter } from '../../../src/sec/index.js';
import type { SecRateLimitOutcome } from '../../../src/sec/index.js';
import { FakeClock, FakeSleeper, systemClock, systemSleeper } from '../../../src/shared/index.js';
import { START, advanceBy, drive } from '../../helpers/resilience.js';

function setup(maxPerWindow: number) {
  const clock = new FakeClock(START);
  const sleeper = new FakeSleeper(clock);
  return { clock, sleeper, limiter: createSecRateLimiter({ clock, sleeper, maxPerWindow, windowMs: 1000 }) };
}

const never = new AbortController().signal;

/** At most `max` grants in every half-open window [t, t + 1000) starting at a grant. */
const windowHolds = (times: readonly number[], max: number): boolean =>
  times.every((start) => times.filter((t) => t >= start && t < start + 1000).length <= max);

describe('SecRateLimiter', () => {
  it('rejects invalid construction', () => {
    for (const maxPerWindow of [0, 11, 1.5]) {
      expect(() =>
        createSecRateLimiter({ clock: systemClock, sleeper: systemSleeper, maxPerWindow, windowMs: 1000 }),
      ).toThrow(RangeError);
    }
    expect(() =>
      createSecRateLimiter({ clock: systemClock, sleeper: systemSleeper, maxPerWindow: 5, windowMs: 0 }),
    ).toThrow(RangeError);
  });

  it('grants a burst of maxPerWindow at once, then one window later', async () => {
    const { clock, sleeper, limiter } = setup(2);
    const times: number[] = [];
    const take = async () => {
      const outcome = await limiter.acquire(Number.POSITIVE_INFINITY, never);
      times.push(clock.monotonicMs());
      return outcome;
    };
    const outcomes = await drive(sleeper, Promise.all([take(), take(), take(), take(), take()]));
    expect(outcomes).toEqual(['GRANTED', 'GRANTED', 'GRANTED', 'GRANTED', 'GRANTED']);
    expect(times).toEqual([0, 0, 1000, 1000, 2000]);
  });

  it('returns DEADLINE without reserving when the slot is at or after the deadline', async () => {
    const { sleeper, limiter } = setup(1);
    expect(await limiter.acquire(10, never)).toBe('GRANTED');
    // The next slot is 1000: a deadline of exactly 1000 is refused and nothing is reserved.
    expect(await limiter.acquire(1000, never)).toBe('DEADLINE');
    expect(sleeper.pending).toBe(0);
    const pending = limiter.acquire(1001, never);
    expect(await drive(sleeper, pending)).toBe('GRANTED');
  });

  it('an aborted wait returns ABORTED and keeps its reservation (only delays later callers)', async () => {
    const { clock, sleeper, limiter } = setup(1);
    await limiter.acquire(Number.POSITIVE_INFINITY, never);
    const controller = new AbortController();
    const waiting = limiter.acquire(Number.POSITIVE_INFINITY, controller.signal);
    controller.abort();
    expect(await waiting).toBe('ABORTED');
    const after = limiter.acquire(Number.POSITIVE_INFINITY, never);
    expect(await drive(sleeper, after)).toBe('GRANTED');
    expect(clock.monotonicMs()).toBe(2000);
  });

  it('an already aborted signal returns ABORTED without reserving', async () => {
    const { limiter } = setup(1);
    const controller = new AbortController();
    controller.abort();
    expect(await limiter.acquire(Number.POSITIVE_INFINITY, controller.signal)).toBe('ABORTED');
    expect(await limiter.acquire(1, never)).toBe('GRANTED');
  });

  it('property: concurrent callers arriving at any times never exceed the window', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 1500 }), fc.integer({ min: 1, max: 4 })), {
          minLength: 1,
          maxLength: 15,
        }),
        async (max, arrivals) => {
          const { clock, sleeper, limiter } = setup(max);
          const granted: number[] = [];
          const outcomes: Promise<SecRateLimitOutcome>[] = [];
          for (const [gap, concurrent] of arrivals) {
            // Fires due waiters one at a time, so each records its own grant time.
            await advanceBy({ clock, sleeper }, gap);
            for (let i = 0; i < concurrent; i += 1) {
              outcomes.push(
                limiter.acquire(Number.POSITIVE_INFINITY, never).then((outcome) => {
                  granted.push(clock.monotonicMs());
                  return outcome;
                }),
              );
            }
            await new Promise((resolve) => setImmediate(resolve));
          }
          const all = await drive(sleeper, Promise.all(outcomes));
          expect(all.every((o) => o === 'GRANTED')).toBe(true);
          expect(windowHolds(granted, max)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});
