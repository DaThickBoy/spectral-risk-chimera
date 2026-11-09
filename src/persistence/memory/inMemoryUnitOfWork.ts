/**
 * In-memory unit of work for tests (task 5.1, U-1). It is not a durable adapter;
 * the real adapter waits for OD-12 (task 5.3).
 *
 * Transaction semantics:
 * - `run` gives `work` repositories over a private draft of the committed state.
 *   Each write is checked against the draft (constraints and canonical decimals),
 *   applied to the draft, and recorded in the transaction's write log, so reads
 *   inside the transaction see its own writes.
 * - When `work` returns, the commit replays the write log, in order, onto a fresh
 *   copy of the committed state and publishes that copy in a single assignment.
 *   Until the publish step, other units of work see only the previous state.
 * - If `work` throws, returns a promise, or the commit fails, the draft and the
 *   copy are discarded: committed state is exactly as before, and the error
 *   propagates. A returned promise gets a rejection handler before the TypeError
 *   is thrown, so it can never become an unhandled rejection.
 * - Nested `run` calls are rejected, and repositories cannot be used after their
 *   `run` returns.
 *
 * Failure injection (for Property 21): `failNextCommit({ atWrite: k })` makes the
 * next commit attempt fail with `COMMIT_FAILED` when it reaches write `k`
 * (zero-based), after writes `0..k-1` have been applied to the commit copy.
 * `atWrite` equal to the number of writes fails at the final publish step, after
 * every write was applied. The fault is consumed by the next commit attempt only.
 * `lastAttempt` reports the write sequence and outcome of the most recent
 * attempt, so a test can target every position.
 *
 * Series (task 9.4): `insertContent` with identical content for an existing hash
 * writes nothing and returns false; `appendRetrieval` assigns `seq` from the
 * draft (next number after the committed and draft retrievals).
 */
import type {
  AlertRecord,
  AlertStateRecord,
  AuditRecord,
  FxRateRecord,
  ImportRecord,
  PortfolioRecord,
  PositionRecord,
  QuarantineRecordRow,
  Repositories,
  RiskResultRecord,
  SeriesContentRecord,
  SeriesRetrievalRecord,
  SnapshotRecord,
  TransactionRecord,
  UnitOfWork,
} from '../ports.js';
import { PersistenceError } from '../ports.js';
import {
  alertStateKey,
  applyWrite,
  compositeKey,
  copyState,
  describeWrites,
  emptyState,
  fxRateKey,
  sameSeriesContent,
  store,
} from './memoryState.js';
import type { State, WriteDescriptor, WriteOperation } from './memoryState.js';
import { neutralizeThenable } from '../thenable.js';

export type { WriteDescriptor, WriteOperation } from './memoryState.js';

export interface CommitFault {
  /** Zero-based write index; equal to the write count means the final publish step. */
  readonly atWrite: number;
}

export type CommitOutcome = 'COMMITTED' | 'COMMIT_FAILED' | 'ROLLED_BACK';

export interface CommitAttempt {
  readonly writes: readonly WriteDescriptor[];
  readonly outcome: CommitOutcome;
}

/** Committed state in insertion order, for test assertions. */
export interface InMemorySnapshot {
  readonly transactions: readonly TransactionRecord[];
  readonly imports: readonly ImportRecord[];
  readonly quarantine: readonly QuarantineRecordRow[];
  readonly positions: readonly PositionRecord[];
  readonly audit: readonly AuditRecord[];
  readonly seriesContent: readonly SeriesContentRecord[];
  /** In `seq` order. */
  readonly seriesRetrievals: readonly SeriesRetrievalRecord[];
  /** In append order (task 10.3). */
  readonly fxRates: readonly FxRateRecord[];
  /** In insertion order (task 6.1). */
  readonly portfolios: readonly PortfolioRecord[];
  /** In append order (task 12.3). */
  readonly riskResults: readonly RiskResultRecord[];
  /** In insertion order (task 12.5). */
  readonly snapshots: readonly SnapshotRecord[];
  /** In first-insertion order (task 16.2). */
  readonly alertState: readonly AlertStateRecord[];
  /** In insertion order (task 16.3). */
  readonly alerts: readonly AlertRecord[];
}

/**
 * Compares stored content with a candidate. A malformed candidate cannot be
 * identical; it then goes through the normal write checks, which reject it as a
 * constraint violation rather than an unrelated exception.
 */
