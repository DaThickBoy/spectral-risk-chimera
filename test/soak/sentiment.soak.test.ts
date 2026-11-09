// Task 25.2: scheduled soak runs (not in `npm test`): a five-minute real-time emission cadence run
// and a WebSocket flood run against a local wss:// server. Run with `npm run soak`; CI runs it on a
// schedule (.github/workflows/soak.yml). Results are written to the gitignored bench-results/.
// Tests: AT-CAD-07, AT-PRV-07
// Validates: Requirements 10.5, 33.5
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';
import { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { createWsStreamTransport } from '../../src/adapters/ws/index.js';
import {
  createSentimentEmitter,
  createSentimentState,
  createSentimentStream,
} from '../../src/sentiment/index.js';
import { brandDecimalString, createLogger, systemClock, systemSleeper } from '../../src/shared/index.js';
import type { SentimentIndex } from '../../src/shared/index.js';
import { repoPath } from '../helpers/repo.js';
import { latestRealDouble } from '../helpers/sentimentAggregatorDouble.js';
import { benchMessage, environmentRecord, writeRecord } from '../helpers/streamHarness.js';

const SOAK_MS = Number.parseInt(process.env['SOAK_DURATION_MS'] ?? '300000', 10); // run length, not a financial value

it('AT-CAD-07: real-time emission cadence over five minutes', async () => {
  const state = createSentimentState({
    clock: systemClock,
    maxAgeSeconds: 900,
    maxFutureSkewSeconds: 5,
    windowSeconds: 300,
    historyLimit: 1000,
    aggregator: latestRealDouble,
  });
  const times: number[] = [];
  const emitter = createSentimentEmitter({
    clock: systemClock,
    sleeper: systemSleeper,
    state,
    emit: (_updates, at) => times.push(at),
    onError: () => undefined,
  });
  const controller = new AbortController();
  const running = emitter.run(controller.signal);
  let i = 0;
  const feeder = setInterval(
    () => {
      i += 1;
      const now = systemClock.nowUtc().toISOString();
      state.record({
        provider: 'soak',
        sourceKind: 'REAL',
        ticker: 'AAA',
        value: brandDecimalString(`0.${String(i % 100).padStart(2, '0')}`) as SentimentIndex,
        observedAt: now,
        receivedAt: now,
        messageId: `s-${i}`,
      });
    },
    700 + Math.floor(Math.random() * 600),
  );
  await new Promise((resolve) => setTimeout(resolve, SOAK_MS));
  clearInterval(feeder);
  controller.abort();
  await running;
  const deviations = times
    .slice(1)
    .map((t, k) => Math.abs(t - (times[k] ?? t) - 3000))
    .sort((a, b) => a - b);
  const p95 = deviations[Math.ceil(0.95 * deviations.length) - 1] ?? Number.POSITIVE_INFINITY;
  const file = writeRecord('soak-cadence', {
    test: 'AT-CAD-07',
    durationMs: String(SOAK_MS),
    emissions: times.length,
    p95DeviationMs: p95.toFixed(3),
    environment: environmentRecord(),
    recordedAt: new Date().toISOString(),
  });
  process.stdout.write(`Cadence soak p95 |interval - 3000| = ${p95.toFixed(3)} ms; record: ${file}\n`);
  expect(p95).toBeLessThanOrEqual(500);
}, 900_000);

it('AT-PRV-07 (soak): a wss:// flood keeps the queue bounded and counts drops', async () => {
  const cert = readFileSync(repoPath('test', 'fixtures', 'tls', 'untrusted-localhost.cert.pem'));
  const key = readFileSync(repoPath('test', 'fixtures', 'tls', 'untrusted-localhost.key.pem'));
  const original = tls.getCACertificates('default');
  tls.setDefaultCACertificates([...original, cert.toString('utf8')]); // test-only trust of the local server
  const server = createServer({ key, cert });
  const wss = new WebSocketServer({ server, perMessageDeflate: false });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const maxQueueSize = 100;
  let maxObserved = 0;
  let accepted = 0;
  let sunk = 0;
  const state = createSentimentState({
    clock: systemClock,
    maxAgeSeconds: 900,
    maxFutureSkewSeconds: 5,
    windowSeconds: 300,
    historyLimit: 1000,
  });
  const stream = createSentimentStream({
    provider: { name: 'soak-ws', kind: 'REAL' },
    transport: createWsStreamTransport({
      url: `wss://localhost:${port}/`,
      maxPayloadBytes: 4096,
      handshakeTimeoutMs: 5000,
    }),
    decode: (text) => JSON.parse(text) as unknown, // test decoder; real adapters use the lossless parser (13.8)
    clock: systemClock,
    sleeper: systemSleeper,
    random: Math.random,
    logger: createLogger({ clock: systemClock, sink: () => undefined }),
    reconnect: { initialDelaySeconds: 1, maxDelaySeconds: 5, maxAttempts: 3, jitter: true },
    maxQueueSize,
    sink: (o) => {
      sunk += 1;
      maxObserved = Math.max(maxObserved, stream.queueSize);
      if (state.record(o) === 'ACCEPTED') {
        accepted += 1;
      }
    },
    onRejected: () => undefined,
    onStatus: () => undefined,
  });
  const sent = 50_000;
  wss.on('connection', (socket) => {
    const observedAt = new Date().toISOString();
    for (let i = 0; i < sent; i += 1) {
      socket.send(benchMessage(i, observedAt));
    }
  });
  const controller = new AbortController();
  const running = stream.run(controller.signal);
  const deadline = Date.now() + 60_000;
  while (sunk + stream.coalescedCount + stream.droppedCount < sent && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  controller.abort();
  await running;
  for (const client of wss.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  tls.setDefaultCACertificates(original);
  const file = writeRecord('soak-flood', {
    test: 'AT-PRV-07',
    sent,
    accepted,
    droppedCount: stream.droppedCount,
    coalescedCount: stream.coalescedCount,
    delivered: sunk,
    maxQueueSize,
    maxObservedQueueSize: maxObserved,
    environment: environmentRecord(),
    recordedAt: new Date().toISOString(),
  });
  process.stdout.write(
    `Flood soak: dropped ${stream.droppedCount}, max queue ${maxObserved}; record: ${file}\n`,
  );
  expect(maxObserved).toBeLessThanOrEqual(maxQueueSize);
  // Every received message is delivered, coalesced into a newer one, or counted as dropped.
  expect(sunk + stream.coalescedCount + stream.droppedCount).toBe(sent);
  expect(accepted).toBeGreaterThan(0);
}, 120_000);
