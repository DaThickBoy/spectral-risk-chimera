// Task 9.2: SeriesCleaner (ProviderSeries -> sorted, cleaned PriceSeries) and the weekends-only
// TradingCalendar. AT-MD-03, AT-MD-04, AT-MD-05, AT-MD-06 (cleaner part), AT-MD-14.
// Validates: Requirements 12.5, 12.8
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FixtureMarketDataProvider,
  createSeriesCleaner,
  utcWeekday,
  weekendsOnlyCalendar,
} from '../../../src/marketdata/index.js';
import type { CleanResult, ProviderObservation, ProviderSeries } from '../../../src/marketdata/index.js';
import { FakeClock, brandDecimalString } from '../../../src/shared/index.js';

const cleaner = createSeriesCleaner(weekendsOnlyCalendar);

// 2026-11-02 is a Monday; 2026-11-07 and 2026-11-08 are a weekend.
const MON = '2026-11-02';
const TUE = '2026-11-03';
const WED = '2026-11-04';
const THU = '2026-11-05';
const FRI = '2026-11-06';
const SAT = '2026-11-07';
const SUN = '2026-11-08';

const ok = (date: string, text: string): ProviderObservation => ({
  date,
  adjustedClose: brandDecimalString(text),
});
const missing = (date: string): ProviderObservation => ({ date, adjustedClose: null, defect: 'MISSING' });
const nonFinite = (date: string, marker: 'NaN' | 'Infinity' | '-Infinity' = 'NaN'): ProviderObservation => ({
  date,
  adjustedClose: null,
  defect: 'NOT_FINITE',
  nonFinite: marker,
});

const raw = (
  observations: ProviderObservation[],
  overrides: Partial<ProviderSeries> = {},
): ProviderSeries => ({
  ticker: 'ACME',
  currency: 'USD',
  source: 'fixture-md',
  sourceKind: 'DEMO',
  retrievedAt: '2026-11-08T09:30:00.000Z',
  observations,
  contentHash: 'provider-level-hash',
  ...overrides,
});

const ZERO = {
  missing: 0,
  nonFinite: 0,
  nonPositive: 0,
  nonTradingDate: 0,
  duplicateCollapsed: 0,
  conflicting: 0,
};

/** The count-balance invariant, checked on every result. */
function expectBalanced(input: ProviderSeries, result: CleanResult): void {
  const c = result.discarded;
  expect(
    result.series.observations.length +
      c.missing +
      c.nonFinite +
      c.nonPositive +
      c.nonTradingDate +
      c.duplicateCollapsed +
      c.conflicting,
  ).toBe(input.observations.length);
}

const clean = (input: ProviderSeries): CleanResult => {
  const result = cleaner.clean(input);
  expectBalanced(input, result);
  return result;
};

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('weekends-only TradingCalendar (UTC weekday, no holidays)', () => {
  it.each([
    [SAT, 6, false],
    [SUN, 0, false],
    [MON, 1, true],
    [FRI, 5, true],
    ['2000-02-29', 2, true],
    ['1900-03-01', 4, true],
    ['2024-01-01', 1, true],
    ['2026-12-25', 5, true], // a holiday is still a trading day here (OD-3, task 9.5)
  ])('%s is weekday %i (trading: %s)', (date, weekday, trading) => {
    expect(utcWeekday(date)).toBe(weekday);
    expect(weekendsOnlyCalendar.isTradingDay(date)).toBe(trading);
  });

  it('matches the UTC weekday of every date from 1999 to 2031', () => {
    for (let t = Date.UTC(1999, 0, 1); t <= Date.UTC(2031, 11, 31); t += 86_400_000) {
      const date = new Date(t).toISOString().slice(0, 10);
      expect(utcWeekday(date), date).toBe(new Date(t).getUTCDay());
    }
  });

  it.each(['2026-02-30', '2026-11-07T00:00:00Z', '', 'x'])('rejects an invalid date %j', (date) => {
    expect(() => weekendsOnlyCalendar.isTradingDay(date)).toThrow(TypeError);
  });
});

