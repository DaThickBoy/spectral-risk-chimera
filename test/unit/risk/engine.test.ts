// Task 12.2: the Base VaR engine (design: Risk Engine; FR-4, FR-5, FR-7, FR-12).
// Expected values are hand-calculated below each case, independently of the implementation.
// Tests: AT-VAR-03, AT-VAR-07, AT-VAR-13, AT-VAR-14, AT-VAR-15, AT-VAR-16, AT-VAR-17, AT-VAR-18
// Validates: Requirements 14.1, 14.2, 14.3, 14.5, 14.6, 14.7, 14.8, 14.9, 14.11, 14.12, 15.8, 11.5
import { describe, expect, it } from 'vitest';
import { computeRisk, scenarioLosses, type7Quantile } from '../../../src/risk/index.js';
import type { RiskInput } from '../../../src/risk/index.js';
import { d, toCanonical } from '../../../src/shared/index.js';
import { EVALUATED_AT, dec, matrix, observedFx, position, riskInput } from '../../helpers/risk.js';

// Two assets (AT-VAR-18): AAA long 10 @ 100 USD (identity); BBB short -5 @ 50 EUR at EURUSD 1.1.
// E_A = 1000; E_B = -5 * 50 * 1.1 = -275. NAV = 1000 - 275 + cash 100 = 825.
// PnL_A = [10, -20, 30]; PnL_B = [-5.5, -2.75, 11]; portfolio = [4.5, -22.75, 41];
// Loss = [-4.5, 22.75, -41]; sorted [-41, -4.5, 22.75]. p = 0.95, n = 3: h = 2.9, j = 2, gamma = 0.9:
// VaR = 0.1 * -4.5 + 0.9 * 22.75 = 20.025. VaR% = 20.025 / 825 * 100 = 2.4272... (40 significant digits).
const TWO_ASSET = riskInput(
  [
    position('AAA', '10', '100'),
    position('BBB', '-5', '50', { currency: 'EUR', fx: observedFx('EUR', '1.1') }),
  ],
  { AAA: ['0.01', '-0.02', '0.03'], BBB: ['0.02', '0.01', '-0.04'] },
);

describe('computeRisk: hand-calculated cases', () => {
  it('two-asset long/short portfolio (AT-VAR-18)', () => {
    const result = computeRisk(TWO_ASSET);
    expect(result.status).toBe('OK');
    expect(result.nav).toBe('825');
    expect(result.baseVaR).toEqual({
      absolute: '20.025',
      rawQuantile: '20.025',
      percentOfNav: '2.427272727272727272727272727272727272727',
    });
    expect(scenarioLosses(TWO_ASSET).map(toCanonical)).toEqual(['-4.5', '22.75', '-41']);
    expect(result.flags).toEqual([]);
  });

  it('single short position: a rising price is a loss (FR-5)', () => {
    // E = -1000; PnL = [-50, 10, -20]; Loss = [50, -10, 20]; sorted [-10, 20, 50]: 0.1*20 + 0.9*50 = 47.
    const result = computeRisk(
      riskInput([position('AAA', '-10', '100')], { AAA: ['0.05', '-0.01', '0.02'] }),
    );
    expect(result.baseVaR?.absolute).toBe('47');
    // NAV = -1000 + 100 = -900 <= 0: no percentage (AT-VAR-15).
    expect(result.nav).toBe('-900');
    expect(result.baseVaR?.percentOfNav).toBeNull();
    expect(result.flags).toEqual(['NAV_NOT_POSITIVE']);
  });

  it('VaR is a quantile of losses, not of P&L or returns (AT-VAR-07)', () => {
    // P&L sorted [-22.75, 4.5, 41]: Q(0.95) = 0.1*4.5 + 0.9*41 = 37.35, which is not the VaR.
    const pnl = scenarioLosses(TWO_ASSET).map((loss) => loss.negated());
    const pnlQuantile = type7Quantile(pnl, d('0.95'));
    expect(pnlQuantile.ok && toCanonical(pnlQuantile.value)).toBe('37.35');
    expect(computeRisk(TWO_ASSET).baseVaR?.absolute).toBe('20.025');
  });

  it('all scenarios are gains: VaR 0, raw quantile kept, NO_LOSS_AT_CONFIDENCE (AT-VAR-13)', () => {
    // E = 1000; Loss = [-10, -20, -30]; sorted [-30, -20, -10]: 0.1*-20 + 0.9*-10 = -11.
    const result = computeRisk(riskInput([position('AAA', '10', '100')], { AAA: ['0.01', '0.02', '0.03'] }));
    expect(result.baseVaR).toEqual({ absolute: '0', rawQuantile: '-11', percentOfNav: '0' });
    expect(result.flags).toEqual(['NO_LOSS_AT_CONFIDENCE']);
  });

  it('NAV exactly 0 gives NAV_NOT_POSITIVE and no percentage (AT-VAR-15)', () => {
    const result = computeRisk(
      riskInput([position('AAA', '10', '100')], { AAA: ['-0.01', '0.02', '0.03'] }, { cash: dec('-1000') }),
    );
    expect(result.nav).toBe('0');
    expect(result.baseVaR?.percentOfNav).toBeNull();
    expect(result.flags).toContain('NAV_NOT_POSITIVE');
  });
});

