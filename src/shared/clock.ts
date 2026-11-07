/**
 * Time source (D-12). Domain code receives a `Clock` and never calls
 * `Date.now()` or `new Date()` directly. Wall-clock time is UTC; the monotonic
 * reading is for measuring intervals and is unaffected by wall-clock changes.
 */
export interface Clock {
  /** Current wall-clock time (UTC instant). */
  nowUtc(): Date;
  /** Monotonic milliseconds since an arbitrary origin. */
  monotonicMs(): number;
}

/** The real clock, backed by the system time and `performance.now()`. */
export const systemClock: Clock = {
  nowUtc: () => new Date(),
  monotonicMs: () => performance.now(),
};

/** A controllable clock for tests. Time moves only when told to. */
export class FakeClock implements Clock {
  private wallMs: number;
  private monoMs: number;

  constructor(start: Date | string, monotonicStartMs = 0) {
    const startMs = new Date(start).getTime();
    if (Number.isNaN(startMs)) {
      throw new RangeError('FakeClock start time is not a valid date.');
    }
    assertNonNegativeMs(monotonicStartMs, 'monotonicStartMs');
    this.wallMs = startMs;
    this.monoMs = monotonicStartMs;
  }

  nowUtc(): Date {
    return new Date(this.wallMs);
  }

  monotonicMs(): number {
    return this.monoMs;
  }

  /** Advances wall-clock and monotonic time together. */
  advance(ms: number): void {
    assertNonNegativeMs(ms, 'ms');
    this.wallMs += ms;
    this.monoMs += ms;
  }

  /** Sets the wall clock (for example a clock jump). Monotonic time is unchanged. */
  setUtc(date: Date | string): void {
    const ms = new Date(date).getTime();
    if (Number.isNaN(ms)) {
      throw new RangeError('FakeClock time is not a valid date.');
    }
    this.wallMs = ms;
  }
}

function assertNonNegativeMs(ms: number, name: string): void {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number of milliseconds.`);
  }
}
