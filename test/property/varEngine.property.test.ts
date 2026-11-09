// Validates: Requirements 14.5, 14.6, 14.7, 14.8
// Property 4: VaR is a quantile of losses, and Property 5: Portfolio P&L is the sum of position
// P&L (task 12.2; design: Correctness Properties). The reference is exact BigInt fraction
// arithmetic (test/helpers/rational.ts), not Decimal.js. Values are small enough that every
// product and quantile is exact within 40 significant digits.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeRisk, scenarioLosses } from '../../src/risk/index.js';
import type { RiskInput, RiskPosition } from '../../src/risk/index.js';
import { toCanonical } from '../../src/shared/index.js';
import {
  addFractions,
  compareFractions,
  equalFractions,
  fraction,
  parseDecimalText,
} from '../helpers/rational.js';
import type { Fraction } from '../helpers/rational.js';
import { dec, observedFx, position, riskInput } from '../helpers/risk.js';

const digits = (max: number) => fc.integer({ min: 0, max });
const decimalArb = (intMax: number, fracDigits: number, signed: boolean) =>
  fc
    .tuple(fc.boolean(), digits(intMax), digits(10 ** fracDigits - 1))
    .map(
      ([neg, i, f]) =>
        `${signed && neg && (i > 0 || f > 0) ? '-' : ''}${i}.${String(f).padStart(fracDigits, '0')}`,
    );
const positiveArb = (intMax: number, fracDigits: number) =>
  fc
    .tuple(digits(intMax), fc.integer({ min: 1, max: 10 ** fracDigits - 1 }))
    .map(([i, f]) => `${i}.${String(f).padStart(fracDigits, '0')}`);

const TICKERS = ['AAA', 'BBB', 'CCC', 'DDD'];

const portfolioArb = (returnArb: fc.Arbitrary<string>, longOnly: boolean) =>
  fc.integer({ min: 1, max: 4 }).chain((k) =>
    fc.integer({ min: 2, max: 30 }).chain((n) =>
      fc.tuple(
        fc.array(
          fc.tuple(
            fc
              .integer({ min: 1, max: 9999 })
              .chain((q) => fc.boolean().map((neg) => (longOnly || !neg ? String(q) : `-${q}`))),
            positiveArb(999, 2),
            fc.option(positiveArb(2, 4), { nil: undefined }),
          ),
          { minLength: k, maxLength: k },
        ),
        fc.array(fc.array(returnArb, { minLength: n, maxLength: n }), { minLength: k, maxLength: k }),
        fc.constantFrom('0.5', '0.9', '0.95', '0.975', '0.99'),
      ),
    ),
  );

function buildInput([specs, returns, confidence]: [
  readonly [string, string, string | undefined][],
  readonly string[][],
  string,
]): RiskInput {
  const positions: RiskPosition[] = specs.map(([q, price, rate], i) =>
    rate === undefined
      ? position(TICKERS[i] ?? 'X', q, price)
      : position(TICKERS[i] ?? 'X', q, price, { currency: 'EUR', fx: observedFx('EUR', rate) }),
  );
  const byTicker = Object.fromEntries(positions.map((p, i) => [p.ticker, returns[i] ?? []]));
  const input = riskInput(positions, byTicker);
  return {
    ...input,
    params: { ...input.params, confidence: confidence as RiskInput['params']['confidence'] },
  };
}

const exposure = (p: RiskPosition): Fraction => {
  const qp = parseDecimalText(p.signedQuantity);
  const price = parseDecimalText(p.marketPrice);
  const rate = parseDecimalText(p.fx.rate);
  return fraction(qp.num * price.num * rate.num, qp.den * price.den * rate.den);
};
const times = (a: Fraction, b: Fraction): Fraction => fraction(a.num * b.num, a.den * b.den);
const negate = (a: Fraction): Fraction => fraction(-a.num, a.den);

