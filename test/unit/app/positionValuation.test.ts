// Task 11.1: position valuation service (design: Portfolio, Valuation rules 1 to 17).
// Tests: AT-FX-07
// Settings are TEST values (OD-6 open): see test/helpers/fx.ts.
// Validates: Requirements 5.2, 25.7, 25.8, 25.9, 30.6, 30.7, 30.8, 30.9, 33.9
import { describe, expect, it } from 'vitest';
import {
  createPositionValuationService,
  createRecordingFxService,
  marketDataCircuitKey,
} from '../../../src/app/index.js';
import type { ObservedFxRate, PortfolioValuation, PositionValuation } from '../../../src/app/index.js';
import { FixtureFxProvider, createFxService } from '../../../src/fx/index.js';
import type { FxService } from '../../../src/fx/index.js';
import { FixtureMarketDataProvider } from '../../../src/marketdata/index.js';
import type { MarketDataProvider } from '../../../src/marketdata/index.js';
import { InMemoryUnitOfWork } from '../../../src/persistence/index.js';
import type { Position } from '../../../src/portfolio/index.js';
import { FakeClock, LastValidStore, sequentialIds } from '../../../src/shared/index.js';
import type { Clock, ProviderErrorCode } from '../../../src/shared/index.js';
import {
  BASE,
  MAX_AGE_SECONDS,
  SUPPORTED,
  fakeProvider,
  minusMs,
  okResult,
  providerFailure,
  quote,
} from '../../helpers/fx.js';
import { advanceBy, drive, harness } from '../../helpers/resilience.js';
import {
  MD_NAME,
  PF,
  QUOTE_DATE,
  RUN_AT,
  RUN_DATE,
  deferred,
  fakeMarketData,
  mdFailure,
  okQuote,
  pos,
  quoteOf,
  valuationSetup,
} from '../../helpers/valuation.js';

const RATES: Readonly<Record<string, string>> = { EUR: '1.085', GBP: '1.27', JPY: '0.0067' };

/** FX provider (`fake-fx`, REAL) with a direct quote per currency, or 404 when none exists. */
const fxProvider = (rates: Readonly<Record<string, string>> = RATES) =>
  fakeProvider((from, _to, asOf, at) => {
    const rate = rates[from];
    return rate === undefined
      ? providerFailure('HTTP_CLIENT_ERROR', 404)
      : okResult(quote({ from, to: BASE, rate, observedAt: observedFor(asOf, at) }));
  });

/** One hour before the FX selection bound min(end of asOf, at), so the rate is valid and fresh. */
function observedFor(asOf: string, at: string): string {
  const endOfDay = `${asOf}T23:59:59.999Z`;
  return minusMs(endOfDay < at ? endOfDay : at, 3_600_000);
}

/** Market data answering one quote per ticker from `byTicker` (currency, price, overrides). */
const marketFor = (byTicker: Readonly<Record<string, Record<string, unknown>>>) =>
  fakeMarketData((ticker) => {
    const overrides = byTicker[ticker];
    return overrides === undefined
      ? mdFailure('HTTP_CLIENT_ERROR', 404)
      : okQuote(quoteOf(ticker, overrides));
  });

function find(result: PortfolioValuation, ticker: string): PositionValuation {
  const found = result.positions.find((entry) => entry.view.ticker === ticker);
  if (found === undefined) {
    throw new Error(`no valuation for ${ticker}`);
  }
  return found;
}

const NULL_MARKET = {
  marketPrice: null,
  marketValueInstrument: null,
  marketValueBase: null,
  allocationPct: null,
};

