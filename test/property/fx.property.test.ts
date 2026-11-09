// Validates: Requirements 30.4, 30.5, 30.6, 30.8, 30.9, 25.4, 25.5
// Task 10.1 property tests.
// Property 26 (FX conversion): the base currency is always the identity rate "1"; a direct quote q
//   gives exactly toCanonical(q); an inverse quote q gives exactly the 40-significant-digit
//   ROUND_HALF_UP rounding of the rational 1 / q; a local value times Rate(X/B) matches the
//   reference. Reference: BigInt fractions (test/helpers/rational.ts) rounded half away from zero
//   (test/helpers/positionReference.ts); no Decimal.js.
// Property 25, FX part: a rate older than the maximum age is never returned for use (FX_STALE with a
//   display-only rate); any provider failure is FX_UNAVAILABLE with no rate; every rate used comes
//   from the single provider quote for the exact pair (no substitution).
// Traceability: AT-FX-01, AT-FX-02, AT-FX-03, AT-FX-04, AT-FX-07
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { FxError, FxRateUsed } from '../../src/fx/index.js';
import { d, toCanonical } from '../../src/shared/index.js';
import type { ProviderErrorCode, Result } from '../../src/shared/index.js';
import {
  AT,
  BASE,
  MAX_AGE_SECONDS,
  fakeProvider,
  fxSetup,
  minusMs,
  okResult,
  providerFailure,
  quote,
} from '../helpers/fx.js';
import { roundSignificant } from '../helpers/positionReference.js';
import { decimalTextArb, equalFractions, fraction, parseDecimalText } from '../helpers/rational.js';

/** Canonical decimal text: no leading zeros, no trailing fractional zeros, no exponent, positive. */
const CANONICAL_POSITIVE = /^(0|[1-9]\d*)(\.\d*[1-9])?$/;

const positiveDecimalArb = decimalTextArb(12, 18).filter(
  (text) => !text.startsWith('-') && /[1-9]/.test(text),
);

const rateOf = (result: Result<FxRateUsed, FxError>): string => {
  if (!result.ok) {
    throw new Error(`expected a rate, got ${result.error.code}`);
  }
  return result.value.rate;
};

