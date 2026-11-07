// AT-DEC-01, AT-DEC-02, AT-DEC-03, AT-DEC-04, AT-DEC-07: the Decimal helper (task 2.1).
// Validates: Requirements 4.1, 4.3, 4.5, 4.6, 4.7, 30.4
import { describe, expect, it } from 'vitest';
import {
  DEC,
  DECIMAL_PRECISION,
  DecimalInputError,
  d,
  roundMoney,
  toCanonical,
  toChartNumber,
} from '../../../src/shared/index.js';
import type { Decimal } from '../../../src/shared/index.js';

const canon = (x: Decimal): string => toCanonical(x);

describe('configuration (R4.5)', () => {
  it('uses precision 40 and ROUND_HALF_UP', () => {
    expect(DEC.precision).toBe(DECIMAL_PRECISION);
    expect(DEC.precision).toBe(40);
    expect(DEC.rounding).toBe(DEC.ROUND_HALF_UP);
  });

  it('rounds division results to 40 significant digits', () => {
    expect(canon(d('1').dividedBy(d('3')))).toBe(`0.${'3'.repeat(40)}`);
    expect(canon(d('2').dividedBy(d('3')))).toBe(`0.${'6'.repeat(39)}7`);
  });
});

describe('AT-DEC-01: exact accumulation', () => {
  it('adds "0.1" ten thousand times to exactly "1000"', () => {
    let total = d('0');
    for (let i = 0; i < 10_000; i += 1) {
      total = total.plus(d('0.1'));
    }
    expect(canon(total)).toBe('1000');
    expect(total.equals(d('1000'))).toBe(true);
  });
});

describe('AT-DEC-02: monetary precision', () => {
  it('preserves every digit in sums and products (hand-calculated)', () => {
    expect(canon(d('1234567890.123456789').plus(d('0.000000001')))).toBe('1234567890.12345679');
    expect(canon(d('19.99').times(d('3')))).toBe('59.97');
    expect(canon(d('0.1').plus(d('0.2')))).toBe('0.3');
    expect(canon(d('100.00').minus(d('99.99')))).toBe('0.01');
  });
});

describe('AT-DEC-03: FX conversion precision', () => {
  it('computes 1.2345678901 x 1000.01 exactly', () => {
    // Hand calculation: 1.2345678901 * 1000 = 1234.5678901000; 1.2345678901 * 0.01 = 0.012345678901;
    // 1234.567890100000 + 0.012345678901 = 1234.580235778901.
    expect(canon(d('1.2345678901').times(d('1000.01')))).toBe('1234.580235778901');
  });
});

describe('AT-DEC-04: canonical strings and JSON round trip', () => {
  it.each([
    ['1.500', '1.5'],
    ['-0', '0'],
    ['-0.000', '0'],
    ['100', '100'],
    ['0.0000001', '0.0000001'],
    ['1000000000000000000000', '1000000000000000000000'],
    ['-12.50', '-12.5'],
  ])('toCanonical(d(%s)) is %s', (input, expected) => {
    expect(canon(d(input))).toBe(expected);
  });

  it('never uses exponent notation for very small or large values', () => {
    expect(canon(d('1').dividedBy(d('10000000000')))).toBe('0.0000000001');
    expect(canon(d('123').times(d('1000000000000000000000000')))).toBe('123000000000000000000000000');
  });

  it('round-trips through JSON unchanged', () => {
    const payload = { nav: canon(d('1234567.8901')), loss: canon(d('-0.05')) };
    const parsed = JSON.parse(JSON.stringify(payload)) as { nav: string; loss: string };
    expect(parsed).toEqual(payload);
    expect(canon(d(parsed.nav))).toBe('1234567.8901');
  });
});

describe('AT-DEC-07: invalid numeric input is rejected', () => {
  it.each([
    'NaN',
    'Infinity',
    '-Infinity',
    '1e-5',
    '2E3',
    '',
    ' 1',
    '1 ',
    '1.',
    '.5',
    '+1',
    '1,000',
    '0x10',
    '007',
    '--1',
  ])('rejects %j', (input) => {
    expect(() => d(input)).toThrow(DecimalInputError);
  });

  it('rejects JavaScript numbers at runtime', () => {
    // @ts-expect-error JS numbers are rejected at the type level too.
    expect(() => d(0.1)).toThrow(DecimalInputError);
    // @ts-expect-error NaN is a number.
    expect(() => d(Number.NaN)).toThrow(DecimalInputError);
  });

  it('rejects non-finite Decimal values', () => {
    const notANumber = d('0').dividedBy(d('0'));
    const infinite = d('1').dividedBy(d('0'));
    expect(() => d(notANumber)).toThrow(DecimalInputError);
    expect(() => toCanonical(infinite)).toThrow(DecimalInputError);
  });
});

describe('roundMoney (FR-14, display only)', () => {
  it('rounds half up to the minor unit', () => {
    expect(canon(roundMoney(d('2.345'), 2))).toBe('2.35');
    expect(canon(roundMoney(d('2.344'), 2))).toBe('2.34');
    expect(canon(roundMoney(d('-2.345'), 2))).toBe('-2.35');
    expect(canon(roundMoney(d('1234.5'), 0))).toBe('1235');
  });

  it('rejects an invalid minor-unit count', () => {
    expect(() => roundMoney(d('1'), -1)).toThrow(RangeError);
    expect(() => roundMoney(d('1'), 1.5)).toThrow(RangeError);
  });
});

describe('toChartNumber (R4.4 presentation boundary)', () => {
  it('converts a canonical decimal string to a chart number', () => {
    // Chart numbers are display-only; this checks the boundary conversion itself.
    expect(toChartNumber(toCanonical(d('12.5')))).toBe(12.5);
  });
});
