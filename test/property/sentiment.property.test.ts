// Validates: Requirements 10.5, 10.6, 10.7, 15.2, 21.2, 21.5
// Property 17: Score range validation (sentiment part); Property 25: Stale, demo, and unavailable
// data are never treated as current (sentiment part); Property 31: Emission cadence
// (tasks 13.1, 13.3, 13.6; design: Correctness Properties).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeRisk } from '../../src/risk/index.js';
import {
  createSentimentEmitter,
  createSentimentState,
  normalizeObservation,
} from '../../src/sentiment/index.js';
import { FakeClock, FakeSleeper, brandDecimalString } from '../../src/shared/index.js';
import type { SentimentIndex } from '../../src/shared/index.js';
import { compareFractions, decimalTextArb, parseDecimalText } from '../helpers/rational.js';
import { advanceBy } from '../helpers/resilience.js';
import { dec, position, riskInput } from '../helpers/risk.js';
import { latestRealDouble } from '../helpers/sentimentAggregatorDouble.js';

const T0 = '2026-11-08T12:00:00.000Z';
const CONTEXT = { provider: 'p1', sourceKind: 'REAL' as const, receivedAt: T0 };

describe('Property 17: Score range validation (sentiment)', () => {
  it('values outside [-1, +1] or not finite decimals are rejected; in-range values are kept unchanged', () => {
    fc.assert(
      fc.property(
        fc.oneof(decimalTextArb(3, 6), fc.constantFrom('NaN', 'Infinity', '-Infinity', '1e0', '')),
        (text) => {
          const result = normalizeObservation({ ticker: 'AAA', value: text, observedAt: T0 }, CONTEXT);
          const inRange =
            /^-?\d+(\.\d+)?$/.test(text) &&
            compareFractions(parseDecimalText(text), { num: -1n, den: 1n }) >= 0 &&
            compareFractions(parseDecimalText(text), { num: 1n, den: 1n }) <= 0;
          expect(result.ok).toBe(inRange);
          if (result.ok) {
            expect(result.value.value).toBe(text);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('Property 25: Stale, demo, and unavailable sentiment is never current (sentiment part)', () => {
  it('a DEMO observation never yields a REAL index; non-CURRENT or DEMO sentiment never triggers', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000, max: -1 }).map((v) => `-0.${String(-v).padStart(4, '0')}`),
        fc.integer({ min: 0, max: 2_000 }),
        fc.constantFrom<'REAL' | 'DEMO'>('REAL', 'DEMO'),
        (value, ageSeconds, kind) => {
          const clock = new FakeClock(T0);
          const state = createSentimentState({
            clock,
            maxAgeSeconds: 900,
            maxFutureSkewSeconds: 5,
            windowSeconds: 300,
            historyLimit: 10,
            aggregator: latestRealDouble,
          });
          state.record({
            provider: 'p1',
            sourceKind: kind,
            ticker: 'AAA',
            value: value as SentimentIndex,
            observedAt: T0,
            receivedAt: T0,
          });
          clock.advance(ageSeconds * 1000);
          const entry = state.forRisk('AAA');
          if (kind === 'DEMO') {
            expect(entry?.sourceKind).toBe('DEMO');
            expect(state.view('AAA').index).toBeNull();
          }
          const base = riskInput([position('AAA', '10', '100')], { AAA: ['-0.01', '0.02', '-0.03'] });
          const result = computeRisk({
            ...base,
            sentiment: entry === undefined ? [] : [entry],
            adjustmentConfigMissing: [],
            params: { ...base.params, adjustment: { threshold: dec('0'), multiplier: dec('1.5') } },
          });
          const eligible = kind === 'REAL' && ageSeconds <= 900;
          expect(result.triggeredAssets.length > 0).toBe(eligible);
          expect(result.sentimentAdjustedVaR === null).toBe(!eligible);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('Property 31: Emission cadence', () => {
  it('p95 |interval - 3000| <= 500 for any arrival jitter; nothing is emitted without changes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 50, max: 2_900 }), { minLength: 300, maxLength: 300 }),
        async (gaps) => {
          const clock = new FakeClock(T0, 0);
          const sleeper = new FakeSleeper(clock);
          const state = createSentimentState({
            clock,
            maxAgeSeconds: 900,
            maxFutureSkewSeconds: 5,
            windowSeconds: 300,
            historyLimit: 50,
            aggregator: latestRealDouble,
          });
          const times: number[] = [];
          const emitter = createSentimentEmitter({
            clock,
            sleeper,
            state,
            emit: (_u, t) => times.push(t),
            onError: () => undefined,
          });
          const controller = new AbortController();
          const running = emitter.run(controller.signal);
          let elapsed = 0;
          let i = 0;
          for (const gap of gaps) {
            if (elapsed >= 300_000) {
              break;
            }
            await advanceBy({ clock, sleeper }, gap);
            elapsed += gap;
            i += 1;
            state.record({
              provider: 'p1',
              sourceKind: 'REAL',
              ticker: 'AAA',
              value: brandDecimalString(`0.${String(i % 100).padStart(2, '0')}`) as SentimentIndex,
              observedAt: clock.nowUtc().toISOString(),
              receivedAt: clock.nowUtc().toISOString(),
              messageId: `m-${i}`,
            });
          }
          const emittedBeforeQuiet = times.length;
          // Input stops: at most the one pending change is emitted, then nothing (no ageing within 900 s).
          await advanceBy({ clock, sleeper }, 9_000);
          expect(times.length - emittedBeforeQuiet).toBeLessThanOrEqual(1);
          const settled = times.length;
          await advanceBy({ clock, sleeper }, 30_000);
          expect(times.length).toBe(settled);
          controller.abort();
          await running;
          const deviations = times
            .slice(1, emittedBeforeQuiet)
            .map((t, k) => Math.abs(t - (times[k] ?? t) - 3000))
            .sort((a, b) => a - b);
          if (deviations.length > 0) {
            expect(deviations[Math.ceil(0.95 * deviations.length) - 1]).toBeLessThanOrEqual(500);
          }
          expect(times.every((t) => t % 3000 === 0)).toBe(true);
        },
      ),
      { numRuns: 15 },
    );
  });
});