describe('AT-MD-03, AT-MD-04, AT-MD-14: defects are discarded, counted, and never filled', () => {
  it('AT-MD-03: a missing adjusted close removes that date; nothing is filled', () => {
    const result = clean(raw([ok(MON, '100'), missing(TUE), ok(WED, '102')]));
    expect(result.series.observations).toEqual([ok(MON, '100'), ok(WED, '102')]);
    expect(result.discarded).toEqual({ ...ZERO, missing: 1 });
  });

  it.each([
    ['zero', '0'],
    ['negative zero', '-0'],
    ['zero with fraction digits', '0.000'],
    ['a negative price', '-3.5'],
  ])('AT-MD-04: a %s price is discarded as nonPositive', (_label, text) => {
    const result = clean(raw([ok(MON, '100'), ok(TUE, text)]));
    expect(result.series.observations).toEqual([ok(MON, '100')]);
    expect(result.discarded).toEqual({ ...ZERO, nonPositive: 1 });
  });

  it.each(['NaN', 'Infinity', '-Infinity'] as const)(
    'AT-MD-04: a %s price is discarded as nonFinite',
    (marker) => {
      const result = clean(raw([ok(MON, '100'), nonFinite(TUE, marker)]));
      expect(result.series.observations).toEqual([ok(MON, '100')]);
      expect(result.discarded).toEqual({ ...ZERO, nonFinite: 1 });
    },
  );

  it('AT-MD-14: weekend observations are discarded as nonTradingDate', () => {
    const result = clean(raw([ok(FRI, '100'), ok(SAT, '101'), ok(SUN, '102'), ok('2026-11-09', '103')]));
    expect(result.series.observations).toEqual([ok(FRI, '100'), ok('2026-11-09', '103')]);
    expect(result.discarded).toEqual({ ...ZERO, nonTradingDate: 2 });
  });

  it('a very small positive price is valid (Decimal comparison, no float rounding)', () => {
    const tiny = '0.0000000000000000000000000000000000000001';
    expect(clean(raw([ok(MON, tiny)])).series.observations).toEqual([ok(MON, tiny)]);
  });
});

describe('each defect is classified exactly once, in priority order', () => {
  it.each([
    ['missing on a Saturday', 'missing', missing(SAT)],
    ['non-finite on a Sunday', 'nonFinite', nonFinite(SUN, 'Infinity')],
    ['zero on a Saturday', 'nonPositive', ok(SAT, '0')],
    ['negative on a Sunday', 'nonPositive', ok(SUN, '-1')],
    ['valid price on a Saturday', 'nonTradingDate', ok(SAT, '100')],
  ] as const)('%s counts only as %s', (_label, bucket, observation) => {
    const result = clean(raw([observation]));
    expect(result.series.observations).toEqual([]);
    expect(result.discarded).toEqual({ ...ZERO, [bucket]: 1 });
  });

  it('exact counts for a mixed series', () => {
    const result = clean(
      raw([
        ok(MON, '100'),
        missing(TUE),
        missing(SAT),
        nonFinite(WED),
        nonFinite(SUN, '-Infinity'),
        ok(THU, '0'),
        ok(SAT, '-2'),
        ok(SAT, '99'),
        ok(SUN, '98'),
        ok(FRI, '105'),
        ok(FRI, '105.000'),
        ok(TUE, '101'),
        ok(TUE, '102'),
      ]),
    );
    expect(result.discarded).toEqual({
      missing: 2,
      nonFinite: 2,
      nonPositive: 2,
      nonTradingDate: 2,
      duplicateCollapsed: 1,
      conflicting: 2,
    });
    expect(result.series.observations).toEqual([ok(MON, '100'), ok(FRI, '105')]);
    expect(result.conflict).toBe(true);
    expect(result.conflictDates).toEqual([TUE]);
  });
});

describe('invalid observations are discarded before duplicate detection', () => {
  it.each([
    ['a missing value', missing(TUE)],
    ['a non-finite value', nonFinite(TUE)],
    ['a zero price', ok(TUE, '0')],
    ['a negative price', ok(TUE, '-101')],
  ])('a date with one valid price and %s is not a duplicate or a conflict', (_label, defect) => {
    for (const order of [
      [ok(TUE, '101'), defect],
      [defect, ok(TUE, '101')],
    ]) {
      const result = clean(raw(order));
      expect(result.series.observations).toEqual([ok(TUE, '101')]);
      expect(result.conflict).toBe(false);
      expect(result.discarded.duplicateCollapsed).toBe(0);
      expect(result.discarded.conflicting).toBe(0);
    }
  });

  it('weekend duplicates are discarded as nonTradingDate, never compared', () => {
    const result = clean(raw([ok(SAT, '1'), ok(SAT, '2')]));
    expect(result.conflict).toBe(false);
    expect(result.discarded).toEqual({ ...ZERO, nonTradingDate: 2 });
  });
});

