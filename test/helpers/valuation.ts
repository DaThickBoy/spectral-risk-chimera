// Test helpers for task 11.1 (position valuation). FX settings are TEST values (OD-6 open), taken
// from test/helpers/fx.ts.
import { createPositionValuationService } from '../../src/app/index.js';
import type { PortfolioValuation, PositionValuationService } from '../../src/app/index.js';
import { createFxService } from '../../src/fx/index.js';
import type { FxProvider, FxService } from '../../src/fx/index.js';
import type { MarketDataProvider, ProviderQuote } from '../../src/marketdata/index.js';
import { positionId } from '../../src/portfolio/index.js';
import type { Position } from '../../src/portfolio/index.js';
import { appError, brandDecimalString } from '../../src/shared/index.js';
import type { ProviderError, ProviderErrorCode, Result } from '../../src/shared/index.js';
import { BASE, MAX_AGE_SECONDS, SUPPORTED } from './fx.js';
import { START, drive, harness } from './resilience.js';
import type { Harness } from './resilience.js';

export const PF = 'pf-valuation';
/** The valuation run's `at`: the harness clock start. */
export const RUN_AT = START;
export const RUN_DATE = START.slice(0, 10);
/** The exchange date of the quotes (the trading day before the run). */
export const QUOTE_DATE = '2026-11-06';
export const MD_NAME = 'fake-md';

/** A position as the 6.2 projector would produce it. */
export function pos(ticker: string, currency: string, signedQuantity: string, portfolioId = PF): Position {
  const flat = signedQuantity === '0';
  return {
    id: positionId(portfolioId, ticker),
    portfolioId,
    ticker,
    currency,
    signedQuantity: brandDecimalString(signedQuantity),
    averagePrice: flat ? null : brandDecimalString('1'),
    isShort: signedQuantity.startsWith('-'),
    updatedAt: '2026-11-01T10:00:00.000Z',
    source: 'csv:test',
  };
}

/** A quote as returned by a provider named `fake-md` (REAL). */
export function quoteOf(ticker: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ticker,
    currency: 'USD',
    price: '100',
    asOf: QUOTE_DATE,
    source: MD_NAME,
    sourceKind: 'REAL',
    retrievedAt: RUN_AT,
    ...overrides,
  };
}

export const okQuote = (value: unknown): { ok: true; value: unknown } => ({ ok: true, value });

export function mdFailure(code: ProviderErrorCode, httpStatus?: number): { ok: false; error: ProviderError } {
  return {
    ok: false,
    error: {
      ...appError(code, `Provider call ${MD_NAME} getLatestPrice failed (${code}).`),
      provider: MD_NAME,
      operation: 'getLatestPrice',
      attempts: 1,
      retryable: false,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    },
  };
}

export interface FakeMarketData extends MarketDataProvider {
  readonly calls: string[];
}

/** A market data provider whose `getLatestPrice` returns (or resolves to) whatever `respond` gives. */
export function fakeMarketData(
  respond: (ticker: string, call: number) => unknown,
  identity: { name?: string; kind?: 'REAL' | 'DEMO' } = {},
): FakeMarketData {
  const calls: string[] = [];
  return {
    name: identity.name ?? MD_NAME,
    kind: identity.kind ?? 'REAL',
    calls,
    getDailySeries: () => {
      throw new Error('not used by valuation');
    },
    getLatestPrice: (ticker) => {
      calls.push(ticker);
      return Promise.resolve(respond(ticker, calls.length)) as Promise<Result<ProviderQuote, ProviderError>>;
    },
  };
}

export interface ValuationSetup {
  readonly h: Harness;
  readonly service: PositionValuationService;
  /** Runs `value(PF, positions)` to completion under the fake clock. */
  readonly value: (positions: readonly Position[], portfolioId?: string) => Promise<PortfolioValuation>;
}

export interface ValuationOptions {
  readonly fx?: FxService | ((h: Harness) => FxService);
  readonly fxProvider?: FxProvider;
  readonly maxRetries?: number;
  readonly failureThreshold?: number;
}

/** `marketData` may be a factory, for providers that need the harness clock. */
export function valuationSetup(
  marketDataOrFactory: MarketDataProvider | ((h: Harness) => MarketDataProvider),
  options: ValuationOptions = {},
): ValuationSetup {
  const h = harness(
    { maxRetries: options.maxRetries ?? 0 },
    { failureThreshold: options.failureThreshold ?? 5 },
  );
  const marketData = typeof marketDataOrFactory === 'function' ? marketDataOrFactory(h) : marketDataOrFactory;
  const fx =
    (typeof options.fx === 'function' ? options.fx(h) : options.fx) ??
    createFxService({
      provider: options.fxProvider ?? failingFx(),
      resilientCall: h.rc,
      baseCurrency: BASE,
      supportedCurrencies: SUPPORTED,
      maxRateAgeSeconds: MAX_AGE_SECONDS,
    });
  const service = createPositionValuationService({ marketData, resilientCall: h.rc, fx, clock: h.clock });
  return {
    h,
    service,
    value: (positions, portfolioId = PF) => drive(h.sleeper, service.value(portfolioId, positions)),
  };
}

/** An FX provider that must not be called (every non-base lookup fails loudly). */
function failingFx(): FxProvider {
  return {
    name: 'unused-fx',
    kind: 'REAL',
    getRate: () => {
      throw new Error('FX provider not expected to be called');
    },
  };
}

/** A promise with its resolver, for providers that answer late. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
