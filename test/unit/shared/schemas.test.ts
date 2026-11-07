// AT-DEC-07 (schema part) and the shared Zod primitives and score schemas (task 2.6).
// Validates: Requirements 4.6, 21.1, 21.2, 21.3
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DecimalStringSchema,
  FilingRiskScoreSchema,
  Iso4217Code,
  IsoDate,
  IsoTimestamp,
  PositiveDecimalString,
  SentimentIndexSchema,
  SignedUnitDecimalString,
  UnitIntervalDecimalString,
} from '../../../src/shared/index.js';
import type { DecimalString, FilingRiskScore, SentimentIndex } from '../../../src/shared/index.js';

describe('DecimalStringSchema', () => {
  it('accepts decimal text unchanged', () => {
    for (const value of ['0', '-0', '1.500', '-12.5', '1000000']) {
      expect(DecimalStringSchema.parse(value)).toBe(value);
    }
  });

  it.each([
    0.1,
    1,
    Number.NaN,
    'NaN',
    'Infinity',
    '1e-5',
    '2E3',
    '',
    '1,000',
    '.5',
    '01',
    null,
    undefined,
    {},
  ])('rejects %j (JSON numbers, non-finite text, exponent notation)', (value) => {
    expect(DecimalStringSchema.safeParse(value).success).toBe(false);
  });
});

describe('PositiveDecimalString', () => {
  it('requires a value greater than zero', () => {
    expect(PositiveDecimalString.safeParse('0.0001').success).toBe(true);
    expect(PositiveDecimalString.safeParse('0').success).toBe(false);
    expect(PositiveDecimalString.safeParse('-1').success).toBe(false);
  });
});

describe('score ranges (no clamping)', () => {
  it('UnitIntervalDecimalString accepts [0, 1] and rejects values outside', () => {
    for (const value of ['0', '0.5', '1', '1.000']) {
      expect(UnitIntervalDecimalString.parse(value)).toBe(value);
    }
    for (const value of ['-0.0001', '1.0001', '2', 'NaN', '1e0']) {
      expect(UnitIntervalDecimalString.safeParse(value).success).toBe(false);
    }
  });

  it('SignedUnitDecimalString accepts [-1, 1] and rejects values outside', () => {
    for (const value of ['-1', '-0.60', '-0.6001', '0', '1']) {
      expect(SignedUnitDecimalString.parse(value)).toBe(value);
    }
    for (const value of ['-1.0001', '1.01', '-2', 'Infinity']) {
      expect(SignedUnitDecimalString.safeParse(value).success).toBe(false);
    }
  });

  it('FilingRiskScore and SentimentIndex use their own ranges', () => {
    expect(FilingRiskScoreSchema.safeParse('-0.5').success).toBe(false);
    expect(SentimentIndexSchema.safeParse('-0.5').success).toBe(true);
    expect(FilingRiskScoreSchema.parse('0.85')).toBe('0.85');
  });
});

describe('SentimentIndex and FilingRiskScore are distinct types (R11)', () => {
  it('are not assignable to each other', () => {
    const sentiment = SentimentIndexSchema.parse('-0.75');
    const filing = FilingRiskScoreSchema.parse('0.9');
    expectTypeOf(sentiment).toEqualTypeOf<SentimentIndex>();
    expectTypeOf(filing).toEqualTypeOf<FilingRiskScore>();
    expectTypeOf<SentimentIndex>().not.toEqualTypeOf<FilingRiskScore>();
    expectTypeOf<SentimentIndex>().toExtend<DecimalString>();

    const takesFiling = (score: FilingRiskScore): FilingRiskScore => score;
    const takesSentiment = (index: SentimentIndex): SentimentIndex => index;
    // @ts-expect-error A SentimentIndex is not a FilingRiskScore.
    takesFiling(sentiment);
    // @ts-expect-error A FilingRiskScore is not a SentimentIndex.
    takesSentiment(filing);
    // @ts-expect-error A plain string is neither score type.
    takesFiling('0.5');
    expect(takesFiling(filing)).toBe('0.9');
  });
});

describe('dates, timestamps, and currencies', () => {
  it('IsoDate accepts real calendar dates only', () => {
    expect(IsoDate.safeParse('2026-11-06').success).toBe(true);
    expect(IsoDate.safeParse('2024-02-29').success).toBe(true);
    expect(IsoDate.safeParse('2026-02-29').success).toBe(false);
    expect(IsoDate.safeParse('2026-13-01').success).toBe(false);
    expect(IsoDate.safeParse('2026-1-6').success).toBe(false);
  });

  it('IsoTimestamp requires an explicit offset', () => {
    expect(IsoTimestamp.safeParse('2026-11-06T10:00:00.000Z').success).toBe(true);
    expect(IsoTimestamp.safeParse('2026-11-06T10:00:00+02:00').success).toBe(true);
    expect(IsoTimestamp.safeParse('2026-11-06T10:00:00').success).toBe(false);
  });

  it('Iso4217Code accepts known codes only', () => {
    for (const code of ['USD', 'EUR', 'JPY', 'GBP']) {
      expect(Iso4217Code.safeParse(code).success).toBe(true);
    }
    for (const code of ['usd', 'US', 'USDD', 'ZZZ']) {
      expect(Iso4217Code.safeParse(code).success).toBe(false);
    }
  });
});
