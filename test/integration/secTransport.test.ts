// Task 19.2: the production Node.js SecTransport against local servers, reached only through the
// test-only socket-factory seam, with fake public DNS so the guard and the production address
// policy run unchanged. TLS verification of the default factory is checked against the local
// untrusted-certificate server with exactly the production options (port replaced by the test).
// Validates: Requirements 6.6, 24.8, 29.9, 29.10, 33.6
import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createTlsServer, globalAgent } from 'node:https';
import type { Server as TlsServer } from 'node:https';
import { connect as netConnect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { connect as tlsConnect, createSecureContext } from 'node:tls';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NO_REUSE_AGENT_OPTIONS,
  NoReuseAgent,
  createNodeSecDnsResolver,
  createNodeSecTransport,
  defaultTlsOptions,
  pinnedLookup,
  toDnsFamilyAnswer,
} from '../../src/adapters/sec/index.js';
import type { SecSocketFactory, SecSocketTarget } from '../../src/adapters/sec/index.js';
import { createSecClient, createSecRateLimiter, createSecUrlGuard } from '../../src/sec/index.js';
import type { ResolvedSecHost, SecTransportRequest } from '../../src/sec/index.js';
import { createLogger, createResilientCall, systemClock, systemSleeper } from '../../src/shared/index.js';
import { repoPath } from '../helpers/repo.js';
import { DEFAULT_CIRCUIT, DEFAULT_RETRY } from '../helpers/resilience.js';
import { PUBLIC_DNS, TEST_USER_AGENT, hostResolver } from '../helpers/secClient.js';
import { recordingSink } from '../helpers/secGuard.js';

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly rawHeaders: string[];
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let server: Server;
let port = 0;
let connections = 0;
let seen: Seen[] = [];
let handler: Handler = (_request, response) => response.end('ok');

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push({ method: request.method ?? '', url: request.url ?? '', rawHeaders: [...request.rawHeaders] });
    handler(request, response);
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  connections = 0;
  handler = (_request, response) => response.end('ok');
});

const targets: SecSocketTarget[] = [];
/** Test-only factory: records the pinned target and connects to the local plain-HTTP server. */
const localFactory: SecSocketFactory = (target) => {
  targets.push(target);
  return netConnect(port, '127.0.0.1');
};

/** A real ResolvedSecHost from the guard, with fake public DNS (the policy is unchanged). */
async function resolved(url = 'https://www.sec.gov/Archives/x.htm?y=1'): Promise<ResolvedSecHost> {
  const guard = createSecUrlGuard({
    resolver: hostResolver(PUBLIC_DNS),
    sink: recordingSink(),
    clock: systemClock,
  });
  const validated = guard.validate(url);
  if (!validated.ok) {
    throw new Error('test URL did not validate');
  }
  const host = await guard.resolveAndCheck(validated.value);
  if (!host.ok) {
    throw new Error('test host did not resolve');
  }
  return host.value;
}

const HEADERS = {
  Host: 'www.sec.gov',
  'User-Agent': TEST_USER_AGENT,
  'Accept-Encoding': 'identity',
  Connection: 'close',
};

async function send(overrides: Partial<SecTransportRequest> = {}, signal = new AbortController().signal) {
  const transport = createNodeSecTransport({ socketFactory: localFactory });
  return transport.request({
    host: await resolved(),
    path: '/Archives/x.htm?y=1',
    headers: HEADERS,
    maxBytes: 100,
    signal,
    ...overrides,
  });
}

describe('node SecTransport: request shape and pinning', () => {
  it('sends exactly the given headers, the path, and GET; the factory gets the pinned target on port 443', async () => {
    targets.length = 0;
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0xff]));
    };
    const outcome = await send();
    expect(outcome).toEqual({
      ok: true,
      status: 200,
      locations: [],
      contentType: 'text/html',
      body: new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0xff]),
    });
    expect(seen).toEqual([
      {
        method: 'GET',
        url: '/Archives/x.htm?y=1',
        rawHeaders: [
          'Host',
          'www.sec.gov',
          'User-Agent',
          TEST_USER_AGENT,
          'Accept-Encoding',
          'identity',
          'Connection',
          'close',
        ],
      },
    ]);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ hostname: 'www.sec.gov', port: 443 });
    expect(targets[0]?.addresses.map((a) => a.address)).toEqual([
      '8.8.8.8',
      '8.8.4.4',
      '2001:4860:4860::8888',
    ]);
  });

  it('never reuses a connection', async () => {
    await send();
    await send();
    expect(seen).toHaveLength(2);
    expect(connections).toBe(2);
  });
});

