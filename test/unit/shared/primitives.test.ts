// Clock, Result, errors, ids, and BoundedQueue (task 2.4).
// Validates: Requirements 26.2, 33.5
import { describe, expect, it } from 'vitest';
import {
  appError,
  assertNever,
  BoundedQueue,
  err,
  FakeClock,
  newCorrelationId,
  ok,
  randomIds,
  sequentialIds,
  systemClock,
} from '../../../src/shared/index.js';
import type { Result } from '../../../src/shared/index.js';

describe('FakeClock', () => {
  it('advances wall-clock and monotonic time together', () => {
    const clock = new FakeClock('2026-11-06T00:00:00.000Z', 100);
    clock.advance(3_000);
    expect(clock.nowUtc().toISOString()).toBe('2026-11-06T00:00:03.000Z');
    expect(clock.monotonicMs()).toBe(3_100);
  });

  it('moves the wall clock without moving monotonic time', () => {
    const clock = new FakeClock('2026-11-06T00:00:00.000Z');
    clock.setUtc('2026-11-05T23:00:00.000Z');
    expect(clock.nowUtc().toISOString()).toBe('2026-11-05T23:00:00.000Z');
    expect(clock.monotonicMs()).toBe(0);
  });

  it('returns a copy so callers cannot mutate the clock', () => {
    const clock = new FakeClock('2026-11-06T00:00:00.000Z');
    clock.nowUtc().setUTCFullYear(2000);
    expect(clock.nowUtc().toISOString()).toBe('2026-11-06T00:00:00.000Z');
  });

  it('rejects negative or invalid input', () => {
    expect(() => new FakeClock('not a date')).toThrow(RangeError);
    expect(() => new FakeClock('2026-11-06T00:00:00Z').advance(-1)).toThrow(RangeError);
  });

  it('has a system implementation', () => {
    expect(systemClock.nowUtc()).toBeInstanceOf(Date);
    expect(systemClock.monotonicMs()).toBeGreaterThanOrEqual(0);
  });
});

describe('Result and AppError', () => {
  const divide = (a: number, b: number): Result<number, ReturnType<typeof appError<'DIVIDE_BY_ZERO'>>> =>
    b === 0 ? err(appError('DIVIDE_BY_ZERO', 'divisor is zero')) : ok(a / b);

  it('carries a value or a typed error', () => {
    const good = divide(6, 3);
    const bad = divide(1, 0);
    expect(good).toEqual({ ok: true, value: 2 });
    expect(bad).toEqual({ ok: false, error: { code: 'DIVIDE_BY_ZERO', message: 'divisor is zero' } });
  });

  it('includes details only when given', () => {
    expect(appError('X', 'm', { key: 'k' })).toEqual({ code: 'X', message: 'm', details: { key: 'k' } });
    expect(Object.keys(appError('X', 'm'))).toEqual(['code', 'message']);
  });

  it('assertNever throws for unhandled cases', () => {
    expect(() => assertNever('unexpected' as never)).toThrow('Unhandled case');
  });
});

describe('ids', () => {
  it('generates sequential ids for tests and unique random ids', () => {
    const ids = sequentialIds('job');
    expect([ids.next(), ids.next()]).toEqual(['job-1', 'job-2']);
    expect(randomIds.next()).not.toBe(randomIds.next());
    expect(newCorrelationId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('BoundedQueue', () => {
  interface Message {
    ticker: string;
    seq: number;
  }
  const queue = (max: number): BoundedQueue<string, Message> => new BoundedQueue(max, (m) => m.ticker);

  it('accepts values in FIFO order', () => {
    const q = queue(3);
    expect(q.offer({ ticker: 'A', seq: 1 })).toBe('ACCEPTED');
    expect(q.offer({ ticker: 'B', seq: 2 })).toBe('ACCEPTED');
    expect(q.take()).toEqual({ ticker: 'A', seq: 1 });
    expect(q.take()).toEqual({ ticker: 'B', seq: 2 });
    expect(q.take()).toBeUndefined();
  });

  it('coalesces by key, keeping the queue position', () => {
    const q = queue(3);
    q.offer({ ticker: 'A', seq: 1 });
    q.offer({ ticker: 'B', seq: 2 });
    expect(q.offer({ ticker: 'A', seq: 3 })).toBe('COALESCED');
    expect(q.size).toBe(2);
    expect(q.take()).toEqual({ ticker: 'A', seq: 3 });
  });

  it('drops the oldest entry when full and counts drops', () => {
    const q = queue(2);
    q.offer({ ticker: 'A', seq: 1 });
    q.offer({ ticker: 'B', seq: 2 });
    expect(q.offer({ ticker: 'C', seq: 3 })).toBe('DROPPED_OLDEST');
    expect(q.offer({ ticker: 'D', seq: 4 })).toBe('DROPPED_OLDEST');
    expect(q.droppedCount).toBe(2);
    expect(q.size).toBe(2);
    expect(q.take()).toEqual({ ticker: 'C', seq: 3 });
    expect(q.take()).toEqual({ ticker: 'D', seq: 4 });
  });

  it('does not count coalescing as a drop', () => {
    const q = queue(1);
    q.offer({ ticker: 'A', seq: 1 });
    q.offer({ ticker: 'A', seq: 2 });
    expect(q.droppedCount).toBe(0);
  });

  it('rejects a non-positive size', () => {
    expect(() => queue(0)).toThrow(RangeError);
    expect(() => queue(1.5)).toThrow(RangeError);
  });
});
