// Builders for risk engine tests (tasks 12.2 to 12.7). Decimals are Canonical Decimal Strings.
import type { FxRateUsed } from '../../src/fx/index.js';
import type { ReturnMatrix } from '../../src/marketdata/index.js';
import type { RiskInput, RiskPosition } from '../../src/risk/index.js';
import { brandDecimalString } from '../../src/shared/index.js';

export const dec = brandDecimalString;
export const EVALUATED_AT = '2026-11-06T21:00:00.000Z';

export const identityFx = (currency = 'USD'): FxRateUsed => ({
  kind: 'IDENTITY',
  pair: `${currency}${currency}`,
  rate: '1',
  observedAt: null,
  source: 'BASE_CURRENCY',
  sourceKind: 'IDENTITY',
  status: 'CURRENT',
});

export const observedFx = (
  currency: string,
  rate: string,
  status: 'CURRENT' | 'DEMO' = 'CURRENT',
  base = 'USD',
): FxRateUsed => ({
  kind: 'OBSERVED',
  pair: `${currency}${base}`,
  rate: dec(rate),
  observedAt: '2026-11-06T15:00:00.000Z',
  observedAtBasis: 'PROVIDER',
  source: status === 'DEMO' ? 'demo-fx' : 'test-fx',
  sourceKind: status === 'DEMO' ? 'DEMO' : 'REAL',
  status,
});

export const position = (
  ticker: string,
  signedQuantity: string,
  marketPrice: string,
  overrides: Partial<RiskPosition> = {},
): RiskPosition => ({
  ticker,
  signedQuantity: dec(signedQuantity),
  marketPrice: dec(marketPrice),
  currency: 'USD',
  fx: identityFx(),
  historySourceKind: 'REAL',
  ...overrides,
});

/** Dates 2026-01-01 onwards, one per return; the last is the as-of date. */
export function matrix(
  returns: Record<string, readonly string[]>,
  overrides: Partial<ReturnMatrix> = {},
  lookbackReturns?: number,
): ReturnMatrix {
  const n = Object.values(returns)[0]?.length ?? 0;
  const dates = Array.from({ length: n }, (_, i) => {
    const day = new Date(Date.UTC(2026, 0, 1 + i));
    return day.toISOString().slice(0, 10);
  });
  return {
    asOfDate: dates.at(-1) ?? '2026-01-01',
    dates,
    returns: Object.fromEntries(Object.entries(returns).map(([t, rs]) => [t, rs.map((r) => dec(r))])),
    n,
    status: lookbackReturns === undefined || n >= lookbackReturns ? 'COMPLETE' : 'REDUCED_LOOKBACK',
    limitingTicker: Object.keys(returns).sort()[0] ?? '',
    multiDayReturnCount: 0,
    seriesHashes: Object.fromEntries(Object.keys(returns).map((t) => [t, `${t.toLowerCase()}-hash`])),
    ...overrides,
  };
}

/** A valid input; lookback and minimum default to the matrix length. */
export function riskInput(
  positions: readonly RiskPosition[],
  returns: Record<string, readonly string[]>,
  overrides: Partial<RiskInput> = {},
): RiskInput {
  const n = Object.values(returns)[0]?.length ?? 2;
  return {
    portfolioId: 'pf-1',
    baseCurrency: 'USD',
    positions,
    cash: dec('100'),
    returns: positions.length === 0 ? null : matrix(returns),
    sentiment: [],
    params: {
      confidence: dec('0.95'),
      horizonDays: 1,
      lookbackReturns: Math.max(n, 2),
      minObservations: 2,
      adjustment: null,
    },
    adjustmentConfigMissing: ['adjustment.bearishThreshold', 'adjustment.multiplier'],
    marketDataStale: false,
    evaluatedAt: EVALUATED_AT,
    ...overrides,
  };
}