describe('node SecTransport: response handling', () => {
  it('a streamed body above maxBytes is TOO_LARGE; exactly maxBytes is accepted', async () => {
    handler = (_request, response) => {
      response.writeHead(200);
      response.write(Buffer.alloc(60));
      response.end(Buffer.alloc(41));
    };
    expect(await send()).toEqual({ ok: false, failure: 'TOO_LARGE' });
    handler = (_request, response) => {
      response.writeHead(200);
      response.write(Buffer.alloc(60));
      response.end(Buffer.alloc(40));
    };
    const exact = await send();
    expect(exact.ok && exact.body.length).toBe(100);
  });

  it('a declared Content-Length above maxBytes is TOO_LARGE before the body is read', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Length': '5000' });
      response.write('partial');
    };
    expect(await send()).toEqual({ ok: false, failure: 'TOO_LARGE' });
  });

  it.each(['gzip', 'br', 'deflate', 'identity, gzip'])(
    'Content-Encoding %s is an invalid response',
    async (encoding) => {
      handler = (_request, response) => {
        response.writeHead(200, { 'Content-Encoding': encoding });
        response.end('x');
      };
      expect(await send()).toEqual({ ok: false, failure: 'INVALID_RESPONSE' });
    },
  );

  it('Content-Encoding identity is accepted', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Encoding': 'identity' });
      response.end('x');
    };
    expect((await send()).ok).toBe(true);
  });

  it('a redirect reports every raw Location value and its body is not read', async () => {
    handler = (_request, response) => {
      response.writeHead(302, [
        ['Location', 'https://www.sec.gov/a'],
        ['Location', 'https://www.sec.gov/b'],
      ]);
      response.end(Buffer.alloc(10_000));
    };
    expect(await send()).toEqual({
      ok: true,
      status: 302,
      locations: ['https://www.sec.gov/a', 'https://www.sec.gov/b'],
      body: new Uint8Array(0),
    });
  });

  it('a 429 reports its first Retry-After', async () => {
    handler = (_request, response) => {
      response.writeHead(429, [
        ['Retry-After', '7'],
        ['Retry-After', '9'],
      ]);
      response.end();
    };
    expect(await send()).toEqual({
      ok: true,
      status: 429,
      locations: [],
      retryAfter: '7',
      body: new Uint8Array(0),
    });
  });

  it('an abort during the response is TIMEOUT', async () => {
    handler = () => undefined;
    const controller = new AbortController();
    const pending = send({}, controller.signal);
    setTimeout(() => controller.abort(), 50);
    expect(await pending).toEqual({ ok: false, failure: 'TIMEOUT' });
  });

  it('a refused connection is NETWORK', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const transport = createNodeSecTransport({ socketFactory: () => netConnect(closedPort, '127.0.0.1') });
    const outcome = await transport.request({
      host: await resolved(),
      path: '/',
      headers: HEADERS,
      maxBytes: 10,
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({ ok: false, failure: 'NETWORK' });
  });
});

describe('pinned lookup', () => {
  const lookupOf = async () => pinnedLookup(await resolved());
  const call = (lookup: ReturnType<typeof pinnedLookup>, hostname: string, options: object) =>
    new Promise<{ error: unknown; address: unknown; family: unknown }>((resolve) =>
      lookup(hostname, options as never, (error, address, family) => resolve({ error, address, family })),
    );

  it('returns every validated address for all: true, and the first otherwise', async () => {
    const lookup = await lookupOf();
    expect(await call(lookup, 'www.sec.gov', { all: true })).toMatchObject({
      error: null,
      address: [
        { address: '8.8.8.8', family: 4 },
        { address: '8.8.4.4', family: 4 },
        { address: '2001:4860:4860::8888', family: 6 },
      ],
    });
    expect(await call(lookup, 'www.sec.gov', {})).toMatchObject({
      error: null,
      address: '8.8.8.8',
      family: 4,
    });
    expect(await call(lookup, 'www.sec.gov', { family: 6 })).toMatchObject({
      address: '2001:4860:4860::8888',
      family: 6,
    });
    expect(await call(lookup, 'www.sec.gov', { family: 'IPv6', all: true })).toMatchObject({
      address: [{ address: '2001:4860:4860::8888', family: 6 }],
    });
  });

  it('refuses any other hostname', async () => {
    const lookup = await lookupOf();
    for (const hostname of ['data.sec.gov', 'localhost', 'WWW.SEC.GOV', 'evil.example']) {
      const result = await call(lookup, hostname, { all: true });
      expect((result.error as { code?: string }).code).toBe('ENOTFOUND');
    }
  });

  it('refuses a family with no validated address', async () => {
    const lookup = pinnedLookup(await resolved('https://data.sec.gov/x'));
    expect(((await call(lookup, 'data.sec.gov', { family: 6 })).error as { code?: string }).code).toBe(
      'ENOTFOUND',
    );
  });
});

