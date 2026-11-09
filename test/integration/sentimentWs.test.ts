// Task 13.2: the wss:// sentiment transport against a real local WSS server (ws@8.22.2) using the
// committed test-only certificate in test/fixtures/tls/. The production transport has no CA option:
// the trusted-server cases add the test certificate to this test process's default CA store
// (tls.setDefaultCACertificates) and restore it afterwards.
// Tests: AT-PRV-04, AT-SEC-23 (WebSocket part)
// Validates: Requirements 9.2, 24.8, 33.5
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { Server } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWsStreamTransport } from '../../src/adapters/ws/index.js';
import type { StreamHandlers } from '../../src/sentiment/index.js';
import { repoPath } from '../helpers/repo.js';

const cert = readFileSync(repoPath('test', 'fixtures', 'tls', 'untrusted-localhost.cert.pem'));
const key = readFileSync(repoPath('test', 'fixtures', 'tls', 'untrusted-localhost.key.pem'));
const ENV_SWITCH = ['NODE', 'TLS', 'REJECT', 'UNAUTHORIZED'].join('_');

let server: Server;
let wss: WebSocketServer;
let port = 0;
const sockets: WebSocket[] = [];
let upgrades = 0;

beforeAll(async () => {
  server = createServer({ key, cert });
  wss = new WebSocketServer({
    server,
    perMessageDeflate: false,
    verifyClient: (info: { req: IncomingMessage }) => info.req.url !== '/missing',
  });
  wss.on('connection', (socket) => {
    upgrades += 1;
    sockets.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  for (const socket of sockets) {
    socket.terminate();
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const url = (): string => `wss://localhost:${port}/stream`;

function collector() {
  const texts: string[] = [];
  let invalid = 0;
  let closed = 0;
  const handlers: StreamHandlers = {
    onText: (t) => texts.push(t),
    onInvalidMessage: () => (invalid += 1),
    onClose: () => (closed += 1),
  };
  return { handlers, texts, invalid: () => invalid, closed: () => closed };
}

const waitFor = async (condition: () => boolean, label = 'condition', ms = 3000): Promise<void> => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) {
      throw new Error(`timeout waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('wss:// transport', () => {
  it('rejects non-wss URLs and invalid limits as programmer errors', () => {
    expect(() =>
      createWsStreamTransport({ url: 'ws://localhost/x', maxPayloadBytes: 10, handshakeTimeoutMs: 10 }),
    ).toThrow(TypeError);
    expect(() => createWsStreamTransport({ url: url(), maxPayloadBytes: 0, handshakeTimeoutMs: 10 })).toThrow(
      RangeError,
    );
  });

  it('an untrusted certificate fails as TLS without opening a socket, even with the environment switch set (AT-SEC-23)', async () => {
    const before = upgrades;
    const previous = process.env[ENV_SWITCH];
    process.env[ENV_SWITCH] = '0';
    try {
      const transport = createWsStreamTransport({
        url: url(),
        maxPayloadBytes: 1024,
        handshakeTimeoutMs: 2000,
      });
      const result = await transport.connect(collector().handlers, new AbortController().signal);
      expect(result).toEqual({ ok: false, failure: 'TLS' });
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, ENV_SWITCH);
      } else {
        process.env[ENV_SWITCH] = previous;
      }
    }
    expect(upgrades).toBe(before);
  });

  describe('with the test certificate trusted by this test process', () => {
    let original: string[] = [];
    beforeAll(() => {
      original = tls.getCACertificates('default');
      tls.setDefaultCACertificates([...original, cert.toString('utf8')]);
    });
    afterAll(() => tls.setDefaultCACertificates(original));

    it('connects, receives text, reports binary and oversized messages, and sees the server close', async () => {
      const transport = createWsStreamTransport({
        url: url(),
        maxPayloadBytes: 200,
        handshakeTimeoutMs: 2000,
      });
      const c = collector();
      const result = await transport.connect(c.handlers, new AbortController().signal);
      expect(result.ok).toBe(true);
      await waitFor(() => sockets.length > 0, 'server socket');
      const socket = sockets.at(-1);
      socket?.send('{"ticker":"AAA","value":"0.1","observedAt":"2026-11-08T12:00:00Z"}');
      socket?.send(Buffer.from([1, 2, 3]), { binary: true });
      await waitFor(
        () => c.texts.length === 1 && c.invalid() === 1,
        `messages ${c.texts.length} ${c.invalid()}`,
      );
      socket?.send('x'.repeat(201)); // over maxPayload: the client closes with 1009
      await waitFor(() => c.closed() === 1, 'oversized close');
      expect(c.texts).toEqual(['{"ticker":"AAA","value":"0.1","observedAt":"2026-11-08T12:00:00Z"}']);
    });

    it('a non-101 response is REJECTED; aborting closes the connection', async () => {
      const rejecting = createWsStreamTransport({
        url: `wss://localhost:${port}/missing`,
        maxPayloadBytes: 64,
        handshakeTimeoutMs: 2000,
        headers: { 'x-test': '1' },
      });
      expect(await rejecting.connect(collector().handlers, new AbortController().signal)).toEqual({
        ok: false,
        failure: 'REJECTED',
      });
      const controller = new AbortController();
      controller.abort();
      expect(await rejecting.connect(collector().handlers, controller.signal)).toEqual({
        ok: false,
        failure: 'NETWORK',
      });
      const transport = createWsStreamTransport({
        url: url(),
        maxPayloadBytes: 64,
        handshakeTimeoutMs: 2000,
      });
      const live = new AbortController();
      const c = collector();
      const result = await transport.connect(c.handlers, live.signal);
      expect(result.ok).toBe(true);
      live.abort();
      await waitFor(() => c.closed() === 1);
    });
  });
});
