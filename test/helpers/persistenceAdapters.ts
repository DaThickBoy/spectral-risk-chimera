// The persistence adapters every repository contract test runs against (OD-12): the in-memory
// unit of work, SQLite in memory, and SQLite on a temporary file. Each adapter offers the same
// test seams (failNextCommit, lastAttempt, snapshot).
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { InMemoryUnitOfWork, SqliteUnitOfWork } from '../../src/persistence/index.js';
import type { UnitOfWork } from '../../src/persistence/index.js';

export type TestUnitOfWork = UnitOfWork &
  Pick<InMemoryUnitOfWork, 'failNextCommit' | 'lastAttempt' | 'snapshot'>;

export const BUSY_TIMEOUT_MS = 2000;

const opened: SqliteUnitOfWork[] = [];
const dirs: string[] = [];

/** A fresh temporary directory, removed after the test. */
export function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'src-db-'));
  dirs.push(dir);
  return dir;
}

/** Opens a SQLite unit of work that is closed after the test. */
export function openSqlite(file: string, busyTimeoutMs = BUSY_TIMEOUT_MS): SqliteUnitOfWork {
  const uow = SqliteUnitOfWork.open(file, { busyTimeoutMs });
  opened.push(uow);
  return uow;
}

afterEach(() => {
  for (const uow of opened.splice(0)) {
    if (uow.isOpen) uow.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Committed state as another reader sees it, during an open unit of work: the in-memory snapshot,
 * or a second SQLite connection to the same file. `undefined` for SQLite `:memory:`, which has no
 * second connection.
 */
export function committedView(uow: TestUnitOfWork): ReturnType<TestUnitOfWork['snapshot']> | undefined {
  if (uow instanceof InMemoryUnitOfWork) {
    return uow.snapshot();
  }
  if (uow instanceof SqliteUnitOfWork && uow.file !== ':memory:') {
    const reader = openSqlite(uow.file);
    try {
      return reader.snapshot();
    } finally {
      reader.close();
    }
  }
  return undefined;
}

export const ADAPTERS: readonly (readonly [string, () => TestUnitOfWork])[] = [
  ['in-memory', () => new InMemoryUnitOfWork()],
  ['sqlite :memory:', () => openSqlite(':memory:')],
  ['sqlite file', () => openSqlite(path.join(tempDir(), 'test.db'))],
];