describe('AT-MD-05: identical duplicates collapse to the first-received observation', () => {
  it('numerically identical prices with different text keep the first text unchanged', () => {
    const result = clean(raw([ok(MON, '100'), ok(MON, '100.0'), ok(MON, '100.00')]));
    expect(result.series.observations).toEqual([ok(MON, '100')]);
    expect(result.discarded).toEqual({ ...ZERO, duplicateCollapsed: 2 });
    expect(result.conflict).toBe(false);

    const reversed = clean(raw([ok(MON, '100.00'), ok(MON, '100.0'), ok(MON, '100')]));
    expect(reversed.series.observations).toEqual([ok(MON, '100.00')]);
  });

  it('kept text is not canonicalized', () => {
    expect(clean(raw([ok(MON, '101.2500')])).series.observations).toEqual([ok(MON, '101.2500')]);
  });

  it('duplicates that are not adjacent still collapse', () => {
    const result = clean(raw([ok(MON, '5'), ok(TUE, '6'), ok(MON, '5.0')]));
    expect(result.series.observations).toEqual([ok(MON, '5'), ok(TUE, '6')]);
    expect(result.discarded.duplicateCollapsed).toBe(1);
  });
});

describe('AT-MD-06 (cleaner part): conflicting duplicates invalidate the series', () => {
  it('two conflicting prices exclude both observations and set conflict', () => {
    const result = clean(raw([ok(MON, '100'), ok(TUE, '101'), ok(TUE, '101.01')]));
    expect(result.conflict).toBe(true);
    expect(result.conflictDates).toEqual([TUE]);
    expect(result.discarded).toEqual({ ...ZERO, conflicting: 2 });
    // The non-conflicting date stays, for identification only; the series as a whole is invalid.
    expect(result.series.observations).toEqual([ok(MON, '100')]);
  });

  it('a group of three with one differing price excludes all three (none is chosen)', () => {
    const result = clean(raw([ok(TUE, '101'), ok(TUE, '101.0'), ok(TUE, '102')]));
    expect(result.series.observations).toEqual([]);
    expect(result.discarded).toEqual({ ...ZERO, conflicting: 3 });
    expect(result.conflictDates).toEqual([TUE]);
  });

  it('a group of four with several distinct prices counts every observation', () => {
    const result = clean(raw([ok(WED, '1'), ok(WED, '2'), ok(WED, '3'), ok(WED, '1')]));
    expect(result.discarded.conflicting).toBe(4);
    expect(result.discarded.duplicateCollapsed).toBe(0);
  });

  it('several conflicting dates are listed sorted and unique', () => {
    const result = clean(
      raw([
        ok(THU, '1'),
        ok(THU, '2'),
        ok(MON, '5'),
        ok(MON, '6'),
        ok(MON, '7'),
        ok(WED, '9'),
        ok(TUE, '3'),
        ok(TUE, '4'),
      ]),
    );
    expect(result.conflictDates).toEqual([MON, TUE, THU]);
    expect(result.series.observations).toEqual([ok(WED, '9')]);
    expect(result.discarded).toEqual({ ...ZERO, conflicting: 7 });
  });

  it('without conflicts, conflict is false and conflictDates is empty', () => {
    const result = clean(raw([ok(MON, '1'), ok(MON, '1.0')]));
    expect(result.conflict).toBe(false);
    expect(result.conflictDates).toEqual([]);
  });
});

