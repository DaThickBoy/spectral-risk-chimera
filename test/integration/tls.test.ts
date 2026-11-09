// Task 8.2, AT-SEC-23: external calls fail on an untrusted TLS certificate, and no code path
// disables verification. Uses a real local HTTPS server with the committed test-only certificate
// in test/fixtures/tls/ (never used outside tests).
// Validates: Requirements 24.8
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:https';
import type { Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpsGet } from '../../src/adapters/http/index.js';
import { FakeClock, createLogger, createResilientCall, systemSleeper } from '../../src/shared/index.js';
import { repoPath } from '../helpers/repo.js';

const cert = readFileSync(repoPath('test', 'fixtures', 'tls', 'untrusted-localhost.cert.pem'));
const key = readFileSync(repoPath('test', 'fixtures', 'tls', 'untrusted-localhost.key.pem'));
const ENV_SWITCH = ['NODE', 'TLS', 'REJECT', 'UNAUTHORIZED'].join('_');

let server: Server;
let port = 0;
let requestsServed = 0;

beforeAll(async () => {
  server = createServer({ key, cert }, (_request, response) => {
    requestsServed += 1;
    response.end('should never be read');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const url = (): string => `https://127.0.0.1:${port}/`;

describe('AT-SEC-23: an untrusted certificate fails the call', () => {
  it('control: the server presents a valid certificate chain when the test CA is trusted explicitly', async () => {
    // Raw TLS in the test only; the production transport has no way to add a CA.
    const authorized = await new Promise<boolean>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port, ca: cert }, () => {
        resolve(socket.authorized);
        socket.end();
      });
      socket.on('error', reject);
    });
    expect(authorized).toBe(true);
  });

  it('httpsGet rejects the untrusted certificate as TLS, with no detail, and sends no request', async () => {
    const before = requestsServed;
    const outcome = await httpsGet(url(), { maxBytes: 1024 }, new AbortController().signal);
    // Exactly this object: no certificate text, error message, code, or host is passed on.
    expect(outcome).toEqual({ ok: false, failure: 'TLS' });
    expect(requestsServed).toBe(before);
  });

  it('still rejects it when the Node.js environment switch tries to disable verification', async () => {
    const previous = process.env[ENV_SWITCH];
    process.env[ENV_SWITCH] = '0';
    try {
      const outcome = await httpsGet(url(), { maxBytes: 1024 }, new AbortController().signal);
      expect(outcome).toEqual({ ok: false, failure: 'TLS' });
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, ENV_SWITCH);
      } else {
        process.env[ENV_SWITCH] = previous;
      }
    }
  });

  it('through ResilientCall it is TLS_ERROR, not retried, safe, and counts toward the circuit', async () => {
    const rc = createResilientCall({
      clock: new FakeClock('2026-11-07T12:00:00.000Z'),
      sleeper: systemSleeper,
      random: () => 0,
      logger: createLogger({ clock: new FakeClock('2026-11-07T12:00:00.000Z'), sink: () => undefined }),
      retry: {
        maxRetries: 3,
        attemptTimeoutMs: 10_000,
        baseDelayMs: 250,
        maxDelayMs: 10_000,
        maxRetryAfterMs: 600_000,
      },
      circuit: { failureThreshold: 2, openMs: 60_000 },
    });
    const get = (signal: AbortSignal) => httpsGet(url(), { maxBytes: 1024 }, signal);
    const first = await rc.run('tls-fixture', 'get', get);
    // Exactly this error: no certificate text, host, or underlying error code is exposed.
    expect(first).toEqual({
      ok: false,
      error: {
        code: 'TLS_ERROR',
        message: 'Provider call tls-fixture get failed (TLS_ERROR).',
        provider: 'tls-fixture',
        operation: 'get',
        attempts: 1,
        retryable: false,
      },
    });
    expect(rc.status('tls-fixture').circuit).toBe('CLOSED');
    await rc.run('tls-fixture', 'get', get);
    expect(rc.status('tls-fixture')).toMatchObject({
      state: 'UNAVAILABLE',
      circuit: 'OPEN',
      lastErrorCode: 'TLS_ERROR',
    });
    const before = requestsServed;
    const third = await rc.run('tls-fixture', 'get', get);
    expect(!third.ok && third.error).toMatchObject({ code: 'CIRCUIT_OPEN', attempts: 0 });
    expect(requestsServed).toBe(before);
  });

  it('accepts only https: URLs', async () => {
    await expect(
      httpsGet(`http://127.0.0.1:${port}/`, { maxBytes: 1 }, new AbortController().signal),
    ).rejects.toThrow(TypeError);
  });
});

describe('AT-SEC-23 (static): no code path disables certificate verification', () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
    });
  const files = sources(repoPath('src')).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

  it('scans the source tree', () => {
    expect(files.some((file) => file.path.endsWith('httpsTransport.ts'))).toBe(true);
  });

  it('never references the environment switch that disables verification', () => {
    for (const { path, text } of files) {
      expect(text.includes(ENV_SWITCH), path).toBe(false);
    }
  });

  it('sets rejectUnauthorized only to true, and never a custom CA or identity check', () => {
    for (const { path, text } of files) {
      for (const match of text.matchAll(/rejectUnauthorized\s*:\s*([\w$.!()]+)/g)) {
        expect(match[1], path).toBe('true');
      }
      expect(/checkServerIdentity\s*:/.test(text), path).toBe(false);
      expect(/[{,]\s*ca\s*:/.test(text), path).toBe(false);
    }
  });

  it('never uses the test certificate fixture outside tests', () => {
    for (const { path, text } of files) {
      expect(text.includes('untrusted-localhost'), path).toBe(false);
    }
  });
});
