// Validates: Requirements 25.3, 25.5, 33.10
// Task 11.5 property tests (design: Last valid price rule 3).
// Property 36 (price part): Provider failure keeps last valid data. For any set of offers, the
//   store's final state is independent of their arrival order: the maximum (asOf, retrievedAt)
//   key wins with its content, or the entry is conflicted (nothing shown) when that maximum key
//   carries more than one distinct content. Reference: an independent restatement of the rule.
// Traceability: AT-PRV-01 (price part)
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createPriceLastValidStore } from '../../src/app/index.js';
import type { ProviderQuote } from '../../src/marketdata/index.js';
import { brandDecimalString } from '../../src/shared/index.js';

const quoteArb: fc.Arbitrary<ProviderQuote> = fc
  .record({
    day: fc.integer({ min: 1, max: 3 }),
    second: fc.integer({ min: 0, max: 2 }),
    price: fc.constantFrom('100', '100.0', '101', '99.5'),
    source: fc.constantFrom('md-a', 'md-b'),
  })
  .map(({ day, second, price, source }) => ({
    ticker: 'AAA',
    currency: 'USD',
    price: brandDecimalString(price),
    asOf: `2026-11-0${day}`,
    source,
    sourceKind: 'REAL' as const,
    retrievedAt: `2026-11-07T12:00:0${second}.000Z`,
  }));

/** Independent reference: canonical price text via a trailing-zero strip (no Decimal.js). */
const canonical = (text: string): string =>
  text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
function reference(quotes: readonly ProviderQuote[]): string {
  const key = (x: ProviderQuote): string => `${x.asOf}|${x.retrievedAt}`;
  const max = quotes.map(key).sort().at(-1);
  const top = quotes.filter((x) => key(x) === max);
  const contents = new Set(top.map((x) => `${canonical(x.price)}|${x.source}`));
  return contents.size === 1 ? ([...contents][0] ?? 'none') : 'conflicted';
}

function apply(quotes: readonly ProviderQuote[]): string {
  const store = createPriceLastValidStore();
  for (const quote of quotes) {
    store.offer(quote, 'USD', 'REAL');
  }
  const shown = store.get('AAA', 'USD', 'REAL');
  return shown === undefined ? 'conflicted' : `${shown.price}|${shown.source}`;
}

describe('Property 36 (price part): arrival-order independence of the last valid store', () => {
  it('every order of the same offers gives the reference state', () => {
    fc.assert(
      fc.property(
        fc.array(quoteArb, { minLength: 1, maxLength: 7 }),
        fc.integer({ min: 0, max: 10_000 }),
        (quotes, seed) => {
          const expected = reference(quotes);
          expect(apply(quotes)).toBe(expected);
          expect(apply([...quotes].reverse())).toBe(expected);
          const rotated = [...quotes.slice(seed % quotes.length), ...quotes.slice(0, seed % quotes.length)];
          expect(apply(rotated)).toBe(expected);
        },
      ),
      { numRuns: 1_000 },
    );
  });
});
