// Task 7.2: trade timestamp normalization (design: CSV Parser, row validation).
// Expected UTC values are hand-calculated from the stated offsets and the tzdb rules of each zone.
// Tests: AT-CSV-23
// Validates: Requirements 28.1, 28.18
import { describe, expect, it } from 'vitest';
import { normalizeTradeTimestamp } from '../../../src/ingestion/index.js';

describe('normalizeTradeTimestamp: ISO 8601 with a zone', () => {
  it.each([
    ['2026-11-02T14:30:00Z', '2026-11-02T14:30:00.000Z'],
    ['2026-11-02T14:30Z', '2026-11-02T14:30:00.000Z'],
    ['2026-11-02T14:30:00.5+01:00', '2026-11-02T13:30:00.500Z'],
    ['2026-11-02T14:30:00.12Z', '2026-11-02T14:30:00.120Z'],
    ['2026-11-02T14:30:00.123Z', '2026-11-02T14:30:00.123Z'],
    ['2026-11-02T00:30:00-05:30', '2026-11-02T06:00:00.000Z'],
    ['2026-11-02T23:30:00-01:00', '2026-11-03T00:30:00.000Z'],
    ['2024-02-29T00:00:00Z', '2024-02-29T00:00:00.000Z'],
    ['2026-01-01T00:30:00+01:00', '2025-12-31T23:30:00.000Z'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeTradeTimestamp(input, undefined)).toBe(expected);
  });

  it.each([
    ['more than three fractional digits (never rounded)', '2026-11-02T14:30:00.1234Z'],
    ['no zone', '2026-11-02T14:30:00'],
    ['lowercase z', '2026-11-02T14:30:00z'],
    ['lowercase t', '2026-11-02t14:30:00Z'],
    ['space separator', '2026-11-02 14:30:00Z'],
    ['leading space (no trimming)', ' 2026-11-02T14:30:00Z'],
    ['trailing space', '2026-11-02T14:30:00Z '],
    ['not a leap year', '2026-02-29T00:00:00Z'],
    ['month 13', '2026-13-01T00:00:00Z'],
    ['day 0', '2026-11-00T00:00:00Z'],
    ['day 31 in November', '2026-11-31T00:00:00Z'],
    ['hour 24', '2026-11-02T24:00:00Z'],
    ['minute 60', '2026-11-02T14:60:00Z'],
    ['second 60', '2026-11-02T14:30:60Z'],
    ['offset hour 24', '2026-11-02T14:30:00+24:00'],
    ['offset minute 60', '2026-11-02T14:30:00+05:60'],
    ['offset without colon', '2026-11-02T14:30:00+0500'],
    ['basic format', '20261102T143000Z'],
    ['expanded year', '+02026-11-02T14:30:00Z'],
    ['empty', ''],
  ])('%s is INVALID_DATE', (_label, input) => {
    expect(normalizeTradeTimestamp(input, 'UTC')).toBeUndefined();
  });
});

describe('normalizeTradeTimestamp: date only (AT-CSV-23)', () => {
  it('is INVALID_DATE without import.defaultTimezone; nothing is assumed', () => {
    expect(normalizeTradeTimestamp('2026-11-02', undefined)).toBeUndefined();
  });

  it.each([
    ['UTC', '2026-11-02', '2026-11-02T00:00:00.000Z'],
    // EST (-05:00) after the 2026-11-01 change.
    ['America/New_York', '2026-11-02', '2026-11-02T05:00:00.000Z'],
    // EDT (-04:00).
    ['America/New_York', '2026-07-01', '2026-07-01T04:00:00.000Z'],
    // CET (+01:00): the previous UTC day.
    ['Europe/Berlin', '2026-11-06', '2026-11-05T23:00:00.000Z'],
    ['Asia/Tokyo', '2026-11-06', '2026-11-05T15:00:00.000Z'],
  ])('%s %s -> %s', (zone, input, expected) => {
    expect(normalizeTradeTimestamp(input, zone)).toBe(expected);
  });

  it('a midnight inside a daylight-saving gap is INVALID_DATE (America/Havana 2026-03-08)', () => {
    expect(normalizeTradeTimestamp('2026-03-08', 'America/Havana')).toBeUndefined();
  });

  it('an ambiguous midnight takes the earlier instant (America/Havana 2026-11-01, CDT -04:00)', () => {
    expect(normalizeTradeTimestamp('2026-11-01', 'America/Havana')).toBe('2026-11-01T04:00:00.000Z');
  });

  it('an invalid calendar date is INVALID_DATE even with a zone', () => {
    expect(normalizeTradeTimestamp('2026-02-30', 'UTC')).toBeUndefined();
    expect(normalizeTradeTimestamp('2026-11-2', 'UTC')).toBeUndefined();
  });
});
