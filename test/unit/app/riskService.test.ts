// Tasks 12.3 and 12.5: the risk input builder, configuration gate, validity, last valid results,
// and stored results (design: Risk Worker and Scheduler, ResultValidityPolicy, Snapshot Service).
// Prices are chosen so the returns are exact: 100 -> 110 -> 99 -> 108.9 gives 0.1, -0.1, 0.1.
// With 10 units at 100 USD (E = 1000): Loss = [-100, 100, -100]; sorted [-100, -100, 100];
// n = 3, p = 0.95: h = 2.9, VaR = 0.1 * -100 + 0.9 * 100 = 80. NAV = 1000 + cash 100 = 1100.
// Tests: AT-MD-13, AT-MD-16, AT-FX-10
// Validates: Requirements 13.2, 13.4, 13.5, 13.7, 14.4, 14.12, 14.14, 30.8, 30.11
import { describe, expect, it } from 'vitest';
import { createRiskInputBuilder } from '../../../src/app/index.js';
import { createReturnsBuilder } from '../../../src/marketdata/index.js';
import { completeTestConfig, withKey } from '../../helpers/config.js';
import { observedFx } from '../../helpers/risk.js';
import { NOW, PF, VERSION, cleanSeries, configView, riskHarness } from '../../helpers/riskService.js';
import type { RiskHarnessOptions } from '../../helpers/riskService.js';

const SMALL = withKey(withKey(completeTestConfig(), 'var.lookbackReturns', 3), 'var.minObservations', 2);
const AAA_PRICES = ['100', '110', '99', '108.9'];

function setup(
  options: RiskHarnessOptions = {},
  positions: Record<string, readonly [string, string]> = { AAA: ['USD', '10'] },
) {
  const h = riskHarness(positions, { values: SMALL, prices: { AAA: { price: '100' } }, ...options });
  if (options.uow === undefined) {
    h.putSeries(cleanSeries('AAA', AAA_PRICES, { start: '2026-11-03' }));
  }
  return h;
}

