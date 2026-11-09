// Task 8.2, AT-PRV-12: the per-provider circuit breaker and ProviderStatus, under FakeClock and
// FakeSleeper (no real time).
// Validates: Requirements 25.1, 25.8
import { describe, expect, it } from 'vitest';
import type { AttemptOutcome } from '../../../src/shared/index.js';
import {
  INVALID,
  NETWORK,
  TIMEOUT,
  TLS,
  advanceBy,
  drive,
  harness,
  http,
  script,
  success,
} from '../../helpers/resilience.js';
import type { Harness, Step } from '../../helpers/resilience.js';

async function calls<T>(h: Harness, provider: string, steps: readonly Step<T>[], count: number) {
  const s = script(h.clock, steps);
  const results = [];
  for (let i = 0; i < count; i += 1) {
    results.push(await drive(h.sleeper, h.rc.run(provider, 'op', s.fn)));
  }
  return { results, s };
}

const codeOf = (result: { ok: boolean; error?: { code: string } }): string | undefined =>
  result.ok ? undefined : result.error?.code;

describe('AT-PRV-12: opening the circuit', () => {
  it('opens after five qualifying failed calls; then fails fast without calling the provider', async () => {
    const h = harness({ maxRetries: 0 });
    const { s } = await calls(h, 'md', [NETWORK], 4);
    expect(h.rc.status('md')).toMatchObject({ state: 'AVAILABLE', circuit: 'CLOSED' });
    await calls(h, 'md', [NETWORK], 1);
    expect(h.rc.status('md')).toMatchObject({
      state: 'UNAVAILABLE',
      circuit: 'OPEN',
      lastErrorCode: 'NETWORK_ERROR',
    });
    const blocked = await calls(h, 'md', [success(1)], 3);
    expect(blocked.results.map(codeOf)).toEqual(['CIRCUIT_OPEN', 'CIRCUIT_OPEN', 'CIRCUIT_OPEN']);
    expect(blocked.results.every((r) => !r.ok && r.error.attempts === 0)).toBe(true);
    expect(blocked.s.calls).toEqual([]);
    expect(s.calls).toHaveLength(4);
    // CIRCUIT_OPEN does not replace the real cause.
    expect(h.rc.status('md').lastErrorCode).toBe('NETWORK_ERROR');
  });

  it('counts complete calls, not attempts', async () => {
    const h = harness({ maxRetries: 3 });
    const { s } = await calls(h, 'md', [NETWORK], 4);
    expect(s.calls).toHaveLength(16);
    expect(h.rc.status('md').circuit).toBe('CLOSED');
    await calls(h, 'md', [NETWORK], 1);
    expect(h.rc.status('md').circuit).toBe('OPEN');
  });

  it.each([
    ['NETWORK_ERROR', NETWORK],
    ['TIMEOUT (outcome)', TIMEOUT],
    ['TIMEOUT (attempt timer)', 'HANG'],
    ['HTTP_SERVER_ERROR', http(502)],
    ['INVALID_RESPONSE', INVALID],
    ['TLS_ERROR', TLS],
  ] as const)('%s counts toward opening', async (_label, step) => {
    const h = harness({ maxRetries: 0 });
    await calls(h, 'md', [step as Step<never>], 5);
    expect(h.rc.status('md').circuit).toBe('OPEN');
  });

  it.each([
    ['RATE_LIMITED', http(429)],
    ['HTTP_CLIENT_ERROR', http(404)],
    ['UNEXPECTED_ERROR', { throws: new Error('bug') }],
  ] as const)('%s does not count', async (_label, step) => {
    const h = harness({ maxRetries: 0 });
    await calls(h, 'md', [step as Step<never>], 10);
    expect(h.rc.status('md')).toMatchObject({ circuit: 'CLOSED', state: 'AVAILABLE' });
  });

  it('HTTP 503 with a Retry-After above the limit counts toward opening, one attempt per call', async () => {
    const h = harness({ maxRetries: 3 });
    const first = await calls(h, 'md', [http(503, '86400')], 4);
    expect(first.results.map(codeOf)).toEqual(Array(4).fill('HTTP_SERVER_ERROR'));
    expect(first.s.calls).toEqual([0, 0, 0, 0]);
    expect(h.rc.status('md').circuit).toBe('CLOSED');
    await calls(h, 'md', [http(503, '86400')], 1);
    expect(h.clock.monotonicMs()).toBe(0);
    expect(h.rc.status('md')).toMatchObject({
      state: 'UNAVAILABLE',
      circuit: 'OPEN',
      lastErrorCode: 'HTTP_SERVER_ERROR',
    });
    const blocked = await calls(h, 'md', [success(1)], 1);
    expect(codeOf(blocked.results[0] ?? { ok: true })).toBe('CIRCUIT_OPEN');
    expect(blocked.s.calls).toEqual([]);
  });

  it('HTTP 429 with a Retry-After above the limit does not count', async () => {
    const h = harness({ maxRetries: 3 });
    const { results, s } = await calls(h, 'md', [http(429, '86400')], 10);
    expect(results.map(codeOf)).toEqual(Array(10).fill('RATE_LIMITED'));
    expect(s.calls).toHaveLength(10);
    expect(h.rc.status('md')).toMatchObject({ circuit: 'CLOSED', state: 'AVAILABLE' });
  });

  it('CANCELLED does not count', async () => {
    const h = harness({ maxRetries: 0 });
    for (let i = 0; i < 10; i += 1) {
      const controller = new AbortController();
      const s = script(h.clock, ['HANG']);
      const pending = h.rc.run('md', 'op', s.fn, { signal: controller.signal });
      await advanceBy(h, 1);
      controller.abort();
      expect(codeOf(await drive(h.sleeper, pending))).toBe('CANCELLED');
    }
    expect(h.rc.status('md').circuit).toBe('CLOSED');
  });

  it('a success resets the consecutive count; non-qualifying failures leave it unchanged', async () => {
    const h = harness({ maxRetries: 0 });
    await calls(h, 'md', [NETWORK], 4);
    await calls(h, 'md', [success(1)], 1);
    await calls(h, 'md', [NETWORK], 4);
    expect(h.rc.status('md').circuit).toBe('CLOSED');
    await calls(h, 'md', [http(404)], 3);
    expect(h.rc.status('md').circuit).toBe('CLOSED');
    await calls(h, 'md', [NETWORK], 1);
    expect(h.rc.status('md').circuit).toBe('OPEN');
  });

  it('keeps independent state per provider', async () => {
    const h = harness({ maxRetries: 0 });
    await calls(h, 'md', [NETWORK], 5);
    expect(h.rc.status('md').circuit).toBe('OPEN');
    const other = await calls(h, 'fx', [success('rate')], 1);
    expect(other.results[0]).toEqual({ ok: true, value: 'rate' });
    expect(h.rc.status('fx')).toMatchObject({ state: 'AVAILABLE', circuit: 'CLOSED' });
  });
});

