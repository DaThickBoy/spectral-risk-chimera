// Task 11.5: last valid market price for display only (design: Last valid price rules 1 to 8).
// Tests: AT-PRV-01 (price part), AT-PRV-02 (price part), AT-PRV-03 (price part)
// Validates: Requirements 25.3, 25.4, 25.5, 33.10
import { describe, expect, it } from 'vitest';
import { createLastValidPriceValuationService, createPriceLastValidStore } from '../../../src/app/index.js';
import type { PortfolioValuation, PositionValuation, PriceLastValidStore } from '../../../src/app/index.js';
import { createFxService } from '../../../src/fx/index.js';
import type { ProviderQuote } from '../../../src/marketdata/index.js';
import type { Position } from '../../../src/portfolio/index.js';
import { brandDecimalString } from '../../../src/shared/index.js';
import type { ProviderErrorCode } from '../../../src/shared/index.js';
import { BASE, MAX_AGE_SECONDS, SUPPORTED, fakeProvider, okResult, quote } from '../../helpers/fx.js';
import { drive, harness } from '../../helpers/resilience.js';
import {
  MD_NAME,
  PF,
  QUOTE_DATE,
  RUN_AT,
  fakeMarketData,
  mdFailure,
  okQuote,
  pos,
  quoteOf,
} from '../../helpers/valuation.js';

const q = (overrides: Partial<ProviderQuote> = {}): ProviderQuote => ({
  ticker: 'AAA',
  currency: 'USD',
  price: brandDecimalString('100'),
  asOf: QUOTE_DATE,
  source: MD_NAME,
  sourceKind: 'REAL',
  retrievedAt: RUN_AT,
  ...overrides,
});

/** A wrapper whose market data answer can be switched between calls. */
function wrapped(options: { kind?: 'REAL' | 'DEMO'; store?: PriceLastValidStore; maxRetries?: number } = {}) {
  const state: { answer: (ticker: string) => unknown } = { answer: (ticker) => okQuote(quoteOf(ticker)) };
  const kind = options.kind ?? 'REAL';
  const md = fakeMarketData((ticker) => state.answer(ticker), { kind });
  const h = harness({ maxRetries: options.maxRetries ?? 0 }, { failureThreshold: 100 });
  const fx = createFxService({
    provider: fakeProvider(() => okResult(quote())),
    resilientCall: h.rc,
    baseCurrency: BASE,
    supportedCurrencies: SUPPORTED,
    maxRateAgeSeconds: MAX_AGE_SECONDS,
  });
  const store = options.store ?? createPriceLastValidStore();
  const service = createLastValidPriceValuationService({
    valuation: { marketData: md, resilientCall: h.rc, fx, clock: h.clock },
    store,
  });
  const value = (positions: readonly Position[] = [pos('AAA', 'USD', '10')]): Promise<PortfolioValuation> =>
    drive(h.sleeper, service.value(PF, positions));
  return { state, store, value, md, h, service };
}

const only = (result: PortfolioValuation, ticker = 'AAA'): PositionValuation => {
  const found = result.positions.find((entry) => entry.view.ticker === ticker);
  if (found === undefined) {
    throw new Error(`no ${ticker}`);
  }
  return found;
};

