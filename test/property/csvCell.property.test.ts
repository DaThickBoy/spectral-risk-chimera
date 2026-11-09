// AT-SEC-22 property tests for neutralizeCsvCell (task 24.1).
// Validates: Requirements 29.7
// The decimal-grammar expectation uses an independent restatement of the R4.6 grammar, so the
// implementation's reuse of DecimalStringSchema is checked against a different definition.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { neutralizeCsvCell } from '../../src/shared/index.js';
import { decimalTextArb } from '../helpers/rational.js';

const RUNS = { numRuns: 2000 };
const DANGEROUS = ['=', '+', '-', '@', '\t', '\r'];

/** Independent check of the fixed decimal grammar: optional '-', integer without leading zeros, optional fraction. */
function referenceIsDecimalText(text: string): boolean {
  let i = 0;
  if (text[i] === '-') {
    i += 1;
  }
  const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
  if (!isDigit(text[i])) {
    return false;
  }
  if (text[i] === '0') {
    i += 1;
  } else {
    while (isDigit(text[i])) {
      i += 1;
    }
  }
  if (text[i] === '.') {
    i += 1;
    if (!isDigit(text[i])) {
      return false;
    }
    while (isDigit(text[i])) {
      i += 1;
    }
  }
  return i === text.length;
}

const isException = (cell: string): boolean => cell.startsWith('-') && referenceIsDecimalText(cell);

const cellArb = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.string({ unit: 'binary', maxLength: 20 }),
  fc.tuple(fc.constantFrom(...DANGEROUS, "'"), fc.string({ maxLength: 30 })).map(([a, b]) => `${a}${b}`),
  decimalTextArb(),
  decimalTextArb().map((text) => `${text}${'+1'}`),
);

describe('AT-SEC-22 properties', () => {
  it('the output is the input unchanged, or the input with one leading quote', () => {
    fc.assert(
      fc.property(cellArb, (cell) => {
        const out = neutralizeCsvCell(cell);
        expect(out === cell || out === `'${cell}`).toBe(true);
      }),
      RUNS,
    );
  });

  it('the output never starts with a dangerous character, except a valid negative decimal', () => {
    fc.assert(
      fc.property(cellArb, (cell) => {
        const out = neutralizeCsvCell(cell);
        if (DANGEROUS.includes(out.charAt(0))) {
          expect(isException(out)).toBe(true);
          expect(out).toBe(cell);
        }
      }),
      RUNS,
    );
  });

  it('prefixes exactly the cells with a dangerous first character that are not the decimal exception', () => {
    fc.assert(
      fc.property(cellArb, (cell) => {
        const shouldPrefix = DANGEROUS.includes(cell.charAt(0)) && !isException(cell);
        expect(neutralizeCsvCell(cell)).toBe(shouldPrefix ? `'${cell}` : cell);
      }),
      RUNS,
    );
  });

  it('every negative decimal-grammar cell is unchanged', () => {
    fc.assert(
      fc.property(decimalTextArb(), (text) => {
        const cell = text.startsWith('-') ? text : `-${text}`;
        expect(neutralizeCsvCell(cell)).toBe(cell);
      }),
      RUNS,
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(cellArb, (cell) => {
        const once = neutralizeCsvCell(cell);
        expect(neutralizeCsvCell(once)).toBe(once);
      }),
      RUNS,
    );
  });
});
