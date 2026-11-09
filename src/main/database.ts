/**
 * Durable persistence for the composition root (OD-12): the SQLite unit of work
 * at `SRC_DATABASE_FILE`. Production start-up refuses to continue when the
 * variable is absent or invalid, or when the database cannot be opened; there is
 * no in-memory fallback. Tests that want `:memory:` open `SqliteUnitOfWork`
 * themselves and pass it to `createApplication`.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import type { EnvLoadResult } from '../config/index.js';
import { PersistenceError, SqliteUnitOfWork } from '../persistence/index.js';
import { ApplicationStartError } from './application.js';

export interface DatabaseOptions {
  /** Bounded wait for another process's write lock, in milliseconds (positive integer). */
  readonly busyTimeoutMs: number;
}

export function openApplicationDatabase(env: EnvLoadResult, options: DatabaseOptions): SqliteUnitOfWork {
  if (env.invalid.some((issue) => issue.key === 'SRC_DATABASE_FILE')) {
    throw new ApplicationStartError('DATABASE_CONFIG_INVALID', ['SRC_DATABASE_FILE']);
  }
  const file = env.env.SRC_DATABASE_FILE;
  if (file === undefined) {
    throw new ApplicationStartError('DATABASE_CONFIG_MISSING', ['SRC_DATABASE_FILE']);
  }
  let directory: boolean;
  try {
    directory = statSync(path.dirname(path.resolve(file))).isDirectory();
  } catch {
    directory = false;
  }
  if (!directory) {
    throw new ApplicationStartError('DATABASE_CONFIG_INVALID', ['SRC_DATABASE_FILE']);
  }
  try {
    return SqliteUnitOfWork.open(file, options);
  } catch (error) {
    if (error instanceof PersistenceError) {
      throw new ApplicationStartError('DATABASE_UNAVAILABLE', ['SRC_DATABASE_FILE'], error.code);
    }
    throw error;
  }
}