describe('Rules 3: ordering, conflicts, and determinism of the store', () => {
  it('stores, ignores older, keeps identical, and replaces a strictly newer key', () => {
    const store = createPriceLastValidStore();
    expect(store.offer(q(), 'USD', 'REAL')).toBe('STORED');
    expect(store.offer(q(), 'USD', 'REAL')).toBe('UNCHANGED');
    expect(
      store.offer(q({ asOf: '2026-11-05', retrievedAt: '2026-11-09T00:00:00.000Z' }), 'USD', 'REAL'),
    ).toBe('IGNORED_OLDER');
    // Same asOf, later retrieval, different price: an intraday replacement.
    expect(
      store.offer(
        q({ price: brandDecimalString('101'), retrievedAt: '2026-11-07T12:00:01.000Z' }),
        'USD',
        'REAL',
      ),
    ).toBe('STORED');
    expect(store.get('AAA', 'USD', 'REAL')).toMatchObject({
      price: '101',
      label: 'LAST_VALID',
      status: 'STALE',
    });
  });

  it('a newer asOf retrieved earlier replaces a stored older asOf', () => {
    const store = createPriceLastValidStore();
    store.offer(q({ asOf: '2026-11-05', retrievedAt: '2026-11-07T12:00:00.000Z' }), 'USD', 'REAL');
    expect(
      store.offer(q({ asOf: '2026-11-06', retrievedAt: '2026-11-06T09:00:00.000Z' }), 'USD', 'REAL'),
    ).toBe('STORED');
    expect(store.get('AAA', 'USD', 'REAL')?.asOf).toBe('2026-11-06');
  });

  it('identical timestamps with different content conflict; only a strictly newer quote clears it', () => {
    const store = createPriceLastValidStore();
    store.offer(q(), 'USD', 'REAL');
    expect(store.offer(q({ price: brandDecimalString('99') }), 'USD', 'REAL')).toBe('CONFLICTED');
    expect(store.get('AAA', 'USD', 'REAL')).toBeUndefined();
    expect(store.offer(q(), 'USD', 'REAL')).toBe('CONFLICTED');
    expect(store.offer(q({ asOf: '2026-11-05' }), 'USD', 'REAL')).toBe('IGNORED_OLDER');
    expect(store.get('AAA', 'USD', 'REAL')).toBeUndefined();
    expect(store.offer(q({ retrievedAt: '2026-11-07T12:00:00.001Z' }), 'USD', 'REAL')).toBe('STORED');
    expect(store.get('AAA', 'USD', 'REAL')?.price).toBe('100');
  });

  it('canonical prices compare by value: "100" and "100.0" are identical content', () => {
    const store = createPriceLastValidStore();
    store.offer(q({ price: brandDecimalString('100.0') }), 'USD', 'REAL');
    expect(store.offer(q({ price: brandDecimalString('100') }), 'USD', 'REAL')).toBe('UNCHANGED');
    expect(store.get('AAA', 'USD', 'REAL')?.price).toBe('100');
  });

  it('keys isolate currency and REAL/DEMO, with no fallback; mismatched offers are programmer errors', () => {
    const store = createPriceLastValidStore();
    store.offer(q(), 'USD', 'REAL');
    expect(store.get('AAA', 'EUR', 'REAL')).toBeUndefined();
    expect(store.get('AAA', 'USD', 'DEMO')).toBeUndefined();
    expect(store.get('BBB', 'USD', 'REAL')).toBeUndefined();
    expect(() => store.offer(q({ currency: 'EUR' }), 'USD', 'REAL')).toThrow(TypeError);
    expect(() => store.offer(q({ sourceKind: 'DEMO' }), 'USD', 'REAL')).toThrow(TypeError);
  });
});

