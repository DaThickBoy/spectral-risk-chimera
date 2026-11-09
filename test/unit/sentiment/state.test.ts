// Tasks 13.3 and 13.4 (and the transport-independent ingestion rules of 13.2): sentiment state,
// deduplication, ordering, future skew, freshness, last valid retention, and the aggregator
// contract run against the test double. Settings are TEST values (OD-6 open).
// Tests: AT-SEN-19, AT-SEN-20, AT-SEN-08 (state part)
// Validates: Requirements 9.5, 9.8, 9.9, 10.4, 10.6, 15.2, 15.13, 21.5
import { describe, expect, it } from 'vitest';
import { createSentimentState, sentimentFreshness } from '../../../src/sentiment/index.js';
import type { SentimentObservation } from '../../../src/sentiment/index.js';
import { FakeClock, brandDecimalString } from '../../../src/shared/index.js';
import type { SentimentIndex } from '../../../src/shared/index.js';
import { runSentimentAggregatorContract } from '../../contracts/sentimentAggregator.contract.js';
import { latestRealDouble } from '../../helpers/sentimentAggregatorDouble.js';

runSentimentAggregatorContract('latest-REAL test double', latestRealDouble);

const T0 = '2026-11-08T12:00:00.000Z';
const at = (offsetSeconds: number): string => new Date(Date.parse(T0) + offsetSeconds * 1000).toISOString();

function obs(overrides: Partial<SentimentObservation> = {}): SentimentObservation {
  return {
    provider: 'p1',
    sourceKind: 'REAL',
    ticker: 'AAA',
    value: brandDecimalString('-0.7') as SentimentIndex,
    observedAt: T0,
    receivedAt: T0,
    ...overrides,
  };
}
const v = (text: string): SentimentIndex => brandDecimalString(text) as SentimentIndex;

function setup(aggregator: boolean = true) {
  const clock = new FakeClock(T0);
  const state = createSentimentState({
    clock,
    maxAgeSeconds: 900,
    maxFutureSkewSeconds: 5,
    windowSeconds: 300,
    historyLimit: 100,
    ...(aggregator ? { aggregator: latestRealDouble } : {}),
  });
  return { clock, state };
}

describe('sentimentFreshness (FR-8)', () => {
  it('CURRENT up to and including maxAgeSeconds, STALE strictly after; null is UNAVAILABLE', () => {
    expect(sentimentFreshness(T0, at(900), 900)).toBe('CURRENT');
    expect(sentimentFreshness(T0, new Date(Date.parse(at(900)) + 1).toISOString(), 900)).toBe('STALE');
    expect(sentimentFreshness(at(3), T0, 900)).toBe('CURRENT');
    expect(sentimentFreshness(null, T0, 900)).toBe('UNAVAILABLE');
    expect(() => sentimentFreshness(T0, T0, 0)).toThrow(TypeError);
  });
});

describe('record: ingestion rules', () => {
  it('a duplicate changes state once, by message id or by provider, ticker, time, and value (R9.5)', () => {
    const { state } = setup();
    expect(state.record(obs({ messageId: 'm-1' }))).toBe('ACCEPTED');
    expect(state.record(obs({ messageId: 'm-1', value: v('0.5') }))).toBe('DUPLICATE');
    expect(state.record(obs())).toBe('ACCEPTED');
    expect(state.record(obs({ receivedAt: at(1) }))).toBe('DUPLICATE');
    expect(state.record(obs({ provider: 'p2' }))).toBe('ACCEPTED');
  });

  it('an older observation is history only and never overwrites newer state (AT-SEN-19)', () => {
    const { state, clock } = setup();
    clock.advance(60_000);
    state.record(obs({ observedAt: at(50), value: v('-0.2') }));
    expect(state.record(obs({ observedAt: at(10), value: v('-0.9') }))).toBe('HISTORY');
    const view = state.view('AAA');
    expect(view.latest?.value).toBe('-0.2');
    expect(view.index?.value).toBe('-0.2');
  });

  it('more than maxFutureSkewSeconds in the future is rejected and not stored (AT-SEN-20)', () => {
    const { state } = setup();
    expect(state.record(obs({ observedAt: at(5) }))).toBe('ACCEPTED');
    expect(
      state.record(obs({ observedAt: new Date(Date.parse(at(5)) + 1).toISOString(), value: v('0.1') })),
    ).toBe('FUTURE_DATED');
    expect(state.view('AAA').latest?.value).toBe('-0.7');
  });
});