function sameContentSafely(existing: SeriesContentRecord, candidate: SeriesContentRecord): boolean {
  try {
    return sameSeriesContent(existing, candidate);
  } catch {
    return false;
  }
}

/** Repositories bound to one transaction's draft and write log. */
function transactionRepositories(
  draft: State,
  writes: WriteOperation[],
  isActive: () => boolean,
): Repositories {
  const guard = (): void => {
    if (!isActive()) {
      throw new Error('Repositories were used outside their unit of work.');
    }
  };
  const write = (operation: WriteOperation): void => {
    guard();
    applyWrite(draft, operation);
    writes.push(operation);
  };
  const read = <T>(fn: () => T): T => {
    guard();
    return fn();
  };
  return {
    portfolios: {
      insert: (record) => write({ repository: 'portfolios', operation: 'insert', record: store(record) }),
      get: (id) => read(() => draft.portfolios.get(id)),
    },
    transactions: {
      insert: (record) => write({ repository: 'transactions', operation: 'insert', record: store(record) }),
      findByKey: (portfolioId, transactionKey) =>
        read(() => {
          const id = draft.transactionKeys.get(compositeKey(portfolioId, transactionKey));
          return id === undefined ? undefined : draft.transactions.get(id);
        }),
      listByPortfolio: (portfolioId) =>
        read(() => [...draft.transactions.values()].filter((record) => record.portfolioId === portfolioId)),
    },
    imports: {
      insert: (record) => write({ repository: 'imports', operation: 'insert', record: store(record) }),
      get: (id) => read(() => draft.imports.get(id)),
    },
    quarantine: {
      insert: (record) => write({ repository: 'quarantine', operation: 'insert', record: store(record) }),
      listByImport: (importId) =>
        read(() => [...draft.quarantine.values()].filter((record) => record.importId === importId)),
    },
    positions: {
      upsert: (record) => write({ repository: 'positions', operation: 'upsert', record: store(record) }),
      delete: (portfolioId, ticker) =>
        write({ repository: 'positions', operation: 'delete', portfolioId, ticker }),
      get: (portfolioId, ticker) => read(() => draft.positions.get(compositeKey(portfolioId, ticker))),
      listByPortfolio: (portfolioId) =>
        read(() => [...draft.positions.values()].filter((record) => record.portfolioId === portfolioId)),
    },
    audit: {
      append: (record) => write({ repository: 'audit', operation: 'append', record: store(record) }),
      list: () => read(() => [...draft.audit.values()]),
    },
    series: {
      insertContent: (record) => {
        guard();
        const stored = store(record);
        const existing = draft.seriesContent.get(stored.contentHash);
        if (existing !== undefined && sameContentSafely(existing, stored)) {
          // Identical content is already stored: nothing is written (task 9.4, rule 5).
          return false;
        }
        write({ repository: 'series', operation: 'insertContent', record: stored });
        return true;
      },
      getContent: (contentHash) => read(() => draft.seriesContent.get(contentHash)),
      appendRetrieval: (record) => {
        guard();
        // `seq` follows the draft, so a rolled-back unit of work consumes no number.
        const stored = store({ ...record, seq: draft.seriesRetrievals.size + 1 });
        write({ repository: 'series', operation: 'appendRetrieval', record: stored });
        return stored;
      },
      listRetrievalsByHash: (contentHash) =>
        read(() => [...draft.seriesRetrievals.values()].filter((r) => r.contentHash === contentHash)),
      listRetrievalsByTicker: (ticker, sourceKind) =>
        read(() =>
          [...draft.seriesRetrievals.values()].filter(
            (r) => r.ticker === ticker && r.sourceKind === sourceKind,
          ),
        ),
    },
    riskResults: {
      append: (record) => write({ repository: 'riskResults', operation: 'append', record: store(record) }),
      listByPortfolio: (portfolioId) =>
        read(() => [...draft.riskResults.values()].filter((record) => record.portfolioId === portfolioId)),
    },
    snapshots: {
      insert: (record) => write({ repository: 'snapshots', operation: 'insert', record: store(record) }),
      get: (id) => read(() => draft.snapshots.get(id)),
      listByHash: (hash) =>
        read(() => [...draft.snapshots.values()].filter((record) => record.hash === hash)),
    },
    alertState: {
      upsert: (record) => write({ repository: 'alertState', operation: 'upsert', record: store(record) }),
      get: (type, portfolioId, ticker) =>
        read(() => draft.alertState.get(alertStateKey(type, portfolioId, ticker))),
    },
    alerts: {
      insert: (record) => write({ repository: 'alerts', operation: 'insert', record: store(record) }),
      update: (record) => write({ repository: 'alerts', operation: 'update', record: store(record) }),
      get: (id) => read(() => draft.alerts.get(id)),
      listByPortfolio: (portfolioId) =>
        read(() => [...draft.alerts.values()].filter((record) => record.portfolioId === portfolioId)),
      listByDelivery: (delivery) =>
        read(() => [...draft.alerts.values()].filter((record) => record.delivery === delivery)),
    },
    fxRates: {
      append: (record) => write({ repository: 'fxRates', operation: 'append', record: store(record) }),
      findByKey: (pair, source, sourceKind, observedAt) =>
        read(() => {
          const id = draft.fxRateKeys.get(fxRateKey(pair, source, sourceKind, observedAt));
          return id === undefined ? undefined : draft.fxRates.get(id);
        }),
      listByPair: (pair) => read(() => [...draft.fxRates.values()].filter((r) => r.pair === pair)),
    },
  };
}