function referenceLosses(input: RiskInput): Fraction[] {
  const n = input.returns?.n ?? 0;
  return Array.from({ length: n }, (_, i) =>
    negate(
      input.positions.reduce(
        (acc, p) =>
          addFractions(
            acc,
            times(exposure(p), parseDecimalText(input.returns?.returns[p.ticker]?.[i] ?? '0')),
          ),
        fraction(0n, 1n),
      ),
    ),
  );
}

/** Type 7 on exact fractions (FR-7), one-based order statistics. */
function referenceType7(values: readonly Fraction[], p: Fraction): Fraction {
  const x = [...values].sort(compareFractions);
  const n = BigInt(x.length);
  const h = addFractions(fraction(1n, 1n), times(fraction(n - 1n, 1n), p));
  const j = h.num / h.den; // floor for positive h
  const gamma = addFractions(h, fraction(-j, 1n));
  const xj = x[Number(j) - 1];
  if (xj === undefined) {
    throw new Error('index');
  }
  if (gamma.num === 0n) {
    return xj;
  }
  const xj1 = x[Number(j)] ?? xj;
  return addFractions(times(addFractions(fraction(1n, 1n), negate(gamma)), xj), times(gamma, xj1));
}

describe('Property 5: Portfolio P&L is the sum of position P&L', () => {
  it('every scenario loss equals -sum_k E[k] * r[k][i] exactly', () => {
    fc.assert(
      fc.property(portfolioArb(decimalArb(0, 4, true), false), (spec) => {
        const input = buildInput(spec);
        const actual = scenarioLosses(input);
        const expected = referenceLosses(input);
        expect(actual).toHaveLength(expected.length);
        actual.forEach((loss, i) => {
          const ref = expected[i];
          expect(ref !== undefined && equalFractions(parseDecimalText(toCanonical(loss)), ref)).toBe(true);
        });
      }),
      { numRuns: 200 },
    );
  });
});

describe('Property 4: VaR is a quantile of losses', () => {
  it('the raw quantile equals the Type 7 loss quantile, and negating the returns gives -Q(1 - p)', () => {
    fc.assert(
      fc.property(portfolioArb(decimalArb(0, 4, true), true), (spec) => {
        const input = buildInput(spec);
        const p = parseDecimalText(input.params.confidence);
        const losses = referenceLosses(input);
        const result = computeRisk(input);
        expect(result.status).toBe('OK');
        const raw = parseDecimalText(result.baseVaR?.rawQuantile ?? 'x');
        expect(equalFractions(raw, referenceType7(losses, p))).toBe(true);

        const flipped: RiskInput = {
          ...input,
          returns: input.returns && {
            ...input.returns,
            returns: Object.fromEntries(
              Object.entries(input.returns.returns).map(([t, rs]) => [
                t,
                rs.map((r) => dec(r.startsWith('-') ? r.slice(1) : /^0(\.0+)?$/.test(r) ? r : `-${r}`)),
              ]),
            ),
          },
        };
        const flippedRaw = parseDecimalText(computeRisk(flipped).baseVaR?.rawQuantile ?? 'x');
        const oneMinusP = addFractions(fraction(1n, 1n), negate(p));
        expect(equalFractions(flippedRaw, negate(referenceType7(losses, oneMinusP)))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('non-negative P&L in every scenario gives VaR "0", raw <= 0, and NO_LOSS_AT_CONFIDENCE when raw < 0', () => {
    fc.assert(
      fc.property(portfolioArb(positiveArb(0, 4), true), (spec) => {
        const result = computeRisk(buildInput(spec));
        expect(result.baseVaR?.absolute).toBe('0');
        const raw = parseDecimalText(result.baseVaR?.rawQuantile ?? 'x');
        expect(raw.num < 0n).toBe(true);
        expect(result.flags).toContain('NO_LOSS_AT_CONFIDENCE');
      }),
      { numRuns: 200 },
    );
  });
});
