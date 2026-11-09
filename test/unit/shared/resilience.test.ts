// Task 8.2: ResilientCall retries, backoff, Retry-After, timeouts, deadlines, cancellation, and
// safe errors. AT-PRV-10, AT-PRV-11, AT-PRV-13. Fully deterministic: FakeClock, FakeSleeper,
// and a fixed random() value; no real time passes.
// Validates: Requirements 25.2, 25.6, 25.7, 25.9, 33.9
import { describe, expect, it } from 'vitest';
import type { ProviderError, RunOptions } from '../../../src/shared/index.js';
import {
  INVALID,
  NETWORK,
  SECRET,
  TIMEOUT,
  TLS,
  advanceBy,
  drive,
  harness,
  http,
  script,
  success,
} from '../../helpers/resilience.js';
import type { Step } from '../../helpers/resilience.js';

async function call<T>(h: ReturnType<typeof harness>, steps: readonly Step<T>[], opts: RunOptions = {}) {
  const s = script(h.clock, steps);
  const result = await drive(h.sleeper, h.rc.run('fixture-md', 'getSeries', s.fn, opts));
  return { result, s };
}

const errorOf = (result: { ok: boolean; error?: ProviderError }): ProviderError => {
  if (result.ok || result.error === undefined) {
    throw new Error('expected a failure');
  }
  return result.error;
};

describe('AT-PRV-10: attempts and retryable classification', () => {
  it('a first-try success makes one call', async () => {
    const h = harness();
    const { result, s } = await call(h, [success('bars')]);
    expect(result).toEqual({ ok: true, value: 'bars' });
    expect(s.calls).toEqual([0]);
  });

  it.each([0, 1, 3])('maxRetries %i makes exactly 1 + maxRetries provider calls', async (maxRetries) => {
    const h = harness({ maxRetries });
    const { result, s } = await call(h, [NETWORK]);
    expect(s.calls).toHaveLength(1 + maxRetries);
    expect(errorOf(result)).toMatchObject({
      code: 'NETWORK_ERROR',
      attempts: 1 + maxRetries,
      retryable: true,
    });
  });

  it.each([
    ['a network error', NETWORK],
    ['an attempt timeout outcome', TIMEOUT],
    ['HTTP 429', http(429)],
    ['HTTP 500', http(500)],
    ['HTTP 503', http(503)],
    ['HTTP 599', http(599)],
  ] as const)('retries %s and succeeds on the next attempt', async (_label, failure) => {
    const h = harness();
    const { result, s } = await call(h, [failure, success(7)]);
    expect(result).toEqual({ ok: true, value: 7 });
    expect(s.calls).toHaveLength(2);
  });

  it.each([400, 401, 403, 404, 409, 422, 499])(
    'does not retry HTTP %i (HTTP_CLIENT_ERROR)',
    async (status) => {
      const h = harness();
      const { result, s } = await call(h, [http(status), success(1)]);
      expect(s.calls).toHaveLength(1);
      expect(errorOf(result)).toMatchObject({
        code: 'HTTP_CLIENT_ERROR',
        httpStatus: status,
        attempts: 1,
        retryable: false,
      });
    },
  );

  it.each([
    ['an invalid response', INVALID, undefined],
    ['an HTTP 200 reported as a failure', http(200), 200],
    ['an HTTP 302', http(302), 302],
    ['an HTTP 600', http(600), 600],
    ['an HTTP 99', http(99), 99],
  ] as const)('does not retry %s (INVALID_RESPONSE)', async (_label, failure, status) => {
    const h = harness();
    const { result, s } = await call(h, [failure, success(1)]);
    expect(s.calls).toHaveLength(1);
    expect(errorOf(result)).toMatchObject({ code: 'INVALID_RESPONSE', attempts: 1, retryable: false });
    expect(errorOf(result).httpStatus).toBe(status);
  });

  it('does not retry a TLS failure (TLS_ERROR) and exposes no detail', async () => {
    const h = harness();
    const { result, s } = await call(h, [TLS, success(1)]);
    expect(s.calls).toHaveLength(1);
    expect(errorOf(result)).toEqual({
      code: 'TLS_ERROR',
      message: 'Provider call fixture-md getSeries failed (TLS_ERROR).',
      provider: 'fixture-md',
      operation: 'getSeries',
      attempts: 1,
      retryable: false,
    });
  });

  it('reports the HTTP status and code of the last attempt', async () => {
    const h = harness({ maxRetries: 2 });
    const { result } = await call(h, [http(503), http(500), http(429)]);
    expect(errorOf(result)).toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
      attempts: 3,
      retryable: true,
    });
  });
});

