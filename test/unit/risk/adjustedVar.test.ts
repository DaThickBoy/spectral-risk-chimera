// Tasks 14.1 and 14.2: the Adjusted VaR eligibility gate, direction-aware triggering, and adjusted
// scenario P&L (design: Risk Engine; FR-6, FR-8, FR-9; R15). Hand-calculated five-scenario case:
// AAA long 10 @ 100 (E = 1000), BBB long 5 @ 40 (E = 200), cash 100, NAV = 1300.
//   PnL_A = [10, -20, 30, -40, 50]; PnL_B = [-10, 4, -2, 6, -4].
//   Base: portfolio [0, -16, 28, -34, 46]; Loss sorted [-46, -28, 0, 16, 34]; n = 5, p = 0.95:
//         h = 4.8, VaR = 0.2 * 16 + 0.8 * 34 = 30.4.
//   AAA at -0.7 triggers (threshold -0.60, multiplier 1.15): PnL_A' = [10, -23, 30, -46, 50];
//         portfolio [0, -19, 28, -40, 46]; Loss sorted [-46, -28, 0, 19, 40]; VaR = 3.8 + 32 = 35.8.
//   1.15 * 30.4 = 34.96, so Adjusted VaR is not the multiplied Base VaR (AT-SEN-07).
// Tests: AT-SEN-01, AT-SEN-02, AT-SEN-03, AT-SEN-04, AT-SEN-05, AT-SEN-06, AT-SEN-07, AT-SEN-08, AT-SEN-09, AT-SEN-10, AT-SEN-11, AT-SEN-12, AT-SEN-13, AT-SEN-14, AT-SEN-18, AT-SEN-29
// Validates: Requirements 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 15.10, 15.12, 13.7
import { describe, expect, it } from 'vitest';
import { computeRisk } from '../../../src/risk/index.js';
import type { RiskInput, SentimentForRisk } from '../../../src/risk/index.js';
import { dec, position, riskInput } from '../../helpers/risk.js';

const RETURNS = {
  AAA: ['0.01', '-0.02', '0.03', '-0.04', '0.05'],
  BBB: ['-0.05', '0.02', '-0.01', '0.03', '-0.02'],
};
const ADJUSTMENT = { threshold: dec('-0.60'), multiplier: dec('1.15') };

function input(
  sentiment: readonly SentimentForRisk[],
  positions = [position('AAA', '10', '100'), position('BBB', '5', '40')],
): RiskInput {
  const base = riskInput(positions, RETURNS);
  return {
    ...base,
    sentiment,
    adjustmentConfigMissing: [],
    params: { ...base.params, adjustment: ADJUSTMENT },
  };
}
const current = (ticker: string, value: string): SentimentForRisk => ({
  ticker,
  value: dec(value),
  status: 'CURRENT',
  sourceKind: 'REAL',
  source: 'test-sentiment',
  observedAt: '2026-11-06T20:59:00.000Z',
});

