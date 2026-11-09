// Tasks 6.1 and 11.4: POST /portfolios with explicit cash; GET /portfolios/:id/positions and
// /allocation (design: API routes, Gateway rules, Valuation, Exposure, and Allocation rules).
// Uses Fastify inject(), the in-memory unit of work, and fake providers. FX settings are TEST
// values (OD-6 open).
// Tests: AT-ALC-10
// Validates: Requirements 4.3, 5.2, 20.1, 20.6, 20.8, 30.1
import { describe, expect, it } from 'vitest';
import { portfolioRoutes } from '../../src/api/index.js';
import {
  createLastValidPriceValuationService,
  createPortfolioQueryService,
  createPortfolioService,
  createPriceLastValidStore,
} from '../../src/app/index.js';
import type { PositionValuationService } from '../../src/app/index.js';
import { createFxService } from '../../src/fx/index.js';
import { InMemoryUnitOfWork } from '../../src/persistence/index.js';
import { StalePriceDisplaySchema, brandDecimalString } from '../../src/shared/index.js';
import { BASE, MAX_AGE_SECONDS, SUPPORTED, fakeProvider, okResult, quote } from '../helpers/fx.js';
import { harness } from '../helpers/resilience.js';
import { jsonNumbers, testServer } from '../helpers/api.js';
import { position } from '../helpers/persistence.js';
import {
  QUOTE_DATE,
  RUN_AT,
  fakeMarketData,
  mdFailure,
  okQuote,
  quoteOf,
  valuationSetup,
} from '../helpers/valuation.js';

const PF = 'pf-1';
const dec = brandDecimalString;

function setup(
  options: { quotes?: Record<string, Record<string, unknown>>; valuation?: PositionValuationService } = {},
) {
  const uow = new InMemoryUnitOfWork();
  const portfolios = createPortfolioService({ unitOfWork: uow, baseCurrency: 'USD' });
  const quotes = options.quotes ?? {
    AAA: { price: '150.25' },
    BBB: { currency: 'EUR', price: '45.5' },
    DDD: { price: '7' },
  };
  const md = fakeMarketData((ticker) => {
    const overrides = quotes[ticker];
    return overrides === undefined
      ? mdFailure('HTTP_CLIENT_ERROR', 404)
      : okQuote(quoteOf(ticker, overrides));
  });
  const fx = fakeProvider(() => okResult(quote({ rate: '1.085' })));
  const valuation = options.valuation ?? valuationSetup(md, { fxProvider: fx }).service;
  const queries = createPortfolioQueryService({ unitOfWork: uow, valuation });
  const { app, lines } = testServer([portfolioRoutes({ portfolios, queries })]);
  const create = (body: unknown) =>
    app.inject({
      method: 'POST',
      url: '/portfolios',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
  const seedPositions = () =>
    uow.run((tx) => {
      tx.positions.upsert(
        position({
          id: 'p-a',
          portfolioId: PF,
          ticker: 'AAA',
          currency: 'USD',
          signedQuantity: dec('10'),
          averagePrice: dec('140'),
        }),
      );
      tx.positions.upsert(
        position({
          id: 'p-b',
          portfolioId: PF,
          ticker: 'BBB',
          currency: 'EUR',
          signedQuantity: dec('20'),
          averagePrice: dec('40'),
        }),
      );
      tx.positions.upsert(
        position({
          id: 'p-d',
          portfolioId: PF,
          ticker: 'DDD',
          currency: 'USD',
          signedQuantity: dec('0'),
          averagePrice: null,
        }),
      );
    });
  return { app, uow, lines, create, seedPositions };
}

describe('AT-ALC-10: POST /portfolios requires explicit cash', () => {
  it('a request without cash is 400 VALIDATION_FAILED and nothing is stored', async () => {
    const { create, uow } = setup();
    const response = await create({ id: PF, base_currency: 'USD' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(uow.snapshot().portfolios).toEqual([]);
  });

  it('an explicit "0" is accepted and stored as "0"', async () => {
    const { create, uow } = setup();
    const response = await create({ id: PF, base_currency: 'USD', cash: '0' });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: PF, base_currency: 'USD', cash: '0' });
    expect(uow.snapshot().portfolios).toEqual([{ id: PF, baseCurrency: 'USD', cash: '0' }]);
  });

  it('negative cash is valid; cash is canonicalized ("-250.50" → "-250.5"; "-0" → "0")', async () => {
    const { create } = setup();
    expect((await create({ id: 'neg', base_currency: 'USD', cash: '-250.50' })).json()).toMatchObject({
      cash: '-250.5',
    });
    expect((await create({ id: 'negzero', base_currency: 'USD', cash: '-0' })).json()).toMatchObject({
      cash: '0',
    });
  });

  it.each([
    ['a JSON number for cash', { id: PF, base_currency: 'USD', cash: 0 }],
    ['null cash', { id: PF, base_currency: 'USD', cash: null }],
    ['empty cash', { id: PF, base_currency: 'USD', cash: '' }],
    ['exponent cash', { id: PF, base_currency: 'USD', cash: '1e3' }],
    ['an unknown field', { id: PF, base_currency: 'USD', cash: '0', leverage: 'x' }],
    ['an invalid id', { id: '../etc', base_currency: 'USD', cash: '0' }],
    ['an invalid currency', { id: PF, base_currency: 'usd', cash: '0' }],
  ])('%s is 400 VALIDATION_FAILED', async (_name, body) => {
    const { create, uow } = setup();
    const response = await create(body);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(uow.snapshot().portfolios).toEqual([]);
  });

  it('a duplicate id is 409 PORTFOLIO_EXISTS and the stored cash is unchanged', async () => {
    const { create, uow } = setup();
    await create({ id: PF, base_currency: 'USD', cash: '100' });
    const response = await create({ id: PF, base_currency: 'USD', cash: '999' });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'PORTFOLIO_EXISTS' } });
    expect(uow.snapshot().portfolios).toEqual([{ id: PF, baseCurrency: 'USD', cash: '100' }]);
  });

  it('a base currency other than the configured one is 422 BASE_CURRENCY_NOT_SUPPORTED (R30.1)', async () => {
    const { create, uow } = setup();
    const response = await create({ id: PF, base_currency: 'EUR', cash: '0' });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'BASE_CURRENCY_NOT_SUPPORTED' } });
    expect(uow.snapshot().portfolios).toEqual([]);
  });

  it('a failed commit is a generic 500 INTERNAL_ERROR', async () => {
    const { create, uow } = setup();
    uow.failNextCommit({ atWrite: 0 });
    const response = await create({ id: PF, base_currency: 'USD', cash: '0' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });
});

