/**
 * SQLite unit of work (task 5.3; OD-12 resolved: SQLite through the built-in
 * `node:sqlite`, WAL, `synchronous=FULL`, multi-process access with a bounded
 * busy timeout).
 *
 * Opening (`SqliteUnitOfWork.open`):
 * - `busy_timeout` (bounded, required), `foreign_keys=ON`, `journal_mode=WAL`
 *   (files; `:memory:` has no journal file), `synchronous=FULL`, then
 *   `quick_check`. A damaged file or a file that is not a database is
 *   `INTEGRITY_ERROR`.
 * - Migrations (`schema.ts`) run forward in one transaction; a database whose
 *   `user_version` is newer than this application is refused (`INTEGRITY_ERROR`).
 *
 * `run(work)` keeps the `UnitOfWork` contract of the in-memory implementation:
 * - One `BEGIN IMMEDIATE` transaction per call. Reads through `tx` see its own
 *   writes; other connections see only committed data (WAL).
 * - If `work` throws, returns a promise, or the commit fails, the transaction is
 *   rolled back: committed state is exactly as before and the error propagates.
 *   Asynchronous work is a `TypeError`; nested calls are refused; repositories
 *   cannot be used after their call returns.
 * - When the busy timeout is exhausted (another process holds the write lock),
 *   the call fails with `COMMIT_FAILED` and nothing is written.
 * - Database errors become `PersistenceError` with fixed messages
 *   (`CONSTRAINT_VIOLATION`, `COMMIT_FAILED`, `INTEGRITY_ERROR`); the driver's
 *   message is never passed on.
 * - After `close()`, every call fails with `COMMIT_FAILED`.
 *
 * Test seams, as in the in-memory unit of work: `failNextCommit({ atWrite })`
 * makes the next commit attempt fail with `COMMIT_FAILED` when it has at least
 * `atWrite` writes (the transaction is rolled back, so the outcome equals a
 * failure at that write); `lastAttempt` reports the write sequence and outcome;
 * `snapshot()` reads every table in insertion order.
 */
import type { Repositories, UnitOfWork } from '../ports.js';
import { PersistenceError } from '../ports.js';
import type {
  CommitAttempt,
  CommitFault,
  InMemorySnapshot,
  WriteDescriptor,
} from '../memory/inMemoryUnitOfWork.js';
import { neutralizeThenable } from '../thenable.js';
import { openNodeSqlite, sqlErrorKind } from './driver.js';
import type { SqlDriver } from './driver.js';
import { readAll, safeError, sqliteRepositories } from './repositories.js';
import type { WriteNote } from './repositories.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema.js';

export interface SqliteOptions {
  /** Bounded wait for another connection's write lock, in milliseconds (positive integer). */
  readonly busyTimeoutMs: number;
}

const closedError = (): PersistenceError =>
  new PersistenceError('COMMIT_FAILED', 'The unit of work could not be committed.');

const openFailure = (error: unknown): PersistenceError => {
  if (error instanceof PersistenceError) {
    return error;
  }
  if (sqlErrorKind(error) === 'CORRUPT') {
    return new PersistenceError('INTEGRITY_ERROR', 'The database file is damaged or not a database.');
  }
  return new PersistenceError('COMMIT_FAILED', 'The database could not be opened.');
};

function pragmaValue(db: SqlDriver, pragma: string): unknown {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  return row === undefined ? undefined : Object.values(row)[0];
}

