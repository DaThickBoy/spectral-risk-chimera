// Task 17.1: the view model builder with signal separation (design: View models).
// Same data as adjustedRisk.test.ts: 10 AAA at 100, Base VaR 80, Adjusted VaR 93.5 with AAA at -0.7.
// Tests: AT-FIL-04 (sentiment half; filing scores stay UNAVAILABLE until the filing pipeline)
// Properties: Property 12 (static type test and examples)
// Validates: Requirements 11.6, 11.7, 17.1, 17.2, 17.3, 17.4, 17.6, 17.7, 17.8, 17.9, 17.10, 35.2, 35.3, 35.6
import { describe, expect, expectTypeOf, it } from 'vitest';
import { AGGREGATION_NOT_APPROVED_EXPLANATION, buildPortfolioRiskView } from '../../../src/app/index.js';
import type { RiskViewParts } from '../../../src/app/index.js';
import { createSentimentState } from '../../../src/sentiment/index.js';
import type { SentimentView } from '../../../src/sentiment/index.js';
import {
  AllocationResponseSchema,
  FakeClock,
  PortfolioRiskViewSchema,
  PositionsResponseSchema,
  brandDecimalString,
} from '../../../src/shared/index.js';
import type { AssetRiskRow, PortfolioRiskView, SentimentIndex } from '../../../src/shared/index.js';
import { completeTestConfig, withKey } from '../../helpers/config.js';
import { NOW, PF, cleanSeries, riskHarness } from '../../helpers/riskService.js';
import { latestRealDouble } from '../../helpers/sentimentAggregatorDouble.js';

const SMALL = withKey(withKey(completeTestConfig(), 'var.lookbackReturns', 3), 'var.minObservations', 2);

function sentimentState(entries: readonly { ticker: string; value: string; sourceKind?: 'REAL' | 'DEMO' }[]) {
  const state = createSentimentState({
    clock: new FakeClock(NOW),
    maxAgeSeconds: 900,
    maxFutureSkewSeconds: 5,
    windowSeconds: 300,
    historyLimit: 100,
    aggregator: latestRealDouble,
  });
  for (const e of entries) {
    state.record({
      provider: 'test-sentiment',
      sourceKind: e.sourceKind ?? 'REAL',
      ticker: e.ticker,
      value: brandDecimalString(e.value) as SentimentIndex,
      observedAt: NOW,
      receivedAt: NOW,
    });
  }
  return state;
}

const positions = (overrides: Record<string, unknown> = {}) =>
  PositionsResponseSchema.parse({
    portfolioId: PF,
    baseCurrency: 'USD',
    at: NOW,
    positions: [
      {
        id: 'pos-1',
        portfolioId: PF,
        ticker: 'AAA',
        currency: 'USD',
        signedQuantity: '10',
        averagePrice: '90',
        isShort: false,
        updatedAt: NOW,
        source: 'CSV',
        marketPrice: '100',
        marketValueInstrument: '1000',
        marketValueBase: '1000',
        allocationPct: '100',
        valuationStatus: 'VALUED',
        priceAsOf: '2026-11-06',
        priceProvenance: { asOf: '2026-11-06', source: 'fixture-md', sourceKind: 'REAL', retrievedAt: NOW },
        fxRate: null,
        priceUnavailable: null,
        fxUnavailable: null,
        ...overrides,
      },
    ],
  });

const measures = {
  long: '1000',
  short: '0',
  gross: '1000',
  net: '1000',
  cash: '0',
  nav: '1000',
  allocationDenominator: '1000',
};
const allocation = (exposureOk = true) =>
  AllocationResponseSchema.parse({
    portfolioId: PF,
    baseCurrency: 'USD',
    at: NOW,
    exposure: exposureOk
      ? { status: 'OK', navStatus: 'NAV_POSITIVE', measures }
      : {
          status: 'EXPOSURE_UNAVAILABLE',
          reason: 'VALUATION_INCOMPLETE',
          unvalued: [{ ticker: 'AAA', valuationStatus: 'PRICE_UNAVAILABLE' }],
          cash: '0',
        },
    allocation: exposureOk
      ? {
          status: 'ELIGIBLE',
          measures,
          lines: [{ kind: 'POSITION', ticker: 'AAA', valueBase: '1000', pct: '100' }],
          total: '100',
        }
      : null,
  });