describe('Task 11.4: GET /portfolios/:id/positions', () => {
  it('valued positions with decimal strings, provenance, allocation, and no JSON numbers', async () => {
    const { app, create, seedPositions } = setup();
    await create({ id: PF, base_currency: 'USD', cash: '510.15' });
    seedPositions();
    const response = await app.inject({ method: 'GET', url: `/portfolios/${PF}/positions` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      positions: Record<string, unknown>[];
      at: string;
      baseCurrency: string;
    };
    expect(jsonNumbers(body)).toEqual([]);
    expect(body).toMatchObject({ portfolioId: PF, baseCurrency: 'USD', at: RUN_AT });
    const byTicker = Object.fromEntries(body.positions.map((p) => [p['ticker'] as string, p]));
    expect(byTicker['AAA']).toMatchObject({
      marketPrice: '150.25',
      marketValueBase: '1502.5',
      valuationStatus: 'VALUED',
      allocationPct: '50.08',
      priceAsOf: QUOTE_DATE,
      priceProvenance: { asOf: QUOTE_DATE, source: 'fake-md', sourceKind: 'REAL', retrievedAt: RUN_AT },
      fxRate: { pair: 'USDUSD', rate: '1', observedAt: null, sourceKind: 'IDENTITY', status: 'CURRENT' },
      priceUnavailable: null,
      fxUnavailable: null,
    });
    // 20 × 45.5 = 910; × 1.085 = 987.35.
    expect(byTicker['BBB']).toMatchObject({
      marketValueInstrument: '910',
      marketValueBase: '987.35',
      allocationPct: '32.91',
      fxRate: { pair: 'EURUSD', rate: '1.085', observedAtBasis: 'PROVIDER', sourceKind: 'REAL' },
    });
    // A flat position is valued ("0" is real) but has no allocation line.
    expect(byTicker['DDD']).toMatchObject({ marketValueBase: '0', allocationPct: null, averagePrice: null });
    expect('lastValid' in (byTicker['AAA'] ?? {})).toBe(false);
  });

  it('a missing price: PRICE_UNAVAILABLE with null fields (never "0") and no allocation anywhere', async () => {
    const { app, create, seedPositions } = setup({ quotes: { AAA: { price: '150.25' } } });
    await create({ id: PF, base_currency: 'USD', cash: '0' });
    seedPositions();
    const body = (await app.inject({ method: 'GET', url: `/portfolios/${PF}/positions` })).json() as {
      positions: Record<string, unknown>[];
    };
    const bbb = body.positions.find((p) => p['ticker'] === 'BBB');
    expect(bbb).toMatchObject({
      valuationStatus: 'PRICE_UNAVAILABLE',
      marketPrice: null,
      marketValueBase: null,
      allocationPct: null,
      priceProvenance: null,
      fxRate: null,
      priceUnavailable: { cause: 'PROVIDER_ERROR', providerCode: 'HTTP_CLIENT_ERROR' },
    });
    expect(body.positions.map((p) => p['allocationPct'])).toEqual([null, null, null]);
  });

  it('an unknown portfolio is 404 NOT_FOUND; an unknown query field is 400', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/portfolios/none/positions' })).json()).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    const bad = await app.inject({ method: 'GET', url: `/portfolios/${PF}/positions?x=1` });
    expect(bad.statusCode).toBe(400);
  });
});

