// Task 8.2: the Sleeper port (FakeSleeper and systemSleeper) and Retry-After parsing.
// Validates: Requirements 25.2, 25.7
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeClock, FakeSleeper, parseRetryAfterMs, systemSleeper } from '../../../src/shared/index.js';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('FakeSleeper', () => {
  it('fires timers in due order and moves the clock to each due time', async () => {
    const clock = new FakeClock('2026-11-07T12:00:00.000Z', 1000);
    const sleeper = new FakeSleeper(clock);
    const fired: [string, number][] = [];
    void sleeper.sleep(300).then(() => fired.push(['b', clock.monotonicMs()]));
    void sleeper.sleep(100).then(() => fired.push(['a', clock.monotonicMs()]));
    void sleeper.sleep(300).then(() => fired.push(['c', clock.monotonicMs()]));
    expect(sleeper.pending).toBe(3);
    expect(sleeper.nextDueInMs()).toBe(100);
    sleeper.advance(250);
    await flush();
    expect(fired).toEqual([['a', 1250]]);
    sleeper.advance(50);
    await flush();
    expect(fired.map(([name]) => name)).toEqual(['a', 'b', 'c']);
    expect(clock.monotonicMs()).toBe(1300);
    expect(sleeper.pending).toBe(0);
  });

  it('resolves ABORTED immediately on abort and drops the timer; sleep(0) elapses at once', async () => {
    const clock = new FakeClock('2026-11-07T12:00:00.000Z');
    const sleeper = new FakeSleeper(clock);
    const controller = new AbortController();
    const waiting = sleeper.sleep(1000, controller.signal);
    controller.abort();
    expect(await waiting).toBe('ABORTED');
    expect(sleeper.pending).toBe(0);
    expect(await sleeper.sleep(5, controller.signal)).toBe('ABORTED');
    expect(await sleeper.sleep(0)).toBe('ELAPSED');
  });

  it.each([-1, Number.NaN])('rejects the delay %s as a programmer error', (ms) => {
    const sleeper = new FakeSleeper(new FakeClock('2026-11-07T12:00:00.000Z'));
    expect(() => sleeper.sleep(ms)).toThrow(RangeError);
  });
});

describe('systemSleeper (driven by Vitest fake timers, no real time)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('elapses after the delay and aborts immediately', async () => {
    let done = false;
    const waiting = systemSleeper.sleep(250).then((outcome) => ((done = true), outcome));
    await vi.advanceTimersByTimeAsync(249);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toBe('ELAPSED');
    const controller = new AbortController();
    const aborted = systemSleeper.sleep(60_000, controller.signal);
    controller.abort();
    expect(await aborted).toBe('ABORTED');
    expect(vi.getTimerCount()).toBe(0);
    expect(await systemSleeper.sleep(10, controller.signal)).toBe('ABORTED');
  });

  it('waits longer than the native timer maximum by chaining timers', async () => {
    // A single timer above 2^31 - 1 ms would fire after 1 ms; chaining must not.
    let done = false;
    const waiting = systemSleeper.sleep(3_000_000_000).then((outcome) => ((done = true), outcome));
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2_999_999_998);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toBe('ELAPSED');
  });
});

describe('parseRetryAfterMs', () => {
  const now = new Date('2026-11-07T12:00:00.000Z');

  it.each([
    ['0', 0],
    ['120', 120_000],
    ['\t7 ', 7000],
    ['Sat, 07 Nov 2026 12:00:30 GMT', 30_000],
    ['Saturday, 07-Nov-26 12:01:00 GMT', 60_000],
    ['Sat Nov  7 12:00:10 2026', 10_000],
    ['Sat, 07 Nov 2026 11:59:00 GMT', 0],
    ['Thu, 29 Feb 2028 00:00:00 GMT', Date.UTC(2028, 1, 29) - now.getTime()],
  ])('%j -> %i ms', (value, expected) => {
    expect(parseRetryAfterMs(value, now)).toBe(expected);
  });

  it('takes a two-digit RFC 850 year more than 50 years ahead as the previous century', () => {
    expect(parseRetryAfterMs('Sunday, 06-Nov-94 08:49:37 GMT', now)).toBe(0);
  });

  it.each([
    undefined,
    '',
    '-1',
    '+5',
    '1.5',
    '1e3',
    '5 seconds',
    'soon',
    'Sat, 07 Nov 2026 12:00:30 UTC',
    'Sat, 7 Nov 2026 12:00:30 GMT',
    'Sat, 31 Nov 2026 12:00:30 GMT',
    'Fri, 29 Feb 2030 12:00:30 GMT',
    'Sat, 07 Nov 2026 24:00:00 GMT',
    'Sat, 07 Foo 2026 12:00:30 GMT',
    '2026-11-07T12:00:30Z',
  ])('%j is unparseable', (value) => {
    expect(parseRetryAfterMs(value, now)).toBeUndefined();
  });

  it('caps an enormous delay-seconds value instead of overflowing', () => {
    expect(parseRetryAfterMs('99999999999999999999', now)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
