// Contract suite for SentimentAggregator (task 13.4; design: Sentiment, Aggregator U-2; R10.1 to
// R10.3, R21.2). Every implementation runs this suite unchanged: the test double now
// (test/unit/sentiment/aggregatorContract.test.ts) and the OD-1 formula in task 13.5.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SentimentAggregator, SentimentObservation } from '../../src/sentiment/index.js';
import { SentimentIndexSchema, brandDecimalString } from '../../src/shared/index.js';
import type { SentimentIndex } from '../../src/shared/index.js';

const NOW = '2026-11-08T12:00:00.000Z';
const WINDOW = 300;

const valueArb = fc
  .integer({ min: -10_000, max: 10_000 })
  .map(
    (v) =>
      `${v < 0 ? '-' : ''}${Math.floor(Math.abs(v) / 10_000)}.${String(Math.abs(v) % 10_000).padStart(4, '0')}`,
  );

const observationArb = fc.record({
  value: valueArb,
  ageMs: fc.integer({ min: -2_000, max: 600_000 }),
  kind: fc.constantFrom<'REAL' | 'DEMO'>('REAL', 'REAL', 'DEMO'),
  provider: fc.constantFrom('p1', 'p2'),
});

const toObservation = (
  o: { value: string; ageMs: number; kind: 'REAL' | 'DEMO'; provider: string },
  i: number,
): SentimentObservation => ({
  provider: o.provider,
  sourceKind: o.kind,
  messageId: `m-${i}`,
  ticker: 'AAA',
  value: brandDecimalString(o.value) as SentimentIndex,
  observedAt: new Date(Date.parse(NOW) - o.ageMs).toISOString(),
  receivedAt: NOW,
});

const inWindow = (o: SentimentObservation): boolean => {
  const age = Date.parse(NOW) - Date.parse(o.observedAt);
  return age >= 0 && age <= WINDOW * 1000;
};

export function runSentimentAggregatorContract(name: string, aggregator: SentimentAggregator): void {
  describe(`SentimentAggregator contract: ${name}`, () => {
    it('has a non-empty version', () => {
      expect(aggregator.version).toMatch(/^\S{1,64}$/);
    });

    it('returns null or a valid SentimentIndex in [-1, +1]', () => {
      fc.assert(
        fc.property(fc.array(observationArb, { maxLength: 20 }), (raw) => {
          const value = aggregator.aggregate(raw.map(toObservation), NOW, WINDOW);
          if (value !== null) {
            expect(SentimentIndexSchema.safeParse(value).success).toBe(true);
          }
        }),
        { numRuns: 200 },
      );
    });

    it('is deterministic and independent of input order', () => {
      fc.assert(
        fc.property(fc.array(observationArb, { maxLength: 20 }), (raw) => {
          const observations = raw.map(toObservation);
          const a = aggregator.aggregate(observations, NOW, WINDOW);
          const b = aggregator.aggregate([...observations].reverse(), NOW, WINDOW);
          expect(b).toBe(a);
          expect(aggregator.aggregate(observations, NOW, WINDOW)).toBe(a);
        }),
        { numRuns: 200 },
      );
    });

    it('uses REAL observations only: DEMO observations never change the result', () => {
      fc.assert(
        fc.property(fc.array(observationArb, { maxLength: 20 }), (raw) => {
          const observations = raw.map(toObservation);
          const realOnly = observations.filter((o) => o.sourceKind === 'REAL');
          expect(aggregator.aggregate(observations, NOW, WINDOW)).toBe(
            aggregator.aggregate(realOnly, NOW, WINDOW),
          );
        }),
        { numRuns: 200 },
      );
    });

    it('returns null when no REAL observation lies in the window', () => {
      fc.assert(
        fc.property(fc.array(observationArb, { maxLength: 20 }), (raw) => {
          const observations = raw.map(toObservation).filter((o) => o.sourceKind === 'DEMO' || !inWindow(o));
          expect(aggregator.aggregate(observations, NOW, WINDOW)).toBeNull();
        }),
        { numRuns: 200 },
      );
      expect(aggregator.aggregate([], NOW, WINDOW)).toBeNull();
    });

    it('returns decimal text, never a native number', () => {
      const value = aggregator.aggregate(
        [toObservation({ value: '-0.6001', ageMs: 1, kind: 'REAL', provider: 'p1' }, 0)],
        NOW,
        WINDOW,
      );
      expect(value === null || typeof value === 'string').toBe(true);
    });
  });
}