export class InMemoryUnitOfWork implements UnitOfWork {
  private committed: State = emptyState();
  private active = false;
  private pendingFault: CommitFault | undefined;
  private attempt: CommitAttempt | undefined;

  run<T>(work: (tx: Repositories) => T): T {
    if (this.active) {
      throw new Error('Nested units of work are not supported.');
    }
    this.active = true;
    const writes: WriteOperation[] = [];
    let open = true;
    let reachedCommit = false;
    try {
      const result = work(transactionRepositories(copyState(this.committed), writes, () => open));
      if (neutralizeThenable(result)) {
        throw new TypeError('UnitOfWork.run requires synchronous work; a promise was returned.');
      }
      reachedCommit = true;
      this.commit(writes);
      return result;
    } catch (error) {
      // A failed commit records its own attempt; anything earlier is a rollback.
      if (!reachedCommit) {
        this.attempt = { writes: describeWrites(writes), outcome: 'ROLLED_BACK' };
      }
      throw error;
    } finally {
      open = false;
      this.active = false;
    }
  }

  /** Makes the next commit attempt fail at write `atWrite` (one-shot). */
  failNextCommit(fault: CommitFault): void {
    if (!Number.isSafeInteger(fault.atWrite) || fault.atWrite < 0) {
      throw new RangeError('atWrite must be a non-negative integer.');
    }
    this.pendingFault = fault;
  }

  /** The most recent commit attempt: its write sequence and outcome. */
  get lastAttempt(): CommitAttempt | undefined {
    return this.attempt;
  }

  /** The committed state, in insertion order. Records are frozen. */
  snapshot(): InMemorySnapshot {
    return {
      transactions: [...this.committed.transactions.values()],
      imports: [...this.committed.imports.values()],
      quarantine: [...this.committed.quarantine.values()],
      positions: [...this.committed.positions.values()],
      audit: [...this.committed.audit.values()],
      seriesContent: [...this.committed.seriesContent.values()],
      seriesRetrievals: [...this.committed.seriesRetrievals.values()],
      fxRates: [...this.committed.fxRates.values()],
      portfolios: [...this.committed.portfolios.values()],
      riskResults: [...this.committed.riskResults.values()],
      snapshots: [...this.committed.snapshots.values()],
      alertState: [...this.committed.alertState.values()],
      alerts: [...this.committed.alerts.values()],
    };
  }

  private commit(writes: readonly WriteOperation[]): void {
    const fault = this.pendingFault;
    this.pendingFault = undefined;
    const descriptors = describeWrites(writes);
    const fail = (): never => {
      throw new PersistenceError('COMMIT_FAILED', 'The unit of work could not be committed.');
    };
    // Replay onto a copy; `this.committed` changes only in the final assignment.
    const next = copyState(this.committed);
    try {
      writes.forEach((write, index) => {
        if (fault?.atWrite === index) {
          fail();
        }
        applyWrite(next, write);
      });
      if (fault?.atWrite === writes.length) {
        fail();
      }
    } catch (error) {
      this.attempt = { writes: descriptors, outcome: 'COMMIT_FAILED' };
      throw error;
    }
    this.committed = next;
    this.attempt = { writes: descriptors, outcome: 'COMMITTED' };
  }
}
