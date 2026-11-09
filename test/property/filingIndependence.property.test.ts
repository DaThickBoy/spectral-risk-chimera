// Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 15.14, 21.4, 27.9
// Property 11: Filing independence (risk side) and Property 17: Score range validation (risk
// input part) (task 14.5; design: Correctness Properties). FilingRiskScore fixtures (the phase 1
// type) vary only in the snapshot's display-only section: the RiskResult, the triggered assets,
// and the snapshot hash stay identical. Invalid sentiment from the source never enters RiskInput.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildSnapshot, createRiskInputBuilder } from '../../src/app/index.js';
import type { FilingScoreDisplay } from '../../src/app/index.js';
import { createReturnsBuilder } from '../../src/marketdata/index.js';
import { computeRisk } from '../../src/risk/index.js';
import type { RiskInput } from '../../src/risk/index.js';
import { FilingRiskScoreSchema, canonicalJson } from '../../src/shared/index.js';
import { completeTestConfig, withKey } from '../helpers/config.js';
import { dec, position, riskInput } from '../helpers/risk.js';
import { PF, VERSION, cleanSeries, configView, fakeValuation, riskHarness } from '../helpers/riskService.js';

const scoreArb = fc
  .integer({ min: 0, max: 10_000 })
  .map((v) => (v === 10_000 ? '1' : `0.${String(v).padStart(4, '0')}`));
const filingArb = fc.array(
  fc.record({
    ticker: fc.constantFrom('AAA', 'BBB'),
    score: fc.option(scoreArb, { nil: null }),
    status: fc.constantFrom('CURRENT', 'STALE', 'SUPERSEDED', 'UNAVAILABLE'),
  }),
  { maxLength: 4 },
);

function input(sentiment: string): RiskInput {
  const base = riskInput([position('AAA', '10', '100'), position('BBB', '-3', '50')], {
    AAA: ['0.01', '-0.02', '0.03', '-0.04'],
    BBB: ['0.02', '0.01', '-0.03', '0.05'],
  });
  return {
    ...base,
    sentiment: [
      {
        ticker: 'AAA',
        value: dec(sentiment),
        status: 'CURRENT',
        sourceKind: 'REAL',
        source: 'test-sentiment',
      },
      { ticker: 'BBB', value: dec('0.1'), status: 'CURRENT', sourceKind: 'REAL', source: 'test-sentiment' },
    ],
    adjustmentConfigMissing: [],
    params: { ...base.params, adjustment: { threshold: dec('-0.60'), multiplier: dec('1.15') } },
  };
}

describe('Property 11: Filing independence (risk side)', () => {
  it('filing scores change neither Base VaR, Adjusted VaR, triggered assets, nor the snapshot hash (AT-FIL-01 to 03)', () => {
    fc.assert(
      fc.property(filingArb, filingArb, fc.constantFrom('-0.9', '-0.6', '0.4'), (a, b, s) => {
        const riskIn = input(s);
        const result = computeRisk(riskIn);
        const scores = (list: typeof a): FilingScoreDisplay[] =>
          list.map((f) => ({ ...f, score: f.score === null ? null : FilingRiskScoreSchema.parse(f.score) }));
        const first = buildSnapshot(riskIn, result, VERSION, 5, { filingScores: scores(a) });
        const second = buildSnapshot(riskIn, computeRisk(riskIn), VERSION, 5, { filingScores: scores(b) });
        expect(second.hash).toBe(first.hash);
        expect(second.inputsCanonical).toBe(first.inputsCanonical);
        expect(canonicalJson(computeRisk(riskIn))).toBe(canonicalJson(result));
      }),
      { numRuns: 200 },
    );
  });

  it('RiskInput has no filing field (type level)', () => {
    const riskIn = input('-0.9');
    // @ts-expect-error -- RiskInput has no filing field (R11.5); excess properties are rejected.
    const withFiling: RiskInput = { ...riskIn, filingRiskScore: '0.9' };
    expect(Object.keys(computeRisk(riskIn)).some((key) => /filing/i.test(key))).toBe(false);
    expect('filingRiskScore' in withFiling).toBe(true);
  });
});

describe('Property 17: invalid scores cannot enter RiskInput (AT-VAL-01)', () => {
  it('an invalid sentiment value from the source is replaced before the engine runs', async () => {
    const values = withKey(withKey(completeTestConfig(), 'var.lookbackReturns', 3), 'var.minObservations', 2);
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('1.0001', '-1.5', 'NaN', '-6e-1', '', 'abc', '0.5'), async (bad) => {
        const h = riskHarness({ AAA: ['USD', '10'] }, { values, prices: { AAA: { price: '100' } } });
        h.putSeries(cleanSeries('AAA', ['100', '110', '99', '108.9'], { start: '2026-11-03' }));
        const checked = createRiskInputBuilder({
          config: configView([], values),
          unitOfWork: h.uow,
          valuation: fakeValuation({ AAA: { price: '100' } }),
          history: {
            history: (t) =>
              t === 'AAA'
                ? {
                    ok: true,
                    value: cleanSeries('AAA', ['100', '110', '99', '108.9'], { start: '2026-11-03' }),
                  }
                : { ok: false, error: { code: 'HISTORY_UNAVAILABLE', message: 'x' } },
          },
          returns: createReturnsBuilder(),
          sentiment: {
            forRisk: (ticker) => ({
              ticker,
              value: bad as never,
              status: 'CURRENT',
              sourceKind: 'REAL',
              source: 'test-sentiment',
            }),
          },
        });
        const built = await checked.build(PF);
        expect(built.ok).toBe(true);
        if (built.ok) {
          const [entry] = built.value.sentiment;
          if (bad === '0.5') {
            expect(entry).toEqual({
              ticker: 'AAA',
              value: '0.5',
              status: 'CURRENT',
              sourceKind: 'REAL',
              source: 'test-sentiment',
            });
          } else {
            expect(entry).toEqual({
              ticker: 'AAA',
              value: null,
              status: 'UNAVAILABLE',
              sourceKind: 'REAL',
              source: 'test-sentiment',
            });
            expect(JSON.stringify(built.value.sentiment)).not.toContain(`"value":"${bad}"`);
          }
        }
      }),
      { numRuns: 7 },
    );
  });
});
