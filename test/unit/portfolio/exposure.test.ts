// Task 11.2: exposure measures and NAV (FR-10, FR-12). Hand-calculated values; Decimal results
// are compared as canonical strings.
// Tests: AT-ALC-09
// Validates: Requirements 20.1, 20.6, 30.6
import { describe, expect, it } from 'vitest';
import { computeExposure, exposureMeasures } from '../../../src/portfolio/index.js';
import type { ExposureResult, PositionView } from '../../../src/portfolio/index.js';
import type { DecimalString } from '../../../src/shared/index.js';
import { ds, line, unvalued, valued } from '../../helpers/exposure.js';
import { pos } from '../../helpers/valuation.js';

function ok(result: ExposureResult): Extract<ExposureResult, { status: 'OK' }> {
  if (result.status !== 'OK') {
    throw new Error(`expected OK, got ${result.status}`);
  }
  return result;
}

describe('AT-ALC-09: gross, net, long, short exposure and NAV', () => {
  it('longs, a short, a flat position, and negative cash', () => {
    // Long 1000 + 500 = 1500; short |-300| = 300; gross 1800; net 1200;
    // NAV = 1000 + 500 - 300 + (-200) = 1000; denominator = 1500 + max(-200, 0) = 1500.
    const result = ok(
      computeExposure(
        [valued('AAA', '1000'), valued('BBB', '500'), valued('CCC', '-300'), valued('DDD', '0', '0')],
        ds('-200'),
      ),
    );
    expect(result).toMatchObject({
      long: '1500',
      short: '300',
      gross: '1800',
      net: '1200',
      cash: '-200',
      nav: '1000',
      allocationDenominator: '1500',
      navStatus: 'NAV_POSITIVE',
    });
    expect(result.lines.map((entry) => entry.ticker)).toEqual(['AAA', 'BBB', 'CCC']);
  });

  it('positive cash enters NAV and the allocation denominator', () => {
    // NAV = 1500 - 300 + 250 = 1450; denominator = 1500 + 250 = 1750.
    const result = ok(
      computeExposure([valued('AAA', '1000'), valued('BBB', '500'), valued('CCC', '-300')], ds('250')),
    );
    expect(result).toMatchObject({ nav: '1450', allocationDenominator: '1750', gross: '1800', net: '1200' });
  });

  it('short-dominated portfolio: negative net and NAV_NOT_POSITIVE, NAV still reported', () => {
    // Long 100; short 400; gross 500; net -300; NAV = -300 + 50 = -250; denominator 150.
    const result = ok(computeExposure([valued('AAA', '100'), valued('BBB', '-400')], ds('50')));
    expect(result).toMatchObject({
      long: '100',
      short: '400',
      gross: '500',
      net: '-300',
      nav: '-250',
      allocationDenominator: '150',
      navStatus: 'NAV_NOT_POSITIVE',
    });
  });

  it('NAV exactly zero is NAV_NOT_POSITIVE', () => {
    expect(ok(computeExposure([valued('AAA', '100')], ds('-100'))).navStatus).toBe('NAV_NOT_POSITIVE');
  });

  it('decimal sums are exact (0.1 + 0.2 = 0.3)', () => {
    const result = ok(computeExposure([valued('AAA', '0.1'), valued('BBB', '0.2')], ds('0')));
    expect(result).toMatchObject({ long: '0.3', nav: '0.3', gross: '0.3', short: '0' });
  });

  it('no positions: every exposure is "0" and NAV equals the explicit cash', () => {
    expect(ok(computeExposure([], ds('100')))).toMatchObject({
      long: '0',
      short: '0',
      gross: '0',
      net: '0',
      nav: '100',
      allocationDenominator: '100',
      lines: [],
    });
  });

  it('the result does not depend on input order', () => {
    const views = [valued('CCC', '-300'), valued('AAA', '1000'), valued('BBB', '500')];
    expect(computeExposure([...views].reverse(), ds('7'))).toEqual(computeExposure(views, ds('7')));
  });
});

describe('missing valuations never become zero', () => {
  it('a non-flat position without a base value makes exposure unavailable, listing each ticker and status', () => {
    const result = computeExposure(
      [valued('AAA', '1000'), unvalued('CCC', 'FX_UNAVAILABLE'), unvalued('BBB', 'NOT_VALUED')],
      ds('0'),
    );
    expect(result).toEqual({
      status: 'EXPOSURE_UNAVAILABLE',
      reason: 'VALUATION_INCOMPLETE',
      unvalued: [
        { ticker: 'BBB', valuationStatus: 'NOT_VALUED' },
        { ticker: 'CCC', valuationStatus: 'FX_UNAVAILABLE' },
      ],
      cash: '0',
    });
    expect('nav' in result).toBe(false);
  });

  it.each(['PRICE_UNAVAILABLE', 'PRICE_CURRENCY_MISMATCH', 'FX_STALE'] as const)(
    'status %s blocks exposure',
    (status) => {
      expect(computeExposure([unvalued('AAA', status)], ds('0')).status).toBe('EXPOSURE_UNAVAILABLE');
    },
  );

  it('a flat position has no exposure (FR-9) and never blocks, whatever its valuation status', () => {
    const result = ok(
      computeExposure([valued('AAA', '10'), unvalued('ZZZ', 'PRICE_UNAVAILABLE', '0')], ds('0')),
    );
    expect(result).toMatchObject({ long: '10', nav: '10' });
    expect(result.lines.map((entry) => entry.ticker)).toEqual(['AAA']);
  });
});

describe('programmer errors', () => {
  const view = valued('AAA', '1');
  it.each([
    ['missing cash', undefined],
    ['exponent cash', '1e3'],
    ['native number cash', 5],
    ['empty cash', ''],
  ])('%s throws TypeError (cash is never defaulted)', (_name, cash) => {
    expect(() => computeExposure([view], cash as unknown as DecimalString)).toThrow(TypeError);
  });

  it('duplicate tickers, mixed portfolios, and an invalid quantity throw TypeError', () => {
    expect(() => computeExposure([view, valued('AAA', '2')], ds('0'))).toThrow(TypeError);
    const other: PositionView = {
      ...valued('BBB', '1'),
      ...pos('BBB', 'USD', '1', 'other-pf'),
      marketValueBase: ds('1'),
    };
    expect(() => computeExposure([view, other], ds('0'))).toThrow(TypeError);
    expect(() => computeExposure([{ ...view, signedQuantity: 'x' as DecimalString }], ds('0'))).toThrow(
      TypeError,
    );
  });

  it('exposureMeasures rejects duplicate or invalid lines', () => {
    expect(() => exposureMeasures([line('AAA', '1'), line('AAA', '2')], ds('0'))).toThrow(TypeError);
    expect(() => exposureMeasures([{ ticker: 'AAA', valueBase: '1e2' as DecimalString }], ds('0'))).toThrow(
      TypeError,
    );
    expect(() => exposureMeasures([{ ticker: '', valueBase: ds('1') }], ds('0'))).toThrow(TypeError);
  });
});
