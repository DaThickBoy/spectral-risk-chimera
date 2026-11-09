// Task 9.2 reference-model property test for the SeriesCleaner (FR-3.1 to FR-3.3).
// Validates: Requirements 12.5, 12.8
// Traceability: AT-MD-03, AT-MD-04, AT-MD-05, AT-MD-06, AT-MD-14
// The reference model is independent of the implementation: positivity and price equality use
// BigInt fractions (not Decimal.js), weekdays use Date's UTC weekday (not the calendar's integer
// arithmetic), and duplicates are found by scanning all observations of each date.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createSeriesCleaner, weekendsOnlyCalendar } from '../../src/marketdata/index.js';
import type { ProviderObservation, ProviderSeries } from '../../src/marketdata/index.js';
import { brandDecimalString } from '../../src/shared/index.js';
import {
  compareFractions,
  decimalTextArb,
  equalFractions,
  fraction,
  parseDecimalText,
} from '../helpers/rational.js';

const ZERO = fraction(0n, 1n);

/** Dates 2026-11-01 (Sunday) to 2026-11-14, so weekends occur often. */
const dateArb = fc.integer({ min: 1, max: 14 }).map((day) => `2026-11-${String(day).padStart(2, '0')}`);

/** A small value pool so duplicates, equal-but-different text, and conflicts occur often. */
const valueArb = fc.oneof(
  fc.constantFrom('100', '100.0', '100.00', '101', '0', '-0', '0.000', '-5', '99.5', '99.50'),
  decimalTextArb(3, 3),
);

const observationArb: fc.Arbitrary<ProviderObservation> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .tuple(dateArb, valueArb)
      .map(([date, text]) => ({ date, adjustedClose: brandDecimalString(text) })),
  },
  {
    weight: 1,
    arbitrary: dateArb.map((date) => ({ date, adjustedClose: null, defect: 'MISSING' as const })),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(dateArb, fc.constantFrom('NaN' as const, 'Infinity' as const, '-Infinity' as const))
      .map(([date, nonFinite]) => ({ date, adjustedClose: null, defect: 'NOT_FINITE' as const, nonFinite })),
  },
);

const isWeekendUtc = (date: string): boolean => {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day === 0 || day === 6;
};

interface Expected {
  kept: { date: string; adjustedClose: string }[];
  counts: {
    missing: number;
    nonFinite: number;
    nonPositive: number;
    nonTradingDate: number;
    duplicateCollapsed: number;
    conflicting: number;
  };
  conflictDates: string[];
}

function reference(observations: readonly ProviderObservation[]): Expected {
  const counts = {
    missing: 0,
    nonFinite: 0,
    nonPositive: 0,
    nonTradingDate: 0,
    duplicateCollapsed: 0,
    conflicting: 0,
  };
  const valid: { date: string; adjustedClose: string }[] = [];
  for (const o of observations) {
    if ('defect' in o && o.defect === 'MISSING') {
      counts.missing += 1;
    } else if ('defect' in o) {
      counts.nonFinite += 1;
    } else if (compareFractions(parseDecimalText(o.adjustedClose), ZERO) <= 0) {
      counts.nonPositive += 1;
    } else if (isWeekendUtc(o.date)) {
      counts.nonTradingDate += 1;
    } else {
      valid.push({ date: o.date, adjustedClose: o.adjustedClose });
    }
  }
  const dates = [...new Set(valid.map((o) => o.date))].sort();
  const kept: Expected['kept'] = [];
  const conflictDates: string[] = [];
  for (const date of dates) {
    const same = valid.filter((o) => o.date === date);
    const first = same[0];
    if (first === undefined) {
      continue;
    }
    const allEqual = same.every((o) =>
      equalFractions(parseDecimalText(o.adjustedClose), parseDecimalText(first.adjustedClose)),
    );
    if (allEqual) {
      kept.push(first);
      counts.duplicateCollapsed += same.length - 1;
    } else {
      counts.conflicting += same.length;
      conflictDates.push(date);
    }
  }
  return { kept, counts, conflictDates };
}

const series = (observations: ProviderObservation[]): ProviderSeries => ({
  ticker: 'ACME',
  currency: 'USD',
  source: 'prop',
  sourceKind: 'REAL',
  retrievedAt: '2026-11-08T00:00:00.000Z',
  observations,
  contentHash: 'x',
});

describe('SeriesCleaner matches an independent reference model', () => {
  const cleaner = createSeriesCleaner(weekendsOnlyCalendar);

  it('kept observations, counts, conflict dates, ordering, and the balance invariant', () => {
    fc.assert(
      fc.property(fc.array(observationArb, { maxLength: 40 }), (observations) => {
        const result = cleaner.clean(series(observations));
        const expected = reference(observations);
        expect(result.series.observations).toEqual(expected.kept);
        expect(result.discarded).toEqual(expected.counts);
        expect(result.conflictDates).toEqual(expected.conflictDates);
        expect(result.conflict).toBe(expected.conflictDates.length > 0);
        const total = Object.values(result.discarded).reduce((sum, n) => sum + n, 0);
        expect(result.series.observations.length + total).toBe(observations.length);
      }),
      { numRuns: 1000 },
    );
  });

  it('the result does not depend on the order of observations of different dates', () => {
    fc.assert(
      fc.property(fc.array(observationArb, { maxLength: 30 }), fc.integer(), (observations, seed) => {
        // Reverse the order of whole date groups, keeping the order within each date.
        const dates = [...new Set(observations.map((o) => o.date))];
        const shuffled = (seed % 2 === 0 ? dates.reverse() : dates).flatMap((date) =>
          observations.filter((o) => o.date === date),
        );
        const a = cleaner.clean(series(observations));
        const b = cleaner.clean(series(shuffled));
        expect(b.series.observations).toEqual(a.series.observations);
        expect(b.series.contentHash).toBe(a.series.contentHash);
        expect(b.discarded).toEqual(a.discarded);
        expect(b.conflictDates).toEqual(a.conflictDates);
      }),
      { numRuns: 500 },
    );
  });
});
