// Task 9.3: ReturnsBuilder over CleanResult[] (FR-2, FR-3.3 to FR-3.8). AT-MD-01, AT-MD-02,
// AT-MD-03, AT-MD-06 (builder part), AT-MD-07, AT-MD-08, AT-MD-09, AT-MD-10, AT-MD-11, AT-MD-12,
// AT-VAR-08 to AT-VAR-12 (status and window; the quantile h values are task 12.2).
// Validates: Requirements 12.4, 12.8, 13.1, 13.2, 13.3, 13.6, 14.4
import { describe, expect, it } from 'vitest';
import {
  createReturnsBuilder,
  createSeriesCleaner,
  weekendsOnlyCalendar,
} from '../../../src/marketdata/index.js';
import type { CleanResult, ProviderObservation, ReturnsOptions } from '../../../src/marketdata/index.js';
import { brandDecimalString } from '../../../src/shared/index.js';

const builder = createReturnsBuilder();
const cleaner = createSeriesCleaner(weekendsOnlyCalendar);
const BASELINE: ReturnsOptions = { lookbackReturns: 250, minObservations: 200, maxReturnGapDays: 5 };
const SMALL: ReturnsOptions = { lookbackReturns: 4, minObservations: 2, maxReturnGapDays: 5 };

/** `count` consecutive weekdays starting at `start` (a weekday), as YYYY-MM-DD. */
function weekdays(start: string, count: number): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00.000Z`); out.length < count; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
  }
  return out;
}

type Cell = [date: string, price: string | null];

/** A CleanResult produced by the real 9.2 cleaner. */
function cleaned(ticker: string, cells: readonly Cell[]): CleanResult {
  const observations: ProviderObservation[] = cells.map(([date, price]) =>
    price === null
      ? { date, adjustedClose: null, defect: 'MISSING' }
      : { date, adjustedClose: brandDecimalString(price) },
  );
  return cleaner.clean({
    ticker,
    currency: 'USD',
    source: 'test',
    sourceKind: 'DEMO',
    retrievedAt: '2026-11-08T00:00:00.000Z',
    observations,
    contentHash: 'provider',
  });
}

/** A series with one price per date: 100, 101, 102, ... */
const ladder = (ticker: string, dates: readonly string[]): CleanResult =>
  cleaned(
    ticker,
    dates.map((date, i): Cell => [date, String(100 + i)]),
  );

const okValue = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) {
    throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
};

// Mon 2026-11-02 ... Fri 2026-11-06; Mon 2026-11-09 ...
const MON = '2026-11-02';
const TUE = '2026-11-03';
const WED = '2026-11-04';
const THU = '2026-11-05';
const FRI = '2026-11-06';
const NEXT_MON = '2026-11-09';

describe('AT-MD-01 and AT-MD-02: Decimal simple returns', () => {
  it('AT-MD-01: 251 adjusted closes produce exactly 250 returns', () => {
    const dates = weekdays(MON, 251);
    const matrix = okValue(builder.build([ladder('ACME', dates)], BASELINE));
    expect(matrix.n).toBe(250);
    expect(matrix.dates).toEqual(dates.slice(1));
    expect(matrix.returns['ACME']).toHaveLength(250);
    expect(matrix.status).toBe('COMPLETE');
  });

  it('AT-MD-02: P[t]/P[t-1]-1 is exact for hand-calculated values, in canonical form', () => {
    const matrix = okValue(
      builder.build(
        [
          cleaned('ACME', [
            [MON, '100'],
            [TUE, '110'],
            [WED, '99'],
            [THU, '99.00'],
            [FRI, '148.5'],
          ]),
        ],
        SMALL,
      ),
    );
    // 110/100-1 = 0.1; 99/110-1 = -0.1; 99/99-1 = 0; 148.5/99-1 = 0.5
    expect(matrix.returns['ACME']).toEqual(['0.1', '-0.1', '0', '0.5']);
  });

  it('a non-terminating quotient is rounded once to 40 significant digits (ROUND_HALF_UP)', () => {
    const matrix = okValue(
      builder.build(
        [
          cleaned('ACME', [
            [MON, '3'],
            [TUE, '1'],
            [WED, '2'],
          ]),
        ],
        SMALL,
      ),
    );
    // 1/3 = 0.3333333333333333333333333333333333333333 (40 digits), minus 1; 2/1 - 1 = 1.
    expect(matrix.returns['ACME']).toEqual(['-0.6666666666666666666666666666666666666667', '1']);
  });
});

describe('AT-MD-03, AT-MD-07, AT-MD-08, AT-MD-09: common dates only, no fill', () => {
  it('AT-MD-07: misaligned dates use the intersection only', () => {
    const a = ladder('AAA', [MON, TUE, WED, THU]);
    const b = ladder('BBB', [TUE, WED, THU, FRI]);
    const matrix = okValue(builder.build([a, b], SMALL));
    expect(matrix.dates).toEqual([WED, THU]);
    // AAA: 102/101-1, 103/102-1; BBB: 101/100-1, 102/101-1
    // Hand-derived: the quotient has 40 significant digits (including its leading 1), e.g.
    // 102/101 = 1.009900990099009900990099009900990099010 (rounded up), then minus 1 exactly.
    expect(matrix.returns).toEqual({
      AAA: ['0.00990099009900990099009900990099009901', '0.009803921568627450980392156862745098039'],
      BBB: ['0.01', '0.00990099009900990099009900990099009901'],
    });
    expect(matrix.asOfDate).toBe(THU);
  });

  it('AT-MD-03 and AT-MD-08: a missing price in one asset removes that date for every asset (no fill)', () => {
    const a = cleaned('AAA', [
      [MON, '100'],
      [TUE, null],
      [WED, '102'],
      [THU, '103'],
    ]);
    const b = cleaned('BBB', [
      [MON, '50'],
      [TUE, '51'],
      [WED, '52'],
      [THU, '53'],
    ]);
    const matrix = okValue(builder.build([a, b], SMALL));
    expect(matrix.dates).toEqual([WED, THU]);
    // The Mon->Wed return of BBB spans Tuesday, which BBB observed: 52/50-1 = 0.04, never 51 or a filled value.
    // 53/52 = 1.019230769230769230769230769230769230769 (40 significant digits), minus 1.
    expect(matrix.returns['BBB']).toEqual(['0.04', '0.019230769230769230769230769230769230769']);
    expect(matrix.returns['AAA']).toEqual(['0.02', '0.009803921568627450980392156862745098039']);
    expect(matrix.multiDayReturnCount).toBe(1);
  });

  it('AT-MD-09: every output return comes from two real observations on consecutive common dates', () => {
    const prices: Record<string, string> = { [MON]: '20', [TUE]: '25', [WED]: '20', [THU]: '40' };
    const matrix = okValue(builder.build([cleaned('ACME', Object.entries(prices) as Cell[])], SMALL));
    expect(matrix.returns['ACME']).toEqual(['0.25', '-0.2', '1']);
    expect(matrix.dates.every((date) => date in prices)).toBe(true);
  });
});

describe('AT-MD-10 and AT-MD-11: as-of date and the gap rule', () => {
  it('AT-MD-10: the as-of date is the last common valid trading date', () => {
    const a = ladder('AAA', [MON, TUE, WED, THU, FRI]);
    const b = ladder('BBB', [MON, TUE, WED, THU]);
    expect(okValue(builder.build([a, b], SMALL)).asOfDate).toBe(THU);
  });

  it('a gap equal to maxReturnGapDays keeps the return; one day more discards it', () => {
    const series = ladder('ACME', [THU, FRI, NEXT_MON]); // Fri -> Mon is 3 calendar days
    const kept = okValue(builder.build([series], { ...SMALL, maxReturnGapDays: 3 }));
    expect(kept.dates).toEqual([FRI, NEXT_MON]);
    const below = builder.build([series], { ...SMALL, maxReturnGapDays: 2, minObservations: 2 });
    // Only Thu -> Fri remains: 1 return, below the minimum of 2.
    expect(below.ok).toBe(false);
    expect(!below.ok && below.error).toEqual({
      code: 'INSUFFICIENT_DATA',
      message: 'Market data insufficient (INSUFFICIENT_DATA).',
      observations: 1,
      required: 2,
      limitingTicker: 'ACME',
    });
  });

  it('AT-MD-11: a discarded gap return is never interpolated and does not count towards sufficiency', () => {
    const dates = [MON, TUE, WED, '2026-11-16', '2026-11-17', '2026-11-18']; // Wed -> next-next Mon: 12 days
    const matrix = okValue(builder.build([ladder('ACME', dates)], { ...SMALL, maxReturnGapDays: 5 }));
    expect(matrix.dates).toEqual([TUE, WED, '2026-11-17', '2026-11-18']);
    expect(matrix.n).toBe(4);
    expect(matrix.status).toBe('COMPLETE');
  });

  it('asOfDate stays the latest common date even when its own return was discarded', () => {
    const matrix = okValue(builder.build([ladder('ACME', [MON, TUE, WED, '2026-11-30'])], SMALL));
    expect(matrix.asOfDate).toBe('2026-11-30');
    expect(matrix.dates).toEqual([TUE, WED]);
  });
});

describe('AT-MD-12: the limiting ticker', () => {
  it('is the asset whose cleaned series starts latest', () => {
    const a = ladder('AAA', [MON, TUE, WED, THU, FRI]);
    const b = ladder('BBB', [WED, THU, FRI]);
    const c = ladder('CCC', [TUE, WED, THU, FRI]);
    expect(okValue(builder.build([a, b, c], SMALL)).limitingTicker).toBe('BBB');
  });

  it('ties on the first date go to fewer cleaned observations', () => {
    const a = ladder('AAA', [TUE, WED, THU, FRI]);
    const b = ladder('BBB', [TUE, WED, THU]);
    expect(okValue(builder.build([a, b], SMALL)).limitingTicker).toBe('BBB');
  });

  it('a full tie goes to the lexicographically smaller ticker, whatever the input order', () => {
    const z = ladder('ZZZ', [MON, TUE, WED]);
    const a = ladder('AAA', [MON, TUE, WED]);
    expect(okValue(builder.build([z, a], SMALL)).limitingTicker).toBe('AAA');
    expect(okValue(builder.build([a, z], SMALL)).limitingTicker).toBe('AAA');
  });

  it('applies the same rule with zero or one common dates (INSUFFICIENT_DATA)', () => {
    const none = builder.build([ladder('AAA', [MON, TUE]), ladder('BBB', [WED, THU, FRI])], SMALL);
    expect(!none.ok && none.error).toMatchObject({
      code: 'INSUFFICIENT_DATA',
      observations: 0,
      limitingTicker: 'BBB',
    });
    const one = builder.build([ladder('AAA', [MON, TUE]), ladder('BBB', [TUE, WED])], SMALL);
    expect(!one.ok && one.error).toMatchObject({
      code: 'INSUFFICIENT_DATA',
      observations: 0,
      limitingTicker: 'BBB',
    });
  });

  it('an asset with no cleaned observations has no history and is the limiting asset', () => {
    const empty = cleaned('ZZZ', [[MON, null]]);
    const result = builder.build([ladder('AAA', [MON, TUE, WED]), empty], SMALL);
    expect(!result.ok && result.error).toMatchObject({
      code: 'INSUFFICIENT_DATA',
      observations: 0,
      limitingTicker: 'ZZZ',
    });
  });
});

describe('AT-VAR-08 to AT-VAR-12: sufficiency and the lookback window (baseline 200 / 250)', () => {
  const withReturns = (count: number) => builder.build([ladder('ACME', weekdays(MON, count + 1))], BASELINE);

  it('AT-VAR-08: 199 returns give INSUFFICIENT_DATA with the count and no returns', () => {
    const result = withReturns(199);
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'INSUFFICIENT_DATA',
        message: 'Market data insufficient (INSUFFICIENT_DATA).',
        observations: 199,
        required: 200,
        limitingTicker: 'ACME',
      },
    });
  });

  it.each([
    [200, 'REDUCED_LOOKBACK', 200],
    [249, 'REDUCED_LOOKBACK', 249],
    [250, 'COMPLETE', 250],
    [300, 'COMPLETE', 250],
  ] as const)('%i returns give %s with n = %i', (count, status, n) => {
    const matrix = okValue(withReturns(count));
    expect(matrix.status).toBe(status);
    expect(matrix.n).toBe(n);
  });

  it('AT-VAR-12: more than 250 returns uses only the newest 250', () => {
    const dates = weekdays(MON, 301);
    const matrix = okValue(builder.build([ladder('ACME', dates)], BASELINE));
    expect(matrix.dates).toEqual(dates.slice(-250));
    expect(matrix.asOfDate).toBe(dates[300]);
  });

  it('the thresholds follow the configured values, not fixed numbers', () => {
    const series = ladder('ACME', weekdays(MON, 6)); // 5 returns
    expect(
      okValue(builder.build([series], { lookbackReturns: 5, minObservations: 5, maxReturnGapDays: 5 }))
        .status,
    ).toBe('COMPLETE');
    expect(
      okValue(builder.build([series], { lookbackReturns: 6, minObservations: 5, maxReturnGapDays: 5 }))
        .status,
    ).toBe('REDUCED_LOOKBACK');
    expect(builder.build([series], { lookbackReturns: 6, minObservations: 6, maxReturnGapDays: 5 }).ok).toBe(
      false,
    );
  });
});

describe('DATA_CONFLICT (AT-MD-06, builder part): first, sorted, and no partial returns', () => {
  const conflicting = (ticker: string): CleanResult =>
    cleaned(ticker, [
      [MON, '100'],
      [TUE, '101'],
      [TUE, '102'],
      [WED, '103'],
    ]);

  it('one conflicting asset gives DATA_CONFLICT and no returns for any asset', () => {
    const result = builder.build([ladder('AAA', [MON, TUE, WED, THU]), conflicting('BBB')], SMALL);
    expect(result).toEqual({
      ok: false,
      error: { code: 'DATA_CONFLICT', message: 'Market data conflict (DATA_CONFLICT).', tickers: ['BBB'] },
    });
  });

  it('every conflicting ticker is listed, sorted', () => {
    const result = builder.build(
      [conflicting('ZZZ'), ladder('MMM', [MON, TUE, WED]), conflicting('AAA')],
      SMALL,
    );
    expect(!result.ok && result.error).toMatchObject({ code: 'DATA_CONFLICT', tickers: ['AAA', 'ZZZ'] });
  });

  it('takes precedence over INSUFFICIENT_DATA', () => {
    const result = builder.build([conflicting('AAA')], BASELINE);
    expect(!result.ok && result.error.code).toBe('DATA_CONFLICT');
  });
});

describe('multiDayReturnCount', () => {
  it('counts kept returns where another asset has an observation strictly between the common dates', () => {
    const a = ladder('AAA', [MON, WED, FRI]);
    const b = ladder('BBB', [MON, TUE, WED, THU, FRI]);
    const matrix = okValue(builder.build([a, b], SMALL));
    expect(matrix.dates).toEqual([WED, FRI]);
    expect(matrix.multiDayReturnCount).toBe(2);
  });

  it('is zero when every asset observes the same dates', () => {
    const dates = [MON, TUE, WED];
    expect(
      okValue(builder.build([ladder('AAA', dates), ladder('BBB', dates)], SMALL)).multiDayReturnCount,
    ).toBe(0);
  });

  it('counts only returns inside the kept window, never discarded gap returns', () => {
    // BBB observes Tuesday, so AAA's Mon->Wed return is multi-day; it falls outside a window of 2.
    const a = ladder('AAA', [MON, WED, THU, FRI]);
    const b = ladder('BBB', [MON, TUE, WED, THU, FRI]);
    const windowed = okValue(
      builder.build([a, b], { lookbackReturns: 2, minObservations: 2, maxReturnGapDays: 5 }),
    );
    expect(windowed.dates).toEqual([THU, FRI]);
    expect(windowed.multiDayReturnCount).toBe(0);
    // A gap-discarded return never counts: Wed -> Mon over a gap of 5 with limit 4.
    const gap = okValue(
      builder.build([ladder('AAA', [MON, TUE, WED, NEXT_MON, '2026-11-10'])], {
        lookbackReturns: 4,
        minObservations: 2,
        maxReturnGapDays: 4,
      }),
    );
    expect(gap.dates).toEqual([TUE, WED, '2026-11-10']);
    expect(gap.multiDayReturnCount).toBe(0);
  });
});

describe('seriesHashes, immutability, and programmer errors', () => {
  it('maps each ticker to its cleaned contentHash', () => {
    const a = ladder('AAA', [MON, TUE, WED]);
    const b = ladder('BBB', [MON, TUE, WED]);
    expect(okValue(builder.build([a, b], SMALL)).seriesHashes).toEqual({
      AAA: a.series.contentHash,
      BBB: b.series.contentHash,
    });
  });

  it('does not modify its inputs and returns a frozen matrix', () => {
    const a = ladder('AAA', [MON, TUE, WED]);
    const snapshot = structuredClone(a);
    const matrix = okValue(builder.build([a], SMALL));
    expect(a).toEqual(snapshot);
    expect(Object.isFrozen(matrix)).toBe(true);
    expect(Object.isFrozen(matrix.dates)).toBe(true);
    expect(Object.isFrozen(matrix.returns)).toBe(true);
    expect(Object.isFrozen(matrix.returns['AAA'])).toBe(true);
    expect(Object.isFrozen(matrix.seriesHashes)).toBe(true);
  });

  it.each([
    ['an empty list', []],
    ['a non-array', 'x'],
  ])('%s of inputs throws TypeError', (_label, inputs) => {
    expect(() => builder.build(inputs as never, SMALL)).toThrow(TypeError);
  });

  it('duplicate tickers throw TypeError', () => {
    const a = ladder('AAA', [MON, TUE, WED]);
    expect(() => builder.build([a, ladder('AAA', [MON, TUE, WED])], SMALL)).toThrow(TypeError);
  });

  it.each([
    ['lookbackReturns 1', { ...SMALL, lookbackReturns: 1 }],
    ['minObservations 1', { ...SMALL, minObservations: 1 }],
    [
      'minObservations above lookbackReturns',
      { lookbackReturns: 3, minObservations: 4, maxReturnGapDays: 5 },
    ],
    ['maxReturnGapDays 0', { ...SMALL, maxReturnGapDays: 0 }],
    ['a fractional value', { ...SMALL, lookbackReturns: 2.5 }],
    ['a string value', { ...SMALL, maxReturnGapDays: '5' }],
    ['a missing option', { lookbackReturns: 4, minObservations: 2 }],
    ['null options', null],
  ])('%s throws TypeError', (_label, opts) => {
    expect(() => builder.build([ladder('AAA', [MON, TUE, WED])], opts as never)).toThrow(TypeError);
  });
});
