// Task 11.3: allocation with the largest-remainder rule (FR-10, FR-11). Hand-calculated values;
// percentages are canonical strings ("33.3" is 33.30).
// Tests: AT-ALC-01, AT-ALC-02, AT-ALC-03, AT-ALC-04, AT-ALC-05, AT-ALC-06, AT-ALC-07
// Validates: Requirements 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.8
import { describe, expect, it } from 'vitest';
import { allocate, allocationCalculator, withAllocation } from '../../../src/portfolio/index.js';
import type { AllocationLine, AllocationResult } from '../../../src/portfolio/index.js';
import { d } from '../../../src/shared/index.js';
import type { DecimalString } from '../../../src/shared/index.js';
import { ds, line, unvalued, valued } from '../../helpers/exposure.js';

const pcts = (result: AllocationResult): Record<string, string> => {
  if (result.status === 'ALLOCATION_UNAVAILABLE') {
    throw new Error('expected lines');
  }
  return Object.fromEntries(
    result.lines.map((entry: AllocationLine) => [entry.kind === 'CASH' ? '<CASH>' : entry.ticker, entry.pct]),
  );
};
const sum = (result: AllocationResult): string =>
  result.status === 'ALLOCATION_UNAVAILABLE'
    ? 'n/a'
    : result.lines.reduce((acc, entry) => acc.plus(d(entry.pct)), d('0')).toFixed(2);

describe('AT-ALC-01: three equal assets give 33.34, 33.33, 33.33', () => {
  it('the extra unit goes to the lexicographically first ticker', () => {
    const result = allocate({
      positions: [line('BBB', '100'), line('CCC', '100'), line('AAA', '100')],
      cash: ds('0'),
    });
    expect(result.status).toBe('ELIGIBLE');
    expect(pcts(result)).toEqual({ AAA: '33.34', BBB: '33.33', CCC: '33.33' });
    expect(result.status === 'ELIGIBLE' && result.total).toBe('100');
  });
});

describe('AT-ALC-02: an eligible long-only portfolio totals exactly 100.00', () => {
  it('seven equal assets: 100 / 7 = 14.2857…; four units go to the first four tickers', () => {
    const tickers = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
    const result = allocate({ positions: tickers.map((ticker) => line(ticker, '1')), cash: ds('0') });
    expect(pcts(result)).toEqual({
      A1: '14.29',
      A2: '14.29',
      A3: '14.29',
      A4: '14.29',
      A5: '14.28',
      A6: '14.28',
      A7: '14.28',
    });
    expect(sum(result)).toBe('100.00');
  });

  it('largest remainders win before ticker order: 1/3 = 33.333…, 2/3 = 66.666…', () => {
    // Floors 33.33 + 66.66 = 99.99; remainders 0.0033… and 0.0066…: BBB (larger) gets the unit.
    const result = allocate({ positions: [line('AAA', '1'), line('BBB', '2')], cash: ds('0') });
    expect(pcts(result)).toEqual({ AAA: '33.33', BBB: '66.67' });
  });

  it('exact percentages need no extra unit', () => {
    const result = allocate({ positions: [line('AAA', '1'), line('BBB', '3')], cash: ds('0') });
    expect(pcts(result)).toEqual({ AAA: '25', BBB: '75' });
    expect(sum(result)).toBe('100.00');
  });
});

