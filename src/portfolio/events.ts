/**
 * Position reconciliation and the `PositionsChanged` event type (task 6.2;
 * design: Portfolio, D-16; R5.3, R5.5, R5.6).
 *
 * `reconcilePositions` compares the persisted positions of one portfolio with the
 * complete replay result:
 * - a replayed position without a persisted counterpart is a change with `before: null`;
 * - a replayed position that differs in any persisted field is a change;
 * - a persisted position whose ticker has no ledger transaction (absent from the
 *   replay) is an orphan: a change with `after: null`;
 * - a zero-quantity position produced by the ledger is a replayed position like
 *   any other and is kept;
 * - unchanged positions are not changes.
 * Changes are sorted by ticker (ordinal).
 *
 * This module only defines the event type. Publication happens in `app/`, after
 * a successful commit; `portfolio/` never imports persistence or an event bus.
 *
 * Pure. Validates: Requirements 5.3, 5.5, 5.6.
 */
import { compareOrdinal } from './ledger.js';
import { positionFields, samePosition } from './position.js';
import type { Position } from './position.js';

/** One position whose persisted and replayed values differ. */
export interface PositionChange {
  readonly ticker: string;
  /** `null`: no persisted position before this rebuild. */
  readonly before: Position | null;
  /** `null`: the persisted position had no ledger transaction and is removed. */
  readonly after: Position | null;
}

/** Published after a successful position commit, only when there are changes (R5.5). */
export interface PositionsChanged {
  readonly type: 'PositionsChanged';
  readonly portfolioId: string;
  /** Tickers of the changes: unique, non-empty, ascending ordinal order. */
  readonly tickers: readonly string[];
}

/** Reconciles `persisted` against the complete replay result `replayed` (one portfolio). */
export function reconcilePositions(
  persisted: readonly Position[],
  replayed: readonly Position[],
): PositionChange[] {
  const stored = new Map(persisted.map((position) => [position.ticker, positionFields(position)]));
  const next = new Map(replayed.map((position) => [position.ticker, positionFields(position)]));
  const tickers = [...new Set([...stored.keys(), ...next.keys()])].sort(compareOrdinal);
  const changes: PositionChange[] = [];
  for (const ticker of tickers) {
    const before = stored.get(ticker) ?? null;
    const after = next.get(ticker) ?? null;
    if (before !== null && after !== null && samePosition(before, after)) {
      continue;
    }
    changes.push({ ticker, before, after });
  }
  return changes;
}

/** The event for a non-empty change list; `undefined` when nothing changed. */
export function positionsChangedEvent(
  portfolioId: string,
  changes: readonly PositionChange[],
): PositionsChanged | undefined {
  if (changes.length === 0) {
    return undefined;
  }
  const tickers = [...new Set(changes.map((change) => change.ticker))].sort(compareOrdinal);
  return { type: 'PositionsChanged', portfolioId, tickers };
}
