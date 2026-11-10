// Kiroween A2: loss-distribution histogram of the Base VaR scenario losses. Every expected value
// below was worked out by hand (comments), independently of the implementation.
// Validates: Requirements 14.7, 4.4, 35.1
// Kiroween decision A2: binding items one to eleven (FR-7 marker).
import { describe, expect, it } from 'vitest';
import { LOSS_HISTOGRAM_BUCKETS, lossHistogram, type7Quantile } from '../../../src/risk/index.js';
import type { LossHistogram } from '../../../src/risk/index.js';
import { currencyMinorUnits, d, toCanonical } from '../../../src/shared/index.js';

const P95 = d('0.95');

function run(values: readonly string[], bucketCount: number, minorUnits: number, p = P95): LossHistogram {
  const result = lossHistogram(
    values.map((v) => d(v)),
    { bucketCount, minorUnits, confidence: p },
  );
  if (!result.ok) throw new Error(`unexpected ${result.error.code}`);
  return result.value;
}

/** Plain text view: exact canonical strings and integer counts. */
const plain = (h: LossHistogram) => ({
  n: h.scenarioCount,
  min: toCanonical(h.min),
  max: toCanonical(h.max),
  width: toCanonical(h.width),
  buckets: h.buckets.map((b) => [
    toCanonical(b.lower),
    toCanonical(b.upper),
    b.upperInclusive ? ']' : ')',
    b.count,
  ]),
  raw: toCanonical(h.rawQuantile),
  varBucket: h.varBucketIndex,
  above: h.scenariosAboveVaR,
  position: toCanonical(h.markerPosition),
});

const errorOf = (values: readonly string[], params: { k?: number; m?: number; p?: string }) => {
  const result = lossHistogram(
    values.map((v) => d(v)),
    { bucketCount: params.k ?? 4, minorUnits: params.m ?? 2, confidence: d(params.p ?? '0.95') },
  );
  return result.ok ? 'OK' : result.error.code;
};

describe('A2 production bucket count', () => {
  it('is exactly 20', () => {
    expect(LOSS_HISTOGRAM_BUCKETS).toBe(20);
  });
});

describe('known answers (the four approved cases)', () => {
  it('losses -2..7 (n = 10), K = 4: width 2.25, counts 3/2/2/3, VaR 95% = 6.55 in bucket 4', () => {
    // span = 9; 9 / 0.01 / 4 = 225 exactly -> width 2.25 (no rounding needed).
    // Edges -2, 0.25, 2.5, 4.75, 7. Buckets: {-2,-1,0}, {1,2}, {3,4}, {5,6,7} (7 = last upper, included).
    // Type 7: h = 1 + 9 * 0.95 = 9.55 -> x9 + 0.55 * (x10 - x9) = 6 + 0.55 = 6.55.
    // Above 6.55: {7} -> 1. Position (6.55 - -2) / 2.25 = 8.55 / 2.25 = 3.8.
    const scrambled = ['3', '-2', '7', '0', '5', '-1', '6', '1', '4', '2'];
    expect(plain(run(scrambled, 4, 2))).toEqual({
      n: 10,
      min: '-2',
      max: '7',
      width: '2.25',
      buckets: [
        ['-2', '0.25', ')', 3],
        ['0.25', '2.5', ')', 2],
        ['2.5', '4.75', ')', 2],
        ['4.75', '7', ']', 3],
      ],
      raw: '6.55',
      varBucket: 3,
      above: 1,
      position: '3.8',
    });
  });

  it('[0, 0.01, 0.02], K = 2: width 0.01, counts 1/2', () => {
    // span 0.02 -> 2 minor units / 2 = 1 -> width 0.01. Buckets [0, 0.01): {0}; [0.01, 0.02]: {0.01, 0.02}.
    // h = 1 + 2 * 0.95 = 2.9 -> 0.01 + 0.9 * 0.01 = 0.019; above {0.02} -> 1; position 1.9.
    expect(plain(run(['0', '0.01', '0.02'], 2, 2))).toEqual({
      n: 3,
      min: '0',
      max: '0.02',
      width: '0.01',
      buckets: [
        ['0', '0.01', ')', 1],
        ['0.01', '0.02', ']', 2],
      ],
      raw: '0.019',
      varBucket: 1,
      above: 1,
      position: '1.9',
    });
  });

  it('[5, 5, 5] (all equal): width is one minor unit, still K buckets, every scenario in the first', () => {
    // span 0 -> width = 0.01 (one cent). Production keeps exactly K buckets (A2 requirement 1).
    // Raw quantile 5 (all equal), in bucket 1; nothing is strictly above it; position 0.
    expect(plain(run(['5', '5', '5'], 2, 2))).toEqual({
      n: 3,
      min: '5',
      max: '5',
      width: '0.01',
      buckets: [
        ['5', '5.01', ')', 3],
        ['5.01', '5.02', ']', 0],
      ],
      raw: '5',
      varBucket: 0,
      above: 0,
      position: '0',
    });
    const production = run(['5', '5', '5'], LOSS_HISTOGRAM_BUCKETS, 2);
    expect(production.buckets).toHaveLength(20);
    expect(production.buckets.map((b) => b.count)).toEqual([3, ...Array.from({ length: 19 }, () => 0)]);
  });

  it('[0, 1], K = 3: width rounds UP to 0.34, counts 1/0/1, last edge 1.02 covers the max', () => {
    // 1 / 0.01 / 3 = 33.33... -> ceil 34 -> width 0.34 (0.33 * 3 = 0.99 would not cover 1).
    // h = 1 + 1 * 0.95 = 1.95 -> 0 + 0.95 * 1 = 0.95, in [0.68, 1.02]. Above {1} -> 1.
    // Position 0.95 / 0.34 = 2.7941176470... -> 2.794118 (6 decimals, half up).
    expect(plain(run(['0', '1'], 3, 2))).toEqual({
      n: 2,
      min: '0',
      max: '1',
      width: '0.34',
      buckets: [
        ['0', '0.34', ')', 1],
        ['0.34', '0.68', ')', 0],
        ['0.68', '1.02', ']', 1],
      ],
      raw: '0.95',
      varBucket: 2,
      above: 1,
      position: '2.794118',
    });
  });
});