describe('AT-FX-07: mixed-currency portfolio valued exactly in base currency', () => {
  const quotes = {
    AAA: [{ ticker: 'AAA', currency: 'USD', asOf: QUOTE_DATE, price: '150.25' }],
    BBB: [{ ticker: 'BBB', currency: 'EUR', asOf: QUOTE_DATE, price: '45.5' }],
    CCC: [{ ticker: 'CCC', currency: 'GBP', asOf: QUOTE_DATE, price: '12.34' }],
    DDD: [{ ticker: 'DDD', currency: 'JPY', asOf: QUOTE_DATE, price: '1500' }],
  };
  const observedAt = '2026-11-06T16:00:00.000Z';
  const fixtureRates = [
    { from: 'EUR', to: 'USD', rate: '1.085', observedAt },
    { from: 'USD', to: 'GBP', rate: '0.8', observedAt }, // inverse quote: Rate(GBP/USD) = 1.25
    { from: 'JPY', to: 'USD', rate: '0.0067', observedAt },
  ];
  const positions = [
    pos('DDD', 'JPY', '0'),
    pos('CCC', 'GBP', '-5'),
    pos('BBB', 'EUR', '20'),
    pos('AAA', 'USD', '10'),
  ];

  const setup = (rates: readonly unknown[]) =>
    valuationSetup(
      (h) => new FixtureMarketDataProvider({ name: 'fixture-md', clock: h.clock, fixtures: { quotes } }),
      {
        fxProvider: new FixtureFxProvider({ name: 'fixture-fx', rates }),
      },
    );

  it('values every position with hand-calculated base values, in ticker order', async () => {
    const result = await setup(fixtureRates).value(positions);
    expect(result.portfolioId).toBe(PF);
    expect(result.at).toBe(RUN_AT);
    expect(result.positions.map((entry) => entry.view.ticker)).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
    const expected: Record<string, [string, string, string]> = {
      AAA: ['150.25', '1502.5', '1502.5'], // 10 × 150.25; identity rate 1
      BBB: ['45.5', '910', '987.35'], // 20 × 45.5 = 910; × 1.085
      CCC: ['12.34', '-61.7', '-77.125'], // -5 × 12.34 = -61.7; × (1 / 0.8 = 1.25)
      DDD: ['1500', '0', '0'], // zero quantity: a real "0"
    };
    for (const [ticker, [price, instrument, base]] of Object.entries(expected)) {
      const entry = find(result, ticker);
      expect(entry.status).toBe('VALUED');
      expect(entry.view).toMatchObject({
        marketPrice: price,
        marketValueInstrument: instrument,
        marketValueBase: base,
        allocationPct: null,
        valuationStatus: 'VALUED',
      });
      expect(entry.priceAsOf).toBe(QUOTE_DATE);
      expect(entry.price).toMatchObject({ source: 'fixture-md', sourceKind: 'DEMO', retrievedAt: RUN_AT });
    }
    expect(find(result, 'AAA').fx).toEqual({
      kind: 'IDENTITY',
      pair: 'USDUSD',
      rate: '1',
      observedAt: null,
      source: 'BASE_CURRENCY',
      sourceKind: 'IDENTITY',
      status: 'CURRENT',
    });
    expect(find(result, 'CCC').fx).toMatchObject({
      kind: 'OBSERVED',
      pair: 'GBPUSD',
      rate: '1.25',
      observedAt,
      observedAtBasis: 'PROVIDER',
      source: 'fixture-fx',
      sourceKind: 'DEMO',
      status: 'DEMO',
    });
  });

  it('a missing rate gives FX_UNAVAILABLE with a null base value, never zero; other positions are unaffected', async () => {
    const result = await setup(fixtureRates.filter((rate) => rate.from !== 'USD')).value(positions);
    const ccc = find(result, 'CCC');
    expect(ccc.status).toBe('FX_UNAVAILABLE');
    expect(ccc.view).toMatchObject({
      marketPrice: '12.34',
      marketValueInstrument: '-61.7',
      marketValueBase: null,
      valuationStatus: 'FX_UNAVAILABLE',
    });
    expect(ccc).toMatchObject({
      fx: null,
      fxError: {
        code: 'FX_UNAVAILABLE',
        currency: 'GBP',
        cause: 'PROVIDER_ERROR',
        providerCode: 'HTTP_CLIENT_ERROR',
      },
    });
    expect(['AAA', 'BBB', 'DDD'].map((ticker) => find(result, ticker).status)).toEqual([
      'VALUED',
      'VALUED',
      'VALUED',
    ]);
  });
});

