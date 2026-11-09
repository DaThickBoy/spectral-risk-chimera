// Task 13.6: the sentiment emission cadence (design: Sentiment, Emitter; R10.5, R10.6, R10.8).
// Tests: AT-CAD-01, AT-CAD-02, AT-CAD-03, AT-CAD-04, AT-CAD-05, AT-CAD-06
// Validates: Requirements 10.5, 10.6, 10.8
import { describe, expect, it } from 'vitest';
import { createSentimentEmitter, createSentimentState } from '../../../src/sentiment/index.js';
import type { SentimentView } from '../../../src/sentiment/index.js';
import { FakeClock, FakeSleeper, brandDecimalString } from '../../../src/shared/index.js';
import type { SentimentIndex } from '../../../src/shared/index.js';
import { advanceBy } from '../../helpers/resilience.js';
import { latestRealDouble } from '../../helpers/sentimentAggregatorDouble.js';

const T0 = '2026-11-08T12:00:00.000Z';
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function setup() {
  const clock = new FakeClock(T0, 1_000);
  const sleeper = new FakeSleeper(clock);
  const state = createSentimentState({
    clock,
    maxAgeSeconds: 10,
    maxFutureSkewSeconds: 5,
    windowSeconds: 10,
    historyLimit: 100,
    aggregator: latestRealDouble,
  });
  const emissions: { at: number; updates: readonly SentimentView[] }[] = [];
  const emitter = createSentimentEmitter({
    clock,
    sleeper,
    state,
    emit: (updates, atMs) => emissions.push({ at: atMs, updates }),
    onError: () => undefined,
  });
  const record = (ticker: string, value: string) =>
    state.record({
      provider: 'p1',
      sourceKind: 'REAL',
      ticker,
      value: brandDecimalString(value) as SentimentIndex,
      observedAt: clock.nowUtc().toISOString(),
      receivedAt: clock.nowUtc().toISOString(),
    });
  return { clock, sleeper, state, emitter, emissions, record };
}

describe('sentiment emitter', () => {
  it('emits on a drift-corrected 3,000 ms schedule; |interval - 3000| p95 <= 500 over five minutes (AT-CAD-01 to 03)', async () => {
    const s = setup();
    const controller = new AbortController();
    const running = s.emitter.run(controller.signal);
    // Continuous input with jittered arrivals (AT-CAD-04): one observation every 700 to 1,300 ms.
    let value = 0;
    for (let elapsed = 0; elapsed < 300_000;) {
      const step = 700 + ((elapsed * 7) % 600); // deterministic jitter, milliseconds
      await advanceBy(s, step); // fires each timer at its due time, like real timers
      elapsed += step;
      value = (value + 1) % 100;
      s.record('AAA', `0.${String(value).padStart(2, '0')}`);
      await flush();
    }
    controller.abort();
    await running;
    const times = s.emissions.map((e) => e.at);
    const deviations = times
      .slice(1)
      .map((t, i) => Math.abs(t - (times[i] ?? t) - 3000))
      .sort((a, b) => a - b);
    const p95 = deviations[Math.ceil(0.95 * deviations.length) - 1] ?? Number.POSITIVE_INFINITY;
    expect(deviations.length).toBeGreaterThanOrEqual(95);
    expect(p95).toBeLessThanOrEqual(500);
    // Emission times are exactly on the schedule, independent of arrivals.
    expect(times.every((t) => (t - 1_000) % 3000 === 0)).toBe(true);
  });

  it('emits nothing when nothing changed, and retains the last value with its timestamp (AT-CAD-05)', async () => {
    const s = setup();
    s.record('AAA', '-0.5');
    const controller = new AbortController();
    const running = s.emitter.run(controller.signal);
    s.sleeper.advance(3000);
    await flush();
    s.sleeper.advance(3000);
    await flush();
    controller.abort();
    await running;
    expect(s.emissions).toHaveLength(1);
    expect(s.state.view('AAA').latest).toMatchObject({ value: '-0.5', observedAt: T0 });
  });

  it('keeps running without input and emits the ageing to STALE (AT-CAD-06)', async () => {
    const s = setup();
    s.record('AAA', '-0.5');
    const controller = new AbortController();
    const running = s.emitter.run(controller.signal);
    for (let i = 0; i < 5; i += 1) {
      s.sleeper.advance(3000);
      await flush();
    }
    controller.abort();
    await running;
    const statuses = s.emissions.map((e) => e.updates[0]?.index?.status);
    expect(statuses).toEqual(['CURRENT', 'STALE']);
  });

  it('an emit failure is reported and the schedule continues', async () => {
    const clock = new FakeClock(T0);
    const sleeper = new FakeSleeper(clock);
    const state = createSentimentState({
      clock,
      maxAgeSeconds: 10,
      maxFutureSkewSeconds: 5,
      windowSeconds: 10,
      historyLimit: 10,
    });
    const errors: unknown[] = [];
    const emitter = createSentimentEmitter({
      clock,
      sleeper,
      state,
      emit: () => {
        throw new Error('gateway down');
      },
      onError: (e) => errors.push(e),
    });
    state.record({
      provider: 'p1',
      sourceKind: 'DEMO',
      ticker: 'AAA',
      value: brandDecimalString('0.1') as SentimentIndex,
      observedAt: T0,
      receivedAt: T0,
    });
    expect(emitter.tick()).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(emitter.tick()).toHaveLength(0);
  });
});
