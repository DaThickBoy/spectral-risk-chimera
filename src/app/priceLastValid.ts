/**
 * Last valid market price for display only (task 11.5; design: Last valid price
 * rules 1 to 8; R25.3, R25.4, R25.5, R33.10).
 *
 * `createLastValidPriceValuationService({ valuation, store })` wraps the 11.1
 * service, as the 10.3 recording FX service wraps `FxService`. The 11.1 factory
 * and its rules are unchanged, and there is no on/off setting.
 *
 * 1. Key `ticker:positionCurrency:configuredKind`. `offer` throws `TypeError` for
 *    a quote whose currency or source kind differs from the key; a stored value
 *    whose kind differs from its key on read is also a `TypeError`. No fallback.
 * 2. Writes happen only after the inner `value()` resolves, in one synchronous
 *    loop in ticker order, and only for status `VALUED`, `FX_UNAVAILABLE`, or
 *    `FX_STALE` (never by `price !== null`). A rejected call writes nothing; late
 *    attempt results are never seen.
 * 3. Ordering by (`asOf`, `retrievedAt`): a strictly greater key replaces and
 *    clears a conflict; a smaller key is ignored; an equal key with identical
 *    content is unchanged; an equal key with different content is conflicted and
 *    shows nothing until a strictly greater key arrives. The final state does
 *    not depend on arrival order.
 * 4. Attachment only to an eligible `PRICE_UNAVAILABLE` (outage, timeout,
 *    invalid response, future date). Never to `HTTP_CLIENT_ERROR` (404 included),
 *    `UNEXPECTED_ERROR`, `CANCELLED`, or `PRICE_CURRENCY_MISMATCH`.
 * 5. Display only: the status and every market field are unchanged; the value
 *    never enters valuation, exposure, NAV, allocation, VaR, or alerts.
 * 8. In process memory, frozen copies; empty after a restart (5.3, OD-12).
 */
import type { ProviderQuote } from '../marketdata/index.js';
import { d, toCanonical } from '../shared/index.js';
import type { DecimalString, ProviderErrorCode } from '../shared/index.js';
import { createPositionValuationService } from './positionValuation.js';
import type {
  PositionValuation,
  PositionValuationDependencies,
  PositionValuationService,
  StalePriceDisplay,
} from './positionValuation.js';

export type PriceOfferOutcome = 'STORED' | 'IGNORED_OLDER' | 'UNCHANGED' | 'CONFLICTED';

export interface PriceLastValidStore {
  offer(quote: ProviderQuote, currency: string, kind: 'REAL' | 'DEMO'): PriceOfferOutcome;
  /** `undefined` when nothing was stored for the key or the entry is conflicted. */
  get(ticker: string, currency: string, kind: 'REAL' | 'DEMO'): StalePriceDisplay | undefined;
}

interface Entry {
  readonly value: StalePriceDisplay;
  readonly conflicted: boolean;
}

const keyOf = (ticker: string, currency: string, kind: string): string => `${ticker}:${currency}:${kind}`;

/** Fixed-width `IsoDate` and `IsoUtcMillis` text compare chronologically. */
const compareKeys = (a: StalePriceDisplay, b: StalePriceDisplay): number =>
  a.asOf < b.asOf
    ? -1
    : a.asOf > b.asOf
      ? 1
      : a.retrievedAt < b.retrievedAt
        ? -1
        : a.retrievedAt > b.retrievedAt
          ? 1
          : 0;

const sameContent = (a: StalePriceDisplay, b: StalePriceDisplay): boolean =>
  a.price === b.price && a.currency === b.currency && a.source === b.source && a.sourceKind === b.sourceKind;

function toDisplay(quote: ProviderQuote): StalePriceDisplay {
  return Object.freeze({
    kind: 'LAST_VALID_DISPLAY',
    status: 'STALE',
    label: 'LAST_VALID',
    ticker: quote.ticker,
    currency: quote.currency,
    price: toCanonical(d(quote.price)) as DecimalString,
    asOf: quote.asOf,
    source: quote.source,
    sourceKind: quote.sourceKind,
    retrievedAt: quote.retrievedAt,
  });
}

