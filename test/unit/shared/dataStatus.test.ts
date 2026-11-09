// Task 8.2: dataStatus precedence and LastValidStore retention. AT-PRV-01 (last valid data kept
// and labelled stale), AT-PRV-02 (stale data labelled), AT-PRV-03 (nothing fabricated).
// Validates: Requirements 25.3, 25.4, 25.5, 33.10
import { describe, expect, it } from 'vitest';
import { LastValidStore, dataStatus } from '../../../src/shared/index.js';
import type { DataStatusInput } from '../../../src/shared/index.js';

const NOW = new Date('2026-11-07T12:00:00.000Z');
const base: DataStatusInput = {
  sourceKind: 'REAL',
  observedAt: '2026-11-07T11:59:00.000Z',
  now: NOW,
  maxAgeMs: 120_000,
  fromCache: false,
};

describe('dataStatus precedence: DEMO, UNAVAILABLE, STALE, CACHED, CURRENT', () => {
  it('fresh data from a fetch is CURRENT; the same served from the store is CACHED', () => {
    expect(dataStatus(base)).toBe('CURRENT');
    expect(dataStatus({ ...base, fromCache: true })).toBe('CACHED');
  });

  it('DEMO wins over everything, including missing inputs and staleness', () => {
    expect(dataStatus({ ...base, sourceKind: 'DEMO' })).toBe('DEMO');
    expect(dataStatus({ now: NOW, sourceKind: 'DEMO', fromCache: true })).toBe('DEMO');
    expect(dataStatus({ ...base, sourceKind: 'DEMO', observedAt: '2020-01-01T00:00:00.000Z' })).toBe('DEMO');
  });

  it.each([
    ['no threshold', { maxAgeMs: undefined }],
    ['a negative threshold', { maxAgeMs: -1 }],
    ['a non-finite threshold', { maxAgeMs: Number.POSITIVE_INFINITY }],
    ['no observation time', { observedAt: undefined }],
    ['a non-canonical observation time', { observedAt: '2026-11-07T11:59:00Z' }],
    ['no source kind', { sourceKind: undefined }],
    ['an unknown source kind', { sourceKind: 'SYNTHETIC' }],
    ['an invalid now', { now: new Date(Number.NaN) }],
    ['an observation in the future', { observedAt: '2026-11-07T12:00:00.001Z' }],
  ])('%s is UNAVAILABLE, never CURRENT', (_label, override) => {
    const input = { ...base, ...override } as DataStatusInput;
    expect(dataStatus(input)).toBe('UNAVAILABLE');
    expect(dataStatus({ ...input, fromCache: true })).toBe('UNAVAILABLE');
  });

  it('AT-PRV-02: older than maxAgeMs is STALE, whether fresh or cached; exactly maxAgeMs is not', () => {
    const atLimit = { ...base, observedAt: '2026-11-07T11:58:00.000Z' };
    expect(dataStatus(atLimit)).toBe('CURRENT');
    const stale = { ...base, observedAt: '2026-11-07T11:57:59.999Z' };
    expect(dataStatus(stale)).toBe('STALE');
    expect(dataStatus({ ...stale, fromCache: true })).toBe('STALE');
  });
});

describe('LastValidStore', () => {
  it('AT-PRV-03: has nothing for a key that was never fetched successfully', () => {
    const store = new LastValidStore<string, { close: string }>();
    expect(store.get('AAA')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('AT-PRV-01: keeps the last valid value and its time; it only changes on recordSuccess', () => {
    const store = new LastValidStore<string, { close: string }>();
    store.recordSuccess('AAA', { close: '10.5' }, '2026-11-07T10:00:00.000Z');
    // A failed fetch has no write path, so the entry is unchanged.
    expect(store.get('AAA')).toEqual({ value: { close: '10.5' }, observedAt: '2026-11-07T10:00:00.000Z' });
    const label = dataStatus({
      sourceKind: 'REAL',
      observedAt: store.get('AAA')?.observedAt,
      now: NOW,
      maxAgeMs: 3_600_000,
      fromCache: true,
    });
    expect(label).toBe('STALE');
  });

  it('never replaces a newer observation with an older one', () => {
    const store = new LastValidStore<string, string>();
    expect(store.recordSuccess('k', 'new', '2026-11-07T11:00:00.000Z')).toBe(true);
    expect(store.recordSuccess('k', 'old', '2026-11-07T10:00:00.000Z')).toBe(false);
    expect(store.get('k')?.value).toBe('new');
    expect(store.recordSuccess('k', 'newer', '2026-11-07T11:00:00.000Z')).toBe(true);
    expect(store.get('k')?.value).toBe('newer');
  });

  it('stores and returns copies, so callers cannot change stored data', () => {
    const store = new LastValidStore<string, { close: string }>();
    const value = { close: '1' };
    store.recordSuccess('k', value, '2026-11-07T10:00:00.000Z');
    value.close = '999';
    const read = store.get('k');
    if (read !== undefined) {
      (read.value as { close: string }).close = '777';
    }
    expect(store.get('k')?.value).toEqual({ close: '1' });
  });

  it('rejects a non-canonical observation time', () => {
    const store = new LastValidStore<string, string>();
    expect(() => store.recordSuccess('k', 'v', '2026-11-07T10:00:00Z')).toThrow(TypeError);
    expect(store.size).toBe(0);
  });
});