describe('AT-PRV-12: half-open probing', () => {
  async function opened(): Promise<Harness> {
    const h = harness({ maxRetries: 0 });
    await calls(h, 'md', [NETWORK], 5);
    return h;
  }

  it('stays open for openMs, then admits exactly one probe; a successful probe closes the circuit', async () => {
    const h = await opened();
    await advanceBy(h, 59_999);
    expect(codeOf((await calls(h, 'md', [success(1)], 1)).results[0] ?? { ok: true })).toBe('CIRCUIT_OPEN');
    await advanceBy(h, 1);
    let release: (outcome: AttemptOutcome<number>) => void = () => undefined;
    const probeFn = () => new Promise<AttemptOutcome<number>>((resolve) => (release = resolve));
    const probe = h.rc.run('md', 'op', probeFn);
    await advanceBy(h, 0);
    expect(h.rc.status('md')).toMatchObject({ state: 'DEGRADED', circuit: 'HALF_OPEN' });
    // A concurrent call during the probe is not admitted.
    const concurrent = script(h.clock, [success(2)]);
    expect(codeOf(await drive(h.sleeper, h.rc.run('md', 'op', concurrent.fn)))).toBe('CIRCUIT_OPEN');
    expect(concurrent.calls).toEqual([]);
    release(success(1));
    expect(await drive(h.sleeper, probe)).toEqual({ ok: true, value: 1 });
    expect(h.rc.status('md')).toMatchObject({ state: 'AVAILABLE', circuit: 'CLOSED' });
  });

  it('a qualifying probe failure reopens the circuit for another openMs', async () => {
    const h = await opened();
    await advanceBy(h, 60_000);
    expect(codeOf((await calls(h, 'md', [http(503)], 1)).results[0] ?? { ok: true })).toBe(
      'HTTP_SERVER_ERROR',
    );
    expect(h.rc.status('md')).toMatchObject({ state: 'UNAVAILABLE', circuit: 'OPEN' });
    await advanceBy(h, 59_999);
    expect(codeOf((await calls(h, 'md', [success(1)], 1)).results[0] ?? { ok: true })).toBe('CIRCUIT_OPEN');
    await advanceBy(h, 1);
    expect((await calls(h, 'md', [success(1)], 1)).results[0]).toEqual({ ok: true, value: 1 });
  });

  it.each([
    ['HTTP_CLIENT_ERROR', http(404)],
    ['RATE_LIMITED', http(429)],
    ['UNEXPECTED_ERROR', { throws: new Error('bug') }],
  ] as const)(
    'a non-qualifying probe result (%s) is returned to its caller and reopens the circuit for a full cooldown',
    async (code, step) => {
      const h = await opened();
      await advanceBy(h, 60_000);
      const probe = await calls(h, 'md', [step as Step<never>], 1);
      expect(codeOf(probe.results[0] ?? { ok: true })).toBe(code);
      expect(probe.s.calls).toHaveLength(1);
      expect(h.rc.status('md')).toMatchObject({ state: 'UNAVAILABLE', circuit: 'OPEN' });
      // The cooldown restarts from the probe's completion.
      await advanceBy(h, 59_999);
      const early = await calls(h, 'md', [success(1)], 1);
      expect(codeOf(early.results[0] ?? { ok: true })).toBe('CIRCUIT_OPEN');
      expect(early.s.calls).toEqual([]);
      await advanceBy(h, 1);
      // Exactly one probe is admitted after the fresh cooldown.
      let release: (outcome: AttemptOutcome<number>) => void = () => undefined;
      const next = h.rc.run(
        'md',
        'op',
        () => new Promise<AttemptOutcome<number>>((resolve) => (release = resolve)),
      );
      await advanceBy(h, 0);
      expect(h.rc.status('md')).toMatchObject({ state: 'DEGRADED', circuit: 'HALF_OPEN' });
      const concurrent = script(h.clock, [success(2)]);
      expect(codeOf(await drive(h.sleeper, h.rc.run('md', 'op', concurrent.fn)))).toBe('CIRCUIT_OPEN');
      expect(concurrent.calls).toEqual([]);
      release(success(1));
      expect(await drive(h.sleeper, next)).toEqual({ ok: true, value: 1 });
      expect(h.rc.status('md')).toMatchObject({ state: 'AVAILABLE', circuit: 'CLOSED' });
    },
  );

  it('a cancelled probe reopens the circuit for a full cooldown', async () => {
    const h = await opened();
    await advanceBy(h, 60_000);
    const controller = new AbortController();
    const s = script(h.clock, ['HANG']);
    const pending = h.rc.run('md', 'op', s.fn, { signal: controller.signal });
    await advanceBy(h, 1);
    controller.abort();
    expect(codeOf(await drive(h.sleeper, pending))).toBe('CANCELLED');
    expect(h.rc.status('md')).toMatchObject({
      state: 'UNAVAILABLE',
      circuit: 'OPEN',
      lastErrorCode: 'NETWORK_ERROR',
    });
    await advanceBy(h, 59_999);
    expect(codeOf((await calls(h, 'md', [success(1)], 1)).results[0] ?? { ok: true })).toBe('CIRCUIT_OPEN');
    await advanceBy(h, 1);
    expect((await calls(h, 'md', [success(1)], 1)).results[0]).toEqual({ ok: true, value: 1 });
    expect(h.rc.status('md').circuit).toBe('CLOSED');
  });

  it('a non-qualifying probe result is not counted; after the next successful probe a full threshold is needed', async () => {
    const h = await opened();
    await advanceBy(h, 60_000);
    await calls(h, 'md', [http(404)], 1);
    expect(h.rc.status('md').circuit).toBe('OPEN');
    await advanceBy(h, 60_000);
    await calls(h, 'md', [success(1)], 1);
    expect(h.rc.status('md').circuit).toBe('CLOSED');
    // A full threshold of new qualifying failures is needed to open again.
    await calls(h, 'md', [NETWORK], 4);
    expect(h.rc.status('md').circuit).toBe('CLOSED');
    await calls(h, 'md', [NETWORK], 1);
    expect(h.rc.status('md').circuit).toBe('OPEN');
  });

  it('ignores the outcome of a call admitted before the circuit opened', async () => {
    const h = harness({ maxRetries: 0 });
    let release: (outcome: AttemptOutcome<number>) => void = () => undefined;
    const slow = h.rc.run(
      'md',
      'op',
      () => new Promise<AttemptOutcome<number>>((resolve) => (release = resolve)),
    );
    await calls(h, 'md', [NETWORK], 5);
    expect(h.rc.status('md').circuit).toBe('OPEN');
    release(success(9));
    expect(await drive(h.sleeper, slow)).toEqual({ ok: true, value: 9 });
    expect(h.rc.status('md').circuit).toBe('OPEN');
  });
});

describe('AT-PRV-12: ProviderStatus', () => {
  it('is DEGRADED while a call waits to retry, AVAILABLE afterwards, with since on wall-clock time', async () => {
    const h = harness({ maxRetries: 1 });
    h.randomValue = 0.999999;
    const s = script(h.clock, [NETWORK, success(1)]);
    const pending = h.rc.run('md', 'op', s.fn);
    await advanceBy(h, 100);
    expect(h.rc.status('md')).toMatchObject({
      state: 'DEGRADED',
      circuit: 'CLOSED',
      since: '2026-11-07T12:00:00.000Z',
    });
    expect(await drive(h.sleeper, pending)).toEqual({ ok: true, value: 1 });
    expect(h.rc.status('md')).toMatchObject({ state: 'AVAILABLE', since: '2026-11-07T12:00:00.250Z' });
  });

  it('an unknown provider is reported AVAILABLE with a closed circuit', () => {
    const h = harness();
    expect(h.rc.status('never-called')).toEqual({
      provider: 'never-called',
      state: 'AVAILABLE',
      circuit: 'CLOSED',
      since: '2026-11-07T12:00:00.000Z',
    });
  });
});