describe('AT-ALC-03: cash is in the denominator and shown as the CASH line', () => {
  it('600 in AAA and 400 cash give 60 and 40, CASH last', () => {
    const result = allocate({ positions: [line('AAA', '600')], cash: ds('400') });
    expect(result.status).toBe('ELIGIBLE');
    expect(result.status !== 'ALLOCATION_UNAVAILABLE' && result.lines).toEqual([
      { kind: 'POSITION', ticker: 'AAA', valueBase: '600', pct: '60' },
      { kind: 'CASH', valueBase: '400', pct: '40' },
    ]);
    expect(result.measures).toMatchObject({ allocationDenominator: '1000', cash: '400', nav: '1000' });
  });

  it('ties break by ascending ticker with CASH last, even after "ZZZ"', () => {
    const result = allocate({ positions: [line('ZZZ', '100'), line('AAA', '100')], cash: ds('100') });
    expect(pcts(result)).toEqual({ AAA: '33.34', ZZZ: '33.33', '<CASH>': '33.33' });
    const order = result.status !== 'ALLOCATION_UNAVAILABLE' ? result.lines.map((entry) => entry.kind) : [];
    expect(order).toEqual(['POSITION', 'POSITION', 'CASH']);
  });

  it('a ticker named "CASH" is a position, distinct from the cash line', () => {
    const result = allocate({ positions: [line('CASH', '50')], cash: ds('50') });
    expect(result.status !== 'ALLOCATION_UNAVAILABLE' && result.lines).toEqual([
      { kind: 'POSITION', ticker: 'CASH', valueBase: '50', pct: '50' },
      { kind: 'CASH', valueBase: '50', pct: '50' },
    ]);
  });

  it('zero cash adds no CASH line', () => {
    const result = allocate({ positions: [line('AAA', '5')], cash: ds('0') });
    expect(result.status !== 'ALLOCATION_UNAVAILABLE' && result.lines.map((entry) => entry.kind)).toEqual([
      'POSITION',
    ]);
  });
});

describe('AT-ALC-04: negative cash is ineligible and never forced to 100', () => {
  it('three equal assets with cash -10: 33.33 each, total 99.99, measures stated separately', () => {
    const result = allocate({
      positions: [line('AAA', '100'), line('BBB', '100'), line('CCC', '100')],
      cash: ds('-10'),
    });
    expect(result.status).toBe('INELIGIBLE');
    expect(result.status === 'INELIGIBLE' && result.reasons).toEqual(['NEGATIVE_CASH', 'LEVERAGE']);
    expect(pcts(result)).toEqual({ AAA: '33.33', BBB: '33.33', CCC: '33.33' });
    expect(sum(result)).toBe('99.99');
    // Denominator = 300 + max(-10, 0) = 300; NAV = 290; gross 300 > NAV 290 (leverage).
    expect(result.measures).toMatchObject({
      allocationDenominator: '300',
      nav: '290',
      gross: '300',
      net: '300',
      long: '300',
      short: '0',
      cash: '-10',
    });
    expect('total' in result).toBe(false);
  });
});

describe('AT-ALC-05: short positions are shown separately; no forced 100', () => {
  it('three equal longs and one short: 33.33 each unforced, the short listed with its value', () => {
    const result = allocate({
      positions: [line('AAA', '300'), line('DDD', '-100'), line('BBB', '300'), line('CCC', '300')],
      cash: ds('0'),
    });
    expect(result.status).toBe('INELIGIBLE');
    if (result.status !== 'INELIGIBLE') {
      return;
    }
    expect(result.reasons).toEqual(['SHORT_POSITIONS', 'LEVERAGE']);
    expect(pcts(result)).toEqual({ AAA: '33.33', BBB: '33.33', CCC: '33.33' });
    expect(result.shortPositions).toEqual([{ ticker: 'DDD', valueBase: '-100' }]);
    // Long 900, short 100, gross 1000, net 800, NAV 800, denominator 900.
    expect(result.measures).toMatchObject({
      long: '900',
      short: '100',
      gross: '1000',
      net: '800',
      nav: '800',
      allocationDenominator: '900',
    });
  });

  it('ineligible percentages round half up independently (2/3 → 66.67, 1/3 → 33.33)', () => {
    const result = allocate({
      positions: [line('AAA', '1'), line('BBB', '2'), line('SSS', '-0.5')],
      cash: ds('0'),
    });
    expect(pcts(result)).toEqual({ AAA: '33.33', BBB: '66.67' });
  });
});