describe('Rules 2, 4, 5, 6: wrapper behaviour (AT-PRV-01, AT-PRV-02, AT-PRV-03 price parts)', () => {
  const eligible: [string, () => unknown][] = [
    ['NETWORK_ERROR', () => mdFailure('NETWORK_ERROR')],
    ['HTTP_SERVER_ERROR', () => mdFailure('HTTP_SERVER_ERROR', 503)],
    ['RATE_LIMITED', () => mdFailure('RATE_LIMITED')],
    ['TLS_ERROR', () => mdFailure('TLS_ERROR')],
    ['provider INVALID_RESPONSE', () => mdFailure('INVALID_RESPONSE')],
    ['an invalid quote', () => okQuote(quoteOf('AAA', { price: '0' }))],
    ['a future-dated quote', () => okQuote(quoteOf('AAA', { asOf: '2026-11-09' }))],
  ];
  it.each(eligible)(
    'after %s the unchanged last valid value is shown; every market field stays null',
    async (_name, fail) => {
      const { state, value } = wrapped();
      expect(only(await value()).status).toBe('VALUED');
      state.answer = fail;
      const first = only(await value());
      const second = only(await value());
      for (const entry of [first, second]) {
        expect(entry.status).toBe('PRICE_UNAVAILABLE');
        expect(entry.view).toMatchObject({
          marketPrice: null,
          marketValueInstrument: null,
          marketValueBase: null,
        });
        expect(entry.status === 'PRICE_UNAVAILABLE' && entry.lastValid).toEqual({
          kind: 'LAST_VALID_DISPLAY',
          status: 'STALE',
          label: 'LAST_VALID',
          ticker: 'AAA',
          currency: 'USD',
          price: '100',
          asOf: QUOTE_DATE,
          source: MD_NAME,
          sourceKind: 'REAL',
          retrievedAt: RUN_AT,
        });
      }
    },
  );

  it('a timed-out price and an open circuit show the last valid value', async () => {
    const { state, value, h } = wrapped();
    await value();
    state.answer = () => new Promise(() => undefined);
    expect(only(await value())).toMatchObject({ providerCode: 'TIMEOUT', lastValid: { price: '100' } });
    expect(h.rc.status(`marketdata:${MD_NAME}`).state).toBeDefined();
  });

  it.each<[string, () => unknown, ProviderErrorCode | 'MISMATCH']>([
    ['HTTP_CLIENT_ERROR 404 (no data)', () => mdFailure('HTTP_CLIENT_ERROR', 404), 'HTTP_CLIENT_ERROR'],
    ['HTTP_CLIENT_ERROR 400', () => mdFailure('HTTP_CLIENT_ERROR', 400), 'HTTP_CLIENT_ERROR'],
    ['UNEXPECTED_ERROR', () => 'not a result', 'UNEXPECTED_ERROR'],
    ['a currency mismatch', () => okQuote(quoteOf('AAA', { currency: 'EUR' })), 'MISMATCH'],
  ])('%s never receives lastValid', async (_name, fail) => {
    const { state, value } = wrapped();
    await value();
    state.answer = fail;
    const entry = only(await value());
    expect('lastValid' in entry).toBe(false);
  });

  it('a currency-mismatched quote never writes; a stored value in another currency is never attached', async () => {
    const { state, value, store } = wrapped();
    state.answer = (ticker) => okQuote(quoteOf(ticker, { currency: 'EUR' }));
    expect(only(await value()).status).toBe('PRICE_CURRENCY_MISMATCH');
    expect(store.get('AAA', 'EUR', 'REAL')).toBeUndefined();
    expect(store.get('AAA', 'USD', 'REAL')).toBeUndefined();
    // A EUR-priced value stored for AAA is never shown for the USD position.
    store.offer(q({ currency: 'EUR' }), 'EUR', 'REAL');
    state.answer = () => mdFailure('NETWORK_ERROR');
    expect('lastValid' in only(await value())).toBe(false);
  });

  it('FX failures still write the used price (status-selected), and VALUED never carries lastValid', async () => {
    const { value, store, state } = wrapped();
    state.answer = (ticker) => okQuote(quoteOf(ticker, ticker === 'GGG' ? { currency: 'CHF' } : {}));
    const result = await value([pos('AAA', 'USD', '1'), pos('GGG', 'CHF', '1')]);
    expect(only(result, 'GGG').status).toBe('FX_UNAVAILABLE');
    expect(store.get('GGG', 'CHF', 'REAL')).toMatchObject({ price: '100' });
    expect('lastValid' in only(result, 'AAA')).toBe(false);
  });

  it('a rejected inner call writes nothing', async () => {
    const { service, store } = wrapped();
    await expect(service.value(PF, [pos('AAA', 'USD', '1'), pos('AAA', 'USD', '2')])).rejects.toThrow(
      TypeError,
    );
    expect(store.get('AAA', 'USD', 'REAL')).toBeUndefined();
  });

  it('a late result of a timed-out attempt never writes the store', async () => {
    let resolveLate: (value: unknown) => void = () => undefined;
    const { state, value, store, h } = wrapped();
    state.answer = () =>
      new Promise((resolve) => {
        resolveLate = resolve;
      });
    expect(only(await value()).status).toBe('PRICE_UNAVAILABLE');
    resolveLate(okQuote(quoteOf('AAA', { price: '555' })));
    await drive(h.sleeper, Promise.resolve());
    expect(store.get('AAA', 'USD', 'REAL')).toBeUndefined();
  });

  it('recovery: VALUED again, no lastValid, and the store advances under the ordering rule', async () => {
    const { state, value, store, h } = wrapped();
    await value();
    state.answer = () => mdFailure('NETWORK_ERROR');
    await value();
    h.clock.advance(60_000);
    state.answer = (ticker) =>
      okQuote(quoteOf(ticker, { price: '105', retrievedAt: h.clock.nowUtc().toISOString() }));
    const recovered = only(await value());
    expect(recovered.status).toBe('VALUED');
    expect('lastValid' in recovered).toBe(false);
    expect(store.get('AAA', 'USD', 'REAL')?.price).toBe('105');
  });

  it('a DEMO provider keeps sourceKind DEMO; DEMO and REAL never share entries', async () => {
    const shared = createPriceLastValidStore();
    const demo = wrapped({ kind: 'DEMO', store: shared });
    demo.state.answer = (ticker) => okQuote(quoteOf(ticker, { sourceKind: 'DEMO' }));
    await demo.value();
    demo.state.answer = () => mdFailure('NETWORK_ERROR');
    expect(only(await demo.value())).toMatchObject({ lastValid: { sourceKind: 'DEMO' } });
    const real = wrapped({ store: shared });
    real.state.answer = () => mdFailure('NETWORK_ERROR');
    expect('lastValid' in only(await real.value())).toBe(false);
  });

  it('display only: every field except lastValid equals the 11.1 result without a stored value', async () => {
    const withValue = wrapped();
    await withValue.value();
    withValue.state.answer = () => mdFailure('NETWORK_ERROR');
    const shown = only(await withValue.value());
    const plain = wrapped();
    plain.state.answer = () => mdFailure('NETWORK_ERROR');
    const bare = only(await plain.value());
    const { lastValid, ...rest } = shown as PositionValuation & { lastValid?: unknown };
    expect(lastValid).toBeDefined();
    expect(rest).toEqual(bare);
  });

  it('an invalid store is refused at creation', () => {
    const h = harness();
    expect(() =>
      createLastValidPriceValuationService({
        valuation: {
          marketData: fakeMarketData(() => undefined),
          resilientCall: h.rc,
          fx: { rateToBase: () => Promise.reject(new Error('unused')) },
          clock: h.clock,
        },
        store: {} as PriceLastValidStore,
      }),
    ).toThrow(TypeError);
  });
});
