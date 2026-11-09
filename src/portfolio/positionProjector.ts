/**
 * Position projector: pure, deterministic replay of the ledger (task 6.2;
 * design: Portfolio, D-9, D-16; FR-13; R5.1, R5.3, R5.6, R5.7, R28.18, R28.19).
 *
 * Method:
 * - Entries are sorted with `compareLedgerOrder` (R28.18) and folded per
 *   ticker, so the result never depends on input order or on the order in which
 *   batches were imported (Property 23).
 * - BUY adds `q` and SELL subtracts `q` from the signed quantity (R28.19).
 * - Average price follows FR-13, with `qty` the signed quantity before the
 *   transaction, `q` its (positive) quantity, and `price` its price:
 *   1. Increase (BUY on flat or long; SELL on flat or short):
 *      `avg = (|qty| * avg + q * price) / (|qty| + q)`; on a flat position `avg = price`.
 *   2. Reduction with `q < |qty|`: average price unchanged.
 *   3. Reduction with `q = |qty|`: the position is flat; `avg = null`, `isShort = false`.
 *   4. Reversal with `q > |qty|`: the position closes and the remainder `q - |qty|`
 *      opens in the opposite direction with `avg = price`.
 * - Arithmetic uses Decimal.js through `d()` under FR-14 (precision 40,
 *   ROUND_HALF_UP). The running average is kept as a Decimal between steps (no
 *   intermediate rounding to text); outputs are Canonical Decimal Strings. A
 *   non-terminating quotient is therefore held to 40 significant digits.
 * - Signed quantity, average price, and `isShort` only: `import.oversellPolicy`
 *   is applied before transactions enter the ledger (task 7.4, R28.20).
 * - `id`, `updatedAt`, and `source` are derived from the inputs (R5.6). No clock,
 *   no random identifiers, no I/O.
 *
 * Errors (returned, never thrown, for invalid data):
 * - `LEDGER_DATA_INVALID`: an entry violates a ledger invariant
 *   (financial-rules 9): type BUY or SELL, a positive integer `sourceSequence`,
 *   a canonical fixed-width UTC `tradeTimestamp`, and a quantity and price that
 *   are decimal text greater than zero. Every violating entry is listed by
 *   `transactionKey` and field, never by value. Only the known data-integrity
 *   failures (`LedgerInvariantError`, and `DecimalInputError` from parsing a
 *   field) are mapped; any other exception is a programmer error and propagates.
 * - `POSITION_CURRENCY_CONFLICT`: all entries of one ticker must share one
 *   currency, which becomes the position currency; otherwise every conflicting
 *   ticker is listed and no position is returned (R5.7).
 * Ledger validity is checked first; currencies are compared only on valid data.
 */
import { DecimalInputError, appError, d, err, isIsoUtcMillis, ok, toCanonical } from '../shared/index.js';
import type { AppError, Decimal, Result } from '../shared/index.js';
import { compareLedgerOrder, compareOrdinal } from './ledger.js';
import type { LedgerEntry } from './ledger.js';
import { positionId } from './position.js';
import type { Position } from './position.js';

/** One ticker whose ledger entries have more than one currency. Currencies sorted. */
export interface CurrencyConflict {
  readonly ticker: string;
  readonly currencies: readonly string[];
}

/** Ledger entry fields with an invariant checked before replay. */
export type LedgerField = 'type' | 'sourceSequence' | 'tradeTimestamp' | 'quantity' | 'price';

/** One invariant violation, identified by transaction key and field (never by value). */
export interface LedgerViolation {
  readonly transactionKey: string;
  readonly field: LedgerField;
}

/** R5.7. One conflict per ticker, sorted by ticker. */
export type CurrencyConflictError = AppError<'POSITION_CURRENCY_CONFLICT'> & {
  readonly conflicts: readonly CurrencyConflict[];
};

/** Invalid ledger data. Violations sorted by transaction key, then field. */
export type LedgerDataError = AppError<'LEDGER_DATA_INVALID'> & {
  readonly violations: readonly LedgerViolation[];
};

export type ProjectionError = CurrencyConflictError | LedgerDataError;

export interface PositionProjector {
  /** Pure replay. Positions are sorted by ticker (ordinal). */
  replay(portfolioId: string, entries: readonly LedgerEntry[]): Result<Position[], ProjectionError>;
}

/** A ledger entry violates an invariant; mapped to `LEDGER_DATA_INVALID` by `replay`. */
export class LedgerInvariantError extends Error {
  readonly field: LedgerField;

  constructor(field: LedgerField, options?: ErrorOptions) {
    super(`Ledger entry violates an invariant: ${field}.`, options);
    this.name = 'LedgerInvariantError';
    this.field = field;
  }
}

/** A validated entry with its parsed quantity and price. */
interface ValidEntry {
  readonly entry: LedgerEntry;
  readonly q: Decimal;
  readonly price: Decimal;
}

interface Running {
  /** Signed quantity. */
  readonly qty: Decimal;
  /** Average price; null exactly when `qty` is zero. */
  readonly avg: Decimal | null;
}

const FLAT: Running = { qty: d('0'), avg: null };

/** Parses a decimal field; a `DecimalInputError` becomes a violation of that field. */
function parsePositive(field: 'quantity' | 'price', text: string): Decimal {
  let value: Decimal;
  try {
    // Ledger text is typed DecimalString; corrupt stored data can still fail here.
    value = d(text);
  } catch (error) {
    if (error instanceof DecimalInputError) {
      throw new LedgerInvariantError(field, { cause: error });
    }
    throw error;
  }
  if (!value.greaterThan(0)) {
    throw new LedgerInvariantError(field);
  }
  return value;
}

