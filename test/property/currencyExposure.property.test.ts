// Validates: Requirements 20.6, 4.1
// Dashboard currency exposure (DR-KW-1, task 17.3): for any list of positions with base values,
// each currency's total equals the exact rational sum of its positions' values (reference:
// BigInt fractions, no Decimal.js), the totals of all currencies add up to the total of all
// positions, the result does not depend on input order, and any missing value makes its whole
// currency UNAVAILABLE with null.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { currencyExposure } from '../../src/app/index.js';
import type { PositionItemDto } from '../../src/shared/index.js';
import { decimalTextArb, equalFractions, parseDecimalText } from '../helpers/rational.js';

interface Fraction {
  readonly num: bigint;
  readonly den: bigint;
}
const add = (a: Fraction, b: Fraction): Fraction => ({
  num: a.num * b.den + b.num * a.den,
  den: a.den * b.den,
});
const ZERO: Fraction = { num: 0n, den: 1n };

const positionArb = fc.record({
  currency: fc.constantFrom('EUR', 'USD', 'GBP'),
  value: fc.option(decimalTextArb(8, 12), { freq: 8 }),
});

const toItems = (rows: readonly { currency: string; value: string | null }[]) =>
  rows.map(
    (row, index) =>
      ({
        ticker: `T${index}`,
        currency: row.currency,
        marketValueBase: row.value,
      }) as unknown as PositionItemDto,
  );

describe('currency exposure', () => {
  it('equals the exact per-currency sum, is order-independent, and never sums around a missing value', () => {
    fc.assert(
      fc.property(fc.array(positionArb, { maxLength: 12 }), (rows) => {
        const items = toItems(rows);
        const result = currencyExposure(items);
        const reversed = currencyExposure([...items].reverse());
        expect(reversed).toEqual(result);
        for (const entry of result) {
          const own = rows.filter((row) => row.currency === entry.currency);
          if (own.some((row) => row.value === null)) {
            expect(entry).toMatchObject({ status: 'UNAVAILABLE', marketValueBase: null });
            continue;
          }
          const expected = own.reduce((sum, row) => add(sum, parseDecimalText(row.value as string)), ZERO);
          expect(entry.status).toBe('OK');
          expect(equalFractions(parseDecimalText(entry.marketValueBase as string), expected)).toBe(true);
        }
        if (rows.every((row) => row.value !== null) && result.length > 0) {
          const all = rows.reduce((sum, row) => add(sum, parseDecimalText(row.value as string)), ZERO);
          const totals = result.reduce(
            (sum, entry) => add(sum, parseDecimalText(entry.marketValueBase as string)),
            ZERO,
          );
          expect(equalFractions(totals, all)).toBe(true);
        }
      }),
      { numRuns: 400 },
    );
  });
});
