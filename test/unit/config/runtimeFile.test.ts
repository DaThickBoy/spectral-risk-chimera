// Runtime configuration file access (task 3.2; Configuration policy 6, AT-CFG-07):
// the candidate is opened once, its identity is checked on the opened handle, and the
// content is read from that same handle, which is always closed.
// Validates: Requirements 24.6, 29.5
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATE_PATH, loadConfig } from '../../../src/config/index.js';
import type { ConfigFileHandle, ConfigFileSystem } from '../../../src/config/index.js';
import { captureLogger, completeTestConfig } from '../../helpers/config.js';

const CANDIDATE = path.resolve('runtime-under-test.jsonc');
const TEMPLATE = path.resolve(DEFAULT_TEMPLATE_PATH);
const TEMPLATE_ID = '1:100';

const errno = (code: string): Error => Object.assign(new Error(`${code}: simulated`), { code });

interface Calls {
  opened: string[];
  infoCalls: number;
  reads: number;
  closes: number;
  identityOf: string[];
  realpath: string[];
}

interface FakeOptions {
  handleIdentity?: string | undefined;
  isFile?: boolean;
  text?: string;
  /** Identity the path lookup would report for the candidate (never consulted). */
  pathIdentityOfCandidate?: string;
  templateIdentity?: string | undefined;
  realpaths?: Record<string, string>;
  infoError?: Error;
  readError?: Error;
  closeError?: Error;
}

function fakeFs(options: FakeOptions): { fs: ConfigFileSystem; calls: Calls } {
  const calls: Calls = { opened: [], infoCalls: 0, reads: 0, closes: 0, identityOf: [], realpath: [] };
  const handle: ConfigFileHandle = {
    info: () => {
      calls.infoCalls += 1;
      if (options.infoError !== undefined) throw options.infoError;
      return {
        identity: 'handleIdentity' in options ? options.handleIdentity : '1:200',
        isFile: options.isFile ?? true,
      };
    },
    readText: () => {
      calls.reads += 1;
      if (options.readError !== undefined) throw options.readError;
      return options.text ?? JSON.stringify(completeTestConfig());
    },
    close: () => {
      calls.closes += 1;
      if (options.closeError !== undefined) throw options.closeError;
    },
  };
  const fs: ConfigFileSystem = {
    open: (file) => {
      calls.opened.push(file);
      return handle;
    },
    identityOf: (file) => {
      calls.identityOf.push(file);
      if (file === TEMPLATE) {
        return 'templateIdentity' in options ? options.templateIdentity : TEMPLATE_ID;
      }
      return options.pathIdentityOfCandidate;
    },
    realpath: (file) => {
      calls.realpath.push(file);
      return options.realpaths?.[file] ?? file;
    },
  };
  return { fs, calls };
}

const load = (fs: ConfigFileSystem) => {
  const { logger } = captureLogger();
  return loadConfig({ srcConfigFile: CANDIDATE, logger, fileSystem: fs, templatePath: TEMPLATE });
};

describe('open once, check the opened handle, read the same handle', () => {
  it('loads from the opened handle and never looks up the candidate by path', () => {
    // The path lookup would claim the candidate is the template (as if it had been
    // swapped after opening); only the opened handle's identity counts.
    const { fs, calls } = fakeFs({ pathIdentityOfCandidate: TEMPLATE_ID });
    const result = load(fs);
    expect(result.file.status).toBe('LOADED');
    expect(calls.opened).toEqual([CANDIDATE]);
    expect(calls.identityOf).toEqual([TEMPLATE]);
    expect(calls.reads).toBe(1);
    expect(calls.closes).toBe(1);
  });

  it('refuses when the opened file has the template identity, without reading it', () => {
    const { fs, calls } = fakeFs({ handleIdentity: TEMPLATE_ID });
    const result = load(fs);
    expect(result.file.status).toBe('TEMPLATE_REFUSED');
    expect(calls.reads).toBe(0);
    expect(calls.closes).toBe(1);
  });

  it('refuses the template path itself before opening anything', () => {
    const { fs, calls } = fakeFs({});
    const { logger } = captureLogger();
    const result = loadConfig({ srcConfigFile: TEMPLATE, logger, fileSystem: fs, templatePath: TEMPLATE });
    expect(result.file.status).toBe('TEMPLATE_REFUSED');
    expect(calls.opened).toEqual([]);
  });

  it('falls back to real paths only when identities are unavailable', () => {
    const refused = fakeFs({ handleIdentity: undefined, realpaths: { [CANDIDATE]: TEMPLATE } });
    expect(load(refused.fs).file.status).toBe('TEMPLATE_REFUSED');
    expect(refused.calls.reads).toBe(0);
    expect(refused.calls.closes).toBe(1);

    const accepted = fakeFs({ handleIdentity: undefined });
    expect(load(accepted.fs).file.status).toBe('LOADED');
    expect(accepted.calls.realpath).toEqual([CANDIDATE, TEMPLATE]);
  });

  it('without a template identity, falls back to real paths, which differ here', () => {
    const { fs } = fakeFs({ templateIdentity: undefined });
    expect(load(fs).file.status).toBe('LOADED');
  });
});

describe('error paths close the handle and map only file-system errors', () => {
  it('ENOENT and ENOTDIR on open are NOT_FOUND; other errno codes are UNREADABLE', () => {
    for (const [code, status] of [
      ['ENOENT', 'NOT_FOUND'],
      ['ENOTDIR', 'NOT_FOUND'],
      ['EACCES', 'UNREADABLE'],
      ['EISDIR', 'UNREADABLE'],
    ] as const) {
      const fs: ConfigFileSystem = {
        ...fakeFs({}).fs,
        open: () => {
          throw errno(code);
        },
      };
      expect(load(fs).file.status, code).toBe(status);
    }
  });

  it('a failing identity check is UNREADABLE and closes the handle', () => {
    const { fs, calls } = fakeFs({ infoError: errno('EIO') });
    const result = load(fs);
    expect(result.file).toMatchObject({ status: 'UNREADABLE', message: expect.stringContaining('EIO') });
    expect(calls.reads).toBe(0);
    expect(calls.closes).toBe(1);
  });

  it('a non-regular file is UNREADABLE and closes the handle', () => {
    const { fs, calls } = fakeFs({ isFile: false });
    expect(load(fs).file.status).toBe('UNREADABLE');
    expect(calls.reads).toBe(0);
    expect(calls.closes).toBe(1);
  });

  it('a failing read is UNREADABLE and closes the handle', () => {
    const { fs, calls } = fakeFs({ readError: errno('EACCES') });
    expect(load(fs).file.status).toBe('UNREADABLE');
    expect(calls.closes).toBe(1);
  });

  it('a parse error still closes the handle', () => {
    const { fs, calls } = fakeFs({ text: '{"var": ' });
    expect(load(fs).file.status).toBe('PARSE_ERROR');
    expect(calls.closes).toBe(1);
  });

  it('a failing close does not change an already computed result', () => {
    const { fs } = fakeFs({ closeError: errno('EBADF') });
    expect(load(fs).file.status).toBe('LOADED');
  });

  it('programmer errors are not swallowed', () => {
    const openBug: ConfigFileSystem = {
      ...fakeFs({}).fs,
      open: () => {
        throw new TypeError('bug in file access');
      },
    };
    expect(() => load(openBug)).toThrow(TypeError);

    const { fs, calls } = fakeFs({ readError: new TypeError('bug while reading') });
    expect(() => load(fs)).toThrow(TypeError);
    expect(calls.closes).toBe(1);
  });
});