describe('Property 26: FX conversion', () => {
  it('a direct quote gives exactly the canonical quote', async () => {
    await fc.assert(
      fc.asyncProperty(positiveDecimalArb, async (q) => {
        const { rate } = fxSetup(fakeProvider(() => okResult(quote({ rate: q }))));
        const result = rateOf(await rate('EUR'));
        expect(result).toMatch(CANONICAL_POSITIVE);
        expect(equalFractions(parseDecimalText(result), parseDecimalText(q))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('an inverse quote gives exactly the 40-significant-digit ROUND_HALF_UP value of 1 / q', async () => {
    await fc.assert(
      fc.asyncProperty(positiveDecimalArb, async (q) => {
        const { rate } = fxSetup(fakeProvider(() => okResult(quote({ from: 'USD', to: 'EUR', rate: q }))));
        const result = rateOf(await rate('EUR'));
        const exactQ = parseDecimalText(q);
        const expected = roundSignificant(fraction(exactQ.den, exactQ.num));
        expect(result).toMatch(CANONICAL_POSITIVE);
        expect(equalFractions(parseDecimalText(result), expected)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('the base currency is always the identity rate, whatever the provider holds', async () => {
    await fc.assert(
      fc.asyncProperty(positiveDecimalArb, fc.integer({ min: 0, max: 10_000_000 }), async (q, ageMs) => {
        const provider = fakeProvider(() => okResult(quote({ rate: q, observedAt: minusMs(AT, ageMs) })));
        const { rate } = fxSetup(provider);
        const result = await rate(BASE);
        expect(result).toEqual({
          ok: true,
          value: {
            kind: 'IDENTITY',
            pair: 'USDUSD',
            rate: '1',
            observedAt: null,
            source: 'BASE_CURRENCY',
            sourceKind: 'IDENTITY',
            status: 'CURRENT',
          },
        });
        expect(provider.calls).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it('a local value times Rate(X/B) matches the rational reference (one rounding)', async () => {
    await fc.assert(
      fc.asyncProperty(positiveDecimalArb, decimalTextArb(10, 6), async (q, local) => {
        const { rate } = fxSetup(fakeProvider(() => okResult(quote({ from: 'USD', to: 'EUR', rate: q }))));
        const r = rateOf(await rate('EUR'));
        const valueBase = toCanonical(d(local).times(d(r)));
        const a = parseDecimalText(local);
        const b = parseDecimalText(r);
        expect(
          equalFractions(
            parseDecimalText(valueBase),
            roundSignificant(fraction(a.num * b.num, a.den * b.den)),
          ),
        ).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe('Property 25 (FX part): stale and unavailable rates are never used', () => {
  const MAX_MS = MAX_AGE_SECONDS * 1000;

  it('the age boundary is strict: age <= max is used, age > max is FX_STALE with a display-only rate', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Boundary ages are drawn often, so the strict `>` comparison is always exercised.
        fc.oneof(fc.constantFrom(0, MAX_MS - 1, MAX_MS, MAX_MS + 1), fc.integer({ min: 0, max: 3 * MAX_MS })),
        fc.constantFrom('REAL' as const, 'DEMO' as const),
        async (ageMs, kind) => {
          const provider = fakeProvider(
            () => okResult(quote({ observedAt: minusMs(AT, ageMs), sourceKind: kind })),
            { kind },
          );
          const result = await fxSetup(provider).rate('EUR');
          if (ageMs > MAX_MS) {
            expect(result.ok).toBe(false);
            expect(result.ok ? undefined : result.error).toMatchObject({
              code: 'FX_STALE',
              displayRate: { kind: 'STALE_DISPLAY', status: 'STALE', sourceKind: kind },
            });
          } else {
            expect(result).toMatchObject({
              ok: true,
              value: { kind: 'OBSERVED', status: kind === 'REAL' ? 'CURRENT' : 'DEMO' },
            });
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('any provider failure is FX_UNAVAILABLE with no rate, last valid value, or display rate', async () => {
    const codes: ProviderErrorCode[] = [
      'NETWORK_ERROR',
      'TIMEOUT',
      'RATE_LIMITED',
      'HTTP_SERVER_ERROR',
      'HTTP_CLIENT_ERROR',
      'INVALID_RESPONSE',
      'CIRCUIT_OPEN',
      'CANCELLED',
      'TLS_ERROR',
      'UNEXPECTED_ERROR',
    ];
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...codes),
        fc.integer({ min: 0, max: 2 }),
        async (code, maxRetries) => {
          const { rate } = fxSetup(
            fakeProvider(() => providerFailure(code)),
            { maxRetries },
          );
          const result = await rate('EUR');
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toMatchObject({
              code: 'FX_UNAVAILABLE',
              cause: 'PROVIDER_ERROR',
              currency: 'EUR',
            });
            expect(result.error).not.toHaveProperty('lastValid');
            expect(result.error).not.toHaveProperty('displayRate');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('every rate used comes from the single provider quote for the exact pair (no substitution)', async () => {
    await fc.assert(
      fc.asyncProperty(
        positiveDecimalArb,
        fc.boolean(),
        fc.constantFrom('EUR', 'GBP', 'JPY'),
        fc.constantFrom('EUR', 'GBP', 'JPY', 'USD'),
        async (q, inverse, requested, quotedOther) => {
          // The provider answers with some pair; only (requested, USD) or (USD, requested) may be used.
          const pairFrom = inverse ? 'USD' : quotedOther;
          const pairTo = inverse ? quotedOther : 'USD';
          const provider = fakeProvider(() => okResult(quote({ from: pairFrom, to: pairTo, rate: q })));
          const result = await fxSetup(provider).rate(requested);
          const matches = quotedOther === requested;
          if (!matches) {
            expect(result).toMatchObject({
              ok: false,
              error: { code: 'FX_UNAVAILABLE', cause: 'INVALID_RESPONSE' },
            });
            return;
          }
          const used = rateOf(result);
          const exactQ = parseDecimalText(q);
          const expected = inverse ? roundSignificant(fraction(exactQ.den, exactQ.num)) : exactQ;
          expect(equalFractions(parseDecimalText(used), expected)).toBe(true);
          expect(provider.calls).toHaveLength(1);
        },
      ),
      { numRuns: 300 },
    );
  });
});