describe('default factory: verified TLS to port 443 with the allowlisted hostname', () => {
  const cert = readFileSync(repoPath('test', 'fixtures', 'tls', 'untrusted-localhost.cert.pem'));
  const key = readFileSync(repoPath('test', 'fixtures', 'tls', 'untrusted-localhost.key.pem'));
  let tlsServer: TlsServer;
  let tlsPort = 0;
  const serverNames: string[] = [];

  beforeAll(async () => {
    tlsServer = createTlsServer({
      key,
      cert,
      SNICallback: (name, callback) => {
        serverNames.push(name);
        callback(null, createSecureContext({ key, cert }));
      },
    });
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
    tlsPort = (tlsServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
  });

  // A test-only pinned host whose lookup points at the local server. It is built here, never by
  // the guard, so the production address policy is untouched.
  const localPin = {
    hostname: 'www.sec.gov',
    addresses: Object.freeze([Object.freeze({ address: '127.0.0.1', family: 4 })]),
    policyVersion: 'iana-special-purpose-2025-10-09',
  } as unknown as ResolvedSecHost;
  const localTarget = (): SecSocketTarget => ({
    hostname: 'www.sec.gov',
    addresses: localPin.addresses,
    port: 443,
    lookup: pinnedLookup(localPin),
  });

  it('has exactly the production options', () => {
    const target = localTarget();
    expect(defaultTlsOptions(target)).toEqual({
      host: 'www.sec.gov',
      port: 443,
      servername: 'www.sec.gov',
      lookup: target.lookup,
      autoSelectFamily: true,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: true,
    });
  });

  const connectWith = (extra: object) =>
    new Promise<string>((resolve) => {
      const socket = tlsConnect({ ...defaultTlsOptions(localTarget()), port: tlsPort, ...extra });
      socket.on('secureConnect', () => {
        socket.destroy();
        resolve('CONNECTED');
      });
      socket.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'UNKNOWN'));
    });

  it('an untrusted certificate fails, after SNI with the allowlisted hostname, through the pinned lookup', async () => {
    serverNames.length = 0;
    expect(await connectWith({})).toMatch(
      /^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/,
    );
    expect(serverNames).toEqual(['www.sec.gov']);
  });

  it('a trusted certificate for another name still fails hostname verification (test-only CA)', async () => {
    expect(await connectWith({ ca: cert })).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
  });

  it('the transport (through its per-request agent) maps a TLS verification failure to TLS, after SNI', async () => {
    serverNames.length = 0;
    const transport = createNodeSecTransport({
      socketFactory: (target) => tlsConnect({ ...defaultTlsOptions(target), port: tlsPort }),
    });
    const outcome = await transport.request({
      host: localPin,
      path: '/',
      headers: HEADERS,
      maxBytes: 10,
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({ ok: false, failure: 'TLS' });
    expect(serverNames).toEqual(['www.sec.gov']);
  });

  it('a trusted certificate for another name still fails hostname verification through the agent', async () => {
    const transport = createNodeSecTransport({
      socketFactory: (target) => tlsConnect({ ...defaultTlsOptions(target), port: tlsPort, ca: cert }),
    });
    const outcome = await transport.request({
      host: localPin,
      path: '/',
      headers: HEADERS,
      maxBytes: 10,
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({ ok: false, failure: 'TLS' });
  });
});

describe('SecClient end to end through the node transport (local server, fake public DNS)', () => {
  function client(timeoutMs = 5_000) {
    const sink = recordingSink();
    const resilience = createResilientCall({
      clock: systemClock,
      sleeper: systemSleeper,
      random: () => 0,
      logger: createLogger({ clock: systemClock, sink: () => undefined }),
      retry: { ...DEFAULT_RETRY, maxRetries: 0 },
      circuit: DEFAULT_CIRCUIT,
    });
    const secClient = createSecClient({
      guard: createSecUrlGuard({ resolver: hostResolver(PUBLIC_DNS), sink, clock: systemClock }),
      transport: createNodeSecTransport({ socketFactory: localFactory }),
      limiter: createSecRateLimiter({
        clock: systemClock,
        sleeper: systemSleeper,
        maxPerWindow: 10,
        windowMs: 1000,
      }),
      resilience,
      clock: systemClock,
      sleeper: systemSleeper,
      userAgent: TEST_USER_AGENT,
      limits: { timeoutMs, maxResponseBytes: 100, maxRedirects: 3 },
    });
    return { secClient, sink };
  }

  it('follows a validated redirect to the other host with its own Host header', async () => {
    handler = (request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { Location: 'https://data.sec.gov/final', 'Set-Cookie': 'session=TEST' });
        response.end();
        return;
      }
      response.end('done');
    };
    const { secClient } = client();
    const result = await secClient.getText('https://www.sec.gov/start');
    expect(result.ok && new TextDecoder().decode(result.value.body)).toBe('done');
    expect(seen.map((s) => [s.url, s.rawHeaders[1]])).toEqual([
      ['/start', 'www.sec.gov'],
      ['/final', 'data.sec.gov'],
    ]);
    // No cookie or authorization is ever sent, even after a Set-Cookie.
    expect(
      seen.flatMap((s) => s.rawHeaders.filter((_v, i) => i % 2 === 0).map((n) => n.toLowerCase())),
    ).not.toContain('cookie');
  });

  it('a redirect to a non-SEC host is rejected and never reaches any server', async () => {
    handler = (_request, response) => {
      response.writeHead(302, { Location: 'https://evil.example/LEAKME' });
      response.end();
    };
    const { secClient, sink } = client();
    const result = await secClient.getText('https://www.sec.gov/start');
    expect(!result.ok && result.error).toMatchObject({
      code: 'SEC_URL_REJECTED',
      reason: 'HOST_NOT_ALLOWED',
    });
    expect(seen).toHaveLength(1);
    expect(JSON.stringify([result, sink.events])).not.toContain('LEAKME');
  });

  it('AT-SEC-13 end to end: an oversized body is SEC_RESPONSE_TOO_LARGE', async () => {
    handler = (_request, response) => response.end(Buffer.alloc(500));
    const { secClient } = client();
    const result = await secClient.getText('https://www.sec.gov/big');
    expect(!result.ok && result.error.code).toBe('SEC_RESPONSE_TOO_LARGE');
  });

  it('AT-SEC-14 end to end: a stalled server is SEC_TIMEOUT within the overall deadline', async () => {
    handler = (_request, response) => {
      response.writeHead(200);
      response.write('a');
    };
    const { secClient } = client(300);
    const started = performance.now();
    const result = await secClient.getText('https://www.sec.gov/slow');
    expect(!result.ok && result.error.code).toBe('SEC_TIMEOUT');
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe('production DNS adapter', () => {
  it('maps resolver results and error codes', async () => {
    const failing = (code: string) => Promise.reject(Object.assign(new Error('dns'), { code }));
    expect(await toDnsFamilyAnswer(Promise.resolve(['8.8.8.8']))).toEqual({
      status: 'RECORDS',
      addresses: ['8.8.8.8'],
    });
    expect(await toDnsFamilyAnswer(Promise.resolve([]))).toEqual({ status: 'RECORDS', addresses: [] });
    expect(await toDnsFamilyAnswer(failing('ENODATA'))).toEqual({ status: 'NO_DATA' });
    expect(await toDnsFamilyAnswer(failing('ENOTFOUND'))).toEqual({ status: 'NOT_FOUND' });
    for (const code of ['ETIMEOUT', 'ECANCELLED']) {
      expect(await toDnsFamilyAnswer(failing(code))).toEqual({ status: 'TIMEOUT' });
    }
    for (const code of ['ESERVFAIL', 'EREFUSED', 'ECONNREFUSED', 'EBADRESP', 'EFORMERR']) {
      expect(await toDnsFamilyAnswer(failing(code))).toEqual({ status: 'ERROR' });
    }
    expect(await toDnsFamilyAnswer(Promise.reject(new Error('no code')))).toEqual({ status: 'ERROR' });
  });

  it('rejects an invalid timeout', () => {
    for (const timeoutMs of [0, -1, 1.5, 2_147_483_648]) {
      expect(() => createNodeSecDnsResolver({ timeoutMs })).toThrow(RangeError);
    }
  });
});

describe('production DNS adapter against a local DNS server', () => {
  type Mode = 'SILENT' | 'SERVFAIL' | 'NXDOMAIN' | 'NODATA' | 'A';
  let dnsServer: Socket;
  let dnsPort = 0;
  let mode: Mode = 'SILENT';
  let queries = 0;

  /** A minimal DNS response to `query`: header, the question only, and an optional A record. */
  function reply(query: Buffer, rcode: number, answer?: readonly number[]): Buffer {
    let end = 12;
    while (end < query.length && query[end] !== 0) {
      end += (query[end] ?? 0) + 1;
    }
    end += 5; // root label, QTYPE, QCLASS
    const header = Buffer.from(query.subarray(0, 12));
    header[2] = 0x81; // QR, RD
    header[3] = 0x80 | rcode; // RA, RCODE
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(answer === undefined ? 0 : 1, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);
    const record =
      answer === undefined
        ? Buffer.alloc(0)
        : Buffer.from([0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0, 0, 0, 60, 0x00, 0x04, ...answer]);
    return Buffer.concat([header, query.subarray(12, end), record]);
  }

  beforeAll(async () => {
    dnsServer = createSocket('udp4');
    dnsServer.on('message', (message, remote) => {
      queries += 1;
      const send = (response: Buffer): void => {
        dnsServer.send(response, remote.port, remote.address);
      };
      switch (mode) {
        case 'SILENT':
          return;
        case 'SERVFAIL':
          send(reply(message, 2));
          return;
        case 'NXDOMAIN':
          send(reply(message, 3));
          return;
        case 'NODATA':
          send(reply(message, 0));
          return;
        case 'A':
          send(reply(message, 0, [8, 8, 8, 8]));
          return;
      }
    });
    await new Promise<void>((resolve) => dnsServer.bind(0, '127.0.0.1', resolve));
    dnsPort = dnsServer.address().port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => dnsServer.close(() => resolve()));
  });

  const resolverFor = () =>
    createNodeSecDnsResolver({ timeoutMs: 30_000, servers: [`127.0.0.1:${dnsPort}`] });

  it.each([
    ['A', { status: 'RECORDS', addresses: ['8.8.8.8'] }],
    ['NODATA', { status: 'NO_DATA' }],
    ['NXDOMAIN', { status: 'NOT_FOUND' }],
    ['SERVFAIL (a genuine failure)', { status: 'ERROR' }],
  ] as const)('maps a %s response', async (label, expected) => {
    mode = label.split(' ')[0] as Mode;
    const answer = await resolverFor().resolve('www.sec.gov', 4, {
      signal: new AbortController().signal,
      timeoutMs: 5_000,
    });
    expect(answer).toEqual(expected);
  });

  it('uses the remaining deadline as its timeout: a silent server is TIMEOUT, not ERROR', async () => {
    mode = 'SILENT';
    const started = performance.now();
    const answer = await resolverFor().resolve('www.sec.gov', 4, {
      signal: new AbortController().signal,
      timeoutMs: 200,
    });
    expect(answer).toEqual({ status: 'TIMEOUT' });
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('cancels the lookup when the deadline signal aborts: TIMEOUT, promptly', async () => {
    mode = 'SILENT';
    const controller = new AbortController();
    const started = performance.now();
    const pending = resolverFor().resolve('www.sec.gov', 6, { signal: controller.signal, timeoutMs: 30_000 });
    setTimeout(() => controller.abort(), 50);
    expect(await pending).toEqual({ status: 'TIMEOUT' });
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('an already aborted signal is TIMEOUT without any query', async () => {
    const before = queries;
    const controller = new AbortController();
    controller.abort();
    expect(
      await resolverFor().resolve('www.sec.gov', 4, { signal: controller.signal, timeoutMs: 1_000 }),
    ).toEqual({
      status: 'TIMEOUT',
    });
    expect(queries).toBe(before);
  });

  it('through the guard: a resolver timeout is SEC_DNS_TIMEOUT and never a DNS_FAILED event, even later', async () => {
    mode = 'SILENT';
    const sink = recordingSink();
    const guard = createSecUrlGuard({ resolver: resolverFor(), sink, clock: systemClock });
    const url = guard.validate('https://www.sec.gov/');
    if (!url.ok) {
      throw new Error('fixture must validate');
    }
    const result = await guard.resolveAndCheck(url.value, {
      signal: new AbortController().signal,
      timeoutMs: 200,
    });
    expect(!result.ok && result.error.code).toBe('SEC_DNS_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sink.events).toEqual([]);
  });

  it('through the guard: a genuine SERVFAIL within the deadline is DNS_FAILED with its event', async () => {
    mode = 'SERVFAIL';
    const sink = recordingSink();
    const guard = createSecUrlGuard({ resolver: resolverFor(), sink, clock: systemClock });
    const url = guard.validate('https://www.sec.gov/');
    if (!url.ok) {
      throw new Error('fixture must validate');
    }
    const result = await guard.resolveAndCheck(url.value, {
      signal: new AbortController().signal,
      timeoutMs: 5_000,
    });
    expect(!result.ok && result.error).toMatchObject({ code: 'SEC_URL_REJECTED', reason: 'DNS_FAILED' });
    expect(sink.events.map((event) => event.reason)).toEqual(['DNS_FAILED']);
  });
});

describe('no socket reuse: one dedicated agent and one new connection per request', () => {
  it('the agent options keep nothing for reuse; a second connection is refused', () => {
    const agent = new NoReuseAgent(() => netConnect(port, '127.0.0.1'));
    expect(NO_REUSE_AGENT_OPTIONS).toEqual({
      keepAlive: false,
      maxSockets: 1,
      maxFreeSockets: 1,
      maxCachedSessions: 0,
    });
    // Node's runtime fields (not all are in @types/node).
    const runtime = agent as unknown as { keepAlive: boolean; maxCachedSessions: number };
    expect(runtime.keepAlive).toBe(false);
    expect(runtime.maxCachedSessions).toBe(0);
    expect(agent.maxSockets).toBe(1);
    expect(agent.maxFreeSockets).toBe(1);
    const first = agent.createConnection();
    expect(() => agent.createConnection()).toThrow('NoReuseAgent opens one connection only.');
    first.destroy();
    agent.destroy();
  });

  /** Server-side view: requests served per socket, and sockets closed. */
  function trackSockets() {
    const perSocket = new Map<object, number>();
    const closed = new Set<object>();
    const onRequest = (request: IncomingMessage): void => {
      perSocket.set(request.socket, (perSocket.get(request.socket) ?? 0) + 1);
      request.socket.once('close', () => closed.add(request.socket));
    };
    server.on('request', onRequest);
    return { perSocket, closed, stop: () => server.off('request', onRequest) };
  }

  /** The server invites reuse: keep-alive responses with a long timeout. */
  const keepAlive =
    (status: number, headers: Record<string, string> = {}): Handler =>
    (_request, response) => {
      response.writeHead(status, { Connection: 'keep-alive', 'Keep-Alive': 'timeout=60', ...headers });
      response.end('x');
    };

  it('sequential requests never share a socket or an agent, even when the server offers keep-alive', async () => {
    handler = keepAlive(200);
    const agents: NoReuseAgent[] = [];
    const tracked = trackSockets();
    const transport = createNodeSecTransport({
      socketFactory: localFactory,
      onAgent: (agent) => agents.push(agent),
    });
    const globalSpy = vi.spyOn(globalAgent as unknown as { addRequest: () => void }, 'addRequest');
    try {
      for (let i = 0; i < 4; i += 1) {
        const outcome = await transport.request({
          host: await resolved(),
          path: '/',
          headers: HEADERS,
          maxBytes: 10,
          signal: new AbortController().signal,
        });
        expect(outcome.ok).toBe(true);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(connections).toBe(4);
      expect([...tracked.perSocket.values()]).toEqual([1, 1, 1, 1]);
      expect(tracked.closed.size).toBe(4);
      expect(new Set(agents).size).toBe(4);
      for (const agent of agents) {
        expect(agent.opened).toBe(1);
        expect(Object.keys(agent.sockets)).toEqual([]);
        expect(Object.keys(agent.freeSockets)).toEqual([]);
      }
      expect(globalSpy).not.toHaveBeenCalled();
    } finally {
      globalSpy.mockRestore();
      tracked.stop();
    }
  });

  function clientWith(agents: NoReuseAgent[], maxRetries: number) {
    return createSecClient({
      guard: createSecUrlGuard({
        resolver: hostResolver(PUBLIC_DNS),
        sink: recordingSink(),
        clock: systemClock,
      }),
      transport: createNodeSecTransport({
        socketFactory: localFactory,
        onAgent: (agent) => agents.push(agent),
      }),
      limiter: createSecRateLimiter({
        clock: systemClock,
        sleeper: systemSleeper,
        maxPerWindow: 10,
        windowMs: 1000,
      }),
      resilience: createResilientCall({
        clock: systemClock,
        sleeper: systemSleeper,
        random: () => 0,
        logger: createLogger({ clock: systemClock, sink: () => undefined }),
        retry: { ...DEFAULT_RETRY, maxRetries },
        circuit: DEFAULT_CIRCUIT,
      }),
      clock: systemClock,
      sleeper: systemSleeper,
      userAgent: TEST_USER_AGENT,
      limits: { timeoutMs: 5_000, maxResponseBytes: 100, maxRedirects: 3 },
    });
  }

  it('retries never reuse the failed attempt’s socket', async () => {
    let served = 0;
    handler = (request, response) => {
      served += 1;
      (served < 3 ? keepAlive(503, { 'Retry-After': '0' }) : keepAlive(200))(request, response);
    };
    const agents: NoReuseAgent[] = [];
    const tracked = trackSockets();
    try {
      const result = await clientWith(agents, 3).getText('https://www.sec.gov/retry');
      expect(result.ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(served).toBe(3);
      expect(connections).toBe(3);
      expect([...tracked.perSocket.values()]).toEqual([1, 1, 1]);
      expect(tracked.closed.size).toBe(3);
      expect(new Set(agents).size).toBe(3);
    } finally {
      tracked.stop();
    }
  });

  it('redirect hops never reuse a socket, even to the same host', async () => {
    handler = (request, response) => {
      if (request.url === '/a') {
        keepAlive(302, { Location: '/b' })(request, response);
      } else if (request.url === '/b') {
        keepAlive(301, { Location: 'https://data.sec.gov/c' })(request, response);
      } else {
        keepAlive(200)(request, response);
      }
    };
    const agents: NoReuseAgent[] = [];
    const tracked = trackSockets();
    try {
      const result = await clientWith(agents, 0).getText('https://www.sec.gov/a');
      expect(result.ok && result.value.finalUrl).toBe('https://data.sec.gov/c');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(seen.map((s) => s.url)).toEqual(['/a', '/b', '/c']);
      expect(connections).toBe(3);
      expect([...tracked.perSocket.values()]).toEqual([1, 1, 1]);
      expect(tracked.closed.size).toBe(3);
      expect(new Set(agents).size).toBe(3);
    } finally {
      tracked.stop();
    }
  });
});

describe('static: test seam, proxies, cookies, authorization', () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
    });
  const files = sources(repoPath('src')).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

  it('the test-only seams (socketFactory, onAgent) appear only in the adapter', () => {
    for (const seam of ['socketFactory', 'onAgent']) {
      const users = files.filter((file) => file.text.includes(seam)).map((file) => file.path);
      expect(users, seam).toEqual([join(repoPath('src'), 'adapters', 'sec', 'nodeSecTransport.ts')]);
    }
  });

  it('the SEC transport never uses a global or default agent', () => {
    const transport = files.find((file) => file.path.endsWith('nodeSecTransport.ts'))?.text ?? '';
    expect(transport).not.toMatch(/agent:\s*(false|undefined|null)|=\s*globalAgent|globalAgent\./);
    expect(transport).toMatch(/agent,\n/);
  });

  it('no source reads proxy settings', () => {
    for (const { path, text } of files) {
      expect(/(HTTPS?|NO|ALL)_PROXY/i.test(text), path).toBe(false);
    }
  });

  it('the SEC client and adapters never set cookies or authorization', () => {
    for (const { path, text } of files.filter((file) => /[\\/](sec)[\\/]/.test(file.path))) {
      expect(/['"](cookie|authorization)['"]\s*:/i.test(text), path).toBe(false);
    }
  });
});
