// Kiroween A2: the dashboard loss distribution, from the real RiskService (stored, verified
// snapshot) to the shared contract. Data as in riskViewBuilder.test.ts: 10 AAA at 100 with prices
// 100, 110, 99, 108.9 -> returns 0.1, -0.1, 0.1 -> losses -100, 100, -100 (Loss = -E * r).
// Base VaR 95%: sorted -100, -100, 100; h = 1 + 2 * 0.95 = 2.9 -> -100 + 0.9 * 200 = 80.
// Validates: Requirements 14.7, 17.10, 32.4, 35.1, 4.4
// Kiroween decision A2: binding items three and seven to eleven.
import { describe, expect, it } from 'vitest';
import { createDashboardService } from '../../../src/app/index.js';
import type { PortfolioQueryService, PortfolioService } from '../../../src/app/index.js';
import { buildLossDistribution } from '../../../src/app/lossDistribution.js';
import type { RiskView, ScenarioLossesOutcome } from '../../../src/app/riskService.js';
import { positionId } from '../../../src/portfolio/index.js';
import { LOSS_HISTOGRAM_BUCKETS } from '../../../src/risk/index.js';
import {
  AllocationResponseSchema,
  DashboardViewResponseSchema,
  FakeClock,
  LossDistributionSchema,
  PositionsResponseSchema,
  brandDecimalString,
  currencyMinorUnits,
  d,
  toCanonical,
} from '../../../src/shared/index.js';
import type { DecimalString, LossDistribution } from '../../../src/shared/index.js';
import { completeTestConfig, withKey } from '../../helpers/config.js';
import { NOW, PF, cleanSeries, riskHarness } from '../../helpers/riskService.js';

const SMALL = withKey(withKey(completeTestConfig(), 'var.lookbackReturns', 3), 'var.minObservations', 2);

async function calculated(missing: readonly string[] = []) {
  const h = riskHarness(
    { AAA: ['USD', '10'] },
    { values: SMALL, prices: { AAA: { price: '100' } }, missing },
  );
  h.putSeries(cleanSeries('AAA', ['100', '110', '99', '108.9'], { start: '2026-11-03' }));
  await h.service.calculate(PF);
  const risk = h.service.view(PF);
  if (risk === undefined) throw new Error('no risk result');
  return { risk, scenarios: h.service.scenarioLosses(PF), service: h.service };
}

const build = (
  risk: RiskView,
  scenarios: ScenarioLossesOutcome | undefined,
  minorUnits = 2,
  bucketCount = 4,
): LossDistribution => {
  const out = buildLossDistribution({ risk, scenarios, currency: 'USD', minorUnits, bucketCount });
  // Every output satisfies the shared contract (strict, refined).
  expect(LossDistributionSchema.safeParse(out).success).toBe(true);
  return out;
};

describe('RiskService.scenarioLosses (A2)', () => {
  it('returns the Base VaR scenario losses recomputed from the stored snapshot, in date order', async () => {
    const { scenarios, service } = await calculated();
    expect(scenarios?.status).toBe('OK');
    if (scenarios?.status !== 'OK') return;
    expect(scenarios.losses.map(toCanonical)).toEqual(['-100', '100', '-100']);
    expect(scenarios.rawQuantile).toBe('80');
    expect(scenarios.confidence).toBe('0.95');
    expect(scenarios.lastDate).toBe('2026-11-06');
    expect(scenarios.firstDate < scenarios.lastDate).toBe(true);
    expect(service.scenarioLosses('no-such-portfolio')).toBeUndefined();
  });

  it('has no scenarios for a precondition result (no snapshot)', async () => {
    const { risk, scenarios } = await calculated(['var.confidence']);
    expect(risk.baseVaR.value).toBeNull();
    expect(scenarios).toEqual({ status: 'NO_SNAPSHOT' });
  });
});