export function createPriceLastValidStore(): PriceLastValidStore {
  const entries = new Map<string, Entry>();
  return {
    offer: (quote, currency, kind) => {
      if (quote.currency !== currency) {
        throw new TypeError('Only a quote in the position currency can be stored.');
      }
      if (quote.sourceKind !== kind) {
        throw new TypeError('The quote source kind must equal the configured provider kind.');
      }
      const key = keyOf(quote.ticker, currency, kind);
      const candidate = toDisplay(quote);
      const existing = entries.get(key);
      if (existing === undefined) {
        entries.set(key, Object.freeze({ value: candidate, conflicted: false }));
        return 'STORED';
      }
      const order = compareKeys(candidate, existing.value);
      if (order > 0) {
        entries.set(key, Object.freeze({ value: candidate, conflicted: false }));
        return 'STORED';
      }
      if (order < 0) {
        return 'IGNORED_OLDER';
      }
      if (existing.conflicted) {
        return 'CONFLICTED';
      }
      if (sameContent(candidate, existing.value)) {
        return 'UNCHANGED';
      }
      entries.set(key, Object.freeze({ value: existing.value, conflicted: true }));
      return 'CONFLICTED';
    },
    get: (ticker, currency, kind) => {
      const entry = entries.get(keyOf(ticker, currency, kind));
      if (entry === undefined || entry.conflicted) {
        return undefined;
      }
      if (entry.value.sourceKind !== kind) {
        throw new TypeError('A stored last valid price does not match its key kind.');
      }
      return entry.value;
    },
  };
}

const WRITES: ReadonlySet<PositionValuation['status']> = new Set(['VALUED', 'FX_UNAVAILABLE', 'FX_STALE']);
const ELIGIBLE_PROVIDER_CODES: ReadonlySet<ProviderErrorCode> = new Set([
  'NETWORK_ERROR',
  'TIMEOUT',
  'HTTP_SERVER_ERROR',
  'RATE_LIMITED',
  'CIRCUIT_OPEN',
  'TLS_ERROR',
  'INVALID_RESPONSE',
]);

/** Rule 4: outage, timeout, invalid-response, and future-date failures only. */
function eligible(entry: Extract<PositionValuation, { status: 'PRICE_UNAVAILABLE' }>): boolean {
  switch (entry.cause) {
    case 'INVALID_RESPONSE':
    case 'FUTURE_DATED':
      return true;
    case 'PROVIDER_ERROR':
      return entry.providerCode !== undefined && ELIGIBLE_PROVIDER_CODES.has(entry.providerCode);
  }
}

export interface LastValidPriceValuationDependencies {
  /** Builds the 11.1 service internally; its provider kind keys the store. */
  readonly valuation: PositionValuationDependencies;
  readonly store: PriceLastValidStore;
}

export function createLastValidPriceValuationService(
  deps: LastValidPriceValuationDependencies,
): PositionValuationService {
  const store = deps.store as Partial<PriceLastValidStore> | undefined;
  if (typeof store?.offer !== 'function' || typeof store.get !== 'function') {
    throw new TypeError('store must be a PriceLastValidStore.');
  }
  const inner = createPositionValuationService(deps.valuation);
  const kind = deps.valuation.marketData.kind;
  const { store: lastValid } = deps;
  return {
    value: async (portfolioId, positions) => {
      // A rejected inner call rejects here, before anything is written (rule 2).
      const result = await inner.value(portfolioId, positions);
      // From here on, one synchronous step: writes (rule 2), then attachment (rule 4).
      for (const entry of result.positions) {
        if (WRITES.has(entry.status) && entry.price !== null) {
          lastValid.offer(entry.price, entry.view.currency, kind);
        }
      }
      const withDisplay = result.positions.map((entry): PositionValuation => {
        if (entry.status !== 'PRICE_UNAVAILABLE' || !eligible(entry)) {
          return entry;
        }
        const shown = lastValid.get(entry.view.ticker, entry.view.currency, kind);
        return shown === undefined ? entry : Object.freeze({ ...entry, lastValid: shown });
      });
      return Object.freeze({ ...result, positions: Object.freeze(withDisplay) });
    },
  };
}
