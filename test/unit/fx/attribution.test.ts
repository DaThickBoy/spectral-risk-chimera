// R30.14 / ECB adapter rule 8 (Kiroween decision H2): ECB rates are attributed, and inverted
// values are labelled as derived, never as published observations, with the reference date,
// the derivation method, and its precision.
// Validates: Requirements 30.14
import { describe, expect, it } from 'vitest';
import {
  ECB_DERIVED_NOTE,
  ECB_INFORMATION_NOTE,
  ECB_SOURCE_NAME,
  ECB_SOURCE_STATEMENT,
  fxAttribution,
} from '../../../src/fx/index.js';

const PRECISION = { significantDigits: 40, rounding: 'ROUND_HALF_UP' };

describe('fxAttribution', () => {
  it('X -> EUR from the ECB is DERIVED_INVERSE of the published EUR -> X rate, with both notes', () => {
    expect(
      fxAttribution({
        pair: 'GBPEUR',
        source: ECB_SOURCE_NAME,
        sourceKind: 'REAL',
        observedAt: '2026-11-06T15:00:00.000Z',
      }),
    ).toEqual({
      statement: ECB_SOURCE_STATEMENT,
      derivation: 'DERIVED_INVERSE',
      publishedPair: 'EURGBP',
      referenceDate: '2026-11-06',
      method: 'DECIMAL_INVERSE',
      precision: PRECISION,
      notes: [ECB_DERIVED_NOTE, ECB_INFORMATION_NOTE],
    });
    expect(ECB_SOURCE_STATEMENT).toBe('Source: ECB statistics.');
  });

  it('EUR -> X from the ECB is the PUBLISHED orientation, without the derived note', () => {
    expect(
      fxAttribution({
        pair: 'EURUSD',
        source: ECB_SOURCE_NAME,
        sourceKind: 'REAL',
        observedAt: '2026-10-23T14:00:00.000Z',
      }),
    ).toEqual({
      statement: ECB_SOURCE_STATEMENT,
      derivation: 'PUBLISHED',
      publishedPair: 'EURUSD',
      referenceDate: '2026-10-23',
      method: 'AS_PUBLISHED',
      precision: PRECISION,
      notes: [ECB_INFORMATION_NOTE],
    });
  });

  it('without an observation time the reference date is null, never invented', () => {
    expect(
      fxAttribution({ pair: 'USDEUR', source: ECB_SOURCE_NAME, sourceKind: 'REAL' })?.referenceDate,
    ).toBeNull();
  });

  it.each([
    ['another source', { pair: 'USDEUR', source: 'demo-fixtures-fx', sourceKind: 'DEMO' }],
    ['the identity rate', { pair: 'EUREUR', source: 'BASE_CURRENCY', sourceKind: 'IDENTITY' }],
    ['an ECB-named DEMO rate', { pair: 'USDEUR', source: ECB_SOURCE_NAME, sourceKind: 'DEMO' }],
    ['a pair without EUR', { pair: 'USDGBP', source: ECB_SOURCE_NAME, sourceKind: 'REAL' }],
    ['EUR to EUR', { pair: 'EUREUR', source: ECB_SOURCE_NAME, sourceKind: 'REAL' }],
    ['a malformed pair', { pair: 'USD', source: ECB_SOURCE_NAME, sourceKind: 'REAL' }],
  ])('%s has no ECB attribution', (_name, rate) => {
    expect(fxAttribution(rate)).toBeUndefined();
  });

  it('results are frozen', () => {
    const attribution = fxAttribution({ pair: 'USDEUR', source: ECB_SOURCE_NAME, sourceKind: 'REAL' });
    expect(Object.isFrozen(attribution)).toBe(true);
    expect(Object.isFrozen(attribution?.notes)).toBe(true);
    expect(Object.isFrozen(attribution?.precision)).toBe(true);
  });
});