describe('buildLossDistribution (A2)', () => {
  it('known answer: K = 4 over -100, 100, -100; marker at the raw quantile 80', async () => {
    const { risk, scenarios } = await calculated();
    // span 200 -> 200 / 0.01 / 4 = 5000 -> width 50. Edges -100, -50, 0, 50, 100.
    // Counts 2/0/0/1; 80 in the last bucket; above 80: {100} -> 1; position 180 / 50 = 3.6.
    expect(build(risk, scenarios)).toEqual({
      status: 'AVAILABLE',
      metric: 'BASE_VAR_SCENARIO_LOSSES',
      currency: 'USD',
      confidence: '0.95',
      horizonDays: 1,
      quantileMethod: 'HYNDMAN_FAN_TYPE_7',
      calculatedAt: risk.calculatedAt,
      scenarioWindow: { firstDate: expect.any(String) as string, lastDate: '2026-11-06' },
      scenarioCount: 3,
      bucketCount: 4,
      width: '50',
      widthDisplay: '50.00',
      min: '-100',
      max: '100',
      buckets: [
        {
          lower: '-100',
          upper: '-50',
          upperInclusive: false,
          count: 2,
          lowerDisplay: '-100.00',
          upperDisplay: '-50.00',
        },
        {
          lower: '-50',
          upper: '0',
          upperInclusive: false,
          count: 0,
          lowerDisplay: '-50.00',
          upperDisplay: '0.00',
        },
        {
          lower: '0',
          upper: '50',
          upperInclusive: false,
          count: 0,
          lowerDisplay: '0.00',
          upperDisplay: '50.00',
        },
        {
          lower: '50',
          upper: '100',
          upperInclusive: true,
          count: 1,
          lowerDisplay: '50.00',
          upperDisplay: '100.00',
        },
      ],
      varMarker: {
        rawQuantile: '80',
        rawQuantileDisplay: '80.00',
        confidence: '0.95',
        bucketIndex: 3,
        scenariosAbove: 1,
        position: '3.6',
      },
    });
  });

  it('the marker equals the stored Base VaR raw quantile and the bucket total equals the observations', async () => {
    const { risk, scenarios } = await calculated();
    const out = build(risk, scenarios, 2, LOSS_HISTOGRAM_BUCKETS);
    if (out.status !== 'AVAILABLE') throw new Error('unavailable');
    expect(out.bucketCount).toBe(20);
    expect(out.varMarker.rawQuantile).toBe(risk.baseVaR.value?.rawQuantile);
    expect(out.buckets.reduce((total, b) => total + b.count, 0)).toBe(risk.observations);
  });

  it('display text follows the currency exponent (JPY: 0 decimals); exact values stay unrounded', async () => {
    const { risk, scenarios } = await calculated();
    const out = build(risk, scenarios, currencyMinorUnits('JPY'));
    if (out.status !== 'AVAILABLE') throw new Error('unavailable');
    expect(out.width).toBe('50');
    expect(out.widthDisplay).toBe('50');
    expect(out.buckets[0]?.lowerDisplay).toBe('-100');
    expect(out.varMarker.rawQuantileDisplay).toBe('80');
  });

  describe('explicit unavailable states, never zero-valued bars', () => {
    it('BASE_VAR_UNAVAILABLE when Base VaR has no figure', async () => {
      const { risk, scenarios } = await calculated(['var.confidence']);
      expect(build(risk, scenarios)).toMatchObject({ status: 'UNAVAILABLE', reason: 'BASE_VAR_UNAVAILABLE' });
    });

    it('NO_SNAPSHOT, SNAPSHOT_RECOMPUTE_FAILED, and a recomputed result without Base VaR', async () => {
      const { risk } = await calculated();
      expect(build(risk, undefined)).toMatchObject({ reason: 'NO_SNAPSHOT' });
      expect(build(risk, { status: 'NO_SNAPSHOT' })).toMatchObject({ reason: 'NO_SNAPSHOT' });
      expect(build(risk, { status: 'SNAPSHOT_RECOMPUTE_FAILED', code: 'RETURNS_MISMATCH' })).toMatchObject({
        reason: 'SNAPSHOT_RECOMPUTE_FAILED',
      });
      expect(build(risk, { status: 'BASE_VAR_UNAVAILABLE' })).toMatchObject({
        reason: 'BASE_VAR_UNAVAILABLE',
      });
    });

    it('SCENARIO_COUNT_MISMATCH, QUANTILE_MISMATCH, and INSUFFICIENT_SCENARIOS', async () => {
      const { risk, scenarios } = await calculated();
      if (scenarios?.status !== 'OK') throw new Error('no scenarios');
      expect(build(risk, { ...scenarios, losses: scenarios.losses.slice(1) })).toMatchObject({
        reason: 'SCENARIO_COUNT_MISMATCH',
      });
      expect(build(risk, { ...scenarios, rawQuantile: '80.0000001' as DecimalString })).toMatchObject({
        reason: 'QUANTILE_MISMATCH',
      });
      // A stored figure that differs from the recomputed quantile is also refused.
      const other = {
        ...risk,
        baseVaR: { ...risk.baseVaR, value: { absolute: '81', rawQuantile: '81', percentOfNav: null } },
      };
      expect(build(other as RiskView, scenarios)).toMatchObject({ reason: 'QUANTILE_MISMATCH' });
      expect(build({ ...risk, observations: 1 }, { ...scenarios, losses: [d('-100')] })).toMatchObject({
        reason: 'INSUFFICIENT_SCENARIOS',
      });
    });

    it('an unavailable distribution carries no buckets, counts, or marker', async () => {
      const { risk } = await calculated();
      const out = build(risk, undefined);
      expect(Object.keys(out).sort()).toEqual(['explanation', 'reason', 'status']);
    });
  });
});

