// Task 11.1: the pure valuation of one position view (design: Portfolio, Valuation rules 11 and 12).
// Hand-calculated values; Decimal results are compared as canonical strings.
// Validates: Requirements 5.2, 30.4, 30.6
import { describe, expect, it } from 'vitest';
import { toPositionView, toValuedPositionView } from '../../../src/portfolio/index.js';
import type { ValuationInput } from '../../../src/portfolio/index.js';
import { DecimalInputError, brandDecimalString } from '../../../src/shared/index.js';
import type { DecimalString } from '../../../src/shared/index.js';
import { pos } from '../../helpers/valuation.js';

const ds = (text: string): DecimalString => brandDecimalString(text);

describe('toValuedPositionView: VALUED (hand-calculated)', () => {
  it('long: 20 × 45.5 = 910; 910 × 1.085 = 987.35', () => {
    const view = toValuedPositionView(pos('BBB', 'EUR', '20'), {
      status: 'VALUED',
      price: ds('45.5'),
      rate: ds('1.085'),
    });
    expect(view).toMatchObject({
      marketPrice: '45.5',
      marketValueInstrument: '910',
      marketValueBase: '987.35',
      allocationPct: null,
      valuationStatus: 'VALUED',
    });
  });

  it('short: -5 × 12.34 = -61.7; -61.7 × 1.25 = -77.125 (signed, negative)', () => {
    const view = toValuedPositionView(pos('CCC', 'GBP', '-5'), {
      status: 'VALUED',
      price: ds('12.34'),
      rate: ds('1.25'),
    });
    expect(view.marketValueInstrument).toBe('-61.7');
    expect(view.marketValueBase).toBe('-77.125');
  });

  it('zero quantity gives the real value "0" with VALUED (no negative zero)', () => {
    const view = toValuedPositionView(pos('DDD', 'JPY', '0'), {
      status: 'VALUED',
      price: ds('1500'),
      rate: ds('0.0067'),
    });
    expect(view).toMatchObject({
      marketPrice: '1500',
      marketValueInstrument: '0',
      marketValueBase: '0',
      valuationStatus: 'VALUED',
    });
  });

  it('identity rate "1": the base value equals the instrument value', () => {
    const view = toValuedPositionView(pos('AAA', 'USD', '10'), {
      status: 'VALUED',
      price: ds('150.25'),
      rate: ds('1'),
    });
    expect(view.marketValueInstrument).toBe('1502.5');
    expect(view.marketValueBase).toBe('1502.5');
  });

  it('marketPrice is canonical; trailing zeros are removed', () => {
    const view = toValuedPositionView(pos('AAA', 'USD', '2'), {
      status: 'VALUED',
      price: ds('100.000'),
      rate: ds('1.50'),
    });
    expect(view).toMatchObject({ marketPrice: '100', marketValueInstrument: '200', marketValueBase: '300' });
  });

  it('rounds each product to 40 significant digits (ROUND_HALF_UP), nothing else', () => {
    // 7 × 0.1428571428571428571428571428571428571429 = 1.0000000000000000000000000000000000000003
    // (41 significant digits) → 40 significant digits → 1.
    const view = toValuedPositionView(pos('AAA', 'USD', '7'), {
      status: 'VALUED',
      price: ds('0.1428571428571428571428571428571428571429'),
      rate: ds('1'),
    });
    expect(view.marketValueInstrument).toBe('1');
    expect(view.marketPrice).toBe('0.1428571428571428571428571428571428571429');
  });
});

describe('toValuedPositionView: fields per status (rule 12)', () => {
  it.each(['FX_UNAVAILABLE', 'FX_STALE'] as const)(
    '%s: price and instrument value set, base value null',
    (status) => {
      const view = toValuedPositionView(pos('BBB', 'EUR', '20'), { status, price: ds('45.5') });
      expect(view).toMatchObject({
        marketPrice: '45.5',
        marketValueInstrument: '910',
        marketValueBase: null,
        allocationPct: null,
        valuationStatus: status,
      });
    },
  );

  it.each(['PRICE_UNAVAILABLE', 'PRICE_CURRENCY_MISMATCH'] as const)(
    '%s: every market field null, never "0"',
    (status) => {
      const view = toValuedPositionView(pos('BBB', 'EUR', '20'), { status });
      expect(view).toMatchObject({
        marketPrice: null,
        marketValueInstrument: null,
        marketValueBase: null,
        allocationPct: null,
        valuationStatus: status,
      });
    },
  );

  it('keeps every position field and adds no other field (same keys as toPositionView)', () => {
    const position = pos('BBB', 'EUR', '20');
    const view = toValuedPositionView(position, { status: 'VALUED', price: ds('1'), rate: ds('1') });
    expect(Object.keys(view).sort()).toEqual(Object.keys(toPositionView(position)).sort());
    expect(view).toMatchObject(position);
  });

  it('does not change toPositionView (6.2): NOT_VALUED with null fields', () => {
    expect(toPositionView(pos('AAA', 'USD', '1'))).toMatchObject({
      marketPrice: null,
      marketValueInstrument: null,
      marketValueBase: null,
      allocationPct: null,
      valuationStatus: 'NOT_VALUED',
    });
  });
});

describe('toValuedPositionView: programmer errors', () => {
  const position = pos('AAA', 'USD', '1');
  const cases: [string, ValuationInput][] = [
    ['zero price', { status: 'VALUED', price: ds('0'), rate: ds('1') }],
    ['negative price', { status: 'VALUED', price: ds('-1'), rate: ds('1') }],
    ['zero rate', { status: 'VALUED', price: ds('1'), rate: ds('0') }],
    ['exponent price', { status: 'VALUED', price: '1e2' as DecimalString, rate: ds('1') }],
    ['missing rate', { status: 'VALUED', price: ds('1') } as unknown as ValuationInput],
    ['zero price with FX_STALE', { status: 'FX_STALE', price: ds('0') }],
  ];
  it.each(cases)('%s throws TypeError', (_name, input) => {
    expect(() => toValuedPositionView(position, input)).toThrow(TypeError);
  });

  it('an invalid signedQuantity throws DecimalInputError', () => {
    const bad = { ...position, signedQuantity: 'abc' as DecimalString };
    expect(() => toValuedPositionView(bad, { status: 'VALUED', price: ds('1'), rate: ds('1') })).toThrow(
      DecimalInputError,
    );
  });
});