function migrate(db: SqlDriver): void {
  const current = pragmaValue(db, 'user_version');
  if (typeof current !== 'number' || !Number.isSafeInteger(current) || current < 0) {
    throw new PersistenceError('INTEGRITY_ERROR', 'The database schema version cannot be read.');
  }
  if (current > LATEST_SCHEMA_VERSION) {
    throw new PersistenceError(
      'INTEGRITY_ERROR',
      'The database schema version is newer than this application supports.',
    );
  }
  if (current === LATEST_SCHEMA_VERSION) {
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const migration of MIGRATIONS) {
      if (migration.version > current) {
        db.exec(migration.sql);
        db.exec(`PRAGMA user_version = ${String(migration.version)}`);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export class SqliteUnitOfWork implements UnitOfWork {
  readonly file: string;
  private readonly db: SqlDriver;
  private active = false;
  private pendingFault: CommitFault | undefined;
  private attempt: CommitAttempt | undefined;

  private constructor(file: string, db: SqlDriver) {
    this.file = file;
    this.db = db;
  }

  /** Opens (and if needed creates and migrates) the database. `:memory:` is accepted for tests. */
  static open(file: string, options: SqliteOptions): SqliteUnitOfWork {
    if (typeof file !== 'string' || file.length === 0) {
      throw new TypeError('file must be a non-empty path.');
    }
    if (!Number.isSafeInteger(options.busyTimeoutMs) || options.busyTimeoutMs < 1) {
      throw new TypeError('busyTimeoutMs must be a positive integer.');
    }
    let db: SqlDriver | undefined;
    try {
      db = openNodeSqlite(file);
      db.exec(`PRAGMA busy_timeout = ${String(options.busyTimeoutMs)}`);
      db.exec('PRAGMA foreign_keys = ON');
      if (file !== ':memory:') {
        const mode = pragmaValue(db, 'journal_mode = WAL');
        if (mode !== 'wal') {
          throw new PersistenceError('COMMIT_FAILED', 'The database could not be opened in WAL mode.');
        }
      }
      db.exec('PRAGMA synchronous = FULL');
      if (pragmaValue(db, 'quick_check') !== 'ok') {
        throw new PersistenceError('INTEGRITY_ERROR', 'The database file is damaged or not a database.');
      }
      migrate(db);
      return new SqliteUnitOfWork(file, db);
    } catch (error) {
      db?.close();
      throw openFailure(error);
    }
  }

  get isOpen(): boolean {
    return this.db.isOpen;
  }

  run<T>(work: (tx: Repositories) => T): T {
    if (!this.db.isOpen) {
      throw closedError();
    }
    if (this.active) {
      throw new Error('Nested units of work are not supported.');
    }
    this.active = true;
    const writes: WriteNote[] = [];
    let open = true;
    try {
      try {
        this.db.exec('BEGIN IMMEDIATE');
      } catch (error) {
        this.attempt = { writes: [], outcome: 'COMMIT_FAILED' };
        throw safeError(error, 'database');
      }
      let result: T;
      try {
        const repositories = sqliteRepositories(
          this.db,
          (write) => writes.push(write),
          () => {
            if (!open) {
              throw new Error('Repositories were used outside their unit of work.');
            }
          },
        );
        result = work(repositories);
        if (neutralizeThenable(result)) {
          throw new TypeError('UnitOfWork.run requires synchronous work; a promise was returned.');
        }
      } catch (error) {
        this.rollback();
        this.attempt = { writes: describe(writes), outcome: 'ROLLED_BACK' };
        throw error;
      }
      this.commit(writes);
      return result;
    } finally {
      open = false;
      this.active = false;
    }
  }

  /** Makes the next commit attempt fail at write `atWrite` (one-shot, test seam). */
  failNextCommit(fault: CommitFault): void {
    if (!Number.isSafeInteger(fault.atWrite) || fault.atWrite < 0) {
      throw new RangeError('atWrite must be a non-negative integer.');
    }
    this.pendingFault = fault;
  }

  get lastAttempt(): CommitAttempt | undefined {
    return this.attempt;
  }

  /** Every table in insertion order, read outside any unit of work (tests). */
  snapshot(): InMemorySnapshot {
    if (!this.db.isOpen) {
      throw closedError();
    }
    if (this.active) {
      // The same connection would see the open transaction's writes, not committed state.
      throw new Error('snapshot() reads committed state and is not available inside a unit of work.');
    }
    return readAll(this.db);
  }

  /** Closes the connection; later calls fail with `COMMIT_FAILED`. Idempotent. */
  close(): void {
    if (this.active) {
      throw new Error('The database cannot be closed inside a unit of work.');
    }
    this.db.close();
  }

  private commit(writes: readonly WriteNote[]): void {
    const fault = this.pendingFault;
    this.pendingFault = undefined;
    const descriptors = describe(writes);
    if (fault !== undefined && fault.atWrite <= writes.length) {
      this.rollback();
      this.attempt = { writes: descriptors, outcome: 'COMMIT_FAILED' };
      throw new PersistenceError('COMMIT_FAILED', 'The unit of work could not be committed.');
    }
    try {
      this.db.exec('COMMIT');
    } catch (error) {
      this.rollback();
      this.attempt = { writes: descriptors, outcome: 'COMMIT_FAILED' };
      const mapped = safeError(error, 'database');
      throw mapped.code === 'CONSTRAINT_VIOLATION' ? mapped : closedError();
    }
    this.attempt = { writes: descriptors, outcome: 'COMMITTED' };
  }

  private rollback(): void {
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // No transaction is open (SQLite already rolled back); nothing else to undo.
    }
  }
}

const describe = (writes: readonly WriteNote[]): readonly WriteDescriptor[] =>
  writes.map(({ repository, operation }) => ({ repository, operation }) as WriteDescriptor);