describe('Rule 4: price call through ResilientCall and error mapping', () => {
  const cases: [ProviderErrorCode, number | undefined][] = [
    ['NETWORK_ERROR', undefined],
    ['TIMEOUT', undefined],
    ['TLS_ERROR', undefined],
    ['RATE_LIMITED', undefined],
    ['HTTP_SERVER_ERROR', 503],
    ['HTTP_CLIENT_ERROR', 404],
    ['HTTP_CLIENT_ERROR', 400],
    ['INVALID_RESPONSE', undefined],
  ];
  it.each(cases)(
    'provider %s (%s) gives PRICE_UNAVAILABLE with that providerCode and no FX call',
    async (code, status) => {
      const fx = fxProvider();
      const { value } = valuationSetup(
        fakeMarketData(() => mdFailure(code, status)),
        { fxProvider: fx },
      );
      const entry = find(await value([pos('BBB', 'EUR', '20')]), 'BBB');
      expect(entry).toMatchObject({
        status: 'PRICE_UNAVAILABLE',
        priceAsOf: null,
        price: null,
        fx: null,
        cause: 'PROVIDER_ERROR',
        providerCode: code,
      });
      expect(entry.view).toMatchObject({ ...NULL_MARKET, valuationStatus: 'PRICE_UNAVAILABLE' });
      expect(fx.calls).toHaveLength(0);
    },
  );

  it.each(['CIRCUIT_OPEN', 'CANCELLED', 'UNEXPECTED_ERROR'] as const)(
    'a provider-returned %s is an unexpected outcome (UNEXPECTED_ERROR)',
    async (code) => {
      const { value } = valuationSetup(fakeMarketData(() => mdFailure(code)));
      expect(find(await value([pos('AAA', 'USD', '1')]), 'AAA')).toMatchObject({
        cause: 'PROVIDER_ERROR',
        providerCode: 'UNEXPECTED_ERROR',
      });
    },
  );

  it('a value that is not a Result, or a thrown exception, is UNEXPECTED_ERROR (8.2 boundary, R25.9)', async () => {
    const notResult = valuationSetup(fakeMarketData(() => 'nonsense'));
    expect(find(await notResult.value([pos('AAA', 'USD', '1')]), 'AAA')).toMatchObject({
      providerCode: 'UNEXPECTED_ERROR',
    });
    const throwing: MarketDataProvider = {
      ...fakeMarketData(() => undefined),
      getLatestPrice: () => {
        throw new Error('provider bug');
      },
    };
    const thrown = valuationSetup(throwing);
    expect(find(await thrown.value([pos('AAA', 'USD', '1')]), 'AAA')).toMatchObject({
      status: 'PRICE_UNAVAILABLE',
      cause: 'PROVIDER_ERROR',
      providerCode: 'UNEXPECTED_ERROR',
    });
  });

  it('retries a retryable failure and then values the position', async () => {
    const md = fakeMarketData((ticker, call) =>
      call === 1 ? mdFailure('NETWORK_ERROR') : okQuote(quoteOf(ticker)),
    );
    const { value } = valuationSetup(md, { maxRetries: 1 });
    expect(find(await value([pos('AAA', 'USD', '2')]), 'AAA').status).toBe('VALUED');
    expect(md.calls).toEqual(['AAA', 'AAA']);
  });

  it('uses the circuit key marketdata:<provider name>; qualifying failures open it', async () => {
    const md = fakeMarketData(() => mdFailure('NETWORK_ERROR'));
    const { h, value } = valuationSetup(md, { failureThreshold: 1 });
    await value([pos('AAA', 'USD', '1')]);
    expect(marketDataCircuitKey(MD_NAME)).toBe('marketdata:fake-md');
    expect(h.rc.status('marketdata:fake-md').circuit).toBe('OPEN');
    const second = find(await value([pos('AAA', 'USD', '1')]), 'AAA');
    expect(second).toMatchObject({ cause: 'PROVIDER_ERROR', providerCode: 'CIRCUIT_OPEN' });
    expect(md.calls).toHaveLength(1);
  });

  it('a 404 does not count toward the circuit breaker', async () => {
    const md = fakeMarketData(() => mdFailure('HTTP_CLIENT_ERROR', 404));
    const { h, value } = valuationSetup(md, { failureThreshold: 1 });
    await value([pos('AAA', 'USD', '1')]);
    await value([pos('AAA', 'USD', '1')]);
    expect(md.calls).toHaveLength(2);
    expect(h.rc.status('marketdata:fake-md').circuit).toBe('CLOSED');
  });
});