/** Checks one entry's invariants; throws `LedgerInvariantError` for the first violation. */
function validateEntry(entry: LedgerEntry): ValidEntry {
  if (entry.type !== 'BUY' && entry.type !== 'SELL') {
    throw new LedgerInvariantError('type');
  }
  if (!Number.isSafeInteger(entry.sourceSequence) || entry.sourceSequence < 1) {
    throw new LedgerInvariantError('sourceSequence');
  }
  if (!isIsoUtcMillis(entry.tradeTimestamp)) {
    throw new LedgerInvariantError('tradeTimestamp');
  }
  return { entry, q: parsePositive('quantity', entry.quantity), price: parsePositive('price', entry.price) };
}

/** Applies one validated transaction per FR-13. */
function apply(state: Running, { entry, q, price }: ValidEntry): Running {
  const buy = entry.type === 'BUY';
  const size = state.qty.abs();
  const sign = (x: Decimal): Decimal => (buy ? x : x.negated());

  // Flat: open at the transaction price (FR-13 rule 1 with qty = 0).
  if (state.qty.isZero() || state.avg === null) {
    return { qty: sign(q), avg: price };
  }
  const increase = buy ? state.qty.greaterThan(0) : state.qty.lessThan(0);
  if (increase) {
    // FR-13 rules 1 and 3: weighted average on the absolute quantity.
    const avg = size.times(state.avg).plus(q.times(price)).dividedBy(size.plus(q));
    return { qty: state.qty.plus(sign(q)), avg };
  }
  if (q.lessThan(size)) {
    // FR-13 rule 2: reduction leaves the average unchanged.
    return { qty: state.qty.plus(sign(q)), avg: state.avg };
  }
  if (q.equals(size)) {
    // FR-13 rule 4: flat, average reset to null.
    return FLAT;
  }
  // FR-13 rule 5: reversal; the remainder opens at this transaction's price.
  return { qty: sign(q.minus(size)), avg: price };
}

function toPosition(portfolioId: string, ticker: string, state: Running, last: LedgerEntry): Position {
  const flat = state.qty.isZero();
  return {
    id: positionId(portfolioId, ticker),
    portfolioId,
    ticker,
    currency: last.currency,
    signedQuantity: toCanonical(state.qty),
    averagePrice: flat || state.avg === null ? null : toCanonical(state.avg),
    isShort: state.qty.lessThan(0),
    updatedAt: last.tradeTimestamp,
    source: last.source,
  };
}

/** Validates every entry, mapping only the known data-integrity errors. */
function validateAll(entries: readonly LedgerEntry[]): {
  valid: ValidEntry[];
  violations: LedgerViolation[];
} {
  const valid: ValidEntry[] = [];
  const violations: LedgerViolation[] = [];
  for (const entry of entries) {
    try {
      valid.push(validateEntry(entry));
    } catch (error) {
      if (error instanceof LedgerInvariantError) {
        violations.push({ transactionKey: entry.transactionKey, field: error.field });
        continue;
      }
      throw error;
    }
  }
  violations.sort(
    (a, b) => compareOrdinal(a.transactionKey, b.transactionKey) || compareOrdinal(a.field, b.field),
  );
  return { valid, violations };
}

function currencyConflicts(valid: readonly ValidEntry[]): CurrencyConflict[] {
  const byTicker = new Map<string, Set<string>>();
  for (const { entry } of valid) {
    const currencies = byTicker.get(entry.ticker) ?? new Set<string>();
    currencies.add(entry.currency);
    byTicker.set(entry.ticker, currencies);
  }
  const conflicts: CurrencyConflict[] = [];
  for (const [ticker, currencies] of byTicker) {
    if (currencies.size > 1) {
      conflicts.push({ ticker, currencies: [...currencies].sort(compareOrdinal) });
    }
  }
  return conflicts.sort((a, b) => compareOrdinal(a.ticker, b.ticker));
}

/** Replays `entries` (the ledger of one portfolio) into netted positions. */
export function replayPositions(
  portfolioId: string,
  entries: readonly LedgerEntry[],
): Result<Position[], ProjectionError> {
  const { valid, violations } = validateAll(entries);
  if (violations.length > 0) {
    return err({
      ...appError('LEDGER_DATA_INVALID', 'Ledger entries violate an invariant.'),
      violations,
    });
  }
  const conflicts = currencyConflicts(valid);
  if (conflicts.length > 0) {
    return err({
      ...appError('POSITION_CURRENCY_CONFLICT', 'Transactions of one position have more than one currency.'),
      conflicts,
    });
  }
  // One pass in ledger order; a ticker's state exists only once it has an entry.
  const folded = new Map<string, { readonly state: Running; readonly last: LedgerEntry }>();
  for (const item of [...valid].sort((a, b) => compareLedgerOrder(a.entry, b.entry))) {
    const previous = folded.get(item.entry.ticker)?.state ?? FLAT;
    folded.set(item.entry.ticker, { state: apply(previous, item), last: item.entry });
  }
  return ok(
    [...folded]
      .sort(([a], [b]) => compareOrdinal(a, b))
      .map(([ticker, { state, last }]) => toPosition(portfolioId, ticker, state, last)),
  );
}

/** The default projector (design: `PositionProjector`). */
export const positionProjector: PositionProjector = { replay: replayPositions };
