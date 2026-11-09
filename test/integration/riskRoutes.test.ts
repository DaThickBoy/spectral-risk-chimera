// Task 12.6: risk and snapshot routes through Fastify inject() (design: API routes, Gateway rules).
// API part of AT-DSH-15 (completed in 17.3): Base and Adjusted VaR are separate entries; an
// unavailable figure is null with its status and reason, never zero and never the Base figure.
// Validates: Requirements 14.10, 14.12, 17.10, 22.5, 35.6
import { describe, expect, it } from 'vitest';
import { riskRoutes } from '../../src/api/index.js';
import { RiskResponseSchema, SnapshotResponseSchema } from '../../src/shared/index.js';
import { jsonNumbers, testServer } from '../helpers/api.js';
import { completeTestConfig, withKey } from '../helpers/config.js';
import { PF, cleanSeries, riskHarness } from '../helpers/riskService.js';

const SMALL = withKey(withKey(completeTestConfig(), 'var.lookbackReturns', 3), 'var.minObservations', 2);

function setup(missing: readonly string[] = []) {
  const h = riskHarness(
    { AAA: ['USD', '10'] },
    { values: SMALL, prices: { AAA: { price: '100' } }, missing },
  );
  h.putSeries(cleanSeries('AAA', ['100', '110', '99', '108.9'], { start: '2026-11-03' }));
  const { app } = testServer([riskRoutes({ risk: h.service })]);
  return { ...h, app };
}

/** JSON numbers allowed in a risk response: integer counts and versions only. */
const ALLOWED_NUMBERS = ['$.observations', '$.lookbackReturns', '$.horizonDays', '$.configVersion.seq'];

describe('GET /portfolios/:id/risk', () => {
  it('returns Base CURRENT with its figure and Adjusted UNAVAILABLE with null and its reason', async () => {
    const s = setup();
    await s.service.calculate(PF);
    const response = await s.app.inject({ method: 'GET', url: `/portfolios/${PF}/risk` });
    expect(response.statusCode).toBe(200);
    const body = RiskResponseSchema.parse(response.json());
    expect(body.baseVaR).toMatchObject({ validity: 'CURRENT', value: { absolute: '80', rawQuantile: '80' } });
    expect(body.adjustedVaR).toEqual({
      validity: 'UNAVAILABLE',
      value: null,
      status: 'SENTIMENT_NOT_CURRENT',
      reason: 'SENTIMENT_NOT_CURRENT',
      missingKeys: [],
      lastValid: null,
    });
    expect(jsonNumbers(response.json()).filter((path) => !ALLOWED_NUMBERS.includes(path))).toEqual([]);
  });

  it('a missing Base VaR key: both figures null with CONFIG_MISSING and keys; earlier figure only as LAST_VALID', async () => {
    const s = setup();
    await s.service.calculate(PF);
    const missing = riskHarness({}, { uow: s.uow, values: SMALL, missing: ['var.confidence'] });
    await missing.service.calculate(PF);
    const response = await s.app.inject({ method: 'GET', url: `/portfolios/${PF}/risk` });
    const body = RiskResponseSchema.parse(response.json());
    expect(body.status).toBe('CONFIG_MISSING');
    expect(body.baseVaR).toMatchObject({
      validity: 'UNAVAILABLE',
      value: null,
      missingKeys: ['var.confidence'],
    });
    expect(body.baseVaR.lastValid?.value.absolute).toBe('80');
    expect(body.adjustedVaR).toMatchObject({
      validity: 'UNAVAILABLE',
      value: null,
      status: 'BASE_UNAVAILABLE',
      lastValid: null,
    });
    expect(body.snapshotHash).toBeNull();
  });

  it('reports missing prices and currency mismatches together, each with its sorted tickers', async () => {
    const h = riskHarness(
      { BBB: ['USD', '1'], AAA: ['USD', '1'] },
      { values: SMALL, prices: { AAA: 'PRICE_CURRENCY_MISMATCH', BBB: 'PRICE_UNAVAILABLE' } },
    );
    const { app } = testServer([riskRoutes({ risk: h.service })]);
    await h.service.calculate(PF);
    const body = RiskResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/portfolios/${PF}/risk` })).json(),
    );
    expect(body.status).toBe('INSUFFICIENT_DATA');
    expect(body.baseVaR).toMatchObject({ value: null, reason: 'PRICE_UNAVAILABLE' });
    expect(body.precondition?.priceIssues).toEqual([
      { reason: 'PRICE_UNAVAILABLE', tickers: ['BBB'] },
      { reason: 'PRICE_CURRENCY_MISMATCH', tickers: ['AAA'] },
    ]);
  });

  it('404 without a result; 400 for an invalid portfolio id', async () => {
    const s = setup();
    expect((await s.app.inject({ method: 'GET', url: `/portfolios/${PF}/risk` })).statusCode).toBe(404);
    expect((await s.app.inject({ method: 'GET', url: '/portfolios/%20bad/risk' })).statusCode).toBe(400);
  });
});

describe('GET /portfolios/:id/snapshots/:hash', () => {
  it('returns the stored full snapshot including displayOnly; financial values are strings', async () => {
    const s = setup();
    await s.service.calculate(PF);
    const hash = s.uow.snapshot().snapshots[0]?.hash ?? '';
    const response = await s.app.inject({ method: 'GET', url: `/portfolios/${PF}/snapshots/${hash}` });
    expect(response.statusCode).toBe(200);
    const body = SnapshotResponseSchema.parse(response.json());
    expect(body.hash).toBe(hash);
    expect(body.snapshot['displayOnly']).toEqual({ filingScores: [] });
    const numbers = jsonNumbers(response.json());
    expect(
      numbers.every((path) =>
        /(schemaVersion|seq|lookbackReturns|minObservations|maxReturnGapDays|observations|horizonDays)$/.test(
          path,
        ),
      ),
    ).toBe(true);
  });

  it('404 for an unknown hash or another portfolio; 400 for a malformed hash', async () => {
    const s = setup();
    await s.service.calculate(PF);
    const hash = s.uow.snapshot().snapshots[0]?.hash ?? '';
    expect(
      (await s.app.inject({ method: 'GET', url: `/portfolios/${PF}/snapshots/${'0'.repeat(64)}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await s.app.inject({ method: 'GET', url: `/portfolios/other/snapshots/${hash}` })).statusCode,
    ).toBe(404);
    expect((await s.app.inject({ method: 'GET', url: `/portfolios/${PF}/snapshots/xyz` })).statusCode).toBe(
      400,
    );
  });
});
