// Validates: Requirements 15.2, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 15.12
// Property 6: Adjustment locality and monotonicity; Property 7: Strict trigger threshold;
// Property 8: Direction awareness; Property 9: Ineligible sentiment never adjusts;
// Property 10: Base VaR is independent of sentiment (tasks 14.1, 14.2; design: Correctness
// Properties). Per-scenario checks use an exact BigInt fraction reference, not Decimal.js.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { adjustScenarios, computeRisk, positionPnl, scenarioLosses } from '../../src/risk/index.js';
import type { RiskInput, SentimentForRisk } from '../../src/risk/index.js';
import { d, toCanonical } from '../../src/shared/index.js';
import { compareFractions, equalFractions, fraction, parseDecimalText } from '../helpers/rational.js';
import { dec, position, riskInput } from '../helpers/risk.js';

const TICKERS = ['AAA', 'BBB', 'CCC'];
const unit4 = fc.integer({ min: -10_000, max: 10_000 }).map((v) => {
  const abs = Math.abs(v);
  const text = `${Math.floor(abs / 10_000)}.${String(abs % 10_000).padStart(4, '0')}`;
  return v < 0 ? `-${text}` : text;
});
const ret = fc.integer({ min: -900, max: 900 }).map((v) => {
  const abs = Math.abs(v);
  return `${v < 0 ? '-' : ''}0.${String(abs).padStart(4, '0')}`;
});
const multiplierArb = fc
  .integer({ min: 100, max: 300 })
  .map((v) => `${Math.floor(v / 100)}.${String(v % 100).padStart(2, '0')}`);

const caseArb = fc.integer({ min: 1, max: 3 }).chain((k) =>
  fc.record({
    quantities: fc.array(
      fc.integer({ min: -50, max: 50 }).filter((q) => q !== 0),
      { minLength: k, maxLength: k },
    ),
    returns: fc.array(fc.array(ret, { minLength: 8, maxLength: 8 }), { minLength: k, maxLength: k }),
    sentiment: fc.array(unit4, { minLength: k, maxLength: k }),
    threshold: unit4,
    multiplier: multiplierArb,
    confidence: fc.constantFrom('0.9', '0.95', '0.99'),
  }),
);
type Case = typeof caseArb extends fc.Arbitrary<infer T> ? T : never;

function build(c: Case, sentimentOverride?: (entries: SentimentForRisk[]) => SentimentForRisk[]): RiskInput {
  const positions = c.quantities.map((q, i) => position(TICKERS[i] ?? 'X', String(q), '10'));
  const returns = Object.fromEntries(positions.map((p, i) => [p.ticker, c.returns[i] ?? []]));
  const base = riskInput(positions, returns);
  const entries: SentimentForRisk[] = positions.map((p, i) => ({
    ticker: p.ticker,
    value: dec(c.sentiment[i] ?? '0'),
    status: 'CURRENT',
    sourceKind: 'REAL',
    source: 'test-sentiment',
  }));
  return {
    ...base,
    sentiment: sentimentOverride === undefined ? entries : sentimentOverride(entries),
    adjustmentConfigMissing: [],
    params: {
      ...base.params,
      confidence: dec(c.confidence),
      adjustment: { threshold: dec(c.threshold), multiplier: dec(c.multiplier) },
    },
  };
}

