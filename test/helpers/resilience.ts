// Deterministic harness for ResilientCall tests (task 8.2): FakeClock, FakeSleeper, scripted
// randomness, a capturing redacting logger, and scripted provider attempts.
import { FakeClock, FakeSleeper, createLogger, createResilientCall } from '../../src/shared/index.js';
import type { AttemptOutcome, CircuitPolicy, ResilientCall, RetryPolicy } from '../../src/shared/index.js';

export const START = '2026-11-07T12:00:00.000Z';
export const SECRET = 'test-api-key-0000';

export const DEFAULT_RETRY: Omit<RetryPolicy, 'deadlineMs'> = {
  maxRetries: 3,
  attemptTimeoutMs: 10_000,
  baseDelayMs: 250,
  maxDelayMs: 10_000,
  maxRetryAfterMs: 600_000,
};
export const DEFAULT_CIRCUIT: CircuitPolicy = { failureThreshold: 5, openMs: 60_000 };

export interface Harness {
  readonly clock: FakeClock;
  readonly sleeper: FakeSleeper;
  readonly rc: ResilientCall;
  readonly logs: Record<string, unknown>[];
  /** The value random() returns; change it per test. */
  randomValue: number;
  /** Set to make the logger's sink throw. */
  failLogging: boolean;
}

export function harness(
  retry: Partial<Omit<RetryPolicy, 'deadlineMs'>> = {},
  circuit: Partial<CircuitPolicy> = {},
): Harness {
  const clock = new FakeClock(START);
  const sleeper = new FakeSleeper(clock);
  const logs: Record<string, unknown>[] = [];
  const h = { clock, sleeper, logs, randomValue: 0.5, failLogging: false } as Harness;
  const logger = createLogger({
    clock,
    secrets: [SECRET],
    level: 'debug',
    sink: (line) => {
      if (h.failLogging) {
        throw new Error('log sink down');
      }
      logs.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  const rc = createResilientCall({
    clock,
    sleeper,
    random: () => h.randomValue,
    logger,
    retry: { ...DEFAULT_RETRY, ...retry },
    circuit: { ...DEFAULT_CIRCUIT, ...circuit },
  });
  return Object.assign(h, { rc });
}

/** One scripted attempt: an outcome, a hang (never settles), or a thrown/rejected error. */
export type Step<T> =
  AttemptOutcome<T> | 'HANG' | { readonly throws: unknown } | { readonly rejects: unknown };

export interface Script<T> {
  readonly fn: (signal: AbortSignal) => Promise<AttemptOutcome<T>>;
  /** Monotonic time of each call. */
  readonly calls: number[];
  /** The signal passed to each call. */
  readonly signals: AbortSignal[];
}

/** A provider that plays `steps` in order (the last step repeats). */
export function script<T>(clock: FakeClock, steps: readonly Step<T>[]): Script<T> {
  const calls: number[] = [];
  const signals: AbortSignal[] = [];
  const fn = (signal: AbortSignal): Promise<AttemptOutcome<T>> => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    calls.push(clock.monotonicMs());
    signals.push(signal);
    if (step === undefined || step === 'HANG') {
      return new Promise(() => undefined);
    }
    if ('throws' in step) {
      throw step.throws;
    }
    if ('rejects' in step) {
      return Promise.reject(step.rejects);
    }
    return Promise.resolve(step);
  };
  return { fn, calls, signals };
}

export const NETWORK = { ok: false, failure: 'NETWORK' } as const;
export const TIMEOUT = { ok: false, failure: 'TIMEOUT' } as const;
export const INVALID = { ok: false, failure: 'INVALID_RESPONSE' } as const;
export const TLS = { ok: false, failure: 'TLS' } as const;
export const http = (status: number, retryAfter?: string): AttemptOutcome<never> =>
  retryAfter === undefined
    ? { ok: false, failure: 'HTTP', status }
    : { ok: false, failure: 'HTTP', status, retryAfter };
export const success = <T>(value: T): AttemptOutcome<T> => ({ ok: true, value });

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Runs `promise` to completion: flushes pending callbacks, then advances fake time to the next
 * timer, until the promise settles. Throws if it is stuck (no timers and still pending).
 */
export async function drive<T>(sleeper: FakeSleeper, promise: Promise<T>, maxSteps = 10_000): Promise<T> {
  let settled = false;
  let value: T | undefined;
  void promise.then((result) => {
    settled = true;
    value = result;
  });
  for (let step = 0; step < maxSteps; step += 1) {
    await flush();
    if (settled) {
      return value as T;
    }
    const next = sleeper.nextDueInMs();
    if (next === undefined) {
      throw new Error('drive(): the call is pending with no timer to advance');
    }
    sleeper.advance(next);
  }
  throw new Error('drive(): too many steps');
}

/** Advances fake time by `ms`, flushing callbacks after each timer. */
export async function advanceBy(h: Pick<Harness, 'clock' | 'sleeper'>, ms: number): Promise<void> {
  const { clock, sleeper } = h;
  const target = clock.monotonicMs() + ms;
  await flush();
  for (;;) {
    const next = sleeper.nextDueInMs();
    const now = clock.monotonicMs();
    if (next === undefined || now + next > target) {
      sleeper.advance(target - now);
      await flush();
      return;
    }
    sleeper.advance(next);
    await flush();
  }
}
