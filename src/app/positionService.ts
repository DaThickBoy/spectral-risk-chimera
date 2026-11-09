/**
 * Position service: rebuilds and reconciles the positions of one portfolio, then
 * publishes `PositionsChanged` (task 6.2; design: Portfolio, D-16; R5.4–R5.7,
 * R28.17).
 *
 * `rebuild(portfolioId)`:
 * 1. Runs exactly one `UnitOfWork.run` with a synchronous callback. Inside it
 *    reads the complete ledger and all persisted positions of the portfolio,
 *    replays the complete ledger (`portfolio/`, pure), reconciles, and writes
 *    only the changes: `upsert` for new and changed positions, `delete` for
 *    persisted positions with no ledger transaction. Unchanged positions are not
 *    written. All reads and writes of one rebuild are in that one unit of work,
 *    so they commit together or not at all (R5.6).
 * 2. A projection error (`LEDGER_DATA_INVALID` or `POSITION_CURRENCY_CONFLICT`)
 *    writes nothing: `PROJECTION_FAILED`. A `PersistenceError` from the unit of
 *    work (a constraint or a failed commit) leaves every position as before:
 *    `COMMIT_FAILED`. Neither publishes anything. Any other exception is a
 *    programmer error: the unit of work rolls back and the exception propagates.
 * 3. Only after `run` returned successfully, and only when at least one position
 *    changed, it publishes one `PositionsChanged` with the sorted tickers of the
 *    changes (including removed ones). It never publishes from inside the
 *    callback, so a rolled-back projection can never be observed.
 * 4. If `publish` throws, or returns a promise or thenable in breach of its
 *    synchronous contract (its rejection is handled, never left unhandled), the
 *    committed positions stay committed, the failure is logged through the
 *    redacting logger with code `POSITIONS_CHANGED_PUBLISH_FAILED`, and the
 *    result is `REBUILT_PUBLISH_FAILED`. A logger that throws is ignored, so the
 *    result is still returned. There is no retry: delivery is at most once per
 *    rebuild, and the repositories remain the source of truth.
 *
 * Rebuild is idempotent: on an unchanged ledger it writes and publishes nothing.
 * Ports are injected; concrete wiring is deferred to the composition root.
 */
import { types } from 'node:util';
import { PersistenceError } from '../persistence/ports.js';
import type { PersistenceErrorCode, UnitOfWork } from '../persistence/ports.js';
import { positionProjector, positionsChangedEvent, reconcilePositions } from '../portfolio/index.js';
import type { PositionChange, PositionProjector, ProjectionError } from '../portfolio/index.js';
import type { Logger } from '../shared/index.js';
import type { PositionEventPublisher } from './ports.js';

export type PositionRebuildResult =
  | { readonly status: 'REBUILT'; readonly changes: readonly PositionChange[]; readonly published: boolean }
  | { readonly status: 'REBUILT_PUBLISH_FAILED'; readonly changes: readonly PositionChange[] }
  | { readonly status: 'PROJECTION_FAILED'; readonly error: ProjectionError }
  | { readonly status: 'COMMIT_FAILED'; readonly code: PersistenceErrorCode };

export interface PositionService {
  /** Replays the complete ledger of the portfolio and reconciles all its persisted positions. */
  rebuild(portfolioId: string): PositionRebuildResult;
}

export interface PositionServiceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly publisher: PositionEventPublisher;
  readonly logger: Logger;
  /** Defaults to the pure projector from `portfolio/`. */
  readonly projector?: PositionProjector;
}

type Reconciled =
  | { readonly ok: true; readonly changes: readonly PositionChange[] }
  | { readonly ok: false; readonly error: ProjectionError };

export const POSITIONS_CHANGED_PUBLISH_FAILED = 'POSITIONS_CHANGED_PUBLISH_FAILED';

const ignoreRejection = (): undefined => undefined;