describe('ordering, provenance, and the content hash', () => {
  it('kept observations are sorted ascending by date', () => {
    const result = clean(raw([ok(FRI, '5'), ok(MON, '1'), ok(WED, '3'), ok(TUE, '2'), ok(THU, '4')]));
    expect(result.series.observations.map((o) => o.date)).toEqual([MON, TUE, WED, THU, FRI]);
  });

  it.each(['REAL', 'DEMO'] as const)(
    'copies source, sourceKind (%s), and retrievedAt; assigns no status',
    (kind) => {
      const result = clean(
        raw([ok(MON, '1')], {
          source: 'vendor-x',
          sourceKind: kind,
          retrievedAt: '2026-01-02T03:04:05.006Z',
        }),
      );
      expect(result.series).toEqual({
        ticker: 'ACME',
        currency: 'USD',
        source: 'vendor-x',
        sourceKind: kind,
        retrievedAt: '2026-01-02T03:04:05.006Z',
        observations: [ok(MON, '1')],
        contentHash: result.series.contentHash,
      });
      expect(result.series).not.toHaveProperty('status');
    },
  );

  it('the hash is SHA-256 of the canonical cleaned, sorted series (hand-written canonical text)', () => {
    const result = clean(raw([ok(TUE, '101.50'), ok(SAT, '9'), ok(MON, '100'), missing(WED)]));
    expect(result.series.contentHash).toBe(
      sha(
        '{"currency":"USD","observations":[{"adjustedClose":"100","date":"2026-11-02"},{"adjustedClose":"101.50","date":"2026-11-03"}],"ticker":"ACME"}',
      ),
    );
    expect(result.series.contentHash).not.toBe('provider-level-hash');
  });

  it('the hash excludes provenance, discard counts, and conflict metadata', () => {
    const base = clean(raw([ok(MON, '100')]));
    const otherProvenance = clean(
      raw([ok(MON, '100')], { source: 'other', sourceKind: 'REAL', retrievedAt: '2030-01-01T00:00:00.000Z' }),
    );
    const withDiscards = clean(raw([missing(TUE), ok(MON, '100'), ok(SAT, '1'), ok(MON, '100.0')]));
    const withConflict = clean(raw([ok(MON, '100'), ok(WED, '1'), ok(WED, '2')]));
    expect(otherProvenance.series.contentHash).toBe(base.series.contentHash);
    expect(withDiscards.series.contentHash).toBe(base.series.contentHash);
    expect(withConflict.series.contentHash).toBe(base.series.contentHash);
    expect(withConflict.conflict).toBe(true);
  });

  it('an empty series cleans to an empty, balanced result', () => {
    const result = clean(raw([]));
    expect(result.series.observations).toEqual([]);
    expect(result.discarded).toEqual(ZERO);
    expect(result.series.contentHash).toBe(sha('{"currency":"USD","observations":[],"ticker":"ACME"}'));
  });
});

describe('purity', () => {
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    }
    return value;
  };

  it('never modifies the input (deep-frozen input, unchanged afterwards)', () => {
    const input = raw([ok(TUE, '2'), ok(MON, '1'), ok(MON, '1.0'), missing(WED), ok(THU, '3'), ok(THU, '4')]);
    const snapshot = structuredClone(input);
    deepFreeze(input);
    expect(() => clean(input)).not.toThrow();
    expect(input).toEqual(snapshot);
  });

  it('returns a frozen result', () => {
    const result = clean(raw([ok(MON, '1')]));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.series)).toBe(true);
    expect(Object.isFrozen(result.series.observations)).toBe(true);
    expect(Object.isFrozen(result.series.observations[0])).toBe(true);
    expect(Object.isFrozen(result.discarded)).toBe(true);
    expect(Object.isFrozen(result.conflictDates)).toBe(true);
  });

  it('cleans a ProviderSeries produced by the 9.1 fixture provider unchanged in 9.1 behaviour', async () => {
    const provider = new FixtureMarketDataProvider({
      name: 'fixture-md',
      clock: new FakeClock('2026-11-08T09:30:00.000Z'),
      fixtures: {
        series: {
          ACME: {
            ticker: 'ACME',
            currency: 'USD',
            observations: [
              { date: TUE, adjustedClose: '101' },
              { date: MON, adjustedClose: '100' },
              { date: SAT, adjustedClose: '99' },
              { date: WED, adjustedClose: null },
              { date: THU, adjustedClose: 'NaN' },
            ],
          },
        },
      },
    });
    const fetched = await provider.getDailySeries('ACME', { from: '2026-11-01', to: '2026-11-30' });
    if (!fetched.ok) {
      throw new Error('fixture must load');
    }
    const result = clean(fetched.value);
    expect(fetched.value.observations).toHaveLength(5);
    expect(result.series.observations).toEqual([ok(MON, '100'), ok(TUE, '101')]);
    expect(result.series.sourceKind).toBe('DEMO');
    expect(result.discarded).toEqual({ ...ZERO, missing: 1, nonFinite: 1, nonTradingDate: 1 });
  });
});