describe('Task 11.4: GET /portfolios/:id/allocation', () => {
  it('raw exposure measures separate from percentages, the denominator used, and an exact 100 total', async () => {
    const { app, create, seedPositions } = setup();
    await create({ id: PF, base_currency: 'USD', cash: '510.15' });
    seedPositions();
    const response = await app.inject({ method: 'GET', url: `/portfolios/${PF}/allocation` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(jsonNumbers(body)).toEqual([]);
    // Long 1502.5 + 987.35 = 2489.85; cash 510.15; denominator 3000; NAV 3000.
    expect(body.exposure).toEqual({
      status: 'OK',
      navStatus: 'NAV_POSITIVE',
      measures: {
        long: '2489.85',
        short: '0',
        gross: '2489.85',
        net: '2489.85',
        cash: '510.15',
        nav: '3000',
        allocationDenominator: '3000',
      },
    });
    // P: AAA 50.0833…, BBB 32.9116…, CASH 17.005. Floors 50.08 + 32.91 + 17.00 = 99.99; the one unit
    // goes to the largest remainder (CASH 0.005).
    expect(body.allocation).toMatchObject({
      status: 'ELIGIBLE',
      total: '100',
      lines: [
        { kind: 'POSITION', ticker: 'AAA', valueBase: '1502.5', pct: '50.08' },
        { kind: 'POSITION', ticker: 'BBB', valueBase: '987.35', pct: '32.91' },
        { kind: 'CASH', valueBase: '510.15', pct: '17.01' },
      ],
    });
  });

  it('incomplete valuation: EXPOSURE_UNAVAILABLE and allocation null (no figures from incomplete data)', async () => {
    const { app, create, seedPositions } = setup({ quotes: { AAA: { price: '1' } } });
    await create({ id: PF, base_currency: 'USD', cash: '10' });
    seedPositions();
    const body = (await app.inject({ method: 'GET', url: `/portfolios/${PF}/allocation` })).json();
    expect(body.exposure).toEqual({
      status: 'EXPOSURE_UNAVAILABLE',
      reason: 'VALUATION_INCOMPLETE',
      unvalued: [{ ticker: 'BBB', valuationStatus: 'PRICE_UNAVAILABLE' }],
      cash: '10',
    });
    expect(body.allocation).toBeNull();
  });

  it('negative cash: INELIGIBLE with reasons and unforced lines', async () => {
    const { app, create, seedPositions } = setup();
    await create({ id: PF, base_currency: 'USD', cash: '-100' });
    seedPositions();
    const body = (await app.inject({ method: 'GET', url: `/portfolios/${PF}/allocation` })).json();
    expect(body.allocation).toMatchObject({ status: 'INELIGIBLE', reasons: ['NEGATIVE_CASH', 'LEVERAGE'] });
    expect(body.exposure.measures).toMatchObject({ nav: '2389.85', allocationDenominator: '2489.85' });
  });

  it('a portfolio with no positions and zero cash: ALLOCATION_UNAVAILABLE', async () => {
    const { app, create } = setup();
    await create({ id: PF, base_currency: 'USD', cash: '0' });
    const body = (await app.inject({ method: 'GET', url: `/portfolios/${PF}/allocation` })).json();
    expect(body.allocation).toMatchObject({
      status: 'ALLOCATION_UNAVAILABLE',
      reason: 'DENOMINATOR_NOT_POSITIVE',
    });
  });
});

describe('Task 11.5: lastValid in the positions response (Last valid price rule 7)', () => {
  it('after an outage the item carries a display-only lastValid; fields stay null; no JSON numbers', async () => {
    const state: { answer: (ticker: string) => unknown } = {
      answer: (ticker) =>
        okQuote(quoteOf(ticker, ticker === 'BBB' ? { currency: 'EUR', price: '45.5' } : { price: '150.25' })),
    };
    const md = fakeMarketData((ticker) => state.answer(ticker));
    const h = harness({ maxRetries: 0 }, { failureThreshold: 100 });
    const fx = createFxService({
      provider: fakeProvider(() => okResult(quote({ rate: '1.085' }))),
      resilientCall: h.rc,
      baseCurrency: BASE,
      supportedCurrencies: SUPPORTED,
      maxRateAgeSeconds: MAX_AGE_SECONDS,
    });
    const valuation = createLastValidPriceValuationService({
      valuation: { marketData: md, resilientCall: h.rc, fx, clock: h.clock },
      store: createPriceLastValidStore(),
    });
    const { app, create, seedPositions } = setup({ valuation });
    await create({ id: PF, base_currency: 'USD', cash: '0' });
    seedPositions();
    const first = (await app.inject({ method: 'GET', url: `/portfolios/${PF}/positions` })).json();
    expect(first.positions.every((p: Record<string, unknown>) => !('lastValid' in p))).toBe(true);

    state.answer = () => mdFailure('NETWORK_ERROR');
    const response = await app.inject({ method: 'GET', url: `/portfolios/${PF}/positions` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(jsonNumbers(body)).toEqual([]);
    const aaa = body.positions.find((p: Record<string, unknown>) => p['ticker'] === 'AAA');
    expect(aaa).toMatchObject({
      valuationStatus: 'PRICE_UNAVAILABLE',
      marketPrice: null,
      marketValueBase: null,
      allocationPct: null,
      priceUnavailable: { cause: 'PROVIDER_ERROR', providerCode: 'NETWORK_ERROR' },
    });
    expect(StalePriceDisplaySchema.parse(aaa.lastValid)).toMatchObject({
      label: 'LAST_VALID',
      status: 'STALE',
      price: '150.25',
      asOf: QUOTE_DATE,
      retrievedAt: RUN_AT,
    });
    // Display only: allocation is unavailable while prices are missing.
    const allocation = (await app.inject({ method: 'GET', url: `/portfolios/${PF}/allocation` })).json();
    expect(allocation.allocation).toBeNull();
    expect(allocation.exposure.status).toBe('EXPOSURE_UNAVAILABLE');
  });

  it('StalePriceDisplaySchema rejects JSON numbers, non-canonical prices, and unknown fields', () => {
    const valid = {
      kind: 'LAST_VALID_DISPLAY',
      status: 'STALE',
      label: 'LAST_VALID',
      ticker: 'AAA',
      currency: 'USD',
      price: '150.25',
      asOf: QUOTE_DATE,
      source: 'fake-md',
      sourceKind: 'REAL',
      retrievedAt: RUN_AT,
    };
    expect(StalePriceDisplaySchema.safeParse(valid).success).toBe(true);
    for (const bad of [
      { ...valid, price: 150.25 },
      { ...valid, price: '150.250' },
      { ...valid, price: '0' },
      { ...valid, extra: 'x' },
    ]) {
      expect(StalePriceDisplaySchema.safeParse(bad).success).toBe(false);
    }
  });
});
