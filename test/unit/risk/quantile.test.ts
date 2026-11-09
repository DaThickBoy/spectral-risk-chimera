// Task 12.1: Hyndman-Fan Type 7 quantile (FR-7). AT-VAR-01, AT-VAR-02, AT-VAR-04,
// AT-VAR-05, AT-VAR-06. Expected values are hand-calculated (see the fixture's
// `handCalculation` fields and the comments below), not produced by the implementation.
// Validates: Requirements 14.2, 14.7, 27.6
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { QUANTILE_METHOD, sortAscending, type7Quantile } from '../../../src/risk/index.js';
// Module-internal helper, imported directly to test the defensive j >= n guard.
import { type7AtPosition } from '../../../src/risk/quantile.js';
import { DecimalStringSchema, d, toCanonical } from '../../../src/shared/index.js';
import type { Decimal } from '../../../src/shared/index.js';
import { repoPath } from '../../helpers/repo.js';

const ExpectedSchema = z.strictObject({
  h: DecimalStringSchema,
  j: z.number().int(),
  gamma: DecimalStringSchema,
  xj: DecimalStringSchema,
  xj1: DecimalStringSchema,
  handCalculation: z.string(),
  quantile: DecimalStringSchema,
});
const FixtureSchema = z.strictObject({
  description: z.string(),
  construction: z.array(z.string()),
  expected: z.strictObject({ '0.95': ExpectedSchema, '0.99': ExpectedSchema }),
  losses: z.array(DecimalStringSchema).length(250),
});

// The fixture holds only decimal strings, so JSON.parse cannot lose precision; Zod validates it.
const fixture = FixtureSchema.parse(
  JSON.parse(readFileSync(repoPath('test', 'fixtures', 'risk', 'quantile-250.json'), 'utf8')),
);
const losses = fixture.losses.map((text) => d(text));

const decimals = (...texts: string[]): Decimal[] => texts.map((text) => d(text));
const canonical = (values: readonly Decimal[]): string[] => values.map((value) => toCanonical(value));

function quantile(values: readonly Decimal[], p: string): string {
  const result = type7Quantile(values, d(p));
  if (!result.ok) {
    throw new Error(`unexpected ${result.error.code}`);
  }
  return toCanonical(result.value);
}

/** One-based order statistic of the fixture, read from the sorted list. */
const x = (sorted: readonly Decimal[], i: number): string => toCanonical(sorted[i - 1] ?? d('0'));

describe('AT-VAR-01 and AT-VAR-02: 250-loss known-answer fixture', () => {
  const sorted = sortAscending(losses);

  it('the sorted fixture has the hand-chosen order statistics', () => {
    expect([x(sorted, 1), x(sorted, 100), x(sorted, 101), x(sorted, 160), x(sorted, 236)]).toEqual([
      '-0.03975',
      '-0.015',
      '-0.015',
      '0',
      '0.019',
    ]);
    expect([x(sorted, 237), x(sorted, 238), x(sorted, 247), x(sorted, 248), x(sorted, 250)]).toEqual([
      '0.0213',
      '0.0251',
      '0.0412',
      '0.0533',
      '0.12',
    ]);
  });

  it('95%: h = 237.55, j = 237, gamma = 0.55, Q = 0.45 * x[237] + 0.55 * x[238] = 0.02339', () => {
    const expected = fixture.expected['0.95'];
    expect([x(sorted, expected.j), x(sorted, expected.j + 1)]).toEqual([expected.xj, expected.xj1]);
    expect(quantile(losses, '0.95')).toBe('0.02339');
    expect(quantile(losses, '0.95')).toBe(expected.quantile);
    // The same value from the FR-7 worked formula applied to the order statistics.
    expect(
      toCanonical(
        d('0.45')
          .times(d(expected.xj))
          .plus(d('0.55').times(d(expected.xj1))),
      ),
    ).toBe('0.02339');
  });

  it('99%: h = 247.51, j = 247, gamma = 0.51, Q = 0.49 * x[247] + 0.51 * x[248] = 0.047371', () => {
    const expected = fixture.expected['0.99'];
    expect([x(sorted, expected.j), x(sorted, expected.j + 1)]).toEqual([expected.xj, expected.xj1]);
    expect(quantile(losses, '0.99')).toBe('0.047371');
    expect(quantile(losses, '0.99')).toBe(expected.quantile);
  });

  it('the result does not depend on the order of the input', () => {
    expect(quantile([...losses].reverse(), '0.95')).toBe('0.02339');
    expect(quantile(sorted, '0.99')).toBe('0.047371');
  });

  it('reports the method identifier HYNDMAN_FAN_TYPE_7', () => {
    expect(QUANTILE_METHOD).toBe('HYNDMAN_FAN_TYPE_7');
  });
});

describe('AT-VAR-04: losses are sorted ascending, exactly, including ties and gains', () => {
  it('sorts numerically, not as text, including negative losses (gains)', () => {
    const input = decimals('10', '9', '-0.5', '-0.05', '0', '0.1', '-10', '2.5');
    expect(canonical(sortAscending(input))).toEqual(['-10', '-0.5', '-0.05', '0', '0.1', '2.5', '9', '10']);
  });

  it('distinguishes values beyond binary floating-point precision', () => {
    const input = decimals('0.30000000000000000001', '0.3', '0.29999999999999999999');
    expect(canonical(sortAscending(input))).toEqual([
      '0.29999999999999999999',
      '0.3',
      '0.30000000000000000001',
    ]);
  });

  it('is stable for ties and leaves the input unchanged', () => {
    const first = d('1');
    const second = d('1.0');
    const input = [d('2'), first, d('-1'), second];
    const sorted = sortAscending(input);
    expect(sorted[1]).toBe(first);
    expect(sorted[2]).toBe(second);
    expect(canonical(input)).toEqual(['2', '1', '-1', '1']);
  });

  it('ties at the interpolation positions give the tied value', () => {
    // n = 5, p = 0.3: h = 2.2, j = 2, gamma = 0.2; x[2] = x[3] = 4 -> Q = 0.8 * 4 + 0.2 * 4 = 4.
    expect(quantile(decimals('9', '4', '1', '4', '7'), '0.3')).toBe('4');
  });

  it('all-gain scenarios give a negative raw quantile (no flooring here)', () => {
    // n = 3, p = 0.95: h = 2.9, j = 2, gamma = 0.9; Q = 0.1 * -2 + 0.9 * -1 = -1.1.
    expect(quantile(decimals('-1', '-3', '-2'), '0.95')).toBe('-1.1');
  });
});

