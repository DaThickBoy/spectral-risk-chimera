/**
 * Position valuation (task 11.1; design: Portfolio, Valuation rules 1 to 17;
 * FR-4, R5.2, R25.7, R25.8, R25.9, R30.6 to R30.9, R33.9).
 *
 * `createPositionValuationService({ marketData, resilientCall, fx, clock })`
 * values the positions of one portfolio in the base currency.
 *
 * Assumptions:
 * - Exposure uses the latest unadjusted Market Price (FR-4) and `Rate(X/B)` from
 *   the injected `FxService` (the 10.1 service or the 10.3 recording service):
 *   `marketValueInstrument = signedQuantity × price` and
 *   `marketValueBase = signedQuantity × price × Rate(X/B)`, both signed, in
 *   Decimal.js (`portfolio/toValuedPositionView`).
 * - The calculation timestamp `at` is read once per `value()` call from the
 *   Clock (rule 2). The FX rate is selected for the quote's own `asOf` and `at`
 *   (rule 10, R30.7) and is held constant (A-9).
 * - There is no price-age rule (rule 8): `priceAsOf` and the quote's
 *   `retrievedAt` are exposed instead. There is no last valid price, so R33.10
 *   and R25.3 are not fulfilled for prices here (task 11.5).
 *
 * Rules (numbers refer to the design):
 * 4. Each price is fetched once through `ResilientCall` under
 *    `marketdata:<provider name>`, mapped by `toPriceAttempt` (FX rule 4).
 *    Exceptions inside the operation become `UNEXPECTED_ERROR` (8.2, R25.9).
 * 4a. Re-validation (rule 6) and the future-date check (rule 7) run inside the
 *    operation. A rejected quote is a non-retryable `INVALID_RESPONSE` attempt
 *    that counts toward the circuit breaker, attributed to its own attempt only.
 * 5. The 9.1 port takes no AbortSignal: an attempt timeout bounds how long the
 *    valuation waits but cannot abort the provider's work. Only the `Result`
 *    returned by `run` is used, and results are frozen, so a late result never
 *    changes a valuation.
 * 9. A quote currency other than the position currency is
 *    `PRICE_CURRENCY_MISMATCH`; the price is never converted.
 * 10. `FX_UNAVAILABLE` and `FX_STALE` leave `marketValueBase` null; a display
 *    rate or last valid rate never enters a valuation. No rate is substituted.
 * 13. Within one call, identical FX keys (`currency`, `asOf`, `at`) share one
 *    call and its result. Nothing is cached across calls.
 * 14. Each position has its own status. Expected provider and FX failures
 *    become statuses; programmer errors (invalid arguments or positions, any
 *    exception thrown by `FxService`) reject `value()`.
 *
 * Results are frozen and never persisted; no event or audit record is written.
 */
import { z } from 'zod';
import type { FxError, FxRateUsed, FxService } from '../fx/index.js';
import type { MarketDataProvider, ProviderQuote } from '../marketdata/index.js';
import { toValuedPositionView } from '../portfolio/index.js';
import type { Position, PositionView, ValuationInput } from '../portfolio/index.js';
import {
  IsoDate,
  Iso4217Code,
  IsoUtcMillis,
  PositiveDecimalString,
  brandDecimalString,
} from '../shared/index.js';
import type { Clock, DecimalString, ProviderErrorCode, ResilientCall, Result } from '../shared/index.js';
import { toPriceAttempt } from './priceAttempt.js';
import { assertValuationDependencies, checkedPositions, readValuationAt } from './valuationArguments.js';

export const MARKET_DATA_PRICE_OPERATION = 'getLatestPrice';

/** Circuit and status key of a market data provider in `ResilientCall` (Valuation rule 4). */
export const marketDataCircuitKey = (providerName: string): string => `marketdata:${providerName}`;

export type PriceUnavailableCause = 'PROVIDER_ERROR' | 'INVALID_RESPONSE' | 'FUTURE_DATED';