async function parts(
  sentimentValue: string | null,
  options: { missing?: readonly string[]; sentiment?: (ticker: string) => SentimentView } = {},
): Promise<RiskViewParts> {
  const state = sentimentState(sentimentValue === null ? [] : [{ ticker: 'AAA', value: sentimentValue }]);
  const h = riskHarness(
    { AAA: ['USD', '10'] },
    { values: SMALL, prices: { AAA: { price: '100' } }, sentiment: state, missing: options.missing ?? [] },
  );
  h.putSeries(cleanSeries('AAA', ['100', '110', '99', '108.9'], { start: '2026-11-03' }));
  await h.service.calculate(PF);
  const risk = h.service.view(PF);
  const adjustment = h.service.adjustmentDetail(PF);
  if (risk === undefined || adjustment === undefined) throw new Error('no risk result');
  return {
    risk,
    adjustment,
    positions: positions(),
    allocation: allocation(),
    sentiment: options.sentiment ?? ((ticker) => state.view(ticker)),
  };
}

describe('VaR entries stay separate (R17.10, R35.6)', () => {
  it('APPLIED: two entries, the difference, and the triggering position in the explanation', async () => {
    const view = buildPortfolioRiskView(await parts('-0.7'));
    expect(view.baseVaR).toMatchObject({ validity: 'CURRENT', status: 'OK', value: { absolute: '80' } });
    expect(view.sentimentAdjustedVaR).toMatchObject({
      validity: 'CURRENT',
      status: 'APPLIED',
      value: { absolute: '93.5' },
    });
    expect(view.varDifference).toBe('13.5'); // 93.5 - 80, hand-calculated
    expect(view.adjustmentExplanation).toBe(
      'Downside adjustment applied to AAA (LONG, effective sentiment -0.7, multiplier 1.15): their bearish sentiment is below the threshold.',
    );
    expect(view.assets[0]?.adjustment).toEqual({
      triggered: true,
      effectiveSentiment: '-0.7',
      direction: 'LONG',
      multiplier: '1.15',
    });
  });

  it('NONE_TRIGGERED: equal figures, difference 0, and the explanation says nothing triggered', async () => {
    const view = buildPortfolioRiskView(await parts('0.4'));
    expect(view.sentimentAdjustedVaR).toMatchObject({ status: 'NONE_TRIGGERED', value: { absolute: '80' } });
    expect(view.varDifference).toBe('0');
    expect(view.adjustmentExplanation).toBe(
      'No position met the bearish sentiment trigger, so no downside adjustment was applied.',
    );
    expect(view.assets[0]?.adjustment.triggered).toBe(false);
  });

  it('SENTIMENT_NOT_CURRENT: Adjusted is null with the ineligible tickers; never the Base figure', async () => {
    const view = buildPortfolioRiskView(await parts(null));
    expect(view.baseVaR.value?.absolute).toBe('80');
    expect(view.sentimentAdjustedVaR).toEqual({
      validity: 'UNAVAILABLE',
      value: null,
      status: 'SENTIMENT_NOT_CURRENT',
      reason: {
        missingConfigKeys: [],
        ineligibleTickers: [{ ticker: 'AAA', sentimentStatus: 'ABSENT' }],
        code: 'SENTIMENT_NOT_CURRENT',
      },
      lastValid: null,
    });
    expect(view.varDifference).toBeNull();
    expect(view.adjustmentExplanation).toBe('Unavailable: sentiment is not current for AAA (ABSENT).');
    expect(view.assets[0]?.sentiment).toEqual({
      value: null,
      status: 'UNAVAILABLE',
      sourceKind: null,
      observedAt: null,
      basis: 'NONE',
    });
  });

  it('ADJUSTMENT_CONFIG_MISSING lists the missing keys', async () => {
    const view = buildPortfolioRiskView(await parts('-0.7', { missing: ['sentiment.multiplier'] }));
    expect(view.sentimentAdjustedVaR).toMatchObject({
      value: null,
      status: 'ADJUSTMENT_CONFIG_MISSING',
      reason: { missingConfigKeys: ['sentiment.multiplier'] },
    });
    expect(view.adjustmentExplanation).toBe(
      'Unavailable: adjustment settings are missing (sentiment.multiplier).',
    );
  });
});

