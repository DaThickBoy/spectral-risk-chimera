// Tasks 14.1, 14.4, and 13.1 (audit part): Adjusted VaR through the input builder, the risk service,
// stored results, snapshots, and recomputation, with sentiment from the 13.3 state and the test
// aggregator double (OD-1 open). Same data as riskService.test.ts: Base VaR 80 for 10 units at 100.
// With AAA at -0.7 (multiplier 1.15): PnL = [100, -115, 100]; Loss sorted [-100, -100, 115];
// h = 2.9: Adjusted VaR = 0.1 * -100 + 0.9 * 115 = 93.5.
// Tests: AT-SEN-08, AT-SEN-17, AT-SEN-27, AT-SEN-28, AT-SEN-29, AT-REP-02, AT-REP-09
// Validates: Requirements 15.1, 15.8, 15.9, 15.13, 32.1, 32.2, 32.4, 13.7, 10.7
import { describe, expect, it } from 'vitest';
import { buildSnapshot, createSentimentRejectionAuditor } from '../../../src/app/index.js';
import { InMemoryUnitOfWork } from '../../../src/persistence/index.js';
import { riskEngine } from '../../../src/risk/index.js';
import { createSentimentState } from '../../../src/sentiment/index.js';
import type { SentimentObservation } from '../../../src/sentiment/index.js';
import { FakeClock, brandDecimalString, canonicalJson, sequentialIds } from '../../../src/shared/index.js';
import type { SentimentIndex } from '../../../src/shared/index.js';
import { completeTestConfig, withKey } from '../../helpers/config.js';
import { NOW, PF, VERSION, cleanSeries, riskHarness } from '../../helpers/riskService.js';
import type { RiskHarnessOptions } from '../../helpers/riskService.js';
import { latestRealDouble } from '../../helpers/sentimentAggregatorDouble.js';

const SMALL = withKey(withKey(completeTestConfig(), 'var.lookbackReturns', 3), 'var.minObservations', 2);

function sentiment(value: string, overrides: Partial<SentimentObservation> = {}, clock = new FakeClock(NOW)) {
  const state = createSentimentState({
    clock,
    maxAgeSeconds: 900,
    maxFutureSkewSeconds: 5,
    windowSeconds: 300,
    historyLimit: 100,
    aggregator: latestRealDouble,
  });
  state.record({
    provider: 'test-sentiment',
    sourceKind: 'REAL',
    ticker: 'AAA',
    value: brandDecimalString(value) as SentimentIndex,
    observedAt: NOW,
    receivedAt: NOW,
    ...overrides,
  });
  return { state, clock };
}

function setup(options: RiskHarnessOptions = {}) {
  const h = riskHarness(
    { AAA: ['USD', '10'] },
    { values: SMALL, prices: { AAA: { price: '100' } }, ...options },
  );
  if (options.uow === undefined) {
    h.putSeries(cleanSeries('AAA', ['100', '110', '99', '108.9'], { start: '2026-11-03' }));
  }
  return h;
}

