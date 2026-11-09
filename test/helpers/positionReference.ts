// Independent reference for FR-13 replay, built on BigInt fractions (no Decimal.js).
// It mirrors FR-14: every arithmetic result is rounded to 40 significant digits,
// ROUND_HALF_UP (half away from zero), as each Decimal.js operation is.
import type { Fraction } from './rational.js';
import { addFractions, compareFractions, fraction, parseDecimalText } from './rational.js';

export const SIGNIFICANT_DIGITS = 40;

const abs = (x: bigint): bigint => (x < 0n ? -x : x);
const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** Rounds `f` to `digits` significant digits, half away from zero. */
export function roundSignificant(f: Fraction, digits = SIGNIFICANT_DIGITS): Fraction {
  if (f.num === 0n) {
    return f;
  }
  const n = abs(f.num);
  const den = f.den;
  const atLeast = (e: number): boolean => (e >= 0 ? n >= den * pow10(e) : n * pow10(-e) >= den);
  // n/den < 10^(len(n) - len(den) + 1), so the exponent is that bound or one less.
  let e = n.toString().length - den.toString().length;
  if (!atLeast(e)) {
    e -= 1;
  }
  const scale = digits - 1 - e;
  const top = scale >= 0 ? n * pow10(scale) : n;
  const bottom = scale >= 0 ? den : den * pow10(-scale);
  let q = top / bottom;
  if (2n * (top % bottom) >= bottom) {
    q += 1n;
  }
  const signed = f.num < 0n ? -q : q;
  return scale >= 0 ? fraction(signed, pow10(scale)) : fraction(signed * pow10(-scale), 1n);
}

const R = roundSignificant;
const neg = (a: Fraction): Fraction => fraction(-a.num, a.den);
const plus = (a: Fraction, b: Fraction): Fraction => R(addFractions(a, b));
const minus = (a: Fraction, b: Fraction): Fraction => R(addFractions(a, neg(b)));
const times = (a: Fraction, b: Fraction): Fraction => R(fraction(a.num * b.num, a.den * b.den));
const div = (a: Fraction, b: Fraction): Fraction => R(fraction(a.num * b.den, a.den * b.num));
const absF = (a: Fraction): Fraction => fraction(abs(a.num), a.den);
const ZERO = fraction(0n, 1n);

export interface ReferenceEntry {
  readonly transactionKey: string;
  readonly sourceId: string;
  readonly sourceSequence: number;
  readonly tradeTimestamp: string;
  readonly ticker: string;
  readonly type: 'BUY' | 'SELL';
  readonly quantity: string;
  readonly price: string;
}

export interface ReferencePosition {
  readonly qty: Fraction;
  readonly avg: Fraction | null;
}

// Independent restatement of the R28.18 order.
const ord = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byLedgerOrder = (a: ReferenceEntry, b: ReferenceEntry): number =>
  ord(a.tradeTimestamp, b.tradeTimestamp) ||
  ord(a.sourceId, b.sourceId) ||
  (a.sourceSequence === b.sourceSequence ? 0 : a.sourceSequence < b.sourceSequence ? -1 : 1) ||
  ord(a.transactionKey, b.transactionKey);

/** FR-13 rules 1 to 5 restated on fractions. */
function step(state: ReferencePosition, entry: ReferenceEntry): ReferencePosition {
  const q = parseDecimalText(entry.quantity);
  const price = parseDecimalText(entry.price);
  const signed = entry.type === 'BUY' ? q : neg(q);
  const qtyCmp = compareFractions(state.qty, ZERO);
  if (qtyCmp === 0 || state.avg === null) {
    return { qty: signed, avg: price };
  }
  const size = absF(state.qty);
  const increase = entry.type === 'BUY' ? qtyCmp > 0 : qtyCmp < 0;
  if (increase) {
    const avg = div(plus(times(size, state.avg), times(q, price)), plus(size, q));
    return { qty: plus(state.qty, signed), avg };
  }
  const c = compareFractions(q, size);
  if (c < 0) {
    return { qty: plus(state.qty, signed), avg: state.avg };
  }
  if (c === 0) {
    return { qty: ZERO, avg: null };
  }
  const remainder = minus(q, size);
  return { qty: entry.type === 'BUY' ? remainder : neg(remainder), avg: price };
}

/** Reference replay: ticker → final signed quantity and average price. */
export function referenceReplay(entries: readonly ReferenceEntry[]): Map<string, ReferencePosition> {
  const result = new Map<string, ReferencePosition>();
  for (const entry of [...entries].sort(byLedgerOrder)) {
    const state = result.get(entry.ticker) ?? { qty: ZERO, avg: null };
    result.set(entry.ticker, step(state, entry));
  }
  return result;
}