describe('Rules 4a, 6, and 7: quote validation and future dates inside the operation', () => {
  const invalid: [string, Record<string, unknown>][] = [
    ['another ticker', { ticker: 'ZZZ' }],
    ['an unknown field', { extra: 'x' }],
    ['exponent notation', { price: '1e2' }],
    ['a zero price', { price: '0' }],
    ['a native number price', { price: 100 }],
    ['an invalid asOf', { asOf: '2026-02-30' }],
    ['another source', { source: 'other-md' }],
    ['another source kind', { sourceKind: 'DEMO' }],
    ['a retrievedAt without milliseconds', { retrievedAt: '2026-11-07T12:00:00Z' }],
  ];
  it.each(invalid)(
    'a quote with %s gives INVALID_RESPONSE, is not retried, and counts toward the circuit',
    async (_name, overrides) => {
      const md = fakeMarketData((ticker) => okQuote(quoteOf(ticker, overrides)));
      const { h, value } = valuationSetup(md, { maxRetries: 2, failureThreshold: 1 });
      const entry = find(await value([pos('AAA', 'USD', '1')]), 'AAA');
      expect(entry).toMatchObject({ status: 'PRICE_UNAVAILABLE', cause: 'INVALID_RESPONSE' });
      expect('providerCode' in entry).toBe(false);
      expect(md.calls).toHaveLength(1);
      expect(h.rc.status('marketdata:fake-md').circuit).toBe('OPEN');
    },
  );

  it('a quote dated on the UTC date of at is accepted', async () => {
    const { value } = valuationSetup(marketFor({ AAA: { asOf: RUN_DATE } }));
    const entry = find(await value([pos('AAA', 'USD', '3')]), 'AAA');
    expect(entry).toMatchObject({ status: 'VALUED', priceAsOf: RUN_DATE });
  });

  it('a quote dated after the UTC date of at is FUTURE_DATED, not retried, and counts toward the circuit', async () => {
    const md = fakeMarketData((ticker) => okQuote(quoteOf(ticker, { asOf: '2026-11-08' })));
    const { h, value } = valuationSetup(md, { maxRetries: 2, failureThreshold: 1 });
    const entry = find(await value([pos('AAA', 'USD', '1')]), 'AAA');
    expect(entry).toMatchObject({ status: 'PRICE_UNAVAILABLE', cause: 'FUTURE_DATED' });
    expect(entry.view).toMatchObject(NULL_MARKET);
    expect(md.calls).toHaveLength(1);
    expect(h.rc.status('marketdata:fake-md').circuit).toBe('OPEN');
  });

  it('a late invalid result of an abandoned attempt does not change the cause of the last attempt', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const md = fakeMarketData((_ticker, call) => (call === 1 ? first.promise : second.promise));
    const h = harness({ maxRetries: 1 });
    h.randomValue = 0; // no backoff wait
    const fx = createFxService({
      provider: fxProvider(),
      resilientCall: h.rc,
      baseCurrency: BASE,
      supportedCurrencies: SUPPORTED,
      maxRateAgeSeconds: MAX_AGE_SECONDS,
    });
    const service = createPositionValuationService({
      marketData: md,
      resilientCall: h.rc,
      fx,
      clock: h.clock,
    });
    const pending = service.value(PF, [pos('AAA', 'USD', '1')]);
    await advanceBy(h, 10_000); // attempt 1 times out; attempt 2 starts
    expect(md.calls).toHaveLength(2);
    first.resolve(okQuote(quoteOf('AAA', { price: '0' }))); // late, invalid
    await advanceBy(h, 0);
    second.resolve(mdFailure('INVALID_RESPONSE')); // the provider's own classification
    const entry = find(await pending, 'AAA');
    expect(entry).toMatchObject({ cause: 'PROVIDER_ERROR', providerCode: 'INVALID_RESPONSE' });
  });
});

