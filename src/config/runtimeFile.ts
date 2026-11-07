/**
 * Locating and reading the runtime configuration file (Configuration policy 6).
 *
 * Only the file named by `SRC_CONFIG_FILE` is read. The template
 * (`config/config.template.jsonc`) is refused in two stages:
 *
 * 1. Before opening anything: the resolved, normalized path is compared with the
 *    template path (case-insensitively on Windows). A match is refused without
 *    opening the file.
 * 2. After opening the candidate once: the identity (device and inode) of the
 *    opened handle is compared with the template's identity. A symbolic link
 *    (opening follows it) or a hard link to the template therefore has the
 *    template's identity and is refused. The content is then read from that same
 *    handle, so the file whose identity was checked is the file that is read;
 *    replacing the path between the check and the read has no effect.
 *
 * Guarantee and its limit: the template's content is never read when file
 * identities are available. The template may be opened (through a link) but is
 * closed unread. Where a file system reports no inode (identity `undefined`, for
 * example some network or FAT volumes), stage 2 falls back to comparing real
 * paths, which is path-based and does not have the same race-free guarantee.
 *
 * File statuses:
 * - `NOT_CONFIGURED`: `SRC_CONFIG_FILE` unset or blank.
 * - `NOT_FOUND`: opening fails with ENOENT or ENOTDIR.
 * - `TEMPLATE_REFUSED`: the path or the opened file is the template.
 * - `UNREADABLE`: any other file-system error (for example EACCES, EISDIR), or
 *   the opened path is not a regular file.
 * - `PARSE_ERROR`: invalid JSONC, nesting beyond the limit, or a top-level value
 *   that is not an object.
 * Only file-system errors (errors carrying an errno `code`) are mapped to a
 * status; any other exception is a programmer error and propagates.
 */
import { closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropNulls, isPlainObject } from './introspection.js';
import { parseConfigJsonc } from './jsonc.js';

export const DEFAULT_TEMPLATE_PATH = fileURLToPath(
  new URL('../../config/config.template.jsonc', import.meta.url),
);

export type ConfigFileStatus =
  'LOADED' | 'NOT_CONFIGURED' | 'NOT_FOUND' | 'TEMPLATE_REFUSED' | 'UNREADABLE' | 'PARSE_ERROR';

/** Identity and type of an opened file. `identity` is `undefined` when unavailable. */
export interface ConfigFileInfo {
  readonly identity: string | undefined;
  readonly isFile: boolean;
}

/** A file opened once by the loader. Every method may throw an errno error. */
export interface ConfigFileHandle {
  info(): ConfigFileInfo;
  readText(): string;
  close(): void;
}

/** File access used by the loader, injectable for tests. Methods may throw errno errors. */
export interface ConfigFileSystem {
  /** Opens a file for reading, following symbolic links. */
  open(file: string): ConfigFileHandle;
  /** Identity of a file by path (used for the template only; the template is never opened here). */
  identityOf(file: string): string | undefined;
  /** Real path, used only when identities are unavailable. */
  realpath(file: string): string;
}

const identityFrom = (stat: { dev: bigint; ino: bigint }): string | undefined =>
  stat.ino === 0n ? undefined : `${stat.dev}:${stat.ino}`;

export const nodeConfigFileSystem: ConfigFileSystem = {
  open: (file) => {
    const fd = openSync(file, 'r');
    return {
      info: () => {
        const stat = fstatSync(fd, { bigint: true });
        return { identity: identityFrom(stat), isFile: stat.isFile() };
      },
      readText: () => readFileSync(fd, 'utf8'),
      close: () => closeSync(fd),
    };
  },
  identityOf: (file) => identityFrom(statSync(file, { bigint: true })),
  realpath: (file) => realpathSync.native(file),
};

export interface RuntimeFileOutcome {
  readonly status: ConfigFileStatus;
  readonly path?: string;
  readonly message?: string;
  /** Parsed content with `null` properties removed; `{}` unless `LOADED`. */
  readonly raw: Record<string, unknown>;
}