describe('Property 6: Adjustment locality and monotonicity', () => {
  it('only triggered negative contributions change, exactly by the multiplier; adjusted losses and VaR never decrease', () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const input = build(c);
        const pnl = positionPnl(input);
        const values = new Map(input.sentiment.map((s) => [s.ticker, d(s.value ?? '0')]));
        const m = parseDecimalText(c.multiplier);
        const adjusted = adjustScenarios(input, pnl, values, d(c.threshold), d(c.multiplier));
        const triggered = new Set(adjusted.triggered.map((t) => t.ticker));
        const baseLosses = scenarioLosses(input);
        // Reference adjusted losses, exactly.
        adjusted.losses.forEach((loss, i) => {
          let total = fraction(0n, 1n);
          input.positions.forEach((p, k) => {
            const x = parseDecimalText(toCanonical(pnl[k]?.[i] ?? d('0')));
            const y = triggered.has(p.ticker) && x.num < 0n ? fraction(x.num * m.num, x.den * m.den) : x;
            total = fraction(total.num * y.den + y.num * total.den, total.den * y.den);
          });
          expect(equalFractions(parseDecimalText(toCanonical(loss)), fraction(-total.num, total.den))).toBe(
            true,
          );
          const base = baseLosses[i];
          expect(
            base !== undefined &&
              compareFractions(parseDecimalText(toCanonical(loss)), parseDecimalText(toCanonical(base))) >= 0,
          ).toBe(true);
        });
        const result = computeRisk(input);
        if (result.sentimentAdjustedVaR !== null && result.baseVaR !== null) {
          expect(
            d(result.sentimentAdjustedVaR.rawQuantile).greaterThanOrEqualTo(d(result.baseVaR.rawQuantile)),
          ).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('Adjusted VaR is generally not the multiplied Base VaR (property 6e, sampled)', () => {
    let differs = 0;
    fc.assert(
      fc.property(caseArb, (c) => {
        const result = computeRisk(build(c));
        if (
          result.adjustmentOutcome.status === 'APPLIED' &&
          result.baseVaR !== null &&
          result.sentimentAdjustedVaR !== null
        ) {
          const scaled = d(result.baseVaR.absolute).times(d(c.multiplier));
          if (!scaled.equals(d(result.sentimentAdjustedVaR.absolute))) {
            differs += 1;
          }
        }
      }),
      { numRuns: 200 },
    );
    expect(differs).toBeGreaterThan(0);
  });
});

describe('Property 7: Strict trigger threshold', () => {
  it('a long position triggers if and only if s < t', () => {
    fc.assert(
      fc.property(caseArb, unit4, unit4, (c, s, t) => {
        const one: Case = {
          ...c,
          quantities: [7],
          returns: [c.returns[0] ?? []],
          sentiment: [s],
          threshold: t,
        };
        const result = computeRisk(build(one));
        expect(result.triggeredAssets.length === 1).toBe(d(s).lessThan(d(t)));
      }),
      { numRuns: 300 },
    );
  });
});

describe('Property 8: Direction awareness', () => {
  it('a short with raw s triggers if and only if a long with raw -s triggers', () => {
    fc.assert(
      fc.property(caseArb, unit4, unit4, (c, s, t) => {
        const negated = toCanonical(d(s).negated());
        const short = computeRisk(
          build({ ...c, quantities: [-7], returns: [c.returns[0] ?? []], sentiment: [s], threshold: t }),
        );
        const long = computeRisk(
          build({ ...c, quantities: [7], returns: [c.returns[0] ?? []], sentiment: [negated], threshold: t }),
        );
        expect(short.triggeredAssets.length).toBe(long.triggeredAssets.length);
        expect(short.triggeredAssets[0]?.effectiveSentiment ?? null).toBe(
          long.triggeredAssets[0]?.effectiveSentiment ?? null,
        );
      }),
      { numRuns: 300 },
    );
  });
});

const ineligible = fc.constantFrom<(e: SentimentForRisk) => SentimentForRisk | undefined>(
  (e) => ({ ...e, status: 'STALE' }),
  (e) => ({ ...e, status: 'UNAVAILABLE', value: null }),
  (e) => ({ ...e, sourceKind: 'DEMO' }),
  (e) => ({ ...e, value: '1.0001' as never }),
  () => undefined,
);

describe('Property 9: Ineligible sentiment never adjusts', () => {
  it('any ineligible position or missing setting: null Adjusted VaR, no triggers, Base unchanged', () => {
    fc.assert(
      fc.property(caseArb, ineligible, fc.nat(), fc.boolean(), (c, spoil, pick, configMissing) => {
        const reference = computeRisk({ ...build(c), sentiment: [] });
        const spoiled = build(c, (entries) => {
          const index = pick % entries.length;
          return entries.flatMap((e, i) => {
            const changed = i === index ? spoil(e) : e;
            return changed === undefined ? [] : [changed];
          });
        });
        const input: RiskInput = configMissing
          ? {
              ...spoiled,
              adjustmentConfigMissing: ['adjustment.multiplier'],
              params: { ...spoiled.params, adjustment: null },
            }
          : spoiled;
        const result = computeRisk(input);
        expect(result.sentimentAdjustedVaR).toBeNull();
        expect(result.triggeredAssets).toEqual([]);
        expect(result.adjustmentOutcome.status).toBe(
          configMissing ? 'ADJUSTMENT_CONFIG_MISSING' : 'SENTIMENT_NOT_CURRENT',
        );
        expect(result.baseVaR).toEqual(reference.baseVaR);
      }),
      { numRuns: 300 },
    );
  });
});

describe('Property 10: Base VaR is independent of sentiment', () => {
  it('inputs that differ only in sentiment have identical Base VaR', () => {
    fc.assert(
      fc.property(caseArb, fc.array(unit4, { minLength: 3, maxLength: 3 }), ineligible, (c, other, spoil) => {
        const a = computeRisk(build(c));
        const b = computeRisk(build({ ...c, sentiment: other.slice(0, c.quantities.length) }));
        const e = computeRisk(
          build(c, (entries) =>
            entries.flatMap((x) => (spoil(x) === undefined ? [] : [spoil(x) as SentimentForRisk])),
          ),
        );
        expect(b.baseVaR).toEqual(a.baseVaR);
        expect(e.baseVaR).toEqual(a.baseVaR);
        expect(b.flags).toEqual(a.flags);
      }),
      { numRuns: 300 },
    );
  });
});