describe('Rule 5: a timed-out price whose late result arrives afterwards', () => {
  it('stays PRICE_UNAVAILABLE (TIMEOUT); the late result changes nothing and triggers no FX call', async () => {
    const late = deferred<unknown>();
    const md = fakeMarketData(() => late.promise);
    const fx = fxProvider();
    const { h, value } = valuationSetup(md, { fxProvider: fx });
    const result = await value([pos('BBB', 'EUR', '20')]);
    const before = structuredClone(result);
    expect(find(result, 'BBB')).toMatchObject({ cause: 'PROVIDER_ERROR', providerCode: 'TIMEOUT' });
    late.resolve(okQuote(quoteOf('BBB', { currency: 'EUR' })));
    await advanceBy(h, 1_000);
    expect(result).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(find(result, 'BBB').view)).toBe(true);
    expect(fx.calls).toHaveLength(0);
  });
});

describe('Rule 9: quote currency must equal the position currency', () => {
  it('gives PRICE_CURRENCY_MISMATCH with null market fields, the quote kept, and no FX call', async () => {
    const fx = fxProvider();
    const { value } = valuationSetup(marketFor({ BBB: { currency: 'USD', price: '45.5' } }), {
      fxProvider: fx,
    });
    const entry = find(await value([pos('BBB', 'EUR', '20')]), 'BBB');
    expect(entry).toMatchObject({ status: 'PRICE_CURRENCY_MISMATCH', priceAsOf: QUOTE_DATE, fx: null });
    expect(entry.price).toMatchObject({ currency: 'USD', price: '45.5' });
    expect(entry.view).toMatchObject({ ...NULL_MARKET, valuationStatus: 'PRICE_CURRENCY_MISMATCH' });
    expect(fx.calls).toHaveLength(0);
  });
});

describe('Rule 10: FX selection and FX failures', () => {
  it('requests the rate for the quote asOf and the run at, and keeps the FxRateUsed unchanged', async () => {
    const fx = fxProvider();
    const { value } = valuationSetup(marketFor({ BBB: { currency: 'EUR', price: '45.5', asOf: RUN_DATE } }), {
      fxProvider: fx,
    });
    const entry = find(await value([pos('BBB', 'EUR', '20')]), 'BBB');
    expect(fx.calls).toEqual([['EUR', 'USD', RUN_DATE, RUN_AT]]);
    expect(entry.fx).toEqual({
      kind: 'OBSERVED',
      pair: 'EURUSD',
      rate: '1.085',
      observedAt: '2026-11-07T11:00:00.000Z', // one hour before at (the bound for asOf = run date)
      observedAtBasis: 'PROVIDER',
      source: 'fake-fx',
      sourceKind: 'REAL',
      status: 'CURRENT',
    });
  });

  it('FX_STALE leaves the base value null and never uses the display rate', async () => {
    const stale = fakeProvider(() =>
      okResult(quote({ observedAt: minusMs(RUN_AT, MAX_AGE_SECONDS * 1000 + 1) })),
    );
    const { value } = valuationSetup(marketFor({ BBB: { currency: 'EUR', price: '45.5' } }), {
      fxProvider: stale,
    });
    const entry = find(await value([pos('BBB', 'EUR', '20')]), 'BBB');
    expect(entry.status).toBe('FX_STALE');
    expect(entry.view).toMatchObject({
      marketPrice: '45.5',
      marketValueInstrument: '910',
      marketValueBase: null,
    });
    expect(entry).toMatchObject({
      fx: null,
      fxError: { code: 'FX_STALE', displayRate: { status: 'STALE' } },
    });
  });

  it('an unsupported currency is FX_UNAVAILABLE (UNSUPPORTED_CURRENCY) without an FX provider call', async () => {
    const fx = fxProvider();
    const { value } = valuationSetup(marketFor({ SSS: { currency: 'CHF', price: '10' } }), {
      fxProvider: fx,
    });
    const entry = find(await value([pos('SSS', 'CHF', '1')]), 'SSS');
    expect(entry).toMatchObject({ status: 'FX_UNAVAILABLE', fxError: { cause: 'UNSUPPORTED_CURRENCY' } });
    expect(entry.view.marketValueBase).toBeNull();
    expect(fx.calls).toHaveLength(0);
  });
});

