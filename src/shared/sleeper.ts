/**
 * Waiting, as an injectable port (task 8.2; design: Provider Resilience Layer).
 *
 * Domain and resilience code never call `setTimeout` directly; they receive a
 * `Sleeper`, so tests drive time deterministically with `FakeSleeper` and
 * `FakeClock`. `sleep` never rejects: it resolves `ELAPSED` after the delay, or
 * `ABORTED` as soon as the signal aborts (immediately if it already has).
 */
import type { FakeClock } from './clock.js';

export type SleepOutcome = 'ELAPSED' | 'ABORTED';

export interface Sleeper {
  /** Waits `ms` milliseconds (a non-negative number; `Infinity` waits until aborted). */
  sleep(ms: number, signal?: AbortSignal): Promise<SleepOutcome>;
}

function assertDelay(ms: number): void {
  if (typeof ms !== 'number' || Number.isNaN(ms) || ms < 0) {
    throw new RangeError('sleep() requires a non-negative number of milliseconds.');
  }
}

/** Node's timers fire immediately for delays above this, so longer waits are chained. */
const MAX_TIMER_MS = 2_147_483_647;

/** The real sleeper, backed by `setTimeout`. Waits longer than about 24.8 days are chained. */
export const systemSleeper: Sleeper = {
  sleep: (ms, signal) => {
    assertDelay(ms);
    return new Promise<SleepOutcome>((resolve) => {
      if (signal?.aborted === true) {
        resolve('ABORTED');
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let remaining = ms;
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve('ABORTED');
      };
      const schedule = (): void => {
        const step = Math.min(remaining, MAX_TIMER_MS);
        remaining -= step;
        timer = setTimeout(() => {
          if (remaining > 0) {
            schedule();
            return;
          }
          signal?.removeEventListener('abort', onAbort);
          resolve('ELAPSED');
        }, step);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      schedule();
    });
  },
};

interface PendingTimer {
  readonly due: number;
  readonly seq: number;
  readonly resolve: (outcome: SleepOutcome) => void;
  readonly cleanup: () => void;
}

/**
 * A sleeper for tests. Timers wait on the given `FakeClock`'s monotonic time and
 * fire only when `advance` moves time past them, in due-time order. The clock is
 * moved to each timer's due time before that timer fires, so code woken by it
 * observes exactly that time.
 */
export class FakeSleeper implements Sleeper {
  private readonly timers: PendingTimer[] = [];
  private seq = 0;

  constructor(private readonly clock: FakeClock) {}

  sleep(ms: number, signal?: AbortSignal): Promise<SleepOutcome> {
    assertDelay(ms);
    if (signal?.aborted === true) {
      return Promise.resolve('ABORTED');
    }
    if (ms === 0) {
      return Promise.resolve('ELAPSED');
    }
    return new Promise<SleepOutcome>((resolve) => {
      const onAbort = (): void => {
        this.remove(timer);
        resolve('ABORTED');
      };
      const timer: PendingTimer = {
        due: this.clock.monotonicMs() + ms,
        seq: this.seq++,
        resolve,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.timers.push(timer);
    });
  }

  /** Number of timers waiting. */
  get pending(): number {
    return this.timers.length;
  }

  /** Milliseconds until the earliest timer, or `undefined` when none is waiting. */
  nextDueInMs(): number | undefined {
    const next = this.earliest();
    return next === undefined ? undefined : Math.max(0, next.due - this.clock.monotonicMs());
  }

  /** Advances the clock by `ms`, firing every timer that falls due on the way. */
  advance(ms: number): void {
    assertDelay(ms);
    const target = this.clock.monotonicMs() + ms;
    for (let next = this.earliest(); next !== undefined && next.due <= target; next = this.earliest()) {
      this.clock.advance(next.due - this.clock.monotonicMs());
      this.remove(next);
      next.cleanup();
      next.resolve('ELAPSED');
    }
    this.clock.advance(target - this.clock.monotonicMs());
  }

  private earliest(): PendingTimer | undefined {
    let best: PendingTimer | undefined;
    for (const timer of this.timers) {
      if (best === undefined || timer.due < best.due || (timer.due === best.due && timer.seq < best.seq)) {
        best = timer;
      }
    }
    return best;
  }

  private remove(timer: PendingTimer): void {
    const index = this.timers.indexOf(timer);
    if (index >= 0) {
      this.timers.splice(index, 1);
    }
  }
}