describe('LossDistributionSchema (shared contract)', () => {
  async function available(): Promise<Extract<LossDistribution, { status: 'AVAILABLE' }>> {
    const { risk, scenarios } = await calculated();
    const out = build(risk, scenarios);
    if (out.status !== 'AVAILABLE') throw new Error('unavailable');
    return out;
  }
  const rejects = (value: unknown): boolean => !LossDistributionSchema.safeParse(value).success;

  it('rejects counts that do not sum to the scenario count, or a bucket count mismatch', async () => {
    const ok = await available();
    expect(rejects({ ...ok, scenarioCount: 4 })).toBe(true);
    expect(rejects({ ...ok, bucketCount: 5 })).toBe(true);
    expect(rejects({ ...ok, buckets: ok.buckets.map((b, i) => (i === 1 ? { ...b, count: 1 } : b)) })).toBe(
      true,
    );
  });

  it('rejects a closed inner bucket, an open last bucket, and out-of-range marker integers', async () => {
    const ok = await available();
    expect(rejects({ ...ok, buckets: ok.buckets.map((b) => ({ ...b, upperInclusive: true })) })).toBe(true);
    expect(rejects({ ...ok, buckets: ok.buckets.map((b) => ({ ...b, upperInclusive: false })) })).toBe(true);
    expect(rejects({ ...ok, varMarker: { ...ok.varMarker, bucketIndex: 4 } })).toBe(true);
    expect(rejects({ ...ok, varMarker: { ...ok.varMarker, scenariosAbove: 3 } })).toBe(true);
  });

  it('accepts only canonical decimal strings for financial values and rejects unknown fields', async () => {
    const ok = await available();
    expect(rejects({ ...ok, width: '50.00' })).toBe(true);
    expect(rejects({ ...ok, width: 50 })).toBe(true);
    expect(rejects({ ...ok, varMarker: { ...ok.varMarker, rawQuantile: '8e1' } })).toBe(true);
    expect(rejects({ ...ok, extra: true })).toBe(true);
    expect(rejects({ status: 'UNAVAILABLE', reason: 'NO_SNAPSHOT', explanation: 'x', buckets: [] })).toBe(
      true,
    );
    expect(rejects({ status: 'UNAVAILABLE', reason: 'ZERO', explanation: 'x' })).toBe(true);
  });
});

