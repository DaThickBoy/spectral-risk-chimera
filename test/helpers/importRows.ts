// Builders for import tests (tasks 7.3 to 7.6). Decimals are Canonical Decimal Strings.
import type { Candidate, ValidRow } from '../../src/ingestion/index.js';
import { brandDecimalString } from '../../src/shared/index.js';

export const FILE_SHA = 'f'.repeat(64);
export const SOURCE_ID = `CSV:${FILE_SHA}`;

export const validRow = (overrides: Partial<ValidRow> = {}): ValidRow => ({
  sequence: 1,
  tradeTimestamp: '2026-11-02T14:30:00.000Z',
  ticker: 'AAA',
  type: 'BUY',
  quantity: brandDecimalString('10'),
  price: brandDecimalString('150.25'),
  currency: 'USD',
  rawExcerpt: 'raw',
  ...overrides,
});

let counter = 0;

/** A candidate with a unique key; `sourceSequence` follows `row.sequence`. */
export function candidate(
  type: 'BUY' | 'SELL',
  quantity: string,
  overrides: Partial<ValidRow> = {},
  sourceId = SOURCE_ID,
): Candidate {
  counter += 1;
  const row = validRow({ type, quantity: brandDecimalString(quantity), ...overrides });
  return {
    row,
    transactionKey: `cand-${String(counter).padStart(8, '0')}`,
    sourceId,
    sourceSequence: row.sequence,
  };
}

/** CSV text with the default header and the given data lines. */
export const csv = (...lines: readonly string[]): string =>
  ['trade_timestamp,ticker,type,quantity,price,currency', ...lines].join('\n') + '\n';
