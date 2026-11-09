/**
 * The netted position model (task 6.2; design: Portfolio; R5.2, R5.3, R5.6).
 *
 * - One position per portfolio and ticker; its identifier is derived from both,
 *   so replaying the same ledger always yields the same identifier.
 * - `averagePrice` is `null` if and only if `signedQuantity` is `"0"`; a
 *   zero-quantity position has `isShort: false` (FR-13 rule 4).
 * - `updatedAt` and `source` come from the last applied transaction, never from
 *   a clock.
 *
 * Pure. Validates: Requirements 5.2, 5.3, 5.6.
 */
import { canonicalJson, sha256Hex } from '../shared/index.js';
import type { DecimalString } from '../shared/index.js';

export interface Position {
  readonly id: string;
  readonly portfolioId: string;
  readonly ticker: string;
  readonly currency: string;
  /** Canonical Decimal String; `"0"` for a flat position. */
  readonly signedQuantity: DecimalString;
  /** Canonical Decimal String, or `null` exactly for a flat position. */
  readonly averagePrice: DecimalString | null;
  /** True exactly when `signedQuantity` is negative. */
  readonly isShort: boolean;
  /** Trade timestamp of the last applied transaction. */
  readonly updatedAt: string;
  /** Source of the last applied transaction. */
  readonly source: string;
}

/** Deterministic identifier: lowercase hex SHA-256 of `canonicalJson(["POS", portfolioId, ticker])`. */
export function positionId(portfolioId: string, ticker: string): string {
  return sha256Hex(canonicalJson(['POS', portfolioId, ticker]));
}

/**
 * `List` itself when it names every key of `T`, otherwise `never`. Type-level
 * only: assigning an incomplete list to this type is a compile error.
 */
export type ExhaustiveKeys<T, List extends readonly (keyof T)[]> = [Exclude<keyof T, List[number]>] extends [
  never,
]
  ? List
  : never;

const FIELD_LIST = [
  'id',
  'portfolioId',
  'ticker',
  'currency',
  'signedQuantity',
  'averagePrice',
  'isShort',
  'updatedAt',
  'source',
] as const satisfies readonly (keyof Position)[];

/** Every field of `Position`; adding a field to `Position` without listing it here fails to compile. */
const FIELDS: ExhaustiveKeys<Position, typeof FIELD_LIST> = FIELD_LIST;

/** True when every persisted field is identical (decimal fields are canonical strings). */
export function samePosition(a: Position, b: Position): boolean {
  return FIELDS.every((field) => a[field] === b[field]);
}

/** A copy holding exactly the position fields (no extra properties of a stored record). */
export function positionFields(position: Position): Position {
  return {
    id: position.id,
    portfolioId: position.portfolioId,
    ticker: position.ticker,
    currency: position.currency,
    signedQuantity: position.signedQuantity,
    averagePrice: position.averagePrice,
    isShort: position.isShort,
    updatedAt: position.updatedAt,
    source: position.source,
  };
}