describe('DR-KW-1 H7: the explicit OD-1 reason when no aggregation method is approved', () => {
  it('SENTIMENT_NOT_CURRENT under NOT_APPROVED starts with the OD-1 reason; status codes unchanged', async () => {
    const view = buildPortfolioRiskView({ ...(await parts(null)), sentimentAggregation: 'NOT_APPROVED' });
    expect(view.sentimentAdjustedVaR).toMatchObject({ status: 'SENTIMENT_NOT_CURRENT', value: null });
    expect(view.adjustmentExplanation).toBe(
      `${AGGREGATION_NOT_APPROVED_EXPLANATION} Unavailable: sentiment is not current for AAA (ABSENT).`,
    );
    expect(AGGREGATION_NOT_APPROVED_EXPLANATION).toMatch(/OD-1/);
  });

  it('ADJUSTMENT_CONFIG_MISSING under NOT_APPROVED also carries the OD-1 reason', async () => {
    const view = buildPortfolioRiskView({
      ...(await parts('-0.7', { missing: ['sentiment.multiplier'] })),
      sentimentAggregation: 'NOT_APPROVED',
    });
    expect(view.adjustmentExplanation.startsWith(AGGREGATION_NOT_APPROVED_EXPLANATION)).toBe(true);
    expect(view.adjustmentExplanation).toMatch(/sentiment\.multiplier/);
  });

  it('an injected aggregator leaves the explanation unchanged; APPLIED never mentions OD-1', async () => {
    const injected = buildPortfolioRiskView({ ...(await parts(null)), sentimentAggregation: 'INJECTED' });
    expect(injected.adjustmentExplanation).toBe('Unavailable: sentiment is not current for AAA (ABSENT).');
    const applied = buildPortfolioRiskView({
      ...(await parts('-0.7')),
      sentimentAggregation: 'NOT_APPROVED',
    });
    expect(applied.adjustmentExplanation).not.toMatch(/OD-1/);
  });
});