describe('boundaries', () => {
  it('a loss on an inner edge belongs to the upper bucket; the maximum on the last edge is included', () => {
    // [0..4], K = 4: width 1; 1, 2, 3 sit on inner edges and go up; 4 = last upper edge, included.
    // h = 1 + 4 * 0.95 = 4.8 -> 3 + 0.8 * 1 = 3.8 (bucket 4); above {4} -> 1.
    expect(plain(run(['0', '1', '2', '3', '4'], 4, 2))).toMatchObject({
      width: '1',
      buckets: [
        ['0', '1', ')', 1],
        ['1', '2', ')', 1],
        ['2', '3', ')', 1],
        ['3', '4', ']', 2],
      ],
      raw: '3.8',
      varBucket: 3,
      above: 1,
    });
  });

  it('a raw quantile on an edge is in the upper bucket, and equal losses are not counted above it', () => {
    // p = 0.5: h = 1 + 4 * 0.5 = 3 (gamma 0) -> x3 = 2 exactly, the lower edge of bucket 3.
    // Strictly greater than 2: {3, 4} -> 2 (the loss equal to 2 is not counted).
    const h = run(['0', '1', '2', '3', '4'], 4, 2, d('0.5'));
    expect(toCanonical(h.rawQuantile)).toBe('2');
    expect(h.varBucketIndex).toBe(2);
    expect(h.scenariosAboveVaR).toBe(2);
    expect(toCanonical(h.markerPosition)).toBe('2');
  });

  it('a single bucket holds every scenario, with both edges included', () => {
    const h = plain(run(['1', '2', '3'], 1, 2));
    expect(h.width).toBe('2');
    expect(h.buckets).toEqual([['1', '3', ']', 3]]);
    expect(h.varBucket).toBe(0);
  });

  it('the counts always sum to the number of scenarios', () => {
    const values = ['-3.5', '0', '0', '12.25', '7.125', '-0.01', '99.99', '42'];
    const h = run(values, LOSS_HISTOGRAM_BUCKETS, 2);
    expect(h.buckets.reduce((total, b) => total + b.count, 0)).toBe(values.length);
    expect(h.buckets).toHaveLength(20);
  });
});

describe('negative values (all scenarios are gains)', () => {
  it('keeps the raw quantile negative (never floored) and buckets the gains exactly', () => {
    // min -10.5, max -1, span 9.5 -> 950 / 4 = 237.5 -> ceil 238 -> width 2.38.
    // Edges -10.5, -8.12, -5.74, -3.36, -0.98. -10.5 -> 1; -7 -> 2; -3.25 and -1 -> 4.
    // Sorted -10.5, -7, -3.25, -1: h = 1 + 3 * 0.95 = 3.85 -> -3.25 + 0.85 * 2.25 = -1.3375.
    // Above -1.3375: {-1} -> 1. Position (-1.3375 + 10.5) / 2.38 = 3.8497899... -> 3.84979.
    expect(plain(run(['-1', '-10.5', '-3.25', '-7'], 4, 2))).toEqual({
      n: 4,
      min: '-10.5',
      max: '-1',
      width: '2.38',
      buckets: [
        ['-10.5', '-8.12', ')', 1],
        ['-8.12', '-5.74', ')', 1],
        ['-5.74', '-3.36', ')', 0],
        ['-3.36', '-0.98', ']', 2],
      ],
      raw: '-1.3375',
      varBucket: 3,
      above: 1,
      position: '3.84979',
    });
  });
});

