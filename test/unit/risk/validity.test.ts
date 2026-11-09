// Task 12.3: the result validity policy (design: ResultValidityPolicy; R13.7).
// Tests: AT-MD-13
// Validates: Requirements 13.5, 13.7, 14.14
import { describe, expect, it } from 'vitest';
import { deriveValidity } from '../../../src/risk/index.js';
import type { AdjustedStatus, CalcStatus } from '../../../src/risk/index.js';

describe('deriveValidity', () => {
  it('OK without MARKET_DATA_STALE is CURRENT; a Reduced Lookback OK result may be CURRENT', () => {
    expect(
      deriveValidity({
        status: 'OK',
        flags: ['REDUCED_LOOKBACK'],
        adjustedStatus: 'SENTIMENT_NOT_CURRENT',
        retained: false,
      }),
    ).toEqual({
      baseValidity: 'CURRENT',
      adjustedValidity: 'UNAVAILABLE',
    });
  });

  it('MARKET_DATA_STALE is STALE, never CURRENT (AT-MD-13)', () => {
    expect(
      deriveValidity({
        status: 'OK',
        flags: ['MARKET_DATA_STALE'],
        adjustedStatus: 'APPLIED',
        retained: false,
      }),
    ).toEqual({
      baseValidity: 'STALE',
      adjustedValidity: 'STALE',
    });
  });

  it('a retained earlier OK result is LAST_VALID', () => {
    expect(
      deriveValidity({ status: 'OK', flags: [], adjustedStatus: 'NONE_TRIGGERED', retained: true }),
    ).toEqual({
      baseValidity: 'LAST_VALID',
      adjustedValidity: 'LAST_VALID',
    });
  });

  it.each<CalcStatus>([
    'INSUFFICIENT_DATA',
    'NO_POSITIONS',
    'INVALID_INPUT',
    'FX_UNAVAILABLE',
    'FX_STALE',
    'FX_DEMO_NOT_ALLOWED',
    'DATA_CONFLICT',
    'CONFIG_MISSING',
  ])('%s is UNAVAILABLE for both figures', (status) => {
    expect(
      deriveValidity({ status, flags: [], adjustedStatus: 'BASE_UNAVAILABLE', retained: false }),
    ).toEqual({
      baseValidity: 'UNAVAILABLE',
      adjustedValidity: 'UNAVAILABLE',
    });
    expect(
      deriveValidity({ status, flags: [], adjustedStatus: 'BASE_UNAVAILABLE', retained: true }).baseValidity,
    ).toBe('UNAVAILABLE');
  });

  it.each<AdjustedStatus>(['ADJUSTMENT_CONFIG_MISSING', 'SENTIMENT_NOT_CURRENT', 'BASE_UNAVAILABLE'])(
    'adjusted status %s makes only Adjusted VaR UNAVAILABLE',
    (adjustedStatus) => {
      expect(deriveValidity({ status: 'OK', flags: [], adjustedStatus, retained: false })).toEqual({
        baseValidity: 'CURRENT',
        adjustedValidity: 'UNAVAILABLE',
      });
    },
  );
});