describe('AT-ALC-06: a zero or negative denominator gives ALLOCATION_UNAVAILABLE', () => {
  it.each([
    ['no positions and zero cash', [], '0'],
    ['no positions and negative cash', [], '-50'],
    ['only shorts and zero cash', [line('AAA', '-100')], '0'],
    ['only shorts and negative cash', [line('AAA', '-100')], '-1'],
  ])('%s', (_name, positions, cash) => {
    const result = allocate({ positions, cash: ds(cash) });
    expect(result.status).toBe('ALLOCATION_UNAVAILABLE');
    expect(result.status === 'ALLOCATION_UNAVAILABLE' && result.reason).toBe('DENOMINATOR_NOT_POSITIVE');
    expect('lines' in result).toBe(false);
    expect(result.measures.allocationDenominator).toBe('0');
  });
});

describe('AT-ALC-07: the tie-break is deterministic across input orders', () => {
  it('every permutation of four equal assets gives the same result', () => {
    const base = [line('DDD', '1'), line('BBB', '1'), line('AAA', '1'), line('CCC', '1')];
    const permutations = (items: typeof base): (typeof base)[] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, index) =>
            permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
              item,
              ...rest,
            ]),
          );
    const results = permutations(base).map((positions) => allocate({ positions, cash: ds('2') }));
    for (const result of results) {
      expect(result).toEqual(results[0]);
    }
    // Denominator 6: each asset 16.666… (floor 16.66, remainder 0.00666…), CASH 33.333… (floor 33.33,
    // remainder 0.00333…). Floors sum to 99.97, so three units go to the equal largest remainders in
    // ticker order (AAA, BBB, CCC); DDD keeps 16.66 and CASH 33.33. Total 100.
    expect(pcts(results[0] as AllocationResult)).toEqual({
      AAA: '16.67',
      BBB: '16.67',
      CCC: '16.67',
      DDD: '16.66',
      '<CASH>': '33.33',
    });
    expect(sum(results[0] as AllocationResult)).toBe('100.00');
  });
});

describe('withAllocation: fills PositionView.allocationPct', () => {
  it('long positions get their percentage; shorts, flat, and absent positions stay null', () => {
    const views = [
      valued('AAA', '300'),
      valued('DDD', '-100'),
      valued('FLT', '0', '0'),
      valued('BBB', '300'),
    ];
    const result = allocationCalculator.allocate({
      positions: [line('AAA', '300'), line('DDD', '-100'), line('BBB', '300')],
      cash: ds('0'),
    });
    const filled = withAllocation(views, result);
    expect(filled.map((view) => [view.ticker, view.allocationPct])).toEqual([
      ['AAA', '50'],
      ['DDD', null],
      ['FLT', null],
      ['BBB', '50'],
    ]);
    expect(filled[0]).toMatchObject({ marketValueBase: '300', valuationStatus: 'VALUED' });
  });

  it('ALLOCATION_UNAVAILABLE leaves every allocationPct null, never "0"', () => {
    const result = allocate({ positions: [line('AAA', '-1')], cash: ds('0') });
    expect(
      withAllocation([valued('AAA', '-1'), unvalued('BBB', 'NOT_VALUED')], result).map(
        (v) => v.allocationPct,
      ),
    ).toEqual([null, null]);
  });
});

describe('programmer errors', () => {
  it.each([
    ['missing cash', { positions: [line('AAA', '1')] }],
    ['exponent value', { positions: [{ ticker: 'AAA', valueBase: '1e2' as DecimalString }], cash: ds('0') }],
    ['duplicate tickers', { positions: [line('AAA', '1'), line('AAA', '2')], cash: ds('0') }],
    ['not an object', null],
  ])('%s throws TypeError', (_name, input) => {
    expect(() => allocate(input as never)).toThrow(TypeError);
  });
});
