// Validates: Requirements 4.1, 4.5, 5.2, 30.4, 30.6, 30.8
// Task 11.1 property tests (financial-rules 12; design: Valuation rules 11 to 14).
// - Valuation arithmetic: marketValueInstrument = q × p and marketValueBase = (q × p) × r match an
//   independent reference on BigInt fractions, each product rounded to 40 significant digits
//   ROUND_HALF_UP (test/helpers/positionReference.ts); no Decimal.js in the reference. Every output
//   is a Canonical Decimal String.
// - Missing data: a status without a usable rate never yields a base value, and no null-able field
//   is ever "0" in place of a missing value.
// - Determinism: the service result does not depend on the input order of the positions.
// Traceability: AT-FX-07
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toValuedPositionView } from '../../src/portfolio/index.js';
import { brandDecimalString } from '../../src/shared/index.js';
import { roundSignificant } from '../helpers/positionReference.js';
import { decimalTextArb, equalFractions, fraction, parseDecimalText } from '../helpers/rational.js';
import { fakeMarketData, mdFailure, okQuote, pos, quoteOf, valuationSetup } from '../helpers/valuation.js';

/** Canonical decimal text: no exponent, no leading or trailing fractional zeros, no negative zero. */
const CANONICAL = /^(-?(0|[1-9]\d*)(\.\d*[1-9])?)$/;
const isCanonical = (text: string): boolean => CANONICAL.test(text) && text !== '-0';

const positiveArb = decimalTextArb(10, 12).filter((text) => !text.startsWith('-') && /[1-9]/.test(text));
const quantityArb = decimalTextArb(10, 8);

const times = (a: string, b: string) => {
  const x = parseDecimalText(a);
  const y = parseDecimalText(b);
  return roundSignificant(fraction(x.num * y.num, x.den * y.den));
};

describe('valuation arithmetic matches the rational reference', () => {
  it('VALUED: instrument and base values are exact (40 significant digits per product) and canonical', () => {
    fc.assert(
      fc.property(quantityArb, positiveArb, positiveArb, (q, p, r) => {
        const view = toValuedPositionView(pos('AAA', 'EUR', q), {
          status: 'VALUED',
          price: brandDecimalString(p),
          rate: brandDecimalString(r),
        });
        const instrument = times(q, p);
        const instrumentText = view.marketValueInstrument ?? '';
        const baseText = view.marketValueBase ?? '';
        expect(isCanonical(instrumentText)).toBe(true);
        expect(isCanonical(baseText)).toBe(true);
        expect(isCanonical(view.marketPrice ?? '')).toBe(true);
        expect(equalFractions(parseDecimalText(view.marketPrice ?? ''), parseDecimalText(p))).toBe(true);
        expect(equalFractions(parseDecimalText(instrumentText), instrument)).toBe(true);
        const base = roundSignificant(
          fraction(instrument.num * parseDecimalText(r).num, instrument.den * parseDecimalText(r).den),
        );
        expect(equalFractions(parseDecimalText(baseText), base)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('a unit rate leaves the base value equal to the instrument value', () => {
    fc.assert(
      fc.property(quantityArb, positiveArb, (q, p) => {
        const view = toValuedPositionView(pos('AAA', 'USD', q), {
          status: 'VALUED',
          price: brandDecimalString(p),
          rate: brandDecimalString('1'),
        });
        expect(view.marketValueBase).toBe(view.marketValueInstrument);
      }),
      { numRuns: 300 },
    );
  });
});

describe('missing data never becomes zero', () => {
  it('without a usable rate the base value is null; without a price every market field is null', () => {
    fc.assert(
      fc.property(
        quantityArb,
        positiveArb,
        fc.constantFrom('FX_UNAVAILABLE', 'FX_STALE', 'PRICE_UNAVAILABLE', 'PRICE_CURRENCY_MISMATCH'),
        (q, p, status) => {
          const view =
            status === 'FX_UNAVAILABLE' || status === 'FX_STALE'
              ? toValuedPositionView(pos('AAA', 'EUR', q), { status, price: brandDecimalString(p) })
              : toValuedPositionView(pos('AAA', 'EUR', q), { status });
          expect(view.marketValueBase).toBeNull();
          expect(view.allocationPct).toBeNull();
          expect(view.valuationStatus).toBe(status);
          if (status === 'PRICE_UNAVAILABLE' || status === 'PRICE_CURRENCY_MISMATCH') {
            expect(view.marketPrice).toBeNull();
            expect(view.marketValueInstrument).toBeNull();
          } else {
            expect(equalFractions(parseDecimalText(view.marketValueInstrument ?? ''), times(q, p))).toBe(
              true,
            );
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('determinism', () => {
  it('the result does not depend on the input order of the positions', async () => {
    const tickersArb = fc.uniqueArray(fc.constantFrom('AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'), {
      minLength: 1,
      maxLength: 6,
    });
    await fc.assert(
      fc.asyncProperty(tickersArb, fc.integer({ min: 0, max: 1_000_000 }), async (tickers, seed) => {
        // AAA, CCC, and EEE have a quote; the others get 404 (PRICE_UNAVAILABLE). Prices and
        // quantities are test text built from integers, never computed values.
        const md = fakeMarketData((ticker) =>
          ['AAA', 'CCC', 'EEE'].includes(ticker)
            ? okQuote(quoteOf(ticker, { price: `${(seed % 97) + 1}.5` }))
            : mdFailure('HTTP_CLIENT_ERROR', 404),
        );
        const positions = tickers.map((ticker, index) => pos(ticker, 'USD', String(index + 1)));
        const forward = await valuationSetup(md).value(positions);
        const backward = await valuationSetup(md).value([...positions].reverse());
        expect(backward).toEqual(forward);
        expect(forward.positions.map((entry) => entry.view.ticker)).toEqual([...tickers].sort());
      }),
      { numRuns: 60 },
    );
  });
});
