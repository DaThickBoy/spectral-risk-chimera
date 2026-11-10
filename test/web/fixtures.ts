// Hand-written dashboard responses for component tests (task 17.3). Every object is validated
// with the shared contract when it is built, so a contract change fails these fixtures instead
// of silently testing an outdated shape. Values mirror a DEMO run with ECB-derived rates; they are
// test data, not market data.
import {
  DashboardIndexResponseSchema,
  DashboardViewResponseSchema,
} from '../../src/shared/apiContracts/index.js';
import type { DashboardIndexResponse, DashboardViewResponse } from '../../src/shared/apiContracts/index.js';

const NOTES = [
  'Derived by inverting the published ECB euro reference rate (1 / EUR->X); not identical to the published reference rate.',
  'The ECB euro foreign exchange reference rates are published for information purposes only.',
];
export const OD1_TEXT =
  'No sentiment aggregation method is approved (open decision OD-1), so no sentiment index can be current and Adjusted VaR is not calculated.';

const bucket = (lower: string, upper: string, count: number, lowerDisplay: string, upperDisplay: string) => ({
  lower,
  upper,
  upperInclusive: false,
  count,
  lowerDisplay,
  upperDisplay,
});

const ecbRate = (currency: string, rate: string) => ({
  pair: `${currency}EUR`,
  rate,
  observedAt: '2026-11-06T15:00:00.000Z',
  observedAtBasis: 'PUBLICATION_CONVENTION' as const,
  conventionId: 'ECB-PUB-1600-FRANKFURT-v1',
  source: 'ECB-EXR',
  sourceKind: 'REAL' as const,
  status: 'CURRENT' as const,
  attribution: {
    statement: 'Source: ECB statistics.',
    derivation: 'DERIVED_INVERSE' as const,
    publishedPair: `EUR${currency}`,
    referenceDate: '2026-11-06',
    method: 'DECIMAL_INVERSE' as const,
    precision: { significantDigits: 40 as const, rounding: 'ROUND_HALF_UP' as const },
    notes: NOTES,
  },
  quote: {
    pair: `EUR${currency}`,
    rate: currency === 'USD' ? '1.1165' : '0.83415',
    referenceDate: '2026-11-06',
    method: 'DECIMAL_INVERSE' as const,
    precision: 'SIGNIFICANT_DIGITS_40_ROUND_HALF_UP' as const,
  },
});
const identity = {
  pair: 'EUREUR',
  rate: '1',
  observedAt: null,
  source: 'BASE_CURRENCY',
  sourceKind: 'IDENTITY' as const,
  status: 'CURRENT' as const,
};

const asset = (
  ticker: string,
  currency: string,
  qty: string,
  price: string,
  base: string | null,
  alloc: string | null,
  status = 'VALUED',
) => ({
  ticker,
  currency,
  signedQuantity: qty,
  marketPrice: price,
  priceProvenance: {
    asOf: '2026-11-06',
    source: 'demo-fixtures-md',
    sourceKind: 'DEMO' as const,
    retrievedAt: '2026-11-06T16:00:00.000Z',
  },
  lastValidPrice: null,
  marketValueBase: base,
  valuationStatus: status,
  allocationPct: alloc,
  sentiment: {
    value: null,
    status: 'UNAVAILABLE' as const,
    sourceKind: null,
    observedAt: null,
    basis: 'NONE' as const,
  },
  filing: { score: null, status: 'UNAVAILABLE' as const, filingDate: null, sourceKind: null },
  adjustment: { triggered: false, effectiveSentiment: null, direction: null, multiplier: null },
  riskContribution: null,
});

const unavailableAdjusted = {
  validity: 'UNAVAILABLE' as const,
  value: null,
  status: 'ADJUSTMENT_CONFIG_MISSING',
  reason: { missingConfigKeys: ['sentiment.maxAgeSeconds'], ineligibleTickers: [], code: null },
  lastValid: null,
};
const explanation = `${OD1_TEXT} Unavailable: adjustment settings are missing (sentiment.maxAgeSeconds).`;