/** True for errors raised by the file system (they carry a string errno `code`). */
function isFileSystemError(error: unknown): error is NodeJS.ErrnoException & { code: string } {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

const normalizePath = (file: string): string =>
  process.platform === 'win32' ? path.normalize(file).toLowerCase() : path.normalize(file);

/** Identity of the template, or `undefined` when it does not exist or has no identity. */
function templateIdentity(fsys: ConfigFileSystem, template: string): string | undefined {
  try {
    return fsys.identityOf(template);
  } catch (error) {
    if (isFileSystemError(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Path-based fallback for file systems without identities. */
function sameRealPath(fsys: ConfigFileSystem, candidate: string, template: string): boolean {
  try {
    return normalizePath(fsys.realpath(candidate)) === normalizePath(fsys.realpath(template));
  } catch (error) {
    if (isFileSystemError(error)) {
      return false;
    }
    throw error;
  }
}

type Failed = (status: ConfigFileStatus, message: string) => RuntimeFileOutcome;

/** Checks and reads an opened handle. The caller closes the handle. */
function readOpened(
  fsys: ConfigFileSystem,
  handle: ConfigFileHandle,
  candidate: string,
  template: string,
  failed: Failed,
): RuntimeFileOutcome {
  let text: string;
  try {
    const info = handle.info();
    if (!info.isFile) {
      return failed('UNREADABLE', 'runtime configuration path is not a regular file');
    }
    const templateId = templateIdentity(fsys, template);
    const isTemplate =
      info.identity !== undefined && templateId !== undefined
        ? info.identity === templateId
        : sameRealPath(fsys, candidate, template);
    if (isTemplate) {
      return failed(
        'TEMPLATE_REFUSED',
        'SRC_CONFIG_FILE resolves to the configuration template, which is never loaded',
      );
    }
    text = handle.readText();
  } catch (error) {
    if (isFileSystemError(error)) {
      return failed('UNREADABLE', `runtime configuration file cannot be read (${error.code})`);
    }
    throw error;
  }
  const parsed = parseConfigJsonc(text);
  if (!parsed.ok) {
    return failed('PARSE_ERROR', parsed.error.message);
  }
  const normalized = dropNulls(parsed.value);
  if (!isPlainObject(normalized)) {
    return failed('PARSE_ERROR', 'top-level value must be an object');
  }
  return { status: 'LOADED', path: candidate, raw: normalized };
}

export function readRuntimeFile(
  srcConfigFile: string | undefined,
  templatePath: string,
  fsys: ConfigFileSystem,
): RuntimeFileOutcome {
  if (srcConfigFile === undefined || srcConfigFile.trim() === '') {
    return { status: 'NOT_CONFIGURED', message: 'SRC_CONFIG_FILE is not set', raw: {} };
  }
  const candidate = path.resolve(srcConfigFile);
  const template = path.resolve(templatePath);
  const failed: Failed = (status, message) => ({ status, path: candidate, message, raw: {} });

  // Stage 1: the template path itself is refused without opening anything.
  if (normalizePath(candidate) === normalizePath(template)) {
    return failed(
      'TEMPLATE_REFUSED',
      'SRC_CONFIG_FILE resolves to the configuration template, which is never loaded',
    );
  }

  let handle: ConfigFileHandle;
  try {
    handle = fsys.open(candidate);
  } catch (error) {
    if (isFileSystemError(error)) {
      return error.code === 'ENOENT' || error.code === 'ENOTDIR'
        ? failed('NOT_FOUND', 'runtime configuration file not found')
        : failed('UNREADABLE', `runtime configuration file cannot be opened (${error.code})`);
    }
    throw error;
  }

  // Stage 2: identity of the opened handle; the content is read from the same handle.
  // The handle is closed on every path, including when an exception propagates.
  let outcome: RuntimeFileOutcome;
  try {
    outcome = readOpened(fsys, handle, candidate, template, failed);
  } catch (error) {
    closeHandle(handle, error);
    throw error;
  }
  closeHandle(handle, undefined);
  return outcome;
}

/**
 * Closes a read-only handle. A file-system error on close cannot affect a result
 * that was already computed, so it is ignored. Any other error is a programmer
 * error and is thrown; if an exception is already propagating, both are reported.
 */
function closeHandle(handle: ConfigFileHandle, pending: unknown): void {
  try {
    handle.close();
  } catch (closeError) {
    if (isFileSystemError(closeError)) {
      return;
    }
    throw pending === undefined
      ? closeError
      : new AggregateError([pending, closeError], 'configuration file handle failed to close');
  }
}