describe('AT-VAR-05: gamma = 0 uses x[j] only; gamma > 0 interpolates', () => {
  it('gamma = 0 returns x[j] and ignores x[j + 1]', () => {
    // n = 5, p = 0.5: h = 3 exactly, so Q = x[3] = 30 whatever x[4] is.
    expect(quantile(decimals('10', '20', '30', '40', '50'), '0.5')).toBe('30');
    expect(quantile(decimals('10', '20', '30', '1000000', '2000000'), '0.5')).toBe('30');
    // n = 11, p = 0.3: h = 4 exactly -> x[4].
    expect(quantile(decimals('0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'), '0.3')).toBe('3');
  });

  it('n = 200, p = 0.95: h = 190.05, j = 190, gamma = 0.05 -> 0.95 * x[190] + 0.05 * x[191]', () => {
    // x[i] = i: 0.95 * 190 + 0.05 * 191 = 180.5 + 9.55 = 190.05.
    const values = Array.from({ length: 200 }, (_, i) => d(String(i + 1)));
    expect(quantile(values, '0.95')).toBe('190.05');
  });

  it('n = 249, p = 0.95: h = 236.6, j = 236, gamma = 0.6 -> 0.4 * x[236] + 0.6 * x[237]', () => {
    // x[i] = 10 * i, given in descending order: 0.4 * 2360 + 0.6 * 2370 = 944 + 1422 = 2366.
    const values = Array.from({ length: 249 }, (_, i) => d(String((249 - i) * 10)));
    expect(quantile(values, '0.95')).toBe('2366');
  });

  it('interpolates exactly without intermediate rounding', () => {
    // n = 4, p = 0.1: h = 1.3, j = 1, gamma = 0.3; Q = 0.7 * 0.1 + 0.3 * 0.2 = 0.07 + 0.06 = 0.13.
    expect(quantile(decimals('0.2', '0.1', '0.3', '0.4'), '0.1')).toBe('0.13');
  });
});

describe('AT-VAR-06: very small n and the j >= n guard', () => {
  it('n = 2 interpolates between the two observations', () => {
    // h = 1 + p: p = 0.5 -> 0.5 * 1 + 0.5 * 3 = 2; p = 0.99 -> 0.01 * 1 + 0.99 * 3 = 2.98;
    // p = 0.0001 -> 0.9999 * 1 + 0.0001 * 3 = 1.0002.
    const values = decimals('3', '1');
    expect(quantile(values, '0.5')).toBe('2');
    expect(quantile(values, '0.99')).toBe('2.98');
    expect(quantile(values, '0.0001')).toBe('1.0002');
  });

  it('the guard returns x[n] when j >= n', () => {
    const sorted = decimals('1', '3');
    expect(toCanonical(type7AtPosition(sorted, d('2')))).toBe('3');
    expect(toCanonical(type7AtPosition(sorted, d('2.5')))).toBe('3');
    expect(toCanonical(type7AtPosition(decimals('5'), d('1')))).toBe('5');
  });

  it('rejects positions below 1 and empty lists as programmer errors', () => {
    expect(() => type7AtPosition(decimals('1', '2'), d('0.5'))).toThrow(RangeError);
    expect(() => type7AtPosition([], d('1'))).toThrow(RangeError);
  });

  it.each([0, 1])('n = %i is INSUFFICIENT_DATA, with no value', (n) => {
    const result = type7Quantile(decimals('1').slice(0, n), d('0.95'));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('INSUFFICIENT_DATA');
    expect('value' in result).toBe(false);
  });
});

describe('input validation', () => {
  const infinity = d('1').dividedBy(d('0'));

  it.each(['0', '1', '-0.1', '1.5'])('rejects p = %s as INVALID_INPUT', (p) => {
    const result = type7Quantile(decimals('1', '2', '3'), d(p));
    expect(!result.ok && result.error.code).toBe('INVALID_INPUT');
  });

  it('rejects a non-finite or non-Decimal p as INVALID_INPUT', () => {
    expect(!type7Quantile(decimals('1', '2'), infinity).ok).toBe(true);
    const numeric = type7Quantile(decimals('1', '2'), 0.95 as unknown as Decimal);
    expect(!numeric.ok && numeric.error.code).toBe('INVALID_INPUT');
  });

  it('rejects non-finite or non-Decimal values as INVALID_INPUT instead of producing a number', () => {
    const withInfinity = type7Quantile([d('1'), infinity, d('2')], d('0.5'));
    expect(!withInfinity.ok && withInfinity.error.code).toBe('INVALID_INPUT');
    const withNumber = type7Quantile([d('1'), 2 as unknown as Decimal], d('0.5'));
    expect(!withNumber.ok && withNumber.error.code).toBe('INVALID_INPUT');
  });

  it('validates p before the observation count', () => {
    const result = type7Quantile([], d('1'));
    expect(!result.ok && result.error.code).toBe('INVALID_INPUT');
  });
});