/** The seeded multi-currency portfolio with current ECB-derived rates. */
export function multiCurrencyView(): DashboardViewResponse {
  return DashboardViewResponseSchema.parse({
    schemaVersion: 2,
    portfolioId: 'demo-eur-usd-gbp',
    generatedAt: '2026-11-06T16:00:01.000Z',
    runMode: 'DEMO_FIXTURES',
    dataMode: 'DEMO',
    view: {
      portfolioId: 'demo-eur-usd-gbp',
      baseCurrency: 'EUR',
      exposure: {
        status: 'OK',
        nav: '22375.74282227089642029897131621579593602',
        long: '21375.74282227089642029897131621579593602',
        short: '0',
        gross: '21375.74282227089642029897131621579593602',
        net: '21375.74282227089642029897131621579593602',
        cash: '1000',
      },
      confidence: '0.95',
      horizonDays: 1,
      baseVaR: {
        validity: 'CURRENT',
        value: {
          absolute: '124.095376636618777169053781414066570861',
          rawQuantile: '124.095376636618777169053781414066570861',
          percentOfNav: '0.5545977964722801352876283961402434634723',
        },
        status: 'OK',
        reason: { missingConfigKeys: [], ineligibleTickers: [], code: null },
        lastValid: null,
      },
      sentimentAdjustedVaR: unavailableAdjusted,
      varDifference: null,
      adjustmentExplanation: explanation,
      assets: [
        asset('DEMO-EU', 'EUR', '100', '89.9429', '8994.29', '40.2'),
        asset('DEMO-UK', 'GBP', '150', '37.0092', '6655.133968710663549721273152310735479231', '29.74'),
        asset('DEMO-US', 'USD', '50', '127.8687', '5726.318853560232870577698163905060456785', '25.59'),
      ],
      calculation: {
        status: 'OK',
        flags: ['DEMO_DATA'],
        missingConfigKeys: [],
        asOfDate: '2026-11-06',
        calculatedAt: '2026-11-06T16:00:00.000Z',
      },
    },
    fx: [
      { currency: 'EUR', status: 'IDENTITY', rate: identity, unavailable: null, tickers: ['DEMO-EU'] },
      {
        currency: 'GBP',
        status: 'CURRENT',
        rate: ecbRate('GBP', '1.198825151351675357549601390637175567944'),
        unavailable: null,
        tickers: ['DEMO-UK'],
      },
      {
        currency: 'USD',
        status: 'CURRENT',
        rate: ecbRate('USD', '0.8956560680698611733094491715181370353784'),
        unavailable: null,
        tickers: ['DEMO-US'],
      },
    ],
    currencyExposure: [
      { currency: 'EUR', status: 'OK', marketValueBase: '8994.29', tickers: ['DEMO-EU'] },
      {
        currency: 'GBP',
        status: 'OK',
        marketValueBase: '6655.133968710663549721273152310735479231',
        tickers: ['DEMO-UK'],
      },
      {
        currency: 'USD',
        status: 'OK',
        marketValueBase: '5726.318853560232870577698163905060456785',
        tickers: ['DEMO-US'],
      },
    ],
    adjustedVaRAvailability: {
      aggregation: 'NOT_APPROVED',
      reasonCode: 'AGGREGATION_NOT_APPROVED',
      openDecision: 'OD-1',
      explanation,
    },
    filing: {
      status: 'NOT_CONFIGURED',
      explanation:
        'SEC filing risk is not configured in this demonstration (Kiroween decision H8); no filing score exists.',
    },
    // The A2 known-answer case (losses -2..7, K = 4), small enough to read in component tests.
    lossDistribution: {
      status: 'AVAILABLE',
      metric: 'BASE_VAR_SCENARIO_LOSSES',
      currency: 'EUR',
      confidence: '0.95',
      horizonDays: 1,
      quantileMethod: 'HYNDMAN_FAN_TYPE_7',
      calculatedAt: '2026-11-06T16:00:00.000Z',
      scenarioWindow: { firstDate: '2026-10-23', lastDate: '2026-11-06' },
      scenarioCount: 10,
      bucketCount: 4,
      width: '2.25',
      widthDisplay: '2.25',
      min: '-2',
      max: '7',
      buckets: [
        bucket('-2', '0.25', 3, '-2.00', '0.25'),
        bucket('0.25', '2.5', 2, '0.25', '2.50'),
        bucket('2.5', '4.75', 2, '2.50', '4.75'),
        { ...bucket('4.75', '7', 3, '4.75', '7.00'), upperInclusive: true },
      ],
      varMarker: {
        rawQuantile: '6.55',
        rawQuantileDisplay: '6.55',
        confidence: '0.95',
        bucketIndex: 3,
        scenariosAbove: 1,
        position: '3.8',
      },
    },
    display: {
      currency: 'EUR',
      minorUnits: 2,
      exposure: {
        nav: '22375.74',
        long: '21375.74',
        short: '0.00',
        gross: '21375.74',
        net: '21375.74',
        cash: '1000.00',
      },
      baseVaR: '124.10',
      baseVaRLastValid: null,
      adjustedVaR: null,
      varDifference: null,
      assets: [
        { ticker: 'DEMO-EU', marketValueBase: '8994.29' },
        { ticker: 'DEMO-UK', marketValueBase: '6655.13' },
        { ticker: 'DEMO-US', marketValueBase: '5726.32' },
      ],
      currencyExposure: [
        { currency: 'EUR', marketValueBase: '8994.29' },
        { currency: 'GBP', marketValueBase: '6655.13' },
        { currency: 'USD', marketValueBase: '5726.32' },
      ],
    },
    freshness: {
      calculatedAt: '2026-11-06T16:00:00.000Z',
      asOfDate: '2026-11-06',
      flags: ['DEMO_DATA'],
      fxStatuses: ['CURRENT', 'IDENTITY'],
      summary: 'CURRENT',
    },
  });
}