describe('views and freshness (13.3)', () => {
  it('the index is CURRENT, then retained with its timestamp and STALE after maxAgeSeconds (R10.6, R15.13)', () => {
    const { state, clock } = setup();
    state.record(obs());
    expect(state.forRisk('AAA')).toEqual({
      ticker: 'AAA',
      value: '-0.7',
      status: 'CURRENT',
      sourceKind: 'REAL',
      source: 'p1',
      aggregatorVersion: 'test-double-latest-real',
      observedAt: T0,
    });
    clock.advance(600_000); // outside the 300 s window, inside the 900 s maximum age
    expect(state.view('AAA').index).toMatchObject({ value: '-0.7', observedAt: T0, status: 'CURRENT' });
    clock.advance(300_001); // 900.001 s old
    expect(state.view('AAA').index).toMatchObject({ value: '-0.7', observedAt: T0, status: 'STALE' });
    expect(state.forRisk('AAA')).toMatchObject({ value: '-0.7', status: 'STALE', sourceKind: 'REAL' });
  });

  it('the last valid index is retained even if nobody read it while it was in the window (R10.4, R10.6)', () => {
    const { state, clock } = setup();
    state.record(obs());
    clock.advance(301_000);
    expect(state.forRisk('AAA')).toMatchObject({ value: '-0.7', status: 'CURRENT', observedAt: T0 });
  });

  it('demo observations never become a REAL index and are DEMO for risk (FR-8)', () => {
    const { state } = setup();
    state.record(obs({ sourceKind: 'DEMO' }));
    expect(state.view('AAA').index).toBeNull();
    expect(state.view('AAA').latest).toMatchObject({ sourceKind: 'DEMO', status: 'CURRENT' });
    expect(state.forRisk('AAA')).toMatchObject({ value: null, sourceKind: 'DEMO' });
  });

  it('without an approved aggregator (OD-1) REAL data is UNAVAILABLE for risk, never assumed', () => {
    const { state } = setup(false);
    state.record(obs());
    expect(state.view('AAA').index).toBeNull();
    expect(state.forRisk('AAA')).toEqual({
      ticker: 'AAA',
      value: null,
      status: 'UNAVAILABLE',
      sourceKind: 'REAL',
      source: 'p1',
    });
  });

  it('a never-seen ticker is absent for risk', () => {
    const { state } = setup();
    expect(state.forRisk('ZZZ')).toBeUndefined();
    expect(state.view('ZZZ')).toEqual({ ticker: 'ZZZ', index: null, latest: null });
  });

  it('history is bounded and tickers are listed sorted', () => {
    const clock = new FakeClock(T0);
    const state = createSentimentState({
      clock,
      maxAgeSeconds: 900,
      maxFutureSkewSeconds: 5,
      windowSeconds: 300,
      historyLimit: 2,
    });
    for (let i = 0; i < 5; i += 1) {
      state.record(obs({ ticker: i % 2 === 0 ? 'BBB' : 'AAA', messageId: `m-${i}` }));
    }
    expect(state.tickers()).toEqual(['AAA', 'BBB']);
  });

  it('rejects a window larger than the maximum age (R10.1)', () => {
    expect(() =>
      createSentimentState({
        clock: new FakeClock(T0),
        maxAgeSeconds: 100,
        maxFutureSkewSeconds: 5,
        windowSeconds: 101,
        historyLimit: 10,
      }),
    ).toThrow(TypeError);
  });
});