describe('M2: the distribution is bound to the exact snapshot of the shown result', () => {
  const OTHER_HASH = 'f'.repeat(64);

  it('matching snapshot hashes produce the existing distribution', async () => {
    const { risk, scenarios } = await calculated();
    if (scenarios?.status !== 'OK') throw new Error('no scenarios');
    expect(scenarios.snapshotHash).toBe(risk.snapshotHash);
    expect(build(risk, scenarios)).toMatchObject({
      status: 'AVAILABLE',
      width: '50',
      varMarker: { rawQuantile: '80', bucketIndex: 3 },
    });
  });

  it('a different snapshot hash is SNAPSHOT_MISMATCH, never a distribution', async () => {
    const { risk, scenarios } = await calculated();
    if (scenarios?.status !== 'OK') throw new Error('no scenarios');
    const out = build(risk, { ...scenarios, snapshotHash: OTHER_HASH });
    expect(out).toEqual({
      status: 'UNAVAILABLE',
      reason: 'SNAPSHOT_MISMATCH',
      explanation:
        'The stored scenarios belong to a different calculation than the shown result, so no distribution is shown.',
    });
    // A risk view without a snapshot hash cannot be matched either.
    expect(build({ ...risk, snapshotHash: null }, scenarios)).toMatchObject({ reason: 'SNAPSHOT_MISMATCH' });
  });

  it('equal raw quantiles and scenario counts do not bypass the snapshot check', async () => {
    const { risk, scenarios } = await calculated();
    if (scenarios?.status !== 'OK') throw new Error('no scenarios');
    // Identical losses, count, confidence, and raw quantile: only the snapshot differs.
    expect(scenarios.rawQuantile).toBe(risk.baseVaR.value?.rawQuantile);
    expect(build(risk, { ...scenarios, snapshotHash: OTHER_HASH })).toMatchObject({
      reason: 'SNAPSHOT_MISMATCH',
    });
  });

  it('the snapshot check precedes the count and quantile checks; those cases are unchanged with matching hashes', async () => {
    const { risk, scenarios } = await calculated();
    if (scenarios?.status !== 'OK') throw new Error('no scenarios');
    const mismatched = { ...scenarios, snapshotHash: OTHER_HASH };
    expect(build(risk, { ...mismatched, rawQuantile: '81' as DecimalString })).toMatchObject({
      reason: 'SNAPSHOT_MISMATCH',
    });
    expect(build(risk, { ...mismatched, losses: scenarios.losses.slice(1) })).toMatchObject({
      reason: 'SNAPSHOT_MISMATCH',
    });
    // Matching hashes: QUANTILE_MISMATCH and SCENARIO_COUNT_MISMATCH as before.
    expect(build(risk, { ...scenarios, rawQuantile: '81' as DecimalString })).toMatchObject({
      reason: 'QUANTILE_MISMATCH',
    });
    expect(build(risk, { ...scenarios, losses: scenarios.losses.slice(1) })).toMatchObject({
      reason: 'SCENARIO_COUNT_MISMATCH',
    });
    // Earlier reasons keep their precedence over the snapshot check.
    expect(build(risk, undefined)).toMatchObject({ reason: 'NO_SNAPSHOT' });
    expect(build(risk, { status: 'SNAPSHOT_RECOMPUTE_FAILED', code: 'RETURNS_MISMATCH' })).toMatchObject({
      reason: 'SNAPSHOT_RECOMPUTE_FAILED',
    });
  });
});