describe('computeRisk: parameters', () => {
  it.each(['0.95', '0.99', '0.5'])('accepts confidence %s (AT-VAR-03)', (confidence) => {
    const input = { ...TWO_ASSET, params: { ...TWO_ASSET.params, confidence: dec(confidence) } };
    expect(computeRisk(input).status).toBe('OK');
  });

  it('confidence 0.99 at n = 3: h = 2.98, VaR = 0.02*-4.5 + 0.98*22.75 = 22.205', () => {
    const input = { ...TWO_ASSET, params: { ...TWO_ASSET.params, confidence: dec('0.99') } };
    expect(computeRisk(input).baseVaR?.absolute).toBe('22.205');
  });

  it.each(['0', '1', '-0.1', '1.5', 'NaN', '0.95e0', ''])(
    'rejects confidence %j (AT-VAR-03)',
    (confidence) => {
      const input = { ...TWO_ASSET, params: { ...TWO_ASSET.params, confidence: confidence as never } };
      const result = computeRisk(input);
      expect(result).toMatchObject({
        status: 'INVALID_INPUT',
        invalidReason: 'CONFIDENCE_OUT_OF_RANGE',
        baseVaR: null,
      });
    },
  );

  it.each([0, 2, 10, 1.5])('rejects horizonDays %s; no scaling exists (AT-VAR-14)', (horizonDays) => {
    const result = computeRisk({ ...TWO_ASSET, params: { ...TWO_ASSET.params, horizonDays } });
    expect(result).toMatchObject({
      status: 'INVALID_INPUT',
      invalidReason: 'HORIZON_NOT_ONE',
      baseVaR: null,
    });
    expect(result.horizonDays).toBe(1);
  });
});

describe('computeRisk: statuses', () => {
  it('no positions gives NO_POSITIONS with NAV = cash (AT-VAR-16)', () => {
    const result = computeRisk(riskInput([], {}));
    expect(result).toMatchObject({ status: 'NO_POSITIONS', nav: '100', baseVaR: null, observations: 0 });
    expect(result.adjustmentOutcome.status).toBe('BASE_UNAVAILABLE');
  });

  it('fewer returns than minObservations gives INSUFFICIENT_DATA with the count and no VaR', () => {
    const input = { ...TWO_ASSET, params: { ...TWO_ASSET.params, minObservations: 3, lookbackReturns: 4 } };
    const result = computeRisk({
      ...input,
      returns: matrix({ AAA: ['0.01', '0.02'], BBB: ['0.01', '0.02'] }, { status: 'REDUCED_LOOKBACK' }),
    });
    expect(result).toMatchObject({ status: 'INSUFFICIENT_DATA', observations: 2, baseVaR: null });
  });

  it.each<[string, (input: RiskInput) => RiskInput, string]>([
    [
      'unsorted positions',
      (i) => ({ ...i, positions: [...i.positions].reverse() }),
      'POSITIONS_NOT_SORTED_UNIQUE',
    ],
    ['zero quantity', (i) => ({ ...i, positions: [position('AAA', '0', '100')] }), 'QUANTITY_INVALID'],
    ['zero price', (i) => ({ ...i, positions: [position('AAA', '1', '0')] }), 'PRICE_INVALID'],
    [
      'stale FX rate',
      (i) => ({
        ...i,
        positions: [
          position('AAA', '1', '1', { fx: { ...observedFx('USD', '1'), status: 'STALE' } as never }),
        ],
      }),
      'FX_RATE_INVALID',
    ],
    [
      'FX pair of another currency',
      (i) => ({
        ...i,
        positions: [position('AAA', '1', '1', { currency: 'EUR', fx: observedFx('GBP', '1') })],
      }),
      'FX_RATE_INVALID',
    ],
    [
      'returns of other tickers',
      (i) => ({ ...i, returns: matrix({ ZZZ: ['0.1', '0.2', '0.3'], BBB: ['0', '0', '0'] }) }),
      'RETURNS_TICKERS_MISMATCH',
    ],
    ['cash missing', (i) => ({ ...i, cash: '' as never }), 'CASH_INVALID'],
    [
      'adjustment present with missing keys',
      (i) => ({
        ...i,
        params: { ...i.params, adjustment: { threshold: dec('-0.6'), multiplier: dec('1.15') } },
      }),
      'ADJUSTMENT_CONFIG_INCONSISTENT',
    ],
  ])('%s is INVALID_INPUT', (_label, change, reason) => {
    expect(computeRisk(change(TWO_ASSET))).toMatchObject({
      status: 'INVALID_INPUT',
      invalidReason: reason,
      baseVaR: null,
      nav: null,
    });
  });

  it('two sentiment entries for one ticker, or an unknown status, are INVALID_INPUT (task 14.1)', () => {
    const entry = {
      ticker: 'AAA',
      value: dec('0.1'),
      status: 'CURRENT' as const,
      sourceKind: 'REAL' as const,
      source: 'test-sentiment',
    };
    expect(computeRisk({ ...TWO_ASSET, sentiment: [entry, entry] })).toMatchObject({
      status: 'INVALID_INPUT',
      invalidReason: 'SENTIMENT_DUPLICATE',
    });
    expect(computeRisk({ ...TWO_ASSET, sentiment: [{ ...entry, status: 'FRESH' as never }] })).toMatchObject({
      status: 'INVALID_INPUT',
      invalidReason: 'SENTIMENT_ENTRY_INVALID',
    });
  });
});