/**
 * Returns true when `value` is a thenable, after attaching a no-op rejection
 * handler so it can never surface as an unhandled rejection. `then` is read once
 * and called once and the result is not awaited. When the custom `then` returns
 * a separate native promise, the handler is attached to it through the intrinsic
 * `Promise.prototype.then`. Errors while attaching are ignored: the publication
 * is reported as failed regardless. (Same approach as the in-memory unit of
 * work's guard against asynchronous callbacks.)
 */
function neutralizeThenable(value: unknown): boolean {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return false;
  }
  let then: unknown;
  try {
    then = (value as { then?: unknown }).then;
  } catch {
    // An object whose `then` cannot even be read is not a successful synchronous result.
    return true;
  }
  if (typeof then !== 'function') {
    return false;
  }
  try {
    const returned: unknown = Reflect.apply(then, value, [undefined, ignoreRejection]);
    if (returned !== value && types.isPromise(returned)) {
      Reflect.apply(Promise.prototype.then, returned, [undefined, ignoreRejection]);
    }
  } catch {
    // A broken custom `then` cannot change the outcome.
  }
  return true;
}

/**
 * Logs a publication failure. The positions are already committed, so a failing
 * logger (for example a throwing sink) must not turn the result into an
 * exception: its error is swallowed and `REBUILT_PUBLISH_FAILED` is still returned.
 */
function logSafely(logger: Logger, portfolioId: string, tickers: readonly string[], error: unknown): void {
  try {
    logger.error('PositionsChanged could not be published; positions are committed.', {
      code: POSITIONS_CHANGED_PUBLISH_FAILED,
      portfolioId,
      tickers,
      error,
    });
  } catch {
    // Nothing else can be reported without risking another failure.
  }
}

export function createPositionService(dependencies: PositionServiceDependencies): PositionService {
  const { unitOfWork, publisher, logger } = dependencies;
  const projector = dependencies.projector ?? positionProjector;

  const reconcileInTransaction = (portfolioId: string): Reconciled =>
    // Synchronous callback: never async, never returns a promise.
    unitOfWork.run((tx): Reconciled => {
      const ledger = tx.transactions.listByPortfolio(portfolioId);
      const persisted = tx.positions.listByPortfolio(portfolioId);
      const replayed = projector.replay(portfolioId, ledger);
      if (!replayed.ok) {
        return { ok: false, error: replayed.error };
      }
      const changes = reconcilePositions(persisted, replayed.value);
      for (const change of changes) {
        if (change.after === null) {
          tx.positions.delete(portfolioId, change.ticker);
        } else {
          tx.positions.upsert(change.after);
        }
      }
      return { ok: true, changes };
    });

  return {
    rebuild: (portfolioId) => {
      let reconciled: Reconciled;
      try {
        reconciled = reconcileInTransaction(portfolioId);
      } catch (error) {
        if (error instanceof PersistenceError) {
          return { status: 'COMMIT_FAILED', code: error.code };
        }
        throw error;
      }
      if (!reconciled.ok) {
        return { status: 'PROJECTION_FAILED', error: reconciled.error };
      }
      const { changes } = reconciled;
      const event = positionsChangedEvent(portfolioId, changes);
      if (event === undefined) {
        return { status: 'REBUILT', changes, published: false };
      }
      let failed = false;
      let failure: unknown;
      try {
        // `publish` is synchronous by contract. An implementation that returns a
        // promise or thenable anyway (for example an `async` function) is not
        // reported as published: its rejection is handled so it cannot become an
        // unhandled rejection, and the outcome counts as a publication failure.
        const returned: unknown = publisher.publish(event);
        if (neutralizeThenable(returned)) {
          failed = true;
          failure = new TypeError(
            'PositionEventPublisher.publish must be synchronous; it returned a promise.',
          );
        }
      } catch (error) {
        failed = true;
        failure = error;
      }
      if (!failed) {
        return { status: 'REBUILT', changes, published: true };
      }
      logSafely(logger, portfolioId, event.tickers, failure);
      return { status: 'REBUILT_PUBLISH_FAILED', changes };
    },
  };
}
