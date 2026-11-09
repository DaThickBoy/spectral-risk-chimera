/**
 * Argument and dependency checks of the position valuation service (task 11.1;
 * design: Valuation rules 2 and 3). Every failure here is a programmer error and
 * throws `TypeError` before any provider call.
 */
import type { FxService } from '../fx/index.js';
import type { MarketDataProvider } from '../marketdata/index.js';
import { compareOrdinal } from '../portfolio/index.js';
import type { Position } from '../portfolio/index.js';
import { Iso4217Code, isDecimalText, isIsoUtcMillis } from '../shared/index.js';
import type { Clock, ResilientCall } from '../shared/index.js';

export interface ValuationDependencyShape {
  readonly marketData: MarketDataProvider;
  readonly resilientCall: ResilientCall;
  readonly fx: FxService;
  readonly clock: Clock;
}

export function assertValuationDependencies(deps: ValuationDependencyShape): void {
  const provider = deps.marketData as Partial<MarketDataProvider> | undefined;
  if (
    typeof provider !== 'object' ||
    provider === null ||
    typeof provider.name !== 'string' ||
    provider.name.length === 0 ||
    (provider.kind !== 'REAL' && provider.kind !== 'DEMO') ||
    typeof provider.getLatestPrice !== 'function'
  ) {
    throw new TypeError('marketData must be a MarketDataProvider with a name and a REAL or DEMO kind.');
  }
  if (typeof (deps.resilientCall as Partial<ResilientCall> | undefined)?.run !== 'function') {
    throw new TypeError('resilientCall must be a ResilientCall.');
  }
  if (typeof (deps.fx as Partial<FxService> | undefined)?.rateToBase !== 'function') {
    throw new TypeError('fx must be an FxService.');
  }
  if (typeof (deps.clock as Partial<Clock> | undefined)?.nowUtc !== 'function') {
    throw new TypeError('clock must be a Clock.');
  }
}

/**
 * Rule 3: `portfolioId` is a non-empty string; every position belongs to it, has a
 * non-empty unique ticker, an ISO 4217 currency, and a decimal `signedQuantity`.
 * Returns a new array sorted by ticker (ordinal).
 */
export function checkedPositions(portfolioId: unknown, positions: unknown): Position[] {
  if (typeof portfolioId !== 'string' || portfolioId.length === 0) {
    throw new TypeError('portfolioId must be a non-empty string.');
  }
  if (!Array.isArray(positions)) {
    throw new TypeError('positions must be an array.');
  }
  const tickers = new Set<string>();
  for (const candidate of positions as readonly unknown[]) {
    const position = candidate as Partial<Position> | null;
    if (typeof position !== 'object' || position === null) {
      throw new TypeError('every position must be an object.');
    }
    if (position.portfolioId !== portfolioId) {
      throw new TypeError('every position must belong to portfolioId.');
    }
    if (typeof position.ticker !== 'string' || position.ticker.length === 0) {
      throw new TypeError('every position must have a non-empty ticker.');
    }
    if (tickers.has(position.ticker)) {
      throw new TypeError('tickers must be unique.');
    }
    tickers.add(position.ticker);
    if (!Iso4217Code.safeParse(position.currency).success) {
      throw new TypeError('every position must have an ISO 4217 currency.');
    }
    if (typeof position.signedQuantity !== 'string' || !isDecimalText(position.signedQuantity)) {
      throw new TypeError('every position must have a decimal signedQuantity.');
    }
  }
  return [...(positions as readonly Position[])].sort((a, b) => compareOrdinal(a.ticker, b.ticker));
}

/** Rule 2: the calculation timestamp, read from the Clock exactly once per call. */
export function readValuationAt(clock: Clock): string {
  const now = clock.nowUtc();
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : undefined;
  if (!isIsoUtcMillis(at)) {
    throw new TypeError('clock must return a time that is a UTC timestamp YYYY-MM-DDTHH:mm:ss.sssZ.');
  }
  return at;
}