describe('adjusted scenario P&L (14.2)', () => {
  it('hand-calculated five-scenario case: APPLIED, 35.8, not 1.15 x Base (AT-SEN-05, AT-SEN-07, AT-SEN-18)', () => {
    const result = computeRisk(input([current('AAA', '-0.7'), current('BBB', '0.2')]));
    expect(result.baseVaR?.absolute).toBe('30.4');
    expect(result.sentimentAdjustedVaR).toEqual({
      absolute: '35.8',
      rawQuantile: '35.8',
      percentOfNav: '2.753846153846153846153846153846153846154',
    });
    expect(result.adjustmentOutcome).toEqual({ status: 'APPLIED', missingConfigKeys: [], ineligible: [] });
    expect(result.triggeredAssets).toEqual([
      {
        ticker: 'AAA',
        direction: 'LONG',
        rawSentiment: '-0.7',
        effectiveSentiment: '-0.7',
        multiplier: '1.15',
      },
    ]);
    expect(result.sentimentAdjustedVaR?.absolute).not.toBe('34.96');
  });

  it.each([
    ['-0.60', 'NONE_TRIGGERED', '30.4'],
    ['-0.6', 'NONE_TRIGGERED', '30.4'],
    ['-0.6001', 'APPLIED', '35.8'],
    ['-0.75', 'APPLIED', '35.8'],
  ])('AAA at %s is %s (AT-SEN-01, AT-SEN-02, AT-SEN-03)', (value, status, adjusted) => {
    const result = computeRisk(input([current('AAA', value), current('BBB', '0')]));
    expect(result.adjustmentOutcome.status).toBe(status);
    expect(result.sentimentAdjustedVaR?.absolute).toBe(adjusted);
    expect(result.baseVaR?.absolute).toBe('30.4');
  });

  it('NONE_TRIGGERED is a real adjusted figure equal to Base VaR (R15.8)', () => {
    const result = computeRisk(input([current('AAA', '0.5'), current('BBB', '0.5')]));
    expect(result.sentimentAdjustedVaR).toEqual(result.baseVaR);
    expect(result.triggeredAssets).toEqual([]);
  });

  it('two triggering positions are adjusted independently (AT-SEN-06)', () => {
    // PnL_A' = [10, -23, 30, -46, 50]; PnL_B' = [-11.5, 4, -2.3, 6, -4.6];
    // portfolio [-1.5, -19, 27.7, -40, 45.4]; Loss sorted [-45.4, -27.7, 1.5, 19, 40]; VaR = 3.8 + 32 = 35.8.
    const both = computeRisk(input([current('AAA', '-0.9'), current('BBB', '-0.9')]));
    expect(both.triggeredAssets.map((t) => t.ticker)).toEqual(['AAA', 'BBB']);
    expect(both.sentimentAdjustedVaR?.absolute).toBe('35.8');
  });

  it('short positions use the negated sentiment (AT-SEN-12, AT-SEN-13)', () => {
    // BBB short -5 @ 40 (E = -200): PnL_B = [10, -4, 2, -6, 4]. Base portfolio [20, -24, 32, -46, 54]:
    // Loss sorted [-54, -32, -20, 24, 46]: VaR = 0.2 * 24 + 0.8 * 46 = 41.6. With BBB triggered:
    // PnL_B' = [10, -4.6, 2, -6.9, 4]; Loss sorted [-54, -32, -20, 24.6, 46.9]: VaR = 4.92 + 37.52 = 42.44.
    const positions = [position('AAA', '10', '100'), position('BBB', '-5', '40')];
    const bullish = computeRisk(input([current('AAA', '0'), current('BBB', '0.8')], positions));
    expect(bullish.baseVaR?.absolute).toBe('41.6');
    expect(bullish.sentimentAdjustedVaR?.absolute).toBe('42.44');
    expect(bullish.triggeredAssets).toEqual([
      {
        ticker: 'BBB',
        direction: 'SHORT',
        rawSentiment: '0.8',
        effectiveSentiment: '-0.8',
        multiplier: '1.15',
      },
    ]);
    const bearish = computeRisk(input([current('AAA', '0'), current('BBB', '-0.8')], positions));
    expect(bearish.adjustmentOutcome.status).toBe('NONE_TRIGGERED');
    expect(bearish.sentimentAdjustedVaR?.absolute).toBe('41.6');
  });

  it('positive contributions are unchanged (AT-SEN-04)', () => {
    // A triggered position whose P&L is non-negative in every scenario changes nothing.
    const gains = riskInput([position('AAA', '10', '100')], { AAA: ['0.01', '0.02', '0.03'] });
    const result = computeRisk({
      ...gains,
      sentiment: [current('AAA', '-1')],
      adjustmentConfigMissing: [],
      params: { ...gains.params, adjustment: ADJUSTMENT },
    });
    expect(result.adjustmentOutcome.status).toBe('APPLIED');
    expect(result.sentimentAdjustedVaR).toEqual(result.baseVaR);
  });

  it('a netted position is one signed position per instrument (AT-SEN-14)', () => {
    const result = computeRisk(input([current('AAA', '-0.7'), current('BBB', '0.2')]));
    expect(result.triggeredAssets.filter((t) => t.ticker === 'AAA')).toHaveLength(1);
  });
});

