// Task 13.2: WebSocket subscription logic over a scripted transport: reconnect with backoff,
// bounded queue with coalescing and a dropped counter, invalid messages, reconnect duplicates.
// The real wss:// adapter is tested in test/integration/sentimentWs.test.ts.
// Tests: AT-PRV-04, AT-PRV-05, AT-PRV-06, AT-PRV-07, AT-SEN-23
// Validates: Requirements 9.2, 9.3, 9.4, 9.5, 9.8, 10.8, 33.5
import { describe, expect, it } from 'vitest';
import {
  createSentimentState,
  createSentimentStream,
  reconnectDelayMs,
} from '../../../src/sentiment/index.js';
import type { SentimentObservation, StreamStatus } from '../../../src/sentiment/index.js';
import { FakeClock, FakeSleeper, createLogger } from '../../../src/shared/index.js';
import { fakeTransport } from '../../helpers/fakeStream.js';
import { advanceBy } from '../../helpers/resilience.js';

const T0 = '2026-11-08T12:00:00.000Z';
const POLICY = { initialDelaySeconds: 1, maxDelaySeconds: 8, maxAttempts: 4, jitter: false };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const message = (ticker: string, value: string, observedAt = T0, messageId?: string): string =>
  JSON.stringify({ ticker, value, observedAt, ...(messageId === undefined ? {} : { messageId }) });

function setup(
  outcomes: Parameters<typeof fakeTransport>[0],
  maxQueueSize = 100,
  sinkOverride?: (o: SentimentObservation) => void,
) {
  const clock = new FakeClock(T0);
  const sleeper = new FakeSleeper(clock);
  const fake = fakeTransport(outcomes);
  const logs: Record<string, unknown>[] = [];
  const sunk: SentimentObservation[] = [];
  const rejected: string[] = [];
  const statuses: StreamStatus[] = [];
  const stream = createSentimentStream({
    provider: { name: 'test-ws', kind: 'REAL' },
    transport: fake.transport,
    decode: (text) => {
      try {
        return JSON.parse(text) as unknown; // test decoder only; real adapters use the lossless parser (13.8)
      } catch {
        return undefined;
      }
    },
    clock,
    sleeper,
    random: () => 0.5,
    logger: createLogger({
      clock,
      sink: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
      level: 'debug',
    }),
    reconnect: POLICY,
    maxQueueSize,
    sink: sinkOverride ?? ((o) => sunk.push(o)),
    onRejected: (r) => rejected.push(r.reason),
    onStatus: (s) => statuses.push(s),
  });
  return { clock, sleeper, fake, stream, logs, sunk, rejected, statuses };
}

describe('reconnect with backoff (AT-PRV-04)', () => {
  it('waits 1 s, 2 s, 4 s between failed connects and gives up after maxAttempts', async () => {
    const s = setup(['NETWORK']);
    const controller = new AbortController();
    const running = s.stream.run(controller.signal);
    const times: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      await flush();
      times.push(s.clock.monotonicMs());
      const next = s.sleeper.nextDueInMs();
      if (next !== undefined) {
        await advanceBy(s, next);
      }
    }
    expect(await running).toBe('GAVE_UP');
    expect(s.fake.calls).toHaveLength(4);
    expect(times.slice(1).map((t, i) => t - (times[i] ?? 0))).toEqual([1000, 2000, 4000]);
    expect(s.statuses.at(-1)).toBe('GAVE_UP');
  });

  it('a successful connection resets the attempts; a server close reconnects after the initial delay', async () => {
    const s = setup(['TLS', 'OPEN', 'OPEN']);
    const controller = new AbortController();
    const running = s.stream.run(controller.signal);
    await flush();
    await advanceBy(s, 1000);
    expect(s.fake.connections).toHaveLength(1);
    s.fake.connections[0]?.drop();
    await flush();
    await advanceBy(s, 1000);
    expect(s.fake.connections).toHaveLength(2);
    controller.abort();
    expect(await running).toBe('STOPPED');
    expect(s.fake.connections[1]?.closedByClient).toBe(true);
  });

  it('jitter draws a full-jitter delay below the capped exponential ceiling', () => {
    expect(reconnectDelayMs({ ...POLICY, jitter: true }, 2, () => 0.25)).toBe(1000);
    expect(reconnectDelayMs(POLICY, 10, () => 0.25)).toBe(8000);
  });
});