describe('Adjusted VaR through the risk service', () => {
  it('eligible bearish sentiment gives APPLIED, a separate adjusted figure, and triggered assets', async () => {
    const h = setup({ sentiment: sentiment('-0.7').state });
    await h.service.calculate(PF);
    const view = h.service.view(PF);
    expect(view?.baseVaR).toMatchObject({ validity: 'CURRENT', value: { absolute: '80' } });
    expect(view?.adjustedVaR).toMatchObject({
      validity: 'CURRENT',
      status: 'APPLIED',
      value: { absolute: '93.5' },
      reason: null,
    });
    const snapshot = JSON.parse(h.uow.snapshot().snapshots[0]?.snapshot ?? '{}') as Record<string, unknown>;
    expect(snapshot['sentiment']).toEqual([
      {
        ticker: 'AAA',
        value: '-0.7',
        status: 'CURRENT',
        sourceKind: 'REAL',
        source: 'test-sentiment',
        aggregatorVersion: 'test-double-latest-real',
        observedAt: NOW,
      },
    ]);
    expect(snapshot['triggeredAssets']).toEqual([
      {
        ticker: 'AAA',
        direction: 'LONG',
        rawSentiment: '-0.7',
        effectiveSentiment: '-0.7',
        multiplier: '1.15',
      },
    ]);
    expect(snapshot['adjustmentOutcome']).toEqual({
      status: 'APPLIED',
      missingConfigKeys: [],
      ineligible: [],
    });
  });

  it('stale sentiment: Base CURRENT, Adjusted UNAVAILABLE naming the ticker; stale value displayed (AT-SEN-08)', async () => {
    const clock = new FakeClock(NOW);
    const s = sentiment('-0.7', {}, clock);
    clock.advance(901_000);
    const h = setup({ sentiment: s.state, at: clock.nowUtc().toISOString() });
    await h.service.calculate(PF);
    const view = h.service.view(PF);
    expect(view?.baseVaR.validity).toBe('CURRENT');
    expect(view?.adjustedVaR).toMatchObject({
      validity: 'UNAVAILABLE',
      value: null,
      status: 'SENTIMENT_NOT_CURRENT',
    });
    expect(s.state.view('AAA').index).toMatchObject({ value: '-0.7', status: 'STALE', observedAt: NOW });
    const body = JSON.parse(h.uow.snapshot().riskResults[0]?.body ?? '{}') as {
      result: { adjustmentOutcome: unknown };
    };
    expect(body.result.adjustmentOutcome).toEqual({
      status: 'SENTIMENT_NOT_CURRENT',
      missingConfigKeys: [],
      ineligible: [{ ticker: 'AAA', sentimentStatus: 'STALE' }],
    });
  });

  it.each([
    'sentiment.windowSeconds',
    'sentiment.maxAgeSeconds',
    'adjustment.bearishThreshold',
    'adjustment.multiplier',
  ])(
    'missing %s: Base CURRENT; Adjusted UNAVAILABLE with ADJUSTMENT_CONFIG_MISSING naming it (AT-SEN-27, AT-SEN-28)',
    async (key) => {
      const h = setup({ sentiment: sentiment('-0.7').state, missing: [key] });
      await h.service.calculate(PF);
      const view = h.service.view(PF);
      expect(view?.baseVaR).toMatchObject({ validity: 'CURRENT', value: { absolute: '80' } });
      expect(view?.adjustedVaR).toMatchObject({
        validity: 'UNAVAILABLE',
        value: null,
        status: 'ADJUSTMENT_CONFIG_MISSING',
        missingKeys: [key],
      });
    },
  );

  it('the Adjusted field never holds the Base figure (AT-SEN-29)', async () => {
    const h = setup();
    await h.service.calculate(PF);
    const view = h.service.view(PF);
    expect(view?.baseVaR.value?.absolute).toBe('80');
    expect(view?.adjustedVaR.value).toBeNull();
    expect(view?.adjustedVaR.status).toBe('SENTIMENT_NOT_CURRENT');
  });

  it('a sentiment change leaves the Base VaR string unchanged (AT-SEN-17, calculation part)', async () => {
    const bearish = setup({ sentiment: sentiment('-0.9').state });
    const bullish = setup({ sentiment: sentiment('0.9').state });
    await bearish.service.calculate(PF);
    await bullish.service.calculate(PF);
    expect(bearish.service.view(PF)?.baseVaR.value).toEqual(bullish.service.view(PF)?.baseVaR.value);
    expect(bullish.service.view(PF)?.adjustedVaR).toMatchObject({
      status: 'NONE_TRIGGERED',
      value: { absolute: '80' },
    });
  });
});

describe('snapshots and recomputation with Adjusted VaR (14.4)', () => {
  it('recompute reproduces the Adjusted figure and its status as identical text (AT-REP-02)', async () => {
    const h = setup({ sentiment: sentiment('-0.7').state });
    await h.service.calculate(PF);
    const [record] = h.uow.snapshot().snapshots;
    const [stored] = h.uow.snapshot().riskResults;
    const again = h.service.recompute(record?.id ?? '');
    expect(again.ok && canonicalJson({ kind: 'CALCULATED', result: again.value })).toBe(stored?.body);
    expect(again.ok && again.value.sentimentAdjustedVaR?.absolute).toBe('93.5');
  });

  it('identical inputs give identical hashes; display-only filing scores never change it (AT-REP-09)', async () => {
    const a = setup({ sentiment: sentiment('-0.7').state });
    const input = await a.builder.build(PF);
    if (!input.ok) {
      throw new Error('expected an input');
    }
    const result = riskEngine.compute(input.value);
    const plain = buildSnapshot(input.value, result, VERSION, 5, { filingScores: [] });
    const scored = buildSnapshot(input.value, result, VERSION, 5, {
      filingScores: [{ ticker: 'AAA', score: '0.95' as never, status: 'CURRENT' }],
    });
    expect(scored.hash).toBe(plain.hash);
    const other = buildSnapshot(
      input.value,
      riskEngine.compute({ ...input.value, sentiment: [] }),
      VERSION,
      5,
      {
        filingScores: [],
      },
    );
    expect(other.hash).not.toBe(plain.hash);
  });
});

describe('sentiment rejection audit (13.1)', () => {
  it('records VALIDATION / SENTIMENT_REJECTED with provider and reason only', () => {
    const uow = new InMemoryUnitOfWork();
    const audit = createSentimentRejectionAuditor({
      unitOfWork: uow,
      clock: new FakeClock(NOW),
      ids: sequentialIds('a'),
      onAuditFailure: () => undefined,
    });
    audit(
      {
        code: 'SENTIMENT_INVALID',
        message: 'Sentiment observation rejected (OUT_OF_RANGE).',
        reason: 'OUT_OF_RANGE',
      },
      { provider: 'p1' },
    );
    expect(uow.snapshot().audit.map((a) => [a.category, a.type, a.details])).toEqual([
      ['VALIDATION', 'SENTIMENT_REJECTED', { provider: 'p1', reason: 'OUT_OF_RANGE' }],
    ]);
  });
});