describe('AT-PRV-10: full-jitter exponential backoff', () => {
  it('waits floor(random * (min(max, base * 2^r) + 1)) before retry r', async () => {
    // random 0.5: r0 floor(0.5 * 251) = 125; r1 floor(0.5 * 501) = 250; r2 floor(0.5 * 1001) = 500.
    const h = harness();
    const { s } = await call(h, [NETWORK]);
    expect(s.calls).toEqual([0, 125, 375, 875]);
  });

  it('random 0 retries immediately; random just below 1 waits the full cap', async () => {
    const low = harness();
    low.randomValue = 0;
    expect((await call(low, [NETWORK])).s.calls).toEqual([0, 0, 0, 0]);
    const high = harness();
    high.randomValue = 0.999999;
    // Caps 250, 500, 1000: waits 250, 500, 1000.
    expect((await call(high, [NETWORK])).s.calls).toEqual([0, 250, 750, 1750]);
  });

  it('caps the delay at maxDelayMs', async () => {
    const h = harness({ maxRetries: 8, baseDelayMs: 250, maxDelayMs: 10_000 });
    h.randomValue = 0.999999;
    const { s } = await call(h, [NETWORK]);
    const waits = s.calls.slice(1).map((time, i) => time - (s.calls[i] ?? 0));
    // 250, 500, 1000, 2000, 4000, 8000, then capped at 10000.
    expect(waits).toEqual([250, 500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
  });

  it('rejects a random() value outside [0, 1) with UNEXPECTED_ERROR', async () => {
    const h = harness();
    h.randomValue = 1;
    const { result } = await call(h, [NETWORK]);
    expect(errorOf(result).code).toBe('UNEXPECTED_ERROR');
  });
});

describe('AT-PRV-10: Retry-After', () => {
  it.each([
    ['integer seconds', '3', 3000],
    ['seconds with surrounding space', ' 2 ', 2000],
    ['an IMF-fixdate', 'Sat, 07 Nov 2026 12:00:05 GMT', 5000],
    ['an RFC 850 date', 'Saturday, 07-Nov-26 12:00:04 GMT', 4000],
    ['an asctime date', 'Sat Nov  7 12:00:06 2026', 6000],
  ])('waits max(backoff, Retry-After) for %s', async (_label, retryAfter, expected) => {
    const h = harness({ maxRetries: 1 });
    h.randomValue = 0;
    const { s } = await call(h, [http(429, retryAfter), success(1)]);
    expect(s.calls).toEqual([0, expected]);
  });

  it('uses the backoff when it is larger than Retry-After', async () => {
    const h = harness({ maxRetries: 1 });
    h.randomValue = 0.999999;
    const { s } = await call(h, [http(503, '0'), success(1)]);
    expect(s.calls).toEqual([0, 250]);
  });

  it.each([
    ['a past date', 'Sat, 07 Nov 2026 11:00:00 GMT'],
    ['an unparseable value', 'soon'],
    ['a negative number', '-5'],
    ['a fraction', '1.5'],
    ['an impossible date', 'Mon, 31 Nov 2026 12:00:05 GMT'],
  ])('falls back to backoff for %s', async (_label, retryAfter) => {
    const h = harness({ maxRetries: 1 });
    h.randomValue = 0.5;
    const { s } = await call(h, [http(503, retryAfter), success(1)]);
    expect(s.calls).toEqual([0, 125]);
  });

  it.each([
    ['delay-seconds above the limit (429)', http(429, '601'), 'RATE_LIMITED', 429],
    ['delay-seconds above the limit (503)', http(503, '86400'), 'HTTP_SERVER_ERROR', 503],
    ['an HTTP date above the limit (429)', http(429, 'Sat, 07 Nov 2026 12:10:01 GMT'), 'RATE_LIMITED', 429],
    [
      'an HTTP date above the limit (503)',
      http(503, 'Sat, 07 Nov 2026 12:10:01 GMT'),
      'HTTP_SERVER_ERROR',
      503,
    ],
    [
      'an RFC 850 date above the limit (502)',
      http(502, 'Sunday, 08-Nov-26 12:00:00 GMT'),
      'HTTP_SERVER_ERROR',
      502,
    ],
  ] as const)(
    'stops at once for %s with its own code, without a deadline, never waiting or retrying early',
    async (_label, failure, code, status) => {
      // 12:00:00 + 600.001 s or more: above provider.retryAfter.maxMs (600,000 ms).
      const h = harness({ maxRetries: 3 });
      const { result, s } = await call(h, [failure, success(1)]);
      expect(s.calls).toEqual([0]);
      expect(h.clock.monotonicMs()).toBe(0);
      expect(h.sleeper.pending).toBe(0);
      expect(errorOf(result)).toMatchObject({ code, httpStatus: status, attempts: 1, retryable: true });
    },
  );

  it.each([
    [429, 'RATE_LIMITED'],
    [503, 'HTTP_SERVER_ERROR'],
  ] as const)(
    'HTTP %i with an excessive Retry-After stops at once (%s) even when a long deadline is set',
    async (status, code) => {
      const h = harness();
      const { result, s } = await call(h, [http(status, '3600'), success(1)], {
        deadlineMs: 86_400_000,
      });
      expect(s.calls).toEqual([0]);
      expect(h.clock.monotonicMs()).toBe(0);
      expect(errorOf(result)).toMatchObject({ code, httpStatus: status, attempts: 1 });
    },
  );

  it('other 4xx keep HTTP_CLIENT_ERROR whatever their Retry-After', async () => {
    const h = harness();
    const { result, s } = await call(h, [http(403, '86400'), success(1)]);
    expect(s.calls).toEqual([0]);
    expect(errorOf(result)).toMatchObject({ code: 'HTTP_CLIENT_ERROR', httpStatus: 403, attempts: 1 });
  });

  it('honours a Retry-After exactly at the limit (seconds and HTTP date)', async () => {
    for (const retryAfter of ['600', 'Sat, 07 Nov 2026 12:10:00 GMT']) {
      const h = harness({ maxRetries: 1 });
      h.randomValue = 0;
      const { result, s } = await call(h, [http(429, retryAfter), success(1)]);
      expect(s.calls).toEqual([0, 600_000]);
      expect(result).toEqual({ ok: true, value: 1 });
    }
  });

  it('within the limit the deadline still applies: a wait reaching it returns the last failure', async () => {
    const h = harness();
    const { result } = await call(h, [http(503, '300'), success(1)], { deadlineMs: 100_000 });
    expect(errorOf(result)).toMatchObject({ code: 'HTTP_SERVER_ERROR', httpStatus: 503, attempts: 1 });
    expect(h.clock.monotonicMs()).toBe(0);
  });

  it('a per-call maxRetryAfterMs override applies', async () => {
    const h = harness();
    const { result, s } = await call(h, [http(429, '5'), success(1)], { maxRetryAfterMs: 4_999 });
    expect(s.calls).toEqual([0]);
    expect(errorOf(result).code).toBe('RATE_LIMITED');
  });

  it.each([
    [429, 'RATE_LIMITED'],
    [503, 'HTTP_SERVER_ERROR'],
  ] as const)(
    'the limit does not change a final attempt: HTTP %i with retries exhausted keeps %s',
    async (status, code) => {
      const h = harness({ maxRetries: 1 });
      h.randomValue = 0;
      const { result, s } = await call(h, [http(status, '1'), http(status, '86400')]);
      expect(s.calls).toEqual([0, 1_000]);
      expect(errorOf(result)).toMatchObject({ code, httpStatus: status, attempts: 2 });
    },
  );

  it('Retry-After never makes a non-retryable status retry', async () => {
    const h = harness();
    const { result, s } = await call(h, [http(404, '1'), success(1)]);
    expect(s.calls).toHaveLength(1);
    expect(errorOf(result).code).toBe('HTTP_CLIENT_ERROR');
  });
});

describe('AT-PRV-13: attempt timeout and a non-cooperative provider', () => {
  it('an attempt that never settles times out after attemptTimeoutMs and its signal is aborted', async () => {
    const h = harness({ maxRetries: 1 });
    h.randomValue = 0;
    const { result, s } = await call(h, ['HANG']);
    expect(s.calls).toEqual([0, 10_000]);
    expect(errorOf(result)).toMatchObject({ code: 'TIMEOUT', attempts: 2, retryable: true });
    expect(s.signals.every((signal) => signal.aborted)).toBe(true);
    expect(h.clock.monotonicMs()).toBe(20_000);
    expect(h.sleeper.pending).toBe(0);
  });

  it('honours a provider-specific attemptTimeoutMs override', async () => {
    const h = harness({ maxRetries: 0 });
    await call(h, ['HANG'], { attemptTimeoutMs: 30_000 });
    expect(h.clock.monotonicMs()).toBe(30_000);
  });

  it('ignores a late fulfilment or rejection of an abandoned attempt, without unhandled rejections', async () => {
    const h = harness({ maxRetries: 0 });
    let rejectLate: (reason: unknown) => void = () => undefined;
    let resolveLate: (value: unknown) => void = () => undefined;
    const late = [
      () => new Promise<never>((_resolve, reject) => (rejectLate = reject)),
      () => new Promise<never>((resolve) => (resolveLate = resolve as (value: unknown) => void)),
    ];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      for (const make of late) {
        const result = await drive(h.sleeper, h.rc.run('p', 'op', make));
        expect(errorOf(result).code).toBe('TIMEOUT');
      }
      rejectLate(new Error(`late failure ${SECRET}`));
      resolveLate({ ok: true, value: 'too late' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('AT-PRV-13: overall deadline on monotonic time', () => {
  it('caps the last attempt at the remaining budget and never runs past the deadline', async () => {
    // Attempt 1 hangs 10000; wait 125; attempt 2 is capped at 15000 - 10125 = 4875.
    const h = harness({ maxRetries: 3 });
    const { result, s } = await call(h, ['HANG'], { deadlineMs: 15_000 });
    expect(s.calls).toEqual([0, 10_125]);
    expect(h.clock.monotonicMs()).toBe(15_000);
    expect(errorOf(result)).toMatchObject({ code: 'TIMEOUT', attempts: 2 });
  });

  it('does not wait when the wait would reach the deadline; returns the last failure', async () => {
    const h = harness();
    const { result, s } = await call(h, [http(503, '60'), success(1)], { deadlineMs: 30_000 });
    expect(s.calls).toEqual([0]);
    expect(h.clock.monotonicMs()).toBe(0);
    expect(errorOf(result)).toMatchObject({ code: 'HTTP_SERVER_ERROR', httpStatus: 503, attempts: 1 });
  });

  it('a zero deadline makes no attempt', async () => {
    const h = harness();
    const { result, s } = await call(h, [success(1)], { deadlineMs: 0 });
    expect(s.calls).toEqual([]);
    expect(errorOf(result)).toMatchObject({ code: 'TIMEOUT', attempts: 0 });
  });

  it('measures the deadline on monotonic time, unaffected by wall-clock jumps', async () => {
    const h = harness({ maxRetries: 1 });
    h.randomValue = 0;
    h.clock.setUtc('2030-01-01T00:00:00.000Z');
    const { result } = await call(h, [NETWORK, success(5)], { deadlineMs: 1_000 });
    expect(result).toEqual({ ok: true, value: 5 });
  });
});

describe('AT-PRV-13: caller cancellation', () => {
  it('a signal aborted before the call makes no attempt', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const { result, s } = await call(h, [success(1)], { signal: controller.signal });
    expect(s.calls).toEqual([]);
    expect(errorOf(result)).toMatchObject({ code: 'CANCELLED', attempts: 0, retryable: false });
  });

  it('cancelling during an attempt aborts it at once and does not retry', async () => {
    const h = harness();
    const controller = new AbortController();
    const s = script(h.clock, ['HANG']);
    const pending = h.rc.run('p', 'op', s.fn, { signal: controller.signal });
    await advanceBy(h, 1_000);
    controller.abort();
    const result = await drive(h.sleeper, pending);
    expect(errorOf(result)).toMatchObject({ code: 'CANCELLED', attempts: 1 });
    expect(h.clock.monotonicMs()).toBe(1_000);
    expect(s.signals[0]?.aborted).toBe(true);
    expect(h.sleeper.pending).toBe(0);
  });

  it('cancelling during a backoff wait ends it at once with no further attempt', async () => {
    const h = harness();
    h.randomValue = 0.999999;
    const controller = new AbortController();
    const s = script(h.clock, [NETWORK, success(1)]);
    const pending = h.rc.run('p', 'op', s.fn, { signal: controller.signal });
    await advanceBy(h, 100);
    controller.abort();
    const result = await drive(h.sleeper, pending);
    expect(errorOf(result)).toMatchObject({ code: 'CANCELLED', attempts: 1 });
    expect(s.calls).toEqual([0]);
    expect(h.clock.monotonicMs()).toBe(100);
  });
});

describe('AT-PRV-13: unexpected exceptions are UNEXPECTED_ERROR, never network errors', () => {
  const boom = Object.assign(new Error(`socket hang up ${SECRET}`), { code: 'ECONNRESET' });

  it.each([
    ['a synchronous throw', { throws: boom }],
    ['a rejection', { rejects: boom }],
    ['a non-Error rejection', { rejects: `raw ${SECRET}` }],
  ] as const)('%s gives a generic, non-retryable UNEXPECTED_ERROR', async (_label, step) => {
    const h = harness();
    const { result, s } = await call(h, [step, success(1)]);
    const error = errorOf(result);
    expect(error).toMatchObject({ code: 'UNEXPECTED_ERROR', attempts: 1, retryable: false });
    expect(s.calls).toHaveLength(1);
    expect(error.message).toBe('Provider call fixture-md getSeries failed (UNEXPECTED_ERROR).');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain('ECONNRESET');
    // The original is logged through the redacting logger.
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ level: 'error', code: 'UNEXPECTED_ERROR', provider: 'fixture-md' });
    expect(JSON.stringify(h.logs)).not.toContain(SECRET);
  });

  it.each([
    ['undefined', undefined],
    ['an empty object', {}],
    ['ok true without value', { ok: true }],
    ['an unknown failure kind', { ok: false, failure: 'WEIRD' }],
    ['a string HTTP status', { ok: false, failure: 'HTTP', status: '500' }],
    ['a non-string Retry-After', { ok: false, failure: 'HTTP', status: 503, retryAfter: 3 }],
  ])('a malformed outcome (%s) is UNEXPECTED_ERROR', async (_label, outcome) => {
    const h = harness();
    const fn = () => Promise.resolve(outcome as never);
    const result = await drive(h.sleeper, h.rc.run('p', 'op', fn));
    expect(errorOf(result)).toMatchObject({ code: 'UNEXPECTED_ERROR', attempts: 1 });
  });

  it('exceptionLogging FULL is the default 8.2 behaviour: the (redacted) original is logged', async () => {
    for (const opts of [{}, { exceptionLogging: 'FULL' as const }]) {
      const h = harness();
      await call(h, [{ throws: new Error('upstream detail') }], opts);
      expect(h.logs).toHaveLength(1);
      expect(h.logs[0]).toHaveProperty('error');
      expect(JSON.stringify(h.logs)).toContain('upstream detail');
      expect(h.logs[0]).not.toHaveProperty('attempt');
    }
  });

  it.each([
    ['a thrown Error', { throws: new Error(`content PRIVATE-DETAIL ${SECRET}`) }, 'EXCEPTION'],
    ['a rejected non-Error', { rejects: 'raw PRIVATE-DETAIL value' }, 'EXCEPTION'],
    [
      'an Error with a cause',
      { throws: new Error('outer', { cause: new Error('PRIVATE-DETAIL') }) },
      'EXCEPTION',
    ],
    ['a malformed outcome', { ok: 'PRIVATE-DETAIL' } as never, 'MALFORMED_OUTCOME'],
  ] as const)(
    'exceptionLogging METADATA_ONLY never logs %s, only metadata',
    async (_label, step, failure) => {
      const h = harness();
      const { result } = await call(h, [step as never], { exceptionLogging: 'METADATA_ONLY' });
      expect(errorOf(result).code).toBe('UNEXPECTED_ERROR');
      expect(h.logs).toHaveLength(1);
      expect(h.logs[0]).toMatchObject({
        level: 'error',
        code: 'UNEXPECTED_ERROR',
        provider: 'fixture-md',
        operation: 'getSeries',
        failure,
        attempt: 1,
      });
      expect(h.logs[0]).not.toHaveProperty('error');
      expect(JSON.stringify(h.logs)).not.toContain('PRIVATE-DETAIL');
    },
  );

  it('METADATA_ONLY reports the attempt number of the failing attempt', async () => {
    const h = harness({ maxRetries: 3 });
    h.randomValue = 0;
    await call(h, [NETWORK, NETWORK, { throws: new Error('PRIVATE-DETAIL') }], {
      exceptionLogging: 'METADATA_ONLY',
    });
    expect(h.logs.map((entry) => entry['attempt'])).toEqual([3]);
    expect(JSON.stringify(h.logs)).not.toContain('PRIVATE-DETAIL');
  });

  it('an unknown exceptionLogging value fails closed to metadata only', async () => {
    const h = harness();
    await call(h, [{ throws: new Error('PRIVATE-DETAIL') }], { exceptionLogging: 'VERBOSE' as never });
    expect(h.logs[0]).not.toHaveProperty('error');
    expect(JSON.stringify(h.logs)).not.toContain('PRIVATE-DETAIL');
  });

  it('METADATA_ONLY also covers an internal programmer error (invalid policy)', async () => {
    const h = harness();
    await call(h, [success(1)], { maxRetries: -1, exceptionLogging: 'METADATA_ONLY' });
    expect(h.logs[0]).toMatchObject({ code: 'UNEXPECTED_ERROR', failure: 'INTERNAL' });
    expect(h.logs[0]).not.toHaveProperty('error');
  });

  it('a failing logger never changes the result or makes run reject', async () => {
    const h = harness();
    h.failLogging = true;
    const { result } = await call(h, [{ throws: boom }]);
    expect(errorOf(result).code).toBe('UNEXPECTED_ERROR');
  });

  it('an invalid policy resolves to UNEXPECTED_ERROR instead of rejecting', async () => {
    const h = harness();
    for (const opts of [
      { maxRetries: -1 },
      { attemptTimeoutMs: 0 },
      { deadlineMs: 1.5 },
      { baseDelayMs: 20_000 },
      { maxRetryAfterMs: 0 },
    ]) {
      const { result, s } = await call(h, [success(1)], opts);
      expect(errorOf(result)).toMatchObject({ code: 'UNEXPECTED_ERROR', attempts: 0 });
      expect(s.calls).toEqual([]);
    }
  });
});

describe('AT-PRV-11: errors name provider, operation, and code without secrets; status is reported', () => {
  it('a failure carries provider, operation, code, attempts, and status, and no secret', async () => {
    const h = harness({ maxRetries: 1 });
    const { result } = await call(h, [http(503, SECRET)]);
    expect(errorOf(result)).toEqual({
      code: 'HTTP_SERVER_ERROR',
      message: 'Provider call fixture-md getSeries failed (HTTP_SERVER_ERROR).',
      provider: 'fixture-md',
      operation: 'getSeries',
      attempts: 2,
      retryable: true,
      httpStatus: 503,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('status reports the last error code after a failure', async () => {
    const h = harness({ maxRetries: 0 });
    await call(h, [NETWORK]);
    expect(h.rc.status('fixture-md')).toMatchObject({
      provider: 'fixture-md',
      state: 'AVAILABLE',
      circuit: 'CLOSED',
      lastErrorCode: 'NETWORK_ERROR',
      since: '2026-11-07T12:00:00.000Z',
    });
  });

  it('run always resolves, even for a non-function fn', async () => {
    const h = harness();
    const result = await drive(h.sleeper, h.rc.run('p', 'op', 42 as never));
    expect(errorOf(result).code).toBe('UNEXPECTED_ERROR');
  });
});