describe('eligibility gate (14.1)', () => {
  const base30 = (result: ReturnType<typeof computeRisk>) => {
    expect(result.status).toBe('OK');
    expect(result.baseVaR?.absolute).toBe('30.4');
    expect(result.sentimentAdjustedVaR).toBeNull();
    expect(result.triggeredAssets).toEqual([]);
  };

  it.each<[string, SentimentForRisk, string]>([
    ['stale (AT-SEN-08)', { ...current('AAA', '-0.9'), status: 'STALE' }, 'STALE'],
    ['demo (AT-SEN-09)', { ...current('AAA', '-0.9'), sourceKind: 'DEMO' }, 'DEMO'],
    // H9: the DEMO-UK fixture value, below the -0.60 threshold, even if it reached the engine.
    ['demo fixture -0.72 (H9)', { ...current('AAA', '-0.72'), sourceKind: 'DEMO' }, 'DEMO'],
    // H9: what the sentiment state actually passes for DEMO-only data (value withheld).
    [
      'demo, value withheld by the state (H9)',
      { ticker: 'AAA', value: null, status: 'CURRENT', sourceKind: 'DEMO', source: 'demo-sentiment-fixture' },
      'DEMO',
    ],
    [
      'unavailable (AT-SEN-11)',
      { ticker: 'AAA', value: null, status: 'UNAVAILABLE', sourceKind: 'REAL', source: 'test-sentiment' },
      'UNAVAILABLE',
    ],
    [
      'current without a value',
      { ticker: 'AAA', value: null, status: 'CURRENT', sourceKind: 'REAL', source: 'test-sentiment' },
      'UNAVAILABLE',
    ],
    ['out of range (AT-SEN-10)', { ...current('AAA', '-0.9'), value: '-1.5' as never }, 'INVALID'],
    ['NaN text (AT-SEN-10)', { ...current('AAA', '-0.9'), value: 'NaN' as never }, 'INVALID'],
    ['exponent text', { ...current('AAA', '-0.9'), value: '-9e-1' as never }, 'INVALID'],
  ])('%s sentiment: SENTIMENT_NOT_CURRENT naming the ticker; Base unchanged', (_label, entry, status) => {
    const result = computeRisk(input([entry, current('BBB', '0.2')]));
    base30(result);
    expect(result.adjustmentOutcome).toEqual({
      status: 'SENTIMENT_NOT_CURRENT',
      missingConfigKeys: [],
      ineligible: [{ ticker: 'AAA', sentimentStatus: status }],
    });
  });

  it('absent sentiment and sentiment of another instrument do not count (R15.2 d)', () => {
    const result = computeRisk(input([current('BBB', '0.2'), current('ZZZ', '-0.9')]));
    base30(result);
    expect(result.adjustmentOutcome.ineligible).toEqual([{ ticker: 'AAA', sentimentStatus: 'ABSENT' }]);
  });

  it('every ineligible position is listed in ticker order', () => {
    const result = computeRisk(input([{ ...current('BBB', '-0.9'), status: 'STALE' }]));
    expect(result.adjustmentOutcome.ineligible).toEqual([
      { ticker: 'AAA', sentimentStatus: 'ABSENT' },
      { ticker: 'BBB', sentimentStatus: 'STALE' },
    ]);
  });

  it('missing settings take precedence: ADJUSTMENT_CONFIG_MISSING with keys, even with eligible sentiment', () => {
    const eligible = input([current('AAA', '-0.9'), current('BBB', '0.2')]);
    const result = computeRisk({
      ...eligible,
      adjustmentConfigMissing: ['sentiment.windowSeconds'],
      params: { ...eligible.params, adjustment: null },
    });
    base30(result);
    expect(result.adjustmentOutcome).toEqual({
      status: 'ADJUSTMENT_CONFIG_MISSING',
      missingConfigKeys: ['sentiment.windowSeconds'],
      ineligible: [],
    });
  });

  it('Base VaR unavailable gives BASE_UNAVAILABLE and no adjusted figure (AT-SEN-29)', () => {
    const eligible = input([current('AAA', '-0.9'), current('BBB', '0.2')]);
    const result = computeRisk({
      ...eligible,
      params: { ...eligible.params, minObservations: 6, lookbackReturns: 6 },
    });
    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.sentimentAdjustedVaR).toBeNull();
    expect(result.adjustmentOutcome.status).toBe('BASE_UNAVAILABLE');
  });
});
