/**
 * Ledger entries and their replay order (task 6.2; design: Portfolio; R28.18).
 *
 * Order: ascending `(tradeTimestamp, sourceId, sourceSequence, transactionKey)`,
 * compared field by field.
 * - `tradeTimestamp` is the normalized UTC form `YYYY-MM-DDTHH:mm:ss.sssZ`
 *   (ensured by ingestion), so ordinal string order is chronological order.
 * - `sourceId` is `"<sourceKind>:" + fileSha256`, so ties between files do not
 *   depend on import order; `sourceSequence` is source order within one file.
 * - `transactionKey` makes the order total.
 * - Strings compare by ordinal UTF-16 code unit order, never by locale;
 *   `sourceSequence` compares numerically (an index, not a financial value).
 *
 * Pure: no I/O, no clock. Validates: Requirements 28.18.
 */
import type { DecimalString } from '../shared/index.js';

/** The transaction fields replay needs. A persisted transaction satisfies it structurally. */
export interface LedgerEntry {
  readonly transactionKey: string;
  readonly sourceId: string;
  readonly sourceSequence: number;
  readonly source: string;
  readonly tradeTimestamp: string;
  readonly ticker: string;
  readonly type: 'BUY' | 'SELL';
  readonly quantity: DecimalString;
  readonly price: DecimalString;
  readonly currency: string;
}

/** Ordinal (UTF-16 code unit) comparison, independent of locale. */
export function compareOrdinal(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** Index comparison for `sourceSequence` (not a financial value). */
function compareIndex(a: number, b: number): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** The R28.18 total order. Returns a negative, zero, or positive number. */
export function compareLedgerOrder(a: LedgerEntry, b: LedgerEntry): number {
  return (
    compareOrdinal(a.tradeTimestamp, b.tradeTimestamp) ||
    compareOrdinal(a.sourceId, b.sourceId) ||
    compareIndex(a.sourceSequence, b.sourceSequence) ||
    compareOrdinal(a.transactionKey, b.transactionKey)
  );
}