describe('asset rows: prices, exposure, and unavailable values (R17.1 to R17.4)', () => {
  it('carries price and provenance unchanged and riskContribution null', async () => {
    const view = buildPortfolioRiskView(await parts('0.4'));
    expect(view.assets[0]).toMatchObject({
      ticker: 'AAA',
      currency: 'USD',
      signedQuantity: '10',
      marketPrice: '100',
      marketValueBase: '1000',
      allocationPct: '100',
      valuationStatus: 'VALUED',
      priceProvenance: { asOf: '2026-11-06', source: 'fixture-md', sourceKind: 'REAL', retrievedAt: NOW },
      lastValidPrice: null,
      riskContribution: null,
    });
    expect(view.exposure).toEqual({
      status: 'OK',
      nav: '1000',
      long: '1000',
      short: '0',
      gross: '1000',
      net: '1000',
      cash: '0',
    });
  });

  it('PRICE_UNAVAILABLE: null price and value (never "0"), the display-only last valid price, exposure unavailable', async () => {
    const p = await parts('0.4');
    const lastValid = {
      kind: 'LAST_VALID_DISPLAY',
      status: 'STALE',
      label: 'LAST_VALID',
      ticker: 'AAA',
      currency: 'USD',
      price: '98.5',
      asOf: '2026-11-05',
      source: 'fixture-md',
      sourceKind: 'REAL',
      retrievedAt: NOW,
    };
    const view = buildPortfolioRiskView({
      ...p,
      positions: positions({
        marketPrice: null,
        marketValueInstrument: null,
        marketValueBase: null,
        allocationPct: null,
        valuationStatus: 'PRICE_UNAVAILABLE',
        priceAsOf: null,
        priceProvenance: null,
        priceUnavailable: { cause: 'PROVIDER_ERROR' },
        lastValid,
      }),
      allocation: allocation(false),
    });
    expect(view.assets[0]).toMatchObject({
      marketPrice: null,
      marketValueBase: null,
      allocationPct: null,
      valuationStatus: 'PRICE_UNAVAILABLE',
      priceProvenance: null,
      lastValidPrice: lastValid,
    });
    expect(view.exposure).toEqual({
      status: 'EXPOSURE_UNAVAILABLE',
      nav: null,
      long: null,
      short: null,
      gross: null,
      net: null,
      cash: '0',
    });
  });

  it('DEMO sentiment is shown with its label when no REAL index exists; filing stays UNAVAILABLE', async () => {
    const demo = sentimentState([{ ticker: 'AAA', value: '0.80', sourceKind: 'DEMO' }]);
    const view = buildPortfolioRiskView(await parts(null, { sentiment: (ticker) => demo.view(ticker) }));
    expect(view.assets[0]?.sentiment).toEqual({
      value: '0.8',
      status: 'CURRENT',
      sourceKind: 'DEMO',
      observedAt: NOW,
      basis: 'LATEST_OBSERVATION',
    });
    expect(view.assets[0]?.filing).toEqual({
      score: null,
      status: 'UNAVAILABLE',
      filingDate: null,
      sourceKind: null,
    });
  });
});

describe('Property 12: No combined score', () => {
  it('static: the row and view types have exactly the designed fields, none combining sentiment and filing', () => {
    expectTypeOf<keyof AssetRiskRow>().toEqualTypeOf<
      | 'ticker'
      | 'currency'
      | 'signedQuantity'
      | 'marketPrice'
      | 'priceProvenance'
      | 'lastValidPrice'
      | 'marketValueBase'
      | 'valuationStatus'
      | 'allocationPct'
      | 'sentiment'
      | 'filing'
      | 'adjustment'
      | 'riskContribution'
    >();
    expectTypeOf<keyof AssetRiskRow['sentiment']>().toEqualTypeOf<
      'value' | 'status' | 'sourceKind' | 'observedAt' | 'basis'
    >();
    expectTypeOf<keyof AssetRiskRow['filing']>().toEqualTypeOf<
      'score' | 'status' | 'filingDate' | 'sourceKind'
    >();
    expectTypeOf<keyof PortfolioRiskView>().toEqualTypeOf<
      | 'portfolioId'
      | 'baseCurrency'
      | 'exposure'
      | 'confidence'
      | 'horizonDays'
      | 'baseVaR'
      | 'sentimentAdjustedVaR'
      | 'varDifference'
      | 'adjustmentExplanation'
      | 'assets'
      | 'calculation'
    >();
  });

  it('static: the schemas reject an added combined field', () => {
    const shape = PortfolioRiskViewSchema.shape;
    const keys = [...Object.keys(shape), ...Object.keys(shape.assets.element.shape)];
    expect(keys.filter((k) => /combined|composite|overall|blend|aggregate|rank/i.test(k))).toEqual([]);
  });

  it('AT-FIL-04 (sentiment half): bullish sentiment is output unchanged and filing is untouched by it', async () => {
    for (const value of ['0.95', '1', '-1', '0']) {
      const view = buildPortfolioRiskView(await parts(value));
      expect(view.assets[0]?.sentiment.value).toBe(value);
      expect(view.assets[0]?.filing).toEqual({
        score: null,
        status: 'UNAVAILABLE',
        filingDate: null,
        sourceKind: null,
      });
    }
  });
});
