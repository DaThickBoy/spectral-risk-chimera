/**
 * In-code fixture market data provider (task 9.1; R12.1, R12.2, R12.6, R27.3;
 * design: Market Data and FX, Port and normalization).
 *
 * Holds payloads in code: no JSON files and no parser (OD-16 is untouched). Its
 * kind is `DEMO`, so every result is `sourceKind: 'DEMO'` and can never pass as
 * real data. `source` is the provider name and `retrievedAt` comes from the
 * injected Clock. It does not use ResilientCall (no network).
 *
 * - `getDailySeries`: the ticker's series payload, normalized and limited to the
 *   inclusive range (received order, duplicates and defects kept).
 * - `getLatestPrice`: the ticker's quotes are all validated; the one with the
 *   latest `asOf` (exchange date) is returned. Equally latest quotes, or quotes
 *   that disagree on currency, are ambiguous: `INVALID_RESPONSE`.
 * - No fixture data for a ticker: `HTTP_CLIENT_ERROR` with `httpStatus: 404`.
 * - An invalid ticker or range throws `TypeError` synchronously, before any lookup.
 */
import { appError } from '../shared/index.js';
import type { Clock, ProviderError, Result } from '../shared/index.js';
import { assertDateRange, assertTicker, normalizeQuote, normalizeSeries } from './normalize.js';
import type { NormalizeContext } from './normalize.js';
import type { DateRange, MarketDataProvider, ProviderQuote, ProviderSeries } from './ports.js';

export interface MarketDataFixtures {
  /** Ticker -> one series payload `{ ticker, currency, observations }`. */
  readonly series?: Readonly<Record<string, unknown>>;
  /** Ticker -> an array of quote payloads `{ ticker, currency, asOf, price }`. */
  readonly quotes?: Readonly<Record<string, unknown>>;
}

export interface FixtureMarketDataProviderOptions {
  readonly name: string;
  readonly clock: Clock;
  readonly fixtures: MarketDataFixtures;
}

type Operation = 'getDailySeries' | 'getLatestPrice';

/** Own-property lookup only, so `__proto__`, `toString`, and similar never resolve. */
function lookup(table: Readonly<Record<string, unknown>> | undefined, ticker: string): unknown {
  return table !== undefined && Object.hasOwn(table, ticker) ? table[ticker] : undefined;
}

export class FixtureMarketDataProvider implements MarketDataProvider {
  readonly name: string;
  readonly kind = 'DEMO' as const;
  readonly #clock: Clock;
  readonly #fixtures: MarketDataFixtures;

  constructor(options: FixtureMarketDataProviderOptions) {
    if (typeof options.name !== 'string' || options.name.length === 0) {
      throw new TypeError('name must be a non-empty string.');
    }
    this.name = options.name;
    this.#clock = options.clock;
    this.#fixtures = options.fixtures;
  }

  getDailySeries(ticker: string, range: DateRange): Promise<Result<ProviderSeries, ProviderError>> {
    assertTicker(ticker);
    assertDateRange(range);
    const payload = lookup(this.#fixtures.series, ticker);
    if (payload === undefined) {
      return Promise.resolve(this.#fail('getDailySeries', 'HTTP_CLIENT_ERROR', 404));
    }
    const result = normalizeSeries(payload, range, this.#context(ticker));
    return Promise.resolve(result.ok ? result : this.#fail('getDailySeries', 'INVALID_RESPONSE'));
  }

  getLatestPrice(ticker: string): Promise<Result<ProviderQuote, ProviderError>> {
    assertTicker(ticker);
    const payloads = lookup(this.#fixtures.quotes, ticker);
    if (payloads === undefined || (Array.isArray(payloads) && payloads.length === 0)) {
      return Promise.resolve(this.#fail('getLatestPrice', 'HTTP_CLIENT_ERROR', 404));
    }
    if (!Array.isArray(payloads)) {
      return Promise.resolve(this.#fail('getLatestPrice', 'INVALID_RESPONSE'));
    }
    const context = this.#context(ticker);
    const quotes: ProviderQuote[] = [];
    for (const payload of payloads as readonly unknown[]) {
      const normalized = normalizeQuote(payload, context);
      if (!normalized.ok) {
        return Promise.resolve(this.#fail('getLatestPrice', 'INVALID_RESPONSE'));
      }
      quotes.push(normalized.value);
    }
    const [first, ...rest] = quotes;
    if (first === undefined || rest.some((quote) => quote.currency !== first.currency)) {
      return Promise.resolve(this.#fail('getLatestPrice', 'INVALID_RESPONSE'));
    }
    const latestDate = quotes.reduce(
      (latest, quote) => (quote.asOf > latest ? quote.asOf : latest),
      first.asOf,
    );
    const latest = quotes.filter((quote) => quote.asOf === latestDate);
    const [chosen] = latest;
    if (chosen === undefined || latest.length > 1) {
      // Equally latest quotes are ambiguous: never pick one arbitrarily.
      return Promise.resolve(this.#fail('getLatestPrice', 'INVALID_RESPONSE'));
    }
    return Promise.resolve({ ok: true, value: chosen });
  }

  #context(ticker: string): NormalizeContext {
    return {
      ticker,
      source: this.name,
      sourceKind: this.kind,
      retrievedAt: this.#clock.nowUtc().toISOString(),
    };
  }

  #fail(
    operation: Operation,
    code: 'INVALID_RESPONSE' | 'HTTP_CLIENT_ERROR',
    httpStatus?: number,
  ): { ok: false; error: ProviderError } {
    return {
      ok: false,
      error: {
        ...appError(code, `Provider call ${this.name} ${operation} failed (${code}).`),
        provider: this.name,
        operation,
        attempts: 1,
        retryable: false,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      },
    };
  }
}
