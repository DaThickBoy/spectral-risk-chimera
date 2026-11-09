// Task 15.1: the /stream WebSocket gateway over a real loopback server and a local `ws` client.
// A client receives sentiment emissions and risk updates as they occur; Origin, query, rate
// limits, the AuthGuard, capacity, and inbound frames are checked before or after the upgrade;
// a slow client is dropped instead of growing memory.
// Validates: Requirements 10.5, 16.7, 17.10, 25.1, 26.9, 29.4
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createStreamHub, listenApiServer, streamRoutes } from '../../src/api/index.js';
import type { AuthGuard, RateLimits, StreamHub } from '../../src/api/index.js';
import { providerStatusEvent, riskUpdateEvent, sentimentUpdateEvents } from '../../src/app/index.js';
import { createSentimentEmitter, createSentimentState } from '../../src/sentiment/index.js';
import { FakeClock, FakeSleeper, StreamEventSchema, brandDecimalString } from '../../src/shared/index.js';
import type { SentimentIndex, StreamEvent } from '../../src/shared/index.js';
import { jsonNumbers, testServer } from '../helpers/api.js';
import { completeTestConfig, withKey } from '../helpers/config.js';
import { PF, cleanSeries, riskHarness } from '../helpers/riskService.js';
import { latestRealDouble } from '../helpers/sentimentAggregatorDouble.js';

const ORIGIN = 'http://127.0.0.1:5173';
const T0 = '2026-11-08T12:00:00.000Z';

interface Opened {
  readonly kind: 'OPEN';
  readonly ws: WebSocket;
  readonly messages: StreamEvent[];
  readonly closed: Promise<number>;
}
interface Refused {
  readonly kind: 'REFUSED';
  readonly status: number;
  readonly body: string;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function gateway(
  options: {
    hub?: Partial<{ maxClients: number; maxBufferedBytes: number }>;
    rateLimits?: RateLimits;
    guard?: AuthGuard;
  } = {},
) {
  // Listening requires the request guard (Gateway rule 9), with the same origin list as /stream.
  const server = testServer([], options.guard, {
    rateLimits: options.rateLimits ?? { perMinute: 1000, uploadPerMinute: 10 },
    requestGuard: { allowedOrigins: [ORIGIN] },
  });
  const hub = createStreamHub({
    logger: server.logger,
    maxClients: options.hub?.maxClients ?? 8,
    maxBufferedBytes: options.hub?.maxBufferedBytes ?? 1_048_576,
  });
  streamRoutes({ hub, logger: server.logger, allowedOrigins: [ORIGIN] })(server.app);
  const address = await listenApiServer(server.app, { host: '127.0.0.1', port: 0 });
  cleanups.push(() => server.app.close());
  const base = address.replace(/^http/, 'ws');
  return { ...server, hub, base };
}

/** `origin: null` sends no Origin header. */
function connect(url: string, origin: string | null = ORIGIN): Promise<Opened | Refused> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin === null ? {} : { origin });
    const messages: StreamEvent[] = [];
    const closed = new Promise<number>((done) => ws.on('close', (code) => done(code)));
    ws.on('message', (data) => {
      messages.push(StreamEventSchema.parse(JSON.parse(String(data))));
    });
    ws.on('open', () => resolve({ kind: 'OPEN', ws, messages, closed }));
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      res.on('end', () => resolve({ kind: 'REFUSED', status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    ws.on('error', () => undefined); // a refused upgrade also emits an error after the response
  });
}

async function open(url: string): Promise<Opened> {
  const result = await connect(url);
  if (result.kind !== 'OPEN') {
    throw new Error(`expected an open socket, got ${result.status}`);
  }
  cleanups.push(async () => {
    result.ws.terminate();
  });
  return result;
}

