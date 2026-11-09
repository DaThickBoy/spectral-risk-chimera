// Harness for the risk input builder, risk service, snapshots, and routes (tasks 12.3 to 12.6).
// The valuation is a fake (prices and FX rates fixed per ticker); history goes through the real
// 9.4 series store and the real 9.3 returns builder. Settings are TEST values (OD-6 open).
import {
  createRiskInputBuilder,
  createRiskService,
  createSeriesStore,
  seriesStoreHistory,
} from '../../src/app/index.js';
import type {
  PortfolioValuation,
  PositionValuation,
  PositionValuationService,
  RiskConfigView,
  RiskSentimentSource,
} from '../../src/app/index.js';
import { FEATURES } from '../../src/config/index.js';
import type { ConfigVersion, Feature } from '../../src/config/index.js';
import type { FxError, FxRateUsed } from '../../src/fx/index.js';
import { createReturnsBuilder } from '../../src/marketdata/index.js';
import type { CleanResult } from '../../src/marketdata/index.js';
import { InMemoryUnitOfWork } from '../../src/persistence/index.js';
import { positionId, toPositionView } from '../../src/portfolio/index.js';
import { riskEngine } from '../../src/risk/index.js';
import {
  FakeClock,
  appError,
  brandDecimalString,
  canonicalJson,
  sequentialIds,
  sha256Hex,
} from '../../src/shared/index.js';
import { completeTestConfig, withKey } from './config.js';
import { identityFx, observedFx } from './risk.js';

export const PF = 'pf-risk';
export const NOW = '2026-11-08T12:00:00.000Z';
export const VERSION: ConfigVersion = { seq: 1, hash: 'c'.repeat(64) };

const available = { available: true, missingKeys: [], invalidKeys: [], blockedBy: [], restrictedBy: [] };

/** All features available with `completeTestConfig()`, except the listed keys (missing). */
export function configView(missing: readonly string[] = [], values = completeTestConfig()): RiskConfigView {
  let config = values;
  for (const key of missing) {
    config = withKey(config, key, undefined);
  }
  const features = Object.fromEntries(
    FEATURES.map((f) => [f, { ...available, missingKeys: [] as string[] }]),
  ) as unknown as Record<
    Feature,
    {
      available: boolean;
      missingKeys: string[];
      invalidKeys: string[];
      blockedBy: Feature[];
      restrictedBy: string[];
    }
  >;
  const owner = (key: string): Feature[] =>
    key.startsWith('adjustment.') || key.startsWith('sentiment.') ? ['adjustedVaR'] : ['baseVaR'];
  for (const key of missing) {
    for (const feature of owner(key)) {
      features[feature].missingKeys.push(key);
      features[feature].available = false;
    }
  }
  if (!features.baseVaR.available) {
    features.adjustedVaR.available = false;
    features.adjustedVaR.blockedBy = ['baseVaR'];
  }
  return { features, values: config } as unknown as RiskConfigView;
}

export type PriceSpec =
  | { readonly price: string; readonly currency?: string; readonly fx?: FxRateUsed }
  | 'FX_UNAVAILABLE'
  | 'FX_STALE'
  | 'PRICE_UNAVAILABLE'
  | 'PRICE_CURRENCY_MISMATCH';

/** A valuation fake: fixed price and FX per ticker; `at` is the calculation time. */
export function fakeValuation(specs: Record<string, PriceSpec>, at = NOW): PositionValuationService {
  return {
    value: async (portfolioId, positions): Promise<PortfolioValuation> => ({
      portfolioId,
      at,
      positions: positions.map((position): PositionValuation => {
        const spec = specs[position.ticker] ?? 'PRICE_UNAVAILABLE';
        const view = toPositionView(position);
        if (spec === 'PRICE_UNAVAILABLE') {
          return {
            status: 'PRICE_UNAVAILABLE',
            view,
            priceAsOf: null,
            price: null,
            fx: null,
            cause: 'PROVIDER_ERROR',
          };
        }
        const quote = {
          ticker: position.ticker,
          currency: position.currency,
          price: brandDecimalString(typeof spec === 'string' ? '1' : spec.price),
          asOf: '2026-11-06',
          source: 'test-md',
          sourceKind: 'REAL' as const,
          retrievedAt: at,
        };
        if (spec === 'FX_UNAVAILABLE' || spec === 'FX_STALE') {
          const fxError = { ...appError(spec, 'FX'), currency: position.currency } as unknown as FxError;
          return { status: spec, view, priceAsOf: quote.asOf, price: quote, fx: null, fxError };
        }
        if (spec === 'PRICE_CURRENCY_MISMATCH') {
          const other = position.currency === 'USD' ? 'EUR' : 'USD';
          return {
            status: 'PRICE_CURRENCY_MISMATCH',
            view,
            priceAsOf: quote.asOf,
            price: { ...quote, currency: other },
            fx: null,
          };
        }
        const fx =
          spec.fx ?? (position.currency === 'USD' ? identityFx() : observedFx(position.currency, '1.1'));
        return { status: 'VALUED', view, priceAsOf: quote.asOf, price: quote, fx };
      }),
    }),
  };
}

