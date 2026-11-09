// Task 24.1, AT-SEC-22: per-cell CSV formula-injection neutralization.
// Validates: Requirements 29.7
import { describe, expect, it } from 'vitest';
import { neutralizeCsvCell } from '../../../src/shared/index.js';

describe('AT-SEC-22: dangerous first characters get one leading quote', () => {
  it.each([
    ['=SUM(A1:A2)', "'=SUM(A1:A2)"],
    ['=1+1', "'=1+1"],
    ['+1', "'+1"],
    ['+cmd|" /C calc"!A0', '\'+cmd|" /C calc"!A0'],
    ['@SUM(1)', "'@SUM(1)"],
    ['@', "'@"],
    ['=', "'="],
    ['+', "'+"],
    ['-', "'-"],
    ['\t=1', "'\t=1"],
    ['\tdata', "'\tdata"],
    ['\r=1', "'\r=1"],
    ['\r', "'\r"],
  ])('%j becomes %j', (cell, expected) => {
    expect(neutralizeCsvCell(cell)).toBe(expected);
  });

  it.each([
    '-1+1',
    '-2+3+cmd|" /C calc"!A0',
    '-SUM(1)',
    '-A1',
    '-1e5',
    '-1E-5',
    '- 1',
    '--1',
    '-.5',
    '-1.',
    '-01',
    '-1,000',
    '-1.5 ',
    '-1.5\n',
    '-1\n=cmd',
    '-1.5\r',
    '-NaN',
    '-Infinity',
    '-0x10',
  ])('a "-" cell outside the decimal grammar is prefixed: %j', (cell) => {
    expect(neutralizeCsvCell(cell)).toBe(`'${cell}`);
  });
});

describe('decimal exception: negative cells in the DecimalStringSchema grammar are unchanged', () => {
  it.each(['-12.5', '-0.001', '-1', '-0', '-1.50', '-1000000', '-123456789012345678901234567890.0001'])(
    '%j is unchanged',
    (cell) => {
      expect(neutralizeCsvCell(cell)).toBe(cell);
    },
  );

  it('the exception applies only to "-": "+12.5" is still prefixed', () => {
    expect(neutralizeCsvCell('+12.5')).toBe("'+12.5");
  });
});

describe('other cells are unchanged', () => {
  it.each([
    '',
    '12.5',
    '0',
    'AAPL',
    'Apple Inc.',
    'a=b',
    'x+1',
    ' =1',
    ' -1',
    '\n=1',
    '\uFF1D1',
    '\uFE621',
    'note: @user',
    '"=1"',
  ])('%j is unchanged', (cell) => {
    expect(neutralizeCsvCell(cell)).toBe(cell);
  });

  it.each(["'=1", "'", "''", "'-1+1", "'+x"])(
    'a cell already starting with a quote is unchanged: %j',
    (cell) => {
      expect(neutralizeCsvCell(cell)).toBe(cell);
    },
  );
});

describe('idempotence', () => {
  it.each(['=1', '+1', '-1+1', '@x', '\tx', '\rx', '-12.5', 'plain', "'=1", ''])(
    'twice equals once: %j',
    (cell) => {
      const once = neutralizeCsvCell(cell);
      expect(neutralizeCsvCell(once)).toBe(once);
    },
  );
});
