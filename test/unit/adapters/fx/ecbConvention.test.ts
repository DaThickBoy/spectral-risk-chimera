// AT-FX-14 (convention part): ECB publication-time convention ECB-PUB-1600-FRANKFURT-v1.
// Validates: Requirements 30.13, 30.7
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ECB_CONVENTION_ID, ecbPublicationInstant } from '../../../../src/adapters/index.js';

describe('ecbPublicationInstant', () => {
  it('has the versioned convention id', () => {
    expect(ECB_CONVENTION_ID).toBe('ECB-PUB-1600-FRANKFURT-v1');
  });

  it.each([
    // 2026: summer time from Sunday 29 March to Sunday 25 October.
    ['2026-03-27', '2026-03-27T15:00:00.000Z'], // Friday before the change: CET
    ['2026-03-28', '2026-03-28T15:00:00.000Z'],
    ['2026-03-29', '2026-03-29T14:00:00.000Z'], // change day: 16:00 local is CEST
    ['2026-03-30', '2026-03-30T14:00:00.000Z'],
    ['2026-10-23', '2026-10-23T14:00:00.000Z'], // recorded fixture row (CEST)
    ['2026-10-24', '2026-10-24T14:00:00.000Z'],
    ['2026-10-25', '2026-10-25T15:00:00.000Z'], // change day: 16:00 local is CET
    ['2026-10-26', '2026-10-26T15:00:00.000Z'], // recorded fixture row (CET)
    ['2026-11-06', '2026-11-06T15:00:00.000Z'],
    ['2026-07-01', '2026-07-01T14:00:00.000Z'],
    ['2025-12-24', '2025-12-24T15:00:00.000Z'],
    // 2024 (leap year): 31 March and 27 October are the change Sundays.
    ['2024-03-30', '2024-03-30T15:00:00.000Z'],
    ['2024-03-31', '2024-03-31T14:00:00.000Z'],
    ['2024-10-26', '2024-10-26T14:00:00.000Z'],
    ['2024-10-27', '2024-10-27T15:00:00.000Z'],
    ['2024-02-29', '2024-02-29T15:00:00.000Z'],
  ])('%s -> %s', (date, instant) => {
    expect(ecbPublicationInstant(date)).toBe(instant);
  });

  it.each(['2026-02-30', '2026-13-01', '2026-1-01', '', '2026-11-06T00:00:00Z'])('rejects %j', (bad) => {
    expect(() => ecbPublicationInstant(bad)).toThrow(TypeError);
  });

  // 1999: first ECB reference rates. Before 1996 the EU summer time ended in September (not covered).
  it('is 16:00 Europe/Berlin local time for every date 1999 to 2099 (reference: the ICU time-zone data)', () => {
    const berlin = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const start = Date.UTC(1999, 0, 1);
    const days = Math.floor((Date.UTC(2099, 11, 31) - start) / 86_400_000);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: days }), (offset) => {
        const date = new Date(start + offset * 86_400_000).toISOString().slice(0, 10);
        expect(berlin.format(new Date(ecbPublicationInstant(date)))).toBe('16:00:00');
      }),
      { numRuns: 2000 },
    );
  });
});
