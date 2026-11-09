// Ledger builders for position tests (task 6.2). Records are full TransactionRecords,
// so the same values can be inserted into a unit of work and passed to replay.
import type { TransactionRecord } from '../../src/persistence/index.js';
import { brandDecimalString } from '../../src/shared/index.js';
import { transaction } from './persistence.js';

export const T0 = '2026-11-02T14:30:00.000Z';
export const T1 = '2026-11-03T14:30:00.000Z';
export const SOURCE_A = `CSV:${'a'.repeat(64)}`;
export const SOURCE_B = `CSV:${'b'.repeat(64)}`;

export type Side = 'BUY' | 'SELL';
export type Row = readonly [Side, string, string];

let counter = 0;

/** One transaction with a unique id and transaction key. */
export function trade(
  type: Side,
  quantity: string,
  price: string,
  overrides: Partial<TransactionRecord> = {},
): TransactionRecord {
  counter += 1;
  const n = String(counter).padStart(8, '0');
  return transaction({
    id: `tx-${n}`,
    transactionKey: `key-${n}`,
    tradeTimestamp: T0,
    sourceId: SOURCE_A,
    sourceSequence: 1,
    type,
    quantity: brandDecimalString(quantity),
    price: brandDecimalString(price),
    ...overrides,
  });
}

/** Rows of one source in source order: sourceSequence 1..n, one timestamp. */
export function rows(
  entries: readonly Row[],
  overrides: Partial<TransactionRecord> = {},
): TransactionRecord[] {
  return entries.map(([type, quantity, price], index) =>
    trade(type, quantity, price, { sourceSequence: index + 1, ...overrides }),
  );
}