describe('messages', () => {
  it('valid messages reach the sink with provider and receipt time; invalid ones are reported (AT-SEN-23)', async () => {
    const s = setup(['OPEN']);
    const controller = new AbortController();
    const running = s.stream.run(controller.signal);
    await flush();
    const c = s.fake.connections[0];
    c?.send(message('AAA', '-0.5'));
    c?.send(message('AAA', '1.5'));
    c?.send('{not json');
    c?.sendInvalid();
    await flush();
    expect(s.sunk.map((o) => [o.provider, o.ticker, o.value, o.receivedAt])).toEqual([
      ['test-ws', 'AAA', '-0.5', T0],
    ]);
    expect(s.rejected).toEqual(['OUT_OF_RANGE', 'UNDECODABLE', 'BINARY_OR_OVERSIZED']);
    controller.abort();
    await running;
  });

  it('duplicates after a reconnect change state once; older messages never overwrite newer state (AT-PRV-05, AT-PRV-06)', async () => {
    const clock = new FakeClock(T0);
    const state = createSentimentState({
      clock,
      maxAgeSeconds: 900,
      maxFutureSkewSeconds: 5,
      windowSeconds: 300,
      historyLimit: 100,
    });
    const outcomes: string[] = [];
    const s = setup(['OPEN', 'OPEN'], 100, (o) => outcomes.push(state.record(o)));
    const controller = new AbortController();
    const running = s.stream.run(controller.signal);
    await flush();
    s.fake.connections[0]?.send(message('AAA', '-0.5', T0, 'm-1'));
    await flush();
    s.fake.connections[0]?.drop();
    await flush();
    await advanceBy(s, 1000);
    s.fake.connections[1]?.send(message('AAA', '-0.5', T0, 'm-1'));
    await flush();
    s.fake.connections[1]?.send(message('AAA', '-0.9', '2026-11-08T11:59:00.000Z', 'm-0'));
    await flush();
    expect(outcomes).toEqual(['ACCEPTED', 'DUPLICATE', 'HISTORY']);
    expect(state.view('AAA').latest?.value).toBe('-0.5');
    controller.abort();
    await running;
  });
});

describe('bounded queue under flood (AT-PRV-07)', () => {
  it('never exceeds ws.maxQueueSize; newer per ticker replace older; drops are counted and logged once per minute', async () => {
    const sizes: number[] = [];
    const ref: { stream?: { queueSize: number } } = {};
    const s = setup(['OPEN'], 3, () => sizes.push(ref.stream?.queueSize ?? -1));
    ref.stream = s.stream;
    const controller = new AbortController();
    const running = s.stream.run(controller.signal);
    await flush();
    const c = s.fake.connections[0];
    // One synchronous burst: 2 updates for AAA (coalesced), then 4 more tickers.
    c?.send(message('AAA', '0.1', '2026-11-08T11:59:58.000Z'));
    c?.send(message('AAA', '0.2', '2026-11-08T11:59:59.000Z'));
    c?.send(message('AAA', '0.0', '2026-11-08T11:59:57.000Z')); // older: straight to the sink, not queued
    for (const t of ['BBB', 'CCC', 'DDD', 'EEE']) {
      c?.send(message(t, '0.3'));
      expect(s.stream.queueSize).toBeLessThanOrEqual(3);
    }
    expect(s.stream.droppedCount).toBe(2);
    await flush();
    expect(Math.max(...sizes)).toBeLessThanOrEqual(3);
    expect(s.logs.filter((l) => l['msg'] === 'sentiment.queue_dropped')).toHaveLength(1);
    expect(s.logs[0]).toMatchObject({ msg: 'sentiment.queue_dropped', droppedCount: 1 });
    controller.abort();
    await running;
  });
});
