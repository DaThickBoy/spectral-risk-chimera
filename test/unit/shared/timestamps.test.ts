// Canonical fixed-width UTC timestamps (persistence `IsoUtc`, R28.18 ordering).
// Validates: Requirements 28.18
import { describe, expect, it } from 'vitest';
import { IsoUtcMillis, isIsoUtcMillis } from '../../../src/shared/index.js';

describe('isIsoUtcMillis', () => {
  it.each([
    '2026-11-06T10:00:00.000Z',
    '2026-12-31T23:59:59.999Z',
    '2024-02-29T00:00:00.000Z', // leap year
    '2000-02-29T12:00:00.000Z', // divisible by 400
    '1970-01-01T00:00:00.000Z',
    '0000-01-01T00:00:00.000Z',
    '9999-12-31T23:59:59.999Z',
  ])('accepts %s', (text) => {
    expect(isIsoUtcMillis(text)).toBe(true);
    expect(IsoUtcMillis.safeParse(text).success).toBe(true);
  });

  it('agrees with Date.prototype.toISOString for real instants', () => {
    for (const ms of [0, 1, 951782400000, 1793786400123, 253402300799999]) {
      expect(isIsoUtcMillis(new Date(ms).toISOString())).toBe(true);
    }
  });

  it.each([
    // malformed
    ['empty', ''],
    ['date only', '2026-11-06'],
    ['space separator', '2026-11-06 10:00:00.000Z'],
    ['lowercase t', '2026-11-06t10:00:00.000Z'],
    ['lowercase z', '2026-11-06T10:00:00.000z'],
    ['surrounding whitespace', ' 2026-11-06T10:00:00.000Z'],
    ['five-digit year', '+02026-11-06T10:00:00.000Z'],
    ['non-ASCII digit', '2026-11-0\u0666T10:00:00.000Z'],
    // offsets
    ['positive offset', '2026-11-06T12:00:00.000+02:00'],
    ['zero offset', '2026-11-06T10:00:00.000+00:00'],
    ['no designator', '2026-11-06T10:00:00.000'],
    // variable precision
    ['no fraction', '2026-11-06T10:00:00Z'],
    ['one digit', '2026-11-06T10:00:00.0Z'],
    ['two digits', '2026-11-06T10:00:00.00Z'],
    ['four digits', '2026-11-06T10:00:00.0000Z'],
    ['microseconds', '2026-11-06T10:00:00.000000Z'],
    ['no seconds', '2026-11-06T10:00Z'],
    // impossible calendar or clock values
    ['month 00', '2026-00-10T10:00:00.000Z'],
    ['month 13', '2026-13-10T10:00:00.000Z'],
    ['day 00', '2026-11-00T10:00:00.000Z'],
    ['30 February', '2026-02-30T10:00:00.000Z'],
    ['29 February, non-leap', '2026-02-29T10:00:00.000Z'],
    ['29 February 1900', '1900-02-29T10:00:00.000Z'],
    ['31 November', '2026-11-31T10:00:00.000Z'],
    ['hour 24', '2026-11-06T24:00:00.000Z'],
    ['minute 60', '2026-11-06T10:60:00.000Z'],
    ['leap second', '2026-12-31T23:59:60.000Z'],
  ])('rejects %s', (_label, text) => {
    expect(isIsoUtcMillis(text)).toBe(false);
    expect(IsoUtcMillis.safeParse(text).success).toBe(false);
  });

  it.each([null, undefined, 0, 1793786400000, new Date(0)])('rejects the non-string %s', (value) => {
    expect(isIsoUtcMillis(value)).toBe(false);
  });

  it('fixed-width values sort chronologically by ordinal order', () => {
    const times = ['2026-11-02T14:30:00.500Z', '2026-11-02T14:30:00.000Z', '2026-11-02T09:00:00.000Z'];
    expect([...times].sort()).toEqual([
      '2026-11-02T09:00:00.000Z',
      '2026-11-02T14:30:00.000Z',
      '2026-11-02T14:30:00.500Z',
    ]);
  });
});
