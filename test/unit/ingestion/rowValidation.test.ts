// Task 7.2: column mapping and row validation (design: CSV Parser, row validation rules).
// Every invalid field produces exactly one row error with row number, source column, and reason.
// Tests: AT-CSV-09, AT-CSV-17, AT-CSV-23
// Validates: Requirements 1.2, 3.1, 28.1, 28.2, 28.7
import { describe, expect, it } from 'vitest';
import { validateRow } from '../../../src/ingestion/index.js';
import type { CanonicalField, CsvColumnMapping, RawRecord, RowResult } from '../../../src/ingestion/index.js';
import { bytes, collect, recordsOf } from '../../helpers/csv.js';

const PF = 'pf-1';
const VALID: Partial<Record<CanonicalField, string>> = {
  trade_timestamp: '2026-11-02T14:30:00Z',
  ticker: 'AAA',
  type: 'BUY',
  quantity: '10',
  price: '150.25',
  currency: 'USD',
};

const raw = (fields: Partial<Record<CanonicalField, string>>, sequence = 1): RawRecord => ({
  sourceKind: 'CSV',
  sequence,
  fields,
  rawExcerpt: Object.values(fields).join(','),
});

const run = (
  overrides: Partial<Record<CanonicalField, string>>,
  opts: { mapping?: CsvColumnMapping; defaultTimezone?: string } = {},
): RowResult =>
  validateRow(raw({ ...VALID, ...overrides }), {
    mapping: opts.mapping ?? {},
    portfolioId: PF,
    ...(opts.defaultTimezone === undefined ? {} : { defaultTimezone: opts.defaultTimezone }),
  });

const errorsOf = (result: RowResult) => {
  if (result.ok) {
    throw new Error('expected a rejected row');
  }
  return result.errors.map(({ column, reason, sequence }) => ({ column, reason, sequence }));
};

describe('validateRow: valid rows', () => {
  it('returns the exact fields, the UTC timestamp, and canonical decimals', () => {
    const result = run({ quantity: '10.500', price: '150.2500', external_id: 'ext-1' });
    expect(result).toEqual({
      ok: true,
      row: {
        sequence: 1,
        externalId: 'ext-1',
        tradeTimestamp: '2026-11-02T14:30:00.000Z',
        ticker: 'AAA',
        type: 'BUY',
        quantity: '10.5',
        price: '150.25',
        currency: 'USD',
        rawExcerpt: expect.any(String),
      },
    });
  });

  it('an empty external_id counts as absent; portfolio_id equal to the import is accepted', () => {
    const result = run({ external_id: '', portfolio_id: PF });
    expect(result.ok).toBe(true);
    expect(result.ok && 'externalId' in result.row).toBe(false);
  });

  it('accepts SELL and the fixed ticker pattern edge cases', () => {
    for (const ticker of ['A', '0', 'BRK.B', 'RDS-A', 'A'.repeat(15), '9A.-']) {
      expect(run({ ticker, type: 'SELL' }).ok, ticker).toBe(true);
    }
  });
});