describe('precision', () => {
  it('keeps edges and the marker unrounded; only the width is rounded up to the minor unit', () => {
    // span = 100.123456789123456789123456789 - 0.000001 = 100.123455789123456789123456789
    // / 0.01 / 20 = 500.6172789... -> ceil 501 -> width 5.01 (5.00 * 20 = 100 < span <= 100.2).
    // h = 1 + 2 * 0.95 = 2.9 -> 50.5 + 0.9 * 49.623456789123456789123456789
    //   = 50.5 + 44.6611111102111111102111111101 = 95.1611111102111111102111111101.
    // Buckets: min -> 1; 50.5 -> floor(50.499999 / 5.01) = 10 -> 11; max -> 20; raw -> 19.
    const top = '100.123456789123456789123456789';
    const h = run(['0.000001', top, '50.5'], 20, 2);
    expect(toCanonical(h.width)).toBe('5.01');
    expect(toCanonical(h.buckets[0]?.lower ?? d('0'))).toBe('0.000001');
    expect(toCanonical(h.buckets[1]?.lower ?? d('0'))).toBe('5.010001');
    expect(toCanonical(h.buckets[19]?.upper ?? d('0'))).toBe('100.200001');
    expect(toCanonical(h.max)).toBe(top);
    expect(toCanonical(h.rawQuantile)).toBe('95.1611111102111111102111111101');
    // The marker is the engine's own Type 7 quantile, unrounded.
    const engineQuantile = type7Quantile([d('0.000001'), d(top), d('50.5')], P95);
    expect(engineQuantile.ok && engineQuantile.value.equals(h.rawQuantile)).toBe(true);
    const counts = h.buckets.map((b) => b.count);
    expect(counts[0]).toBe(1);
    expect(counts[10]).toBe(1);
    expect(counts[19]).toBe(1);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
    expect(h.varBucketIndex).toBe(18);
    expect(h.scenariosAboveVaR).toBe(1);
  });

  it('does not round the width up when the span divides exactly into minor units', () => {
    // span 9, K = 4: exactly 2.25 (not 2.26); 0.04, K = 4: exactly 0.01.
    expect(toCanonical(run(['-2', '7'], 4, 2).width)).toBe('2.25');
    expect(toCanonical(run(['1', '1.04'], 4, 2).width)).toBe('0.01');
  });
});

describe('currency exponent (minor units from the ISO 4217 definition)', () => {
  it('uses the currency definition: JPY 0, EUR 2, BHD 3', () => {
    expect(currencyMinorUnits('JPY')).toBe(0);
    expect(currencyMinorUnits('EUR')).toBe(2);
    expect(currencyMinorUnits('BHD')).toBe(3);
  });

  it('JPY (0 decimals): the width is a whole yen', () => {
    // [0, 1], K = 3: 1 / 1 / 3 = 0.33... -> ceil 1 -> width 1; buckets [0,1): {0}, [1,2): {1}, [2,3]: {}.
    expect(plain(run(['0', '1'], 3, currencyMinorUnits('JPY')))).toMatchObject({
      width: '1',
      buckets: [
        ['0', '1', ')', 1],
        ['1', '2', ')', 1],
        ['2', '3', ']', 0],
      ],
      raw: '0.95',
      varBucket: 0,
      position: '0.95',
    });
    // Fractional yen losses keep exact edges; only the width is whole: span 10.2 / 20 = 0.51 -> 1.
    const yen = run(['0.4', '10.6'], 20, 0);
    expect(toCanonical(yen.width)).toBe('1');
    expect(toCanonical(yen.buckets[10]?.lower ?? d('0'))).toBe('10.4');
    expect(yen.buckets[10]?.count).toBe(1);
  });

  it('BHD (3 decimals) and a 4-decimal currency round the width up to their own minor unit', () => {
    // [0, 1], K = 3: 1000 / 3 -> ceil 334 -> 0.334; 10000 / 3 -> ceil 3334 -> 0.3334.
    // BHD position 0.95 / 0.334 = 2.8443113772... -> 2.844311.
    const bhd = plain(run(['0', '1'], 3, currencyMinorUnits('BHD')));
    expect(bhd).toMatchObject({
      width: '0.334',
      buckets: [
        ['0', '0.334', ')', 1],
        ['0.334', '0.668', ')', 0],
        ['0.668', '1.002', ']', 1],
      ],
      varBucket: 2,
      position: '2.844311',
    });
    expect(toCanonical(run(['0', '1'], 3, 4).width)).toBe('0.3334');
  });
});

describe('explicit errors: never bars for an empty or unusable distribution', () => {
  it('no scenarios -> NO_SCENARIOS; one scenario -> INSUFFICIENT_SCENARIOS', () => {
    expect(errorOf([], {})).toBe('NO_SCENARIOS');
    expect(errorOf(['5'], {})).toBe('INSUFFICIENT_SCENARIOS');
  });

  it('rejects an invalid bucket count, minor units, or confidence', () => {
    expect(errorOf(['1', '2'], { k: 0 })).toBe('INVALID_INPUT');
    expect(errorOf(['1', '2'], { k: 1.5 })).toBe('INVALID_INPUT');
    expect(errorOf(['1', '2'], { m: 5 })).toBe('INVALID_INPUT');
    expect(errorOf(['1', '2'], { m: -1 })).toBe('INVALID_INPUT');
    expect(errorOf(['1', '2'], { p: '1' })).toBe('INVALID_INPUT');
    expect(errorOf(['1', '2'], { p: '0' })).toBe('INVALID_INPUT');
  });
});