const until = async (check: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error('condition not reached');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const waitForClients = (hub: StreamHub, n: number) => until(() => hub.clientCount === n);

describe('15.1 /stream delivers events as they occur', () => {
  it('a client receives sentiment emissions (13.6 emitter) and risk updates; values are decimal strings', async () => {
    const g = await gateway();
    const client = await open(`${g.base}/stream`);
    await waitForClients(g.hub, 1);

    const clock = new FakeClock(T0, 1_000);
    const state = createSentimentState({
      clock,
      maxAgeSeconds: 10,
      maxFutureSkewSeconds: 5,
      windowSeconds: 10,
      historyLimit: 100,
      aggregator: latestRealDouble,
    });
    const emitter = createSentimentEmitter({
      clock,
      sleeper: new FakeSleeper(clock),
      state,
      emit: (updates) => {
        for (const event of sentimentUpdateEvents(updates)) {
          expect(g.hub.publish(event)).toEqual({ ok: true, delivered: 1, dropped: 0 });
        }
      },
      onError: (error) => {
        throw error;
      },
    });
    state.record({
      provider: 'p1',
      sourceKind: 'REAL',
      ticker: 'AAA',
      value: brandDecimalString('-0.6001') as SentimentIndex,
      observedAt: T0,
      receivedAt: T0,
    });
    emitter.tick();
    await until(() => client.messages.length === 1);
    expect(client.messages[0]).toMatchObject({
      type: 'SentimentUpdate',
      ticker: 'AAA',
      index: { value: '-0.6001', source: 'p1', status: 'CURRENT' },
      latest: { value: '-0.6001', provider: 'p1', sourceKind: 'REAL' },
    });

    const SMALL = withKey(withKey(completeTestConfig(), 'var.lookbackReturns', 3), 'var.minObservations', 2);
    const h = riskHarness({ AAA: ['USD', '10'] }, { values: SMALL, prices: { AAA: { price: '100' } } });
    h.putSeries(cleanSeries('AAA', ['100', '110', '99', '108.9'], { start: '2026-11-03' }));
    await h.service.calculate(PF);
    const view = h.service.view(PF);
    expect(view).toBeDefined();
    if (view === undefined) return;
    expect(g.hub.publish(riskUpdateEvent(PF, view))).toMatchObject({ ok: true, delivered: 1 });
    await until(() => client.messages.length === 2);
    const risk = client.messages[1];
    expect(risk).toMatchObject({
      type: 'RiskUpdate',
      portfolioId: PF,
      risk: {
        baseVaR: { validity: 'CURRENT', value: { absolute: '80' } },
        adjustedVaR: { validity: 'UNAVAILABLE', value: null },
      },
    });
    // Only integer counts and versions may be JSON numbers in a risk payload.
    expect(jsonNumbers(risk).sort()).toEqual(
      [
        '$.risk.configVersion.seq',
        '$.risk.horizonDays',
        '$.risk.lookbackReturns',
        '$.risk.observations',
      ].sort(),
    );
  });

  it('provider status events reach every connected client', async () => {
    const g = await gateway();
    const a = await open(`${g.base}/stream`);
    const b = await open(`${g.base}/stream`);
    await waitForClients(g.hub, 2);
    const event = providerStatusEvent([
      {
        provider: 'sentiment:test-ws',
        state: 'DEGRADED',
        circuit: 'CLOSED',
        since: T0,
        lastErrorCode: 'TIMEOUT',
      },
    ]);
    expect(g.hub.publish(event)).toEqual({ ok: true, delivered: 2, dropped: 0 });
    await until(() => a.messages.length === 1 && b.messages.length === 1);
    expect(a.messages[0]).toEqual(event);
  });
});

describe('15.1 checks before the upgrade', () => {
  it.each([
    ['no Origin header', null],
    ['another origin', 'http://evil.example'],
    ['a different port on the allowed host', 'http://127.0.0.1:5174'],
  ])('%s is 403 ORIGIN_FORBIDDEN and no client is added', async (_name, origin) => {
    const g = await gateway();
    const result = await connect(`${g.base}/stream`, origin);
    expect(result).toMatchObject({ kind: 'REFUSED', status: 403 });
    if (result.kind === 'REFUSED') {
      expect(JSON.parse(result.body)).toMatchObject({ error: { code: 'ORIGIN_FORBIDDEN' } });
    }
    expect(g.hub.clientCount).toBe(0);
  });

  it('an unknown query parameter is 400 VALIDATION_FAILED', async () => {
    const g = await gateway();
    const result = await connect(`${g.base}/stream?portfolio=x`);
    expect(result).toMatchObject({ kind: 'REFUSED', status: 400 });
    expect(g.hub.clientCount).toBe(0);
  });

  it('connection attempts are rate limited (429 RATE_LIMITED with Retry-After)', async () => {
    const g = await gateway({ rateLimits: { perMinute: 2, uploadPerMinute: 1 } });
    await open(`${g.base}/stream`);
    await open(`${g.base}/stream`);
    const third = await connect(`${g.base}/stream`);
    expect(third).toMatchObject({ kind: 'REFUSED', status: 429 });
    if (third.kind === 'REFUSED') {
      expect(JSON.parse(third.body)).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    }
  });

  it('the AuthGuard pre-handler runs on the upgrade and can deny it', async () => {
    const guard: AuthGuard = {
      name: 'deny-all',
      preHandler: async (request, reply) => {
        await reply
          .code(403)
          .type('application/json')
          .send({
            error: { code: 'FORBIDDEN', message: 'Denied.', correlationId: request.id },
          });
      },
    };
    const g = await gateway({ guard });
    const result = await connect(`${g.base}/stream`);
    expect(result).toMatchObject({ kind: 'REFUSED', status: 403 });
    if (result.kind === 'REFUSED') {
      expect(JSON.parse(result.body)).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
    expect(g.hub.clientCount).toBe(0);
  });

  it('beyond maxClients the upgrade is 503 STREAM_CAPACITY', async () => {
    const g = await gateway({ hub: { maxClients: 1 } });
    await open(`${g.base}/stream`);
    await waitForClients(g.hub, 1);
    const second = await connect(`${g.base}/stream`);
    expect(second).toMatchObject({ kind: 'REFUSED', status: 503 });
    expect(g.hub.clientCount).toBe(1);
  });

  it('an upgrade to another path is refused and its socket is closed', async () => {
    const g = await gateway();
    const result = await connect(`${g.base}/nowhere`);
    expect(result).toMatchObject({ kind: 'REFUSED', status: 404 });
  });

  it('streamRoutes refuses an empty or malformed origin list', () => {
    const hub = createStreamHub({ logger: testServer().logger, maxClients: 1, maxBufferedBytes: 1024 });
    const logger = testServer().logger;
    expect(() => streamRoutes({ hub, logger, allowedOrigins: [] })).toThrow(TypeError);
    expect(() => streamRoutes({ hub, logger, allowedOrigins: ['*'] })).toThrow(TypeError);
    expect(() => streamRoutes({ hub, logger, allowedOrigins: ['http://a.example/path'] })).toThrow(TypeError);
    expect(() => streamRoutes({ hub, logger, allowedOrigins: ['ws://a.example'] })).toThrow(TypeError);
  });
});

describe('15.1 inbound frames and slow clients', () => {
  it('a client message closes the connection with 1008 and removes the client', async () => {
    const g = await gateway();
    const client = await open(`${g.base}/stream`);
    await waitForClients(g.hub, 1);
    client.ws.send('{"subscribe":"everything"}');
    expect(await client.closed).toBe(1008);
    await waitForClients(g.hub, 0);
  });

  it('a frame above STREAM_MAX_INBOUND_BYTES is refused with 1009', async () => {
    const g = await gateway();
    const client = await open(`${g.base}/stream`);
    await waitForClients(g.hub, 1);
    client.ws.send('x'.repeat(4096));
    expect(await client.closed).toBe(1009);
    await waitForClients(g.hub, 0);
  });

  it('a client that stops reading is dropped once its unsent bytes reach the limit', async () => {
    const maxBufferedBytes = 65_536;
    const g = await gateway({ hub: { maxBufferedBytes } });
    const slow = await open(`${g.base}/stream`);
    const fast = await open(`${g.base}/stream`);
    await waitForClients(g.hub, 2);
    (slow.ws as unknown as { _socket: Socket })._socket.pause(); // stop reading: the kernel buffers fill up
    const providers = Array.from({ length: 200 }, (_, i) => ({
      provider: `marketdata:p${String(i).padStart(4, '0')}`,
      state: 'AVAILABLE' as const,
      circuit: 'CLOSED' as const,
      since: T0,
    }));
    let dropped = 0;
    let published = 0;
    for (; published < 5000 && dropped === 0; published += 1) {
      const result = g.hub.publish(providerStatusEvent(providers));
      expect(result.ok).toBe(true);
      if (result.ok) dropped += result.dropped;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(dropped).toBe(1);
    expect(g.hub.clientCount).toBe(1);
    await until(() => fast.messages.length === published);
    expect(g.lines.some((line) => line.msg === 'stream.client_dropped' && line.reason === 'SLOW')).toBe(true);
  });
});