describe('validateRow: one error per invalid field', () => {
  it.each([
    ['type lowercase', { type: 'buy' }, 'type', 'UNSUPPORTED_TRANSACTION_TYPE'],
    ['type SHORT', { type: 'SHORT' }, 'type', 'UNSUPPORTED_TRANSACTION_TYPE'],
    ['type with space', { type: 'BUY ' }, 'type', 'UNSUPPORTED_TRANSACTION_TYPE'],
    ['ticker lowercase (no case folding)', { ticker: 'aaa' }, 'ticker', 'INVALID_TICKER'],
    ['ticker leading space (no trimming)', { ticker: ' AAA' }, 'ticker', 'INVALID_TICKER'],
    ['ticker 16 characters', { ticker: 'A'.repeat(16) }, 'ticker', 'INVALID_TICKER'],
    ['ticker leading dot', { ticker: '.AAA' }, 'ticker', 'INVALID_TICKER'],
    ['ticker pipe', { ticker: 'A|B' }, 'ticker', 'INVALID_TICKER'],
    ['quantity exponent', { quantity: '1e5' }, 'quantity', 'MALFORMED_NUMBER'],
    ['quantity zero', { quantity: '0' }, 'quantity', 'MALFORMED_NUMBER'],
    ['quantity negative', { quantity: '-1' }, 'quantity', 'MALFORMED_NUMBER'],
    ['quantity separator', { quantity: '1,000' }, 'quantity', 'MALFORMED_NUMBER'],
    ['quantity leading zero (outside the R4.6 grammar)', { quantity: '010' }, 'quantity', 'MALFORMED_NUMBER'],
    ['quantity plus sign', { quantity: '+1' }, 'quantity', 'MALFORMED_NUMBER'],
    ['price NaN', { price: 'NaN' }, 'price', 'MALFORMED_NUMBER'],
    ['price Infinity', { price: 'Infinity' }, 'price', 'MALFORMED_NUMBER'],
    ['price leading dot', { price: '.5' }, 'price', 'MALFORMED_NUMBER'],
    ['price zero with decimals', { price: '0.000' }, 'price', 'MALFORMED_NUMBER'],
    ['currency lowercase', { currency: 'usd' }, 'currency', 'UNSUPPORTED_CURRENCY'],
    ['currency unknown', { currency: 'XYZ' }, 'currency', 'UNSUPPORTED_CURRENCY'],
    ['currency 4 letters', { currency: 'USDT' }, 'currency', 'UNSUPPORTED_CURRENCY'],
    ['timestamp without zone', { trade_timestamp: '2026-11-02T14:30:00' }, 'trade_timestamp', 'INVALID_DATE'],
    ['other portfolio', { portfolio_id: 'pf-2' }, 'portfolio_id', 'PORTFOLIO_MISMATCH'],
    ['empty ticker', { ticker: '' }, 'ticker', 'MISSING_REQUIRED_FIELD'],
    ['empty price', { price: '' }, 'price', 'MISSING_REQUIRED_FIELD'],
  ] as const)('%s', (_label, overrides, column, reason) => {
    expect(errorsOf(run(overrides))).toEqual([{ column, reason, sequence: 1 }]);
  });

  it('an absent required field is MISSING_REQUIRED_FIELD', () => {
    const rest = Object.fromEntries(Object.entries(VALID).filter(([field]) => field !== 'currency'));
    const result = validateRow(raw(rest, 7), { mapping: {}, portfolioId: PF });
    expect(errorsOf(result)).toEqual([{ column: 'currency', reason: 'MISSING_REQUIRED_FIELD', sequence: 7 }]);
  });

  it('several invalid fields give exactly one error each, in field order', () => {
    const result = run({
      trade_timestamp: 'x',
      ticker: 'a',
      type: 'X',
      quantity: '0',
      price: '1e1',
      currency: 'usd',
    });
    expect(errorsOf(result).map((e) => [e.column, e.reason])).toEqual([
      ['trade_timestamp', 'INVALID_DATE'],
      ['ticker', 'INVALID_TICKER'],
      ['type', 'UNSUPPORTED_TRANSACTION_TYPE'],
      ['quantity', 'MALFORMED_NUMBER'],
      ['price', 'MALFORMED_NUMBER'],
      ['currency', 'UNSUPPORTED_CURRENCY'],
    ]);
  });

  it('messages name the column and never echo the value', () => {
    const result = run({ quantity: 'secret-1e5' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.message).toMatch(/^quantity /);
      expect(result.errors[0]?.message).not.toContain('secret');
    }
  });
});

describe('validateRow: date-only timestamps (AT-CSV-23)', () => {
  it('rejects a date-only value without import.defaultTimezone', () => {
    expect(errorsOf(run({ trade_timestamp: '2026-11-02' }))).toEqual([
      { column: 'trade_timestamp', reason: 'INVALID_DATE', sequence: 1 },
    ]);
  });

  it('converts a date-only value with import.defaultTimezone', () => {
    const result = run({ trade_timestamp: '2026-11-02' }, { defaultTimezone: 'America/New_York' });
    expect(result.ok && result.row.tradeTimestamp).toBe('2026-11-02T05:00:00.000Z');
  });
});

describe('column mapping for renamed columns (AT-CSV-17)', () => {
  const mapping: CsvColumnMapping = {
    trade_timestamp: 'Date',
    ticker: 'Symbol',
    type: 'Side',
    quantity: 'Qty',
    price: 'Px',
    currency: 'Ccy',
    external_id: 'Ref',
  };

  it('parses and validates a file whose columns are renamed', async () => {
    const file = bytes(
      'Ref,Date,Symbol,Side,Qty,Px,Ccy,Extra\nr-1,2026-11-02T14:30:00Z,AAA,SELL,5,10.10,EUR,ignored\n',
    );
    const [record] = recordsOf(await collect(file, mapping));
    if (record === undefined) {
      throw new Error('expected a record');
    }
    const result = validateRow(record, { mapping, portfolioId: PF });
    expect(result.ok && result.row).toMatchObject({
      externalId: 'r-1',
      ticker: 'AAA',
      type: 'SELL',
      quantity: '5',
      price: '10.1',
      currency: 'EUR',
    });
  });

  it('errors name the source column, not the canonical field', async () => {
    const file = bytes('Ref,Date,Symbol,Side,Qty,Px,Ccy\nr-1,2026-11-02T14:30:00Z,AAA,HOLD,5,10,EUR\n');
    const [record] = recordsOf(await collect(file, mapping));
    if (record === undefined) {
      throw new Error('expected a record');
    }
    expect(errorsOf(validateRow(record, { mapping, portfolioId: PF }))).toEqual([
      { column: 'Side', reason: 'UNSUPPORTED_TRANSACTION_TYPE', sequence: 1 },
    ]);
  });
});
