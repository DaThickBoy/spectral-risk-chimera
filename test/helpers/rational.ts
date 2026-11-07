// Independent rational (BigInt fraction) reference for decimal tests.
// It does not use Decimal.js, so the Decimal helper is checked against a different mechanism.
import fc from 'fast-check';

export interface Fraction {
  readonly num: bigint;
  readonly den: bigint;
}

const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x === 0n ? 1n : x;
};

export function fraction(num: bigint, den: bigint): Fraction {
  if (den === 0n) {
    throw new RangeError('zero denominator');
  }
  const sign = den < 0n ? -1n : 1n;
  const g = gcd(num, den);
  return { num: (sign * num) / g, den: (sign * den) / g };
}

/** Parses decimal text in the fixed grammar into an exact fraction. */
export function parseDecimalText(text: string): Fraction {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) {
    throw new RangeError(`not decimal text: ${text}`);
  }
  const [, sign = '', whole = '0', frac = ''] = match;
  const digits = BigInt(`${whole}${frac}`);
  const den = 10n ** BigInt(frac.length);
  return fraction(sign === '-' ? -digits : digits, den);
}

export const addFractions = (a: Fraction, b: Fraction): Fraction =>
  fraction(a.num * b.den + b.num * a.den, a.den * b.den);

export const equalFractions = (a: Fraction, b: Fraction): boolean => a.num * b.den === b.num * a.den;

export const compareFractions = (a: Fraction, b: Fraction): number => {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left === right ? 0 : left < right ? -1 : 1;
};

/**
 * Decimal text in the fixed grammar: optional "-", an integer part without
 * leading zeros, and optional fractional digits (trailing zeros allowed).
 */
export function decimalTextArb(maxIntDigits = 18, maxFracDigits = 18): fc.Arbitrary<string> {
  const intPart = fc.oneof(
    fc.constant('0'),
    fc
      .tuple(
        fc.constantFrom('1', '2', '3', '4', '5', '6', '7', '8', '9'),
        fc.string({
          unit: fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9'),
          maxLength: maxIntDigits - 1,
        }),
      )
      .map(([first, rest]) => `${first}${rest}`),
  );
  const fracPart = fc.option(
    fc.string({
      unit: fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9'),
      minLength: 1,
      maxLength: maxFracDigits,
    }),
    { nil: undefined },
  );
  return fc
    .tuple(fc.boolean(), intPart, fracPart)
    .map(
      ([negative, whole, frac]) => `${negative ? '-' : ''}${whole}${frac === undefined ? '' : `.${frac}`}`,
    );
}