describe('computeRisk: flags, adjusted outcome, and metadata', () => {
  it('REDUCED_LOOKBACK, MARKET_DATA_STALE, and DEMO_DATA are reported in a fixed order', () => {
    const input: RiskInput = {
      ...TWO_ASSET,
      positions: [
        position('AAA', '10', '100', { historySourceKind: 'DEMO' }),
        position('BBB', '-5', '50', { currency: 'EUR', fx: observedFx('EUR', '1.1') }),
      ],
      params: { ...TWO_ASSET.params, lookbackReturns: 5 },
      returns: matrix(TWO_ASSET.returns?.returns ?? {}, {}, 5),
      marketDataStale: true,
    };
    expect(computeRisk(input).flags).toEqual(['REDUCED_LOOKBACK', 'MARKET_DATA_STALE', 'DEMO_DATA']);
  });

  it('a DEMO FX rate sets DEMO_DATA', () => {
    const input = {
      ...TWO_ASSET,
      positions: [
        position('AAA', '10', '100'),
        position('BBB', '-5', '50', { currency: 'EUR', fx: observedFx('EUR', '1.1', 'DEMO') }),
      ],
    };
    expect(computeRisk(input).flags).toEqual(['DEMO_DATA']);
  });

  it('Adjusted VaR is never a copy of Base VaR (R15.8)', () => {
    const missing = computeRisk(TWO_ASSET);
    expect(missing.sentimentAdjustedVaR).toBeNull();
    expect(missing.adjustmentOutcome).toEqual({
      status: 'ADJUSTMENT_CONFIG_MISSING',
      missingConfigKeys: ['adjustment.bearishThreshold', 'adjustment.multiplier'],
      ineligible: [],
    });
    const configured = computeRisk({
      ...TWO_ASSET,
      adjustmentConfigMissing: [],
      params: { ...TWO_ASSET.params, adjustment: { threshold: dec('-0.6'), multiplier: dec('1.15') } },
    });
    expect(configured.sentimentAdjustedVaR).toBeNull();
    expect(configured.adjustmentOutcome).toEqual({
      status: 'SENTIMENT_NOT_CURRENT',
      missingConfigKeys: [],
      ineligible: [
        { ticker: 'AAA', sentimentStatus: 'ABSENT' },
        { ticker: 'BBB', sentimentStatus: 'ABSENT' },
      ],
    });
  });

  it('exposes every R14.12 metadata field the engine owns (AT-VAR-17)', () => {
    const result = computeRisk(TWO_ASSET);
    expect(result).toMatchObject({
      algorithmVersion: 'hs-var-2',
      portfolioId: 'pf-1',
      evaluatedAt: EVALUATED_AT,
      asOfDate: '2026-01-03',
      confidence: '0.95',
      horizonDays: 1,
      observations: 3,
      lookbackReturns: 3,
      completeness: 'COMPLETE',
      quantileMethod: 'HYNDMAN_FAN_TYPE_7',
      currency: 'USD',
      seriesHashes: { AAA: 'aaa-hash', BBB: 'bbb-hash' },
    });
    expect(result.returnsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('the result has no filing field and the input type has none (R11.5)', () => {
    const keys = Object.keys(computeRisk(TWO_ASSET));
    expect(keys.some((key) => /filing/i.test(key))).toBe(false);
    expect(Object.keys(TWO_ASSET).some((key) => /filing/i.test(key))).toBe(false);
  });
});