describe('risk service: a calculated result', () => {
  it('stores result and snapshot; Base VaR CURRENT; Adjusted VaR UNAVAILABLE and never a copy', async () => {
    const h = setup();
    expect(await h.service.calculate(PF)).toMatchObject({ status: 'STORED', calcStatus: 'OK' });
    const view = h.service.view(PF);
    expect(view).toMatchObject({
      status: 'OK',
      nav: '1100',
      asOfDate: '2026-11-06',
      observations: 3,
      lookbackReturns: 3,
      completeness: 'COMPLETE',
      confidence: '0.95',
      configVersion: VERSION,
      calculatedAt: NOW,
      flags: [],
    });
    expect(view?.baseVaR).toMatchObject({ validity: 'CURRENT', status: 'OK', lastValid: null });
    expect(view?.baseVaR.value?.absolute).toBe('80');
    expect(view?.adjustedVaR).toEqual({
      validity: 'UNAVAILABLE',
      value: null,
      status: 'SENTIMENT_NOT_CURRENT',
      reason: 'SENTIMENT_NOT_CURRENT',
      missingKeys: [],
      lastValid: null,
    });
    expect(view?.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    const snap = h.uow.snapshot();
    expect(snap.snapshots).toHaveLength(1);
    expect(snap.riskResults[0]?.snapshotHash).toBe(snap.snapshots[0]?.hash);
  });

  it('a missing adjustment setting makes only Adjusted VaR unavailable (R15.8)', async () => {
    const h = setup({ missing: ['adjustment.multiplier'] });
    await h.service.calculate(PF);
    const view = h.service.view(PF);
    expect(view?.baseVaR.validity).toBe('CURRENT');
    expect(view?.adjustedVaR).toMatchObject({
      validity: 'UNAVAILABLE',
      value: null,
      status: 'ADJUSTMENT_CONFIG_MISSING',
      missingKeys: ['adjustment.multiplier'],
    });
  });

  it('a stale as-of date gives MARKET_DATA_STALE and validity STALE, never CURRENT (AT-MD-13)', async () => {
    // As-of 2026-11-06; calculation on 2026-11-12 is 6 days later, more than maxStalenessDays 5.
    const h = setup({ at: '2026-11-12T09:00:00.000Z' });
    await h.service.calculate(PF);
    const view = h.service.view(PF);
    expect(view?.flags).toEqual(['MARKET_DATA_STALE']);
    expect(view?.baseVaR).toMatchObject({ validity: 'STALE', lastValid: null });
    expect(view?.baseVaR.value?.absolute).toBe('80');
  });

  it('exactly maxStalenessDays old is not stale', async () => {
    const h = setup({ at: '2026-11-11T23:59:59.999Z' });
    await h.service.calculate(PF);
    expect(h.service.view(PF)?.baseVaR.validity).toBe('CURRENT');
  });

  it('a DEMO FX rate flags DEMO_DATA (AT-FX-10)', async () => {
    const h = setup(
      { prices: { AAA: { price: '100' }, BBB: { price: '10', fx: observedFx('EUR', '1.1', 'DEMO') } } },
      { AAA: ['USD', '10'], BBB: ['EUR', '5'] },
    );
    h.putSeries(cleanSeries('BBB', ['10', '11', '10', '11'], { start: '2026-11-03', currency: 'EUR' }));
    await h.service.calculate(PF);
    expect(h.service.view(PF)?.flags).toContain('DEMO_DATA');
  });

  it('DEMO history flags DEMO_DATA (R25.4)', async () => {
    const h = riskHarness(
      { AAA: ['USD', '10'] },
      { values: SMALL, prices: { AAA: { price: '100' } }, historyKind: 'DEMO' },
    );
    h.putSeries(cleanSeries('AAA', AAA_PRICES, { start: '2026-11-03', sourceKind: 'DEMO' }));
    await h.service.calculate(PF);
    expect(h.service.view(PF)?.flags).toEqual(['DEMO_DATA']);
  });
});

describe('risk service: preconditions and last valid results', () => {
  it('a missing Base VaR setting gives CONFIG_MISSING with keys, no figures, earlier result LAST_VALID (AT-MD-16)', async () => {
    const first = setup();
    await first.service.calculate(PF);
    const second = riskHarness(
      {},
      { uow: first.uow, values: SMALL, missing: ['var.confidence', 'marketData.maxStalenessDays'] },
    );
    expect(await second.service.calculate(PF)).toMatchObject({
      status: 'STORED',
      calcStatus: 'CONFIG_MISSING',
    });
    const view = second.service.view(PF);
    expect(view?.status).toBe('CONFIG_MISSING');
    expect(view?.baseVaR).toMatchObject({
      validity: 'UNAVAILABLE',
      value: null,
      status: 'CONFIG_MISSING',
      missingKeys: ['marketData.maxStalenessDays', 'var.confidence'],
    });
    expect(view?.baseVaR.lastValid?.value.absolute).toBe('80');
    expect(view?.baseVaR.lastValid?.calculatedAt).toBe(NOW);
    expect(view?.adjustedVaR).toMatchObject({
      validity: 'UNAVAILABLE',
      value: null,
      status: 'BASE_UNAVAILABLE',
      lastValid: null,
    });
    expect(view?.snapshotHash).toBeNull();
  });

  it('the configuration gate runs before any data is loaded', async () => {
    const touched: string[] = [];
    const builder = createRiskInputBuilder({
      config: configView(['var.lookbackReturns'], SMALL),
      unitOfWork: { run: () => touched.push('unitOfWork') as never },
      valuation: { value: () => (touched.push('valuation'), Promise.reject(new Error('not expected'))) },
      history: { history: () => touched.push('history') as never },
      returns: createReturnsBuilder(),
    });
    expect(await builder.build(PF)).toEqual({
      ok: false,
      error: { status: 'CONFIG_MISSING', missingKeys: ['var.lookbackReturns'] },
    });
    expect(touched).toEqual([]);
  });

  it.each([
    ['FX_UNAVAILABLE', { AAA: 'FX_UNAVAILABLE' as const }, { status: 'FX_UNAVAILABLE', currencies: ['USD'] }],
    ['FX_STALE', { AAA: 'FX_STALE' as const }, { status: 'FX_STALE', currencies: ['USD'] }],
    [
      'price unavailable',
      { AAA: 'PRICE_UNAVAILABLE' as const },
      {
        status: 'INSUFFICIENT_DATA',
        reason: 'PRICE_UNAVAILABLE',
        tickers: ['AAA'],
        priceIssues: [{ reason: 'PRICE_UNAVAILABLE', tickers: ['AAA'] }],
      },
    ],
    [
      'price currency mismatch',
      { AAA: 'PRICE_CURRENCY_MISMATCH' as const },
      {
        status: 'INSUFFICIENT_DATA',
        reason: 'PRICE_CURRENCY_MISMATCH',
        tickers: ['AAA'],
        priceIssues: [{ reason: 'PRICE_CURRENCY_MISMATCH', tickers: ['AAA'] }],
      },
    ],
  ])('%s is a precondition: no calculation, no snapshot', async (_label, prices, expected) => {
    const h = setup({ prices });
    expect((await h.builder.build(PF)).ok).toBe(false);
    expect(await h.builder.build(PF)).toEqual({ ok: false, error: expected });
    await h.service.calculate(PF);
    expect(h.uow.snapshot().snapshots).toEqual([]);
    const view = h.service.view(PF);
    expect(view?.baseVaR).toMatchObject({ validity: 'UNAVAILABLE', value: null, status: expected.status });
  });

  it('simultaneous missing prices and currency mismatches are both reported, each sorted', async () => {
    const h = setup(
      {
        prices: {
          DDD: 'PRICE_CURRENCY_MISMATCH',
          BBB: 'PRICE_UNAVAILABLE',
          AAA: 'PRICE_CURRENCY_MISMATCH',
          EEE: 'PRICE_UNAVAILABLE',
          CCC: { price: '1' },
        },
      },
      { EEE: ['USD', '1'], DDD: ['USD', '1'], CCC: ['USD', '1'], BBB: ['USD', '1'], AAA: ['USD', '1'] },
    );
    const issues = [
      { reason: 'PRICE_UNAVAILABLE', tickers: ['BBB', 'EEE'] },
      { reason: 'PRICE_CURRENCY_MISMATCH', tickers: ['AAA', 'DDD'] },
    ];
    expect(await h.builder.build(PF)).toEqual({
      ok: false,
      error: {
        status: 'INSUFFICIENT_DATA',
        reason: 'PRICE_UNAVAILABLE',
        tickers: ['AAA', 'BBB', 'DDD', 'EEE'],
        priceIssues: issues,
      },
    });
    await h.service.calculate(PF);
    const view = h.service.view(PF);
    expect(view?.baseVaR).toMatchObject({
      value: null,
      status: 'INSUFFICIENT_DATA',
      reason: 'PRICE_UNAVAILABLE',
    });
    expect(view?.precondition).toEqual({
      currencies: [],
      tickers: ['AAA', 'BBB', 'DDD', 'EEE'],
      priceIssues: issues,
    });
  });

  it('a currency mismatch alone reaches the view with its own reason', async () => {
    const h = setup(
      { prices: { AAA: 'PRICE_CURRENCY_MISMATCH', CCC: 'PRICE_CURRENCY_MISMATCH', BBB: { price: '1' } } },
      { CCC: ['USD', '1'], AAA: ['USD', '1'], BBB: ['USD', '1'] },
    );
    await h.service.calculate(PF);
    const view = h.service.view(PF);
    expect(view?.baseVaR).toMatchObject({
      value: null,
      status: 'INSUFFICIENT_DATA',
      reason: 'PRICE_CURRENCY_MISMATCH',
    });
    expect(view?.precondition?.priceIssues).toEqual([
      { reason: 'PRICE_CURRENCY_MISMATCH', tickers: ['AAA', 'CCC'] },
    ]);
  });
  it('missing history is INSUFFICIENT_DATA (HISTORY_UNAVAILABLE); too few returns names the limiting ticker', async () => {
    const h = riskHarness({ AAA: ['USD', '10'] }, { values: SMALL, prices: { AAA: { price: '100' } } });
    expect(await h.builder.build(PF)).toEqual({
      ok: false,
      error: { status: 'INSUFFICIENT_DATA', reason: 'HISTORY_UNAVAILABLE', tickers: ['AAA'] },
    });
    h.putSeries(cleanSeries('AAA', ['100', '110'], { start: '2026-11-05' }));
    expect(await h.builder.build(PF)).toEqual({
      ok: false,
      error: {
        status: 'INSUFFICIENT_DATA',
        reason: 'OBSERVATIONS',
        tickers: ['AAA'],
        observations: 1,
        required: 2,
      },
    });
  });

  it('only zero-quantity positions give NO_POSITIONS; an unknown portfolio is not stored', async () => {
    const h = riskHarness({ AAA: ['USD', '0'] }, { values: SMALL });
    expect(await h.builder.build(PF)).toEqual({ ok: false, error: { status: 'NO_POSITIONS' } });
    expect(await h.service.calculate('unknown')).toEqual({ status: 'PORTFOLIO_NOT_FOUND' });
    expect(h.uow.snapshot().riskResults).toEqual([]);
  });

  it('a commit failure stores nothing', async () => {
    const h = setup();
    // Runs: 0 portfolio and positions, 1 series read, 2 the result commit.
    const inner = h.uow;
    const originalRun = inner.run.bind(inner);
    let runs = 0;
    inner.run = ((work) => {
      runs += 1;
      if (runs === 3) {
        inner.failNextCommit({ atWrite: 0 });
      }
      return originalRun(work);
    }) as typeof inner.run;
    expect(await h.service.calculate(PF)).toEqual({ status: 'COMMIT_FAILED' });
    expect(inner.snapshot().riskResults).toEqual([]);
    expect(inner.snapshot().snapshots).toEqual([]);
  });

  it('no result yet: view is undefined', () => {
    expect(setup().service.view(PF)).toBeUndefined();
  });
});