describe('Rule 13: lookup reuse only within one call and only for identical keys', () => {
  it('identical FX keys make one call; a different asOf makes a separate call', async () => {
    const fx = fxProvider();
    const md = marketFor({
      E1: { currency: 'EUR', price: '1' },
      E2: { currency: 'EUR', price: '2' },
      E3: { currency: 'EUR', price: '3', asOf: RUN_DATE },
    });
    const { value } = valuationSetup(md, { fxProvider: fx });
    const result = await value([pos('E1', 'EUR', '1'), pos('E2', 'EUR', '1'), pos('E3', 'EUR', '1')]);
    expect(result.positions.map((entry) => entry.status)).toEqual(['VALUED', 'VALUED', 'VALUED']);
    expect(fx.calls.map((call) => call[2]).sort()).toEqual([QUOTE_DATE, RUN_DATE]);
    expect(md.calls.sort()).toEqual(['E1', 'E2', 'E3']);
  });

  it('nothing is reused across calls', async () => {
    const fx = fxProvider();
    const md = marketFor({ E1: { currency: 'EUR' } });
    const { value } = valuationSetup(md, { fxProvider: fx });
    await value([pos('E1', 'EUR', '1')]);
    await value([pos('E1', 'EUR', '1')]);
    expect(fx.calls).toHaveLength(2);
    expect(md.calls).toHaveLength(2);
  });
});

