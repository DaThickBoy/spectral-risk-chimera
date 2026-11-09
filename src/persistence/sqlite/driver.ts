/**
 * Internal SQLite driver interface (OD-12: built-in `node:sqlite`). Only this
 * file touches `node:sqlite`, so the adapter does not depend on the driver's API.
 *
 * Errors are classified by SQLite's primary result code (`errcode & 0xff`).
 * Callers turn a classification into a `PersistenceError` with a fixed message;
 * the driver's own message, which can contain stored values, is never passed on.
 */
import { DatabaseSync } from 'node:sqlite';

export type SqlValue = string | number | null;
export type SqlRow = Readonly<Record<string, SqlValue>>;

export interface SqlStatement {
  run(...params: SqlValue[]): { readonly changes: number };
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): readonly SqlRow[];
}

/** Driver-level interface; `openNodeSqlite` is its only implementation. */
export interface SqlDriver {
  exec(sql: string): void;
  /** Statements are prepared once per SQL text and reused. */
  prepare(sql: string): SqlStatement;
  close(): void;
  readonly isOpen: boolean;
}

export type SqlErrorKind = 'CONSTRAINT' | 'BUSY' | 'IO' | 'CORRUPT' | 'OTHER';

const PRIMARY = {
  BUSY: 5,
  LOCKED: 6,
  READONLY: 8,
  IOERR: 10,
  CORRUPT: 11,
  FULL: 13,
  CANTOPEN: 14,
  CONSTRAINT: 19,
  NOTADB: 26,
} as const;

/** `undefined` when `error` is not a SQLite error. */
export function sqlErrorKind(error: unknown): SqlErrorKind | undefined {
  const candidate = error as { code?: unknown; errcode?: unknown } | null;
  if (typeof candidate !== 'object' || candidate === null || candidate.code !== 'ERR_SQLITE_ERROR') {
    return undefined;
  }
  const primary = typeof candidate.errcode === 'number' ? candidate.errcode & 0xff : -1;
  switch (primary) {
    case PRIMARY.CONSTRAINT:
      return 'CONSTRAINT';
    case PRIMARY.BUSY:
    case PRIMARY.LOCKED:
      return 'BUSY';
    case PRIMARY.READONLY:
    case PRIMARY.IOERR:
    case PRIMARY.FULL:
    case PRIMARY.CANTOPEN:
      return 'IO';
    case PRIMARY.CORRUPT:
    case PRIMARY.NOTADB:
      return 'CORRUPT';
    default:
      return 'OTHER';
  }
}

export function openNodeSqlite(file: string): SqlDriver {
  const db = new DatabaseSync(file);
  const statements = new Map<string, SqlStatement>();
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      let statement = statements.get(sql);
      if (statement === undefined) {
        const prepared = db.prepare(sql);
        statement = {
          run: (...params) => ({ changes: Number(prepared.run(...params).changes) }), // a row count
          get: (...params) => prepared.get(...params) as SqlRow | undefined,
          all: (...params) => prepared.all(...params) as SqlRow[],
        };
        statements.set(sql, statement);
      }
      return statement;
    },
    close: () => {
      statements.clear();
      if (db.isOpen) {
        db.close();
      }
    },
    get isOpen() {
      return db.isOpen;
    },
  };
}