/** The same portfolio when the GBP rate is stale and the USD rate unavailable: Base VaR unavailable. */
export function fxProblemView(): DashboardViewResponse {
  const base = multiCurrencyView();
  return DashboardViewResponseSchema.parse({
    ...base,
    view: {
      ...base.view,
      exposure: {
        status: 'EXPOSURE_UNAVAILABLE',
        nav: null,
        long: null,
        short: null,
        gross: null,
        net: null,
        cash: '1000',
      },
      baseVaR: {
        validity: 'UNAVAILABLE',
        value: null,
        status: 'FX_UNAVAILABLE',
        reason: { missingConfigKeys: [], ineligibleTickers: [], code: 'FX_UNAVAILABLE' },
        lastValid: null,
      },
      sentimentAdjustedVaR: { ...unavailableAdjusted, status: 'BASE_UNAVAILABLE' },
      assets: [
        asset('DEMO-EU', 'EUR', '100', '89.9429', '8994.29', null),
        asset('DEMO-UK', 'GBP', '150', '37.0092', null, null, 'FX_STALE'),
        asset('DEMO-US', 'USD', '50', '127.8687', null, null, 'FX_UNAVAILABLE'),
      ],
      calculation: { ...base.view.calculation, status: 'FX_UNAVAILABLE' },
    },
    lossDistribution: {
      status: 'UNAVAILABLE',
      reason: 'BASE_VAR_UNAVAILABLE',
      explanation: 'Base VaR is unavailable (FX_UNAVAILABLE), so no scenario loss distribution is shown.',
    },
    fx: [
      base.fx[0],
      {
        currency: 'GBP',
        status: 'STALE',
        rate: null,
        unavailable: { code: 'FX_STALE', currency: 'GBP' },
        tickers: ['DEMO-UK'],
      },
      {
        currency: 'USD',
        status: 'UNAVAILABLE',
        rate: null,
        unavailable: {
          code: 'FX_UNAVAILABLE',
          currency: 'USD',
          cause: 'PROVIDER_ERROR',
          providerCode: 'HTTP_SERVER_ERROR',
        },
        tickers: ['DEMO-US'],
      },
    ],
    currencyExposure: [
      { currency: 'EUR', status: 'OK', marketValueBase: '8994.29', tickers: ['DEMO-EU'] },
      { currency: 'GBP', status: 'UNAVAILABLE', marketValueBase: null, tickers: ['DEMO-UK'] },
      { currency: 'USD', status: 'UNAVAILABLE', marketValueBase: null, tickers: ['DEMO-US'] },
    ],
    display: {
      ...base.display,
      exposure: { nav: null, long: null, short: null, gross: null, net: null, cash: '1000.00' },
      baseVaR: null,
      assets: [
        { ticker: 'DEMO-EU', marketValueBase: '8994.29' },
        { ticker: 'DEMO-UK', marketValueBase: null },
        { ticker: 'DEMO-US', marketValueBase: null },
      ],
      currencyExposure: [
        { currency: 'EUR', marketValueBase: '8994.29' },
        { currency: 'GBP', marketValueBase: null },
        { currency: 'USD', marketValueBase: null },
      ],
    },
    freshness: {
      ...base.freshness,
      fxStatuses: ['IDENTITY', 'STALE', 'UNAVAILABLE'],
      summary: 'FX_UNAVAILABLE',
    },
  });
}

export function demoIndex(): DashboardIndexResponse {
  return DashboardIndexResponseSchema.parse({
    schemaVersion: 2,
    generatedAt: '2026-11-06T16:00:01.000Z',
    runMode: 'DEMO_FIXTURES',
    portfolios: [
      { id: 'demo-eur-usd-gbp', baseCurrency: 'EUR' },
      { id: 'demo-eur-only', baseCurrency: 'EUR' },
    ],
  });
}