/** Consecutive calendar dates from `start`, one per price. */
export function cleanSeries(
  ticker: string,
  prices: readonly string[],
  options: { start?: string; currency?: string; sourceKind?: 'REAL' | 'DEMO' } = {},
): CleanResult {
  const start = Date.parse(`${options.start ?? '2026-01-01'}T00:00:00Z`);
  const observations = prices.map((p, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    adjustedClose: brandDecimalString(p),
  }));
  const currency = options.currency ?? 'USD';
  return {
    series: {
      ticker,
      currency,
      source: 'test-md',
      sourceKind: options.sourceKind ?? 'REAL',
      retrievedAt: '2026-11-08T06:00:00.000Z',
      observations,
      contentHash: sha256Hex(canonicalJson({ ticker, currency, observations })),
    },
    discarded: {
      missing: 0,
      nonFinite: 0,
      nonPositive: 0,
      nonTradingDate: 0,
      duplicateCollapsed: 0,
      conflicting: 0,
    },
    conflict: false,
    conflictDates: [],
  };
}

export interface RiskHarnessOptions {
  readonly missing?: readonly string[];
  readonly values?: Record<string, unknown>;
  readonly prices?: Record<string, PriceSpec>;
  readonly at?: string;
  readonly version?: ConfigVersion;
  readonly historyKind?: 'REAL' | 'DEMO';
  readonly uow?: InMemoryUnitOfWork;
  readonly sentiment?: RiskSentimentSource;
}

/** Portfolio PF (cash 100 USD) with positions `{ ticker: [currency, signedQuantity] }`. */
export function riskHarness(
  positions: Record<string, readonly [string, string]>,
  options: RiskHarnessOptions = {},
) {
  const uow = options.uow ?? new InMemoryUnitOfWork();
  if (options.uow === undefined) {
    uow.run((tx) => {
      tx.portfolios.insert({ id: PF, baseCurrency: 'USD', cash: brandDecimalString('100') });
      for (const [ticker, [currency, qty]] of Object.entries(positions)) {
        const flat = qty === '0';
        tx.positions.upsert({
          id: positionId(PF, ticker),
          portfolioId: PF,
          ticker,
          currency,
          signedQuantity: brandDecimalString(qty),
          averagePrice: flat ? null : brandDecimalString('1'),
          isShort: qty.startsWith('-'),
          source: 'csv:test',
          updatedAt: '2026-11-01T10:00:00.000Z',
        });
      }
    });
  }
  const seriesStore = createSeriesStore({ unitOfWork: uow });
  const returns = createReturnsBuilder();
  const clock = new FakeClock(NOW);
  const ids = sequentialIds('r');
  const config = configView(options.missing ?? [], options.values ?? completeTestConfig());
  const builder = createRiskInputBuilder({
    config,
    unitOfWork: uow,
    valuation: fakeValuation(options.prices ?? {}, options.at ?? NOW),
    history: seriesStoreHistory(seriesStore, options.historyKind ?? 'REAL'),
    returns,
    ...(options.sentiment === undefined ? {} : { sentiment: options.sentiment }),
  });
  const service = createRiskService({
    builder,
    compute: async (input) => riskEngine.compute(input),
    engine: riskEngine,
    unitOfWork: uow,
    clock,
    ids,
    configVersion: options.version ?? VERSION,
    maxReturnGapDays: 5,
    seriesStore,
    returns,
    display: () => ({ filingScores: [] }),
  });
  const putSeries = (series: CleanResult) => {
    const outcome = seriesStore.put(series);
    if (!outcome.ok) {
      throw new Error(outcome.error.code);
    }
  };
  return { uow, seriesStore, returns, clock, builder, service, putSeries, config };
}

/** `n + 1` prices giving `n` returns: alternating moves around 100 for a deterministic loss spread. */
export function pricePath(n: number, scale = 1): string[] {
  const prices = ['100'];
  for (let i = 1; i <= n; i += 1) {
    // integer cents so every price is exact text; a sequence index, not a financial calculation
    const cents = 10_000 + ((i * 37) % 23) * 10 * scale - 110 * scale;
    prices.push(`${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`);
  }
  return prices;
}