/** One position. `status` always equals `view.valuationStatus`. */
export type PositionValuation =
  | {
      readonly status: 'VALUED';
      readonly view: PositionView;
      readonly priceAsOf: string;
      readonly price: ProviderQuote;
      readonly fx: FxRateUsed;
    }
  | {
      readonly status: 'FX_UNAVAILABLE' | 'FX_STALE';
      readonly view: PositionView;
      readonly priceAsOf: string;
      readonly price: ProviderQuote;
      readonly fx: null;
      /** Display only; never used in a valuation. */
      readonly fxError: FxError;
    }
  | {
      readonly status: 'PRICE_CURRENCY_MISMATCH';
      readonly view: PositionView;
      readonly priceAsOf: string;
      /** Kept for diagnosis; never used in a valuation. */
      readonly price: ProviderQuote;
      readonly fx: null;
    }
  | {
      readonly status: 'PRICE_UNAVAILABLE';
      readonly view: PositionView;
      readonly priceAsOf: null;
      readonly price: null;
      readonly fx: null;
      readonly cause: PriceUnavailableCause;
      readonly providerCode?: ProviderErrorCode;
      /** Task 11.5 only; display only (Last valid price rules). 11.1 never sets it. */
      readonly lastValid?: StalePriceDisplay;
    };

/**
 * Task 11.5: a display-only last valid price. Its `kind` and `status` make it
 * unassignable to `ProviderQuote` and to `ValuationInput`, so it can never enter
 * a valuation.
 */
export interface StalePriceDisplay {
  readonly kind: 'LAST_VALID_DISPLAY';
  readonly status: 'STALE';
  readonly label: 'LAST_VALID';
  readonly ticker: string;
  /** The key's position currency. */
  readonly currency: string;
  /** Canonical Decimal String. */
  readonly price: DecimalString;
  readonly asOf: string;
  readonly source: string;
  readonly sourceKind: 'REAL' | 'DEMO';
  readonly retrievedAt: string;
}

export interface PortfolioValuation {
  readonly portfolioId: string;
  /** `YYYY-MM-DDTHH:mm:ss.sssZ`, read once from the Clock per `value()` call. */
  readonly at: string;
  /** Ascending ticker (ordinal). */
  readonly positions: readonly PositionValuation[];
}

export interface PositionValuationService {
  /** Resolves for every expected provider or FX failure; rejects only for programmer errors. */
  value(portfolioId: string, positions: readonly Position[]): Promise<PortfolioValuation>;
}

export interface PositionValuationDependencies {
  /** The 9.1 port, unchanged. */
  readonly marketData: MarketDataProvider;
  /** 8.2, unchanged. */
  readonly resilientCall: ResilientCall;
  /** The 10.1 service or the 10.3 recording service. */
  readonly fx: FxService;
  readonly clock: Clock;
}

/** Rule 6: the quote is validated again, because the port is an interface. */
const QuoteSchema = z.strictObject({
  ticker: z.string().min(1),
  currency: Iso4217Code,
  price: PositiveDecimalString,
  asOf: IsoDate,
  source: z.string().min(1),
  sourceKind: z.enum(['REAL', 'DEMO']),
  retrievedAt: IsoUtcMillis,
});

type RejectionCause = 'INVALID_RESPONSE' | 'FUTURE_DATED';

type PriceLookup =
  | { readonly ok: true; readonly quote: ProviderQuote }
  | { readonly ok: false; readonly cause: PriceUnavailableCause; readonly providerCode?: ProviderErrorCode };

type RateLookup = (currency: string, asOf: string) => Promise<Result<FxRateUsed, FxError>>;

const INVALID_ATTEMPT = { ok: false, failure: 'INVALID_RESPONSE' } as const;

