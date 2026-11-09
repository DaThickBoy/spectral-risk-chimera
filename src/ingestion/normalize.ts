/**
 * Normalization and deduplication (task 7.3; design: Normalizer and Deduper;
 * R28.11 to R28.14, R28.18, R30.2).
 *
 * - `transactionKey` (R28.11), as lowercase hex SHA-256 of UTF-8 text:
 *   - with `external_id`: `"EXT|" + portfolioId + "|" + source + "|" + externalId`;
 *   - otherwise: `"CNT|" + portfolioId + "|" + canonicalFields + "|" + occurrence`,
 *     where `canonicalFields` is `tradeTimestamp|ticker|type|quantity|price|currency`
 *     (UTC timestamp, Canonical Decimal Strings). None of these values can
 *     contain `|` (fixed formats and the fixed ticker pattern), so the join is
 *     unambiguous. `occurrence` is the one-based count of rows with identical
 *     `canonicalFields` (and no `external_id`) among the file's valid rows, in
 *     file order, so two identical rows are both kept (R28.14).
 * - A key already in the ledger, or already used earlier in the same file, is a
 *   duplicate and creates no transaction (R28.12, R28.13). A row the caller has
 *   `excluded` (rejected by 7.4) uses no key, so it hides no later row.
 * - `sourceId = "CSV:" + fileSha256` and `sourceSequence = sequence` (R28.18).
 * - A currency outside `fx.supportedCurrencies` is `UNSUPPORTED_CURRENCY` (R30.2).
 *   `CURRENCY_MISMATCH` needs chronological order and is checked in 7.4.
 *
 * Limitation (R28.14, OD-8 interim position): an identical trade without
 * `external_id` that appears again in a different file gets the same key and is
 * treated as a duplicate. This is documented for users in
 * `docs/import-deduplication.md`.
 *
 * Pure. Validates: Requirements 28.11, 28.12, 28.13, 28.14, 28.18, 30.2.
 */
import { sha256Hex } from '../shared/index.js';
import type { ValidRow } from './csv/rowValidation.js';

export interface Candidate {
  readonly row: ValidRow;
  readonly transactionKey: string;
  readonly sourceId: string;
  readonly sourceSequence: number;
}

export type NormalizeOutcome =
  | { readonly kind: 'CANDIDATE'; readonly candidate: Candidate }
  | { readonly kind: 'DUPLICATE'; readonly sequence: number; readonly transactionKey: string }
  | { readonly kind: 'UNSUPPORTED_CURRENCY'; readonly row: ValidRow }
  | { readonly kind: 'EXCLUDED'; readonly sequence: number };

export interface NormalizeContext {
  readonly portfolioId: string;
  /** The source label passed to the import (R28.11). */
  readonly source: string;
  readonly fileSha256: string;
  /** `fx.supportedCurrencies`. */
  readonly supportedCurrencies: ReadonlySet<string>;
  /** Keys already in the portfolio's ledger. */
  readonly ledgerKeys: ReadonlySet<string>;
  /**
   * Row sequences already rejected by a later stage (7.4). They still count toward
   * `occurrence` but create no key, so a later row with the same key is not a
   * duplicate of them (R28.12: only an existing transaction makes a duplicate).
   */
  readonly excluded?: ReadonlySet<number>;
}

export const canonicalFields = (row: ValidRow): string =>
  [row.tradeTimestamp, row.ticker, row.type, row.quantity, row.price, row.currency].join('|');

export function transactionKey(
  portfolioId: string,
  source: string,
  row: ValidRow,
  occurrence: number,
): string {
  return row.externalId === undefined
    ? sha256Hex(`CNT|${portfolioId}|${canonicalFields(row)}|${occurrence}`)
    : sha256Hex(`EXT|${portfolioId}|${source}|${row.externalId}`);
}

/** Valid rows in file order -> one outcome each, in the same order. */
export function normalizeRows(rows: readonly ValidRow[], ctx: NormalizeContext): NormalizeOutcome[] {
  const occurrences = new Map<string, number>();
  const seen = new Set<string>();
  const sourceId = `CSV:${ctx.fileSha256}`;
  return rows.map((row): NormalizeOutcome => {
    let occurrence = 1;
    if (row.externalId === undefined) {
      const fields = canonicalFields(row);
      occurrence = (occurrences.get(fields) ?? 0) + 1; // a count, not a financial value
      occurrences.set(fields, occurrence);
    }
    if (ctx.excluded?.has(row.sequence) === true) {
      return { kind: 'EXCLUDED', sequence: row.sequence };
    }
    if (!ctx.supportedCurrencies.has(row.currency)) {
      return { kind: 'UNSUPPORTED_CURRENCY', row };
    }
    const key = transactionKey(ctx.portfolioId, ctx.source, row, occurrence);
    if (ctx.ledgerKeys.has(key) || seen.has(key)) {
      return { kind: 'DUPLICATE', sequence: row.sequence, transactionKey: key };
    }
    seen.add(key);
    return {
      kind: 'CANDIDATE',
      candidate: { row, transactionKey: key, sourceId, sourceSequence: row.sequence },
    };
  });
}