describe('Rules 2, 3, and 14: run timestamp, arguments, isolation, and programmer errors', () => {
  it('reads the Clock exactly once per call, also for an empty list', async () => {
    const h = harness();
    let reads = 0;
    const clock: Clock = {
      nowUtc: () => {
        reads += 1;
        return h.clock.nowUtc();
      },
      monotonicMs: () => h.clock.monotonicMs(),
    };
    const md = marketFor({ AAA: {}, BBB: {} });
    const service = createPositionValuationService({
      marketData: md,
      resilientCall: h.rc,
      fx: createFxService({
        provider: fxProvider(),
        resilientCall: h.rc,
        baseCurrency: BASE,
        supportedCurrencies: SUPPORTED,
        maxRateAgeSeconds: MAX_AGE_SECONDS,
      }),
      clock,
    });
    const result = await drive(
      h.sleeper,
      service.value(PF, [pos('AAA', 'USD', '1'), pos('BBB', 'USD', '1')]),
    );
    expect(reads).toBe(1);
    expect(result.at).toBe(RUN_AT);
    const empty = await service.value(PF, []);
    expect(reads).toBe(2);
    expect(empty).toEqual({ portfolioId: PF, at: RUN_AT, positions: [] });
  });

  it('one failing position does not change another', async () => {
    const { value } = valuationSetup(marketFor({ AAA: { price: '2' } }));
    const result = await value([pos('AAA', 'USD', '3'), pos('BBB', 'USD', '1')]);
    expect(find(result, 'AAA').view.marketValueBase).toBe('6');
    expect(find(result, 'BBB')).toMatchObject({
      status: 'PRICE_UNAVAILABLE',
      providerCode: 'HTTP_CLIENT_ERROR',
    });
  });

  it('the result does not depend on the input order and is frozen throughout', async () => {
    const md = marketFor({ AAA: { price: '2' }, BBB: { price: '3' } });
    const a = await valuationSetup(md).value([pos('AAA', 'USD', '1'), pos('BBB', 'USD', '1')]);
    const b = await valuationSetup(md).value([pos('BBB', 'USD', '1'), pos('AAA', 'USD', '1')]);
    expect(a).toEqual(b);
    expect(Object.isFrozen(a.positions)).toBe(true);
    for (const entry of a.positions) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.view)).toBe(true);
      expect(Object.isFrozen(entry.price)).toBe(true);
    }
  });

  const badArguments: [string, string, readonly Position[]][] = [
    ['an empty portfolioId', '', [pos('AAA', 'USD', '1')]],
    ['a position of another portfolio', PF, [pos('AAA', 'USD', '1', 'other')]],
    ['duplicate tickers', PF, [pos('AAA', 'USD', '1'), pos('AAA', 'USD', '2')]],
    ['an empty ticker', PF, [pos('', 'USD', '1')]],
    ['an invalid currency', PF, [{ ...pos('AAA', 'USD', '1'), currency: 'usd' }]],
    [
      'an invalid signedQuantity',
      PF,
      [{ ...pos('AAA', 'USD', '1'), signedQuantity: '1e3' } as unknown as Position],
    ],
  ];
  it.each(badArguments)(
    '%s throws TypeError before any provider call',
    async (_name, portfolioId, positions) => {
      const md = marketFor({ AAA: {} });
      const { service } = valuationSetup(md);
      await expect(service.value(portfolioId, positions)).rejects.toThrow(TypeError);
      expect(md.calls).toHaveLength(0);
    },
  );

  it('an exception thrown by the FxService propagates (programmer error)', async () => {
    const fx: FxService = {
      rateToBase: () => Promise.reject(new TypeError('fx programmer error')),
    };
    const { service } = valuationSetup(marketFor({ BBB: { currency: 'EUR' } }), { fx });
    await expect(service.value(PF, [pos('BBB', 'EUR', '1')])).rejects.toThrow('fx programmer error');
  });

  it('a Clock that returns an invalid time throws TypeError', async () => {
    const h = harness();
    const service = createPositionValuationService({
      marketData: marketFor({}),
      resilientCall: h.rc,
      fx: { rateToBase: () => Promise.reject(new Error('unused')) },
      clock: { nowUtc: () => new Date(Number.NaN), monotonicMs: () => 0 },
    });
    await expect(service.value(PF, [])).rejects.toThrow(TypeError);
  });

  it('invalid dependencies throw TypeError at creation', () => {
    const h = harness();
    const fx: FxService = { rateToBase: () => Promise.reject(new Error('unused')) };
    const md = marketFor({});
    const good = { marketData: md, resilientCall: h.rc, fx, clock: h.clock };
    const bad = [
      { ...good, marketData: { ...md, name: '' } },
      { ...good, marketData: { ...md, kind: 'IDENTITY' } },
      { ...good, resilientCall: {} },
      { ...good, fx: {} },
      { ...good, clock: {} },
    ];
    for (const deps of bad) {
      expect(() => createPositionValuationService(deps as never)).toThrow(TypeError);
    }
    expect(() => createPositionValuationService(good)).not.toThrow();
  });
});

describe('Rule 15: works with the 10.3 recording FxService', () => {
  it('values the position and the recorder records the observed rate', async () => {
    const uow = new InMemoryUnitOfWork();
    const { value } = valuationSetup(marketFor({ BBB: { currency: 'EUR', price: '45.5' } }), {
      fx: (h) =>
        createRecordingFxService({
          fx: {
            provider: fxProvider(),
            resilientCall: h.rc,
            baseCurrency: BASE,
            supportedCurrencies: SUPPORTED,
            maxRateAgeSeconds: MAX_AGE_SECONDS,
          },
          unitOfWork: uow,
          lastValid: new LastValidStore<string, ObservedFxRate>(),
          clock: new FakeClock(RUN_AT),
          ids: sequentialIds('fx'),
        }),
    });
    const entry = find(await value([pos('BBB', 'EUR', '20')]), 'BBB');
    expect(entry.view.marketValueBase).toBe('987.35');
    expect(uow.snapshot().fxRates).toHaveLength(1);
  });
});