describe('M2 through the dashboard service: a calculation stored during the view request', () => {
  /** AAA 10 at 100 (USD base), cash 100: the positions and allocation responses of the view. */
  const positionsResponse = () =>
    PositionsResponseSchema.parse({
      portfolioId: PF,
      baseCurrency: 'USD',
      at: NOW,
      positions: [
        {
          id: 'pos-1',
          portfolioId: PF,
          ticker: 'AAA',
          currency: 'USD',
          signedQuantity: '10',
          averagePrice: '1',
          isShort: false,
          updatedAt: NOW,
          source: 'CSV',
          marketPrice: '100',
          marketValueInstrument: '1000',
          marketValueBase: '1000',
          allocationPct: '100',
          valuationStatus: 'VALUED',
          priceAsOf: '2026-11-06',
          priceProvenance: { asOf: '2026-11-06', source: 'fixture-md', sourceKind: 'REAL', retrievedAt: NOW },
          fxRate: null,
          priceUnavailable: null,
          fxUnavailable: null,
        },
      ],
    });
  const measures = {
    long: '1000',
    short: '0',
    gross: '1000',
    net: '1000',
    cash: '100',
    nav: '1100',
    allocationDenominator: '1000',
  };
  const allocationResponse = () =>
    AllocationResponseSchema.parse({
      portfolioId: PF,
      baseCurrency: 'USD',
      at: NOW,
      exposure: { status: 'OK', navStatus: 'NAV_POSITIVE', measures },
      allocation: {
        status: 'ELIGIBLE',
        measures,
        lines: [{ kind: 'POSITION', ticker: 'AAA', valueBase: '1000', pct: '100' }],
        total: '100',
      },
    });

  /**
   * The real RiskService and dashboard service. `during` runs inside the positions query, after
   * the risk view was read and before the scenarios are read: exactly the window of the race.
   */
  async function dashboardWith(during?: (h: ReturnType<typeof riskHarness>) => Promise<void>) {
    const h = riskHarness(
      { AAA: ['USD', '10'] },
      { values: SMALL, prices: { AAA: { price: '100' }, BBB: { price: '50' } } },
    );
    h.putSeries(cleanSeries('AAA', ['100', '110', '99', '108.9'], { start: '2026-11-03' }));
    // BBB never moves: adding it changes the snapshot but not one loss or the quantile.
    h.putSeries(cleanSeries('BBB', ['50', '50', '50', '50'], { start: '2026-11-03' }));
    await h.service.calculate(PF);
    const queries: PortfolioQueryService = {
      positions: async () => {
        if (during !== undefined) await during(h);
        return { ok: true, value: positionsResponse() };
      },
      allocation: () => Promise.resolve({ ok: true, value: allocationResponse() }),
    };
    const service = createDashboardService({
      risk: h.service,
      queries,
      portfolios: { get: () => undefined } as unknown as PortfolioService,
      sentiment: undefined,
      sentimentAggregation: 'NOT_APPROVED',
      clock: new FakeClock(NOW),
      portfolioIds: [PF],
      runMode: 'UNSPECIFIED',
    });
    const result = await service.view(PF);
    if (!result.ok) throw new Error(result.error.code);
    return { body: DashboardViewResponseSchema.parse(result.value), h };
  }

  const addPosition = (h: ReturnType<typeof riskHarness>, ticker: string, qty: string) =>
    h.uow.run((tx) => {
      tx.positions.upsert({
        id: positionId(PF, ticker),
        portfolioId: PF,
        ticker,
        currency: 'USD',
        signedQuantity: brandDecimalString(qty),
        averagePrice: brandDecimalString('1'),
        isShort: false,
        source: 'csv:test',
        updatedAt: '2026-11-02T10:00:00.000Z',
      });
    });

  it('without a concurrent calculation the response carries the distribution', async () => {
    const { body } = await dashboardWith();
    expect(body.lossDistribution).toMatchObject({ status: 'AVAILABLE', varMarker: { rawQuantile: '80' } });
  });

  it('a newer snapshot with the SAME losses and raw quantile is refused with SNAPSHOT_MISMATCH', async () => {
    const { body, h } = await dashboardWith(async (harness) => {
      addPosition(harness, 'BBB', '5');
      await harness.service.calculate(PF);
    });
    // The newer result really has the same scenarios and quantile, and another snapshot.
    const newer = h.service.scenarioLosses(PF);
    expect(newer?.status === 'OK' && newer.rawQuantile).toBe('80');
    expect(newer?.status === 'OK' && newer.losses.map(toCanonical)).toEqual(['-100', '100', '-100']);
    expect(body.view.baseVaR.value?.rawQuantile).toBe('80');
    expect(body.lossDistribution).toEqual({
      status: 'UNAVAILABLE',
      reason: 'SNAPSHOT_MISMATCH',
      explanation:
        'The stored scenarios belong to a different calculation than the shown result, so no distribution is shown.',
    });
  });

  it('a newer snapshot with a different quantile is SNAPSHOT_MISMATCH too (checked first)', async () => {
    const { body } = await dashboardWith(async (harness) => {
      addPosition(harness, 'AAA', '20'); // doubles every loss: raw quantile 160
      await harness.service.calculate(PF);
    });
    expect(body.view.baseVaR.value?.rawQuantile).toBe('80');
    expect(body.lossDistribution).toMatchObject({ status: 'UNAVAILABLE', reason: 'SNAPSHOT_MISMATCH' });
  });
});