export function createPositionValuationService(
  deps: PositionValuationDependencies,
): PositionValuationService {
  assertValuationDependencies(deps);
  const { marketData, resilientCall, fx, clock } = deps;
  const circuitKey = marketDataCircuitKey(marketData.name);

  /** Rules 4, 4a, 6, and 7: one price lookup through ResilientCall. */
  const fetchPrice = async (ticker: string, runDate: string): Promise<PriceLookup> => {
    let attempts = 0;
    // Rejections by attempt number, so a late result of an abandoned attempt cannot
    // change the cause attributed to the last attempt.
    const rejections = new Map<number, RejectionCause>();
    const called = await resilientCall.run<ProviderQuote>(
      circuitKey,
      MARKET_DATA_PRICE_OPERATION,
      async () => {
        attempts += 1;
        const attempt = attempts; // index only, not a financial value
        const outcome = toPriceAttempt(await marketData.getLatestPrice(ticker));
        if (!outcome.ok) {
          return outcome;
        }
        const parsed = QuoteSchema.safeParse(outcome.value);
        if (
          !parsed.success ||
          parsed.data.ticker !== ticker ||
          parsed.data.source !== marketData.name ||
          parsed.data.sourceKind !== marketData.kind
        ) {
          rejections.set(attempt, 'INVALID_RESPONSE');
          return INVALID_ATTEMPT;
        }
        // Rule 7: fixed-width IsoDate text compares chronologically.
        if (parsed.data.asOf > runDate) {
          rejections.set(attempt, 'FUTURE_DATED');
          return INVALID_ATTEMPT;
        }
        const quote: ProviderQuote = Object.freeze({ ...parsed.data });
        return { ok: true, value: quote };
      },
    );
    if (called.ok) {
      return { ok: true, quote: called.value };
    }
    const own = rejections.get(attempts);
    if (called.error.code === 'INVALID_RESPONSE' && own !== undefined) {
      return { ok: false, cause: own };
    }
    return { ok: false, cause: 'PROVIDER_ERROR', providerCode: called.error.code };
  };

  /** Rules 9 to 12 for one position. */
  const valueOne = async (
    position: Position,
    runDate: string,
    rateFor: RateLookup,
  ): Promise<PositionValuation> => {
    const priced = await fetchPrice(position.ticker, runDate);
    if (!priced.ok) {
      return Object.freeze({
        status: 'PRICE_UNAVAILABLE',
        view: Object.freeze(toValuedPositionView(position, { status: 'PRICE_UNAVAILABLE' })),
        priceAsOf: null,
        price: null,
        fx: null,
        cause: priced.cause,
        ...(priced.providerCode === undefined ? {} : { providerCode: priced.providerCode }),
      });
    }
    const { quote } = priced;
    if (quote.currency !== position.currency) {
      return Object.freeze({
        status: 'PRICE_CURRENCY_MISMATCH',
        view: Object.freeze(toValuedPositionView(position, { status: 'PRICE_CURRENCY_MISMATCH' })),
        priceAsOf: quote.asOf,
        price: quote,
        fx: null,
      });
    }
    // Exceptions thrown by the FxService are programmer errors and propagate.
    const rate = await rateFor(position.currency, quote.asOf);
    if (rate.ok) {
      const input: ValuationInput = {
        status: 'VALUED',
        price: quote.price,
        rate: brandDecimalString(rate.value.rate),
      };
      return Object.freeze({
        status: 'VALUED',
        view: Object.freeze(toValuedPositionView(position, input)),
        priceAsOf: quote.asOf,
        price: quote,
        fx: rate.value,
      });
    }
    const status = rate.error.code;
    return Object.freeze({
      status,
      view: Object.freeze(toValuedPositionView(position, { status, price: quote.price })),
      priceAsOf: quote.asOf,
      price: quote,
      fx: null,
      fxError: rate.error,
    });
  };

  return {
    value: async (portfolioId, positions): Promise<PortfolioValuation> => {
      const sorted = checkedPositions(portfolioId, positions);
      const at = readValuationAt(clock);
      const runDate = at.slice(0, 10);

      // Rule 13: identical FX keys share one call within this value() call only.
      const rates = new Map<string, Promise<Result<FxRateUsed, FxError>>>();
      const rateFor: RateLookup = (currency, asOf) => {
        const key = JSON.stringify([currency, asOf, at]);
        let pending = rates.get(key);
        if (pending === undefined) {
          pending = fx.rateToBase(currency, asOf, at);
          rates.set(key, pending);
        }
        return pending;
      };

      // Rule 14: positions are valued concurrently; results are in ticker order.
      const valued = await Promise.all(sorted.map((position) => valueOne(position, runDate, rateFor)));
      return Object.freeze({ portfolioId, at, positions: Object.freeze(valued) });
    },
  };
}
