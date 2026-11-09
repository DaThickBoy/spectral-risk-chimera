// Shared setup for the sentiment stream benchmark and soak runs (tasks 13.7, 25.2): a scripted
// transport, the real stream logic, and the real sentiment state as the sink.
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createSentimentState, createSentimentStream } from '../../src/sentiment/index.js';
import type { Clock, Sleeper } from '../../src/shared/index.js';
import { createLogger } from '../../src/shared/index.js';
import { fakeTransport } from './fakeStream.js';

export function streamHarness(clock: Clock, sleeper: Sleeper, maxQueueSize: number) {
  const fake = fakeTransport(['OPEN']);
  const state = createSentimentState({
    clock,
    maxAgeSeconds: 900,
    maxFutureSkewSeconds: 5,
    windowSeconds: 300,
    historyLimit: 1000,
  });
  let rejected = 0;
  const stream = createSentimentStream({
    provider: { name: 'bench-ws', kind: 'REAL' },
    transport: fake.transport,
    decode: (text) => JSON.parse(text) as unknown, // test decoder; real adapters use the lossless parser (13.8)
    clock,
    sleeper,
    random: () => 0,
    logger: createLogger({ clock, sink: () => undefined }),
    reconnect: { initialDelaySeconds: 1, maxDelaySeconds: 1, maxAttempts: 1, jitter: false },
    maxQueueSize,
    sink: (o) => state.record(o),
    onRejected: () => (rejected += 1),
    onStatus: () => undefined,
  });
  return { fake, state, stream, rejected: () => rejected };
}

/** Deterministic message text: 50 tickers, values in [-0.99, 0.99], unique message ids. */
export function benchMessage(i: number, observedAt: string): string {
  const v = ((i * 37) % 199) - 99;
  const value = `${v < 0 ? '-' : ''}0.${String(Math.abs(v)).padStart(2, '0')}`;
  return JSON.stringify({
    messageId: `m-${i}`,
    ticker: `T${String(i % 50).padStart(3, '0')}`,
    value,
    observedAt,
  });
}

/** CPU, cores, RAM, OS, and Node.js version, recorded with every benchmark and soak result. */
export function environmentRecord(): Record<string, unknown> {
  const cpus = os.cpus();
  return {
    cpuModel: cpus[0]?.model ?? 'unknown',
    cores: os.availableParallelism(),
    ramBytes: String(os.totalmem()),
    os: `${os.type()} ${os.release()} (${os.version()})`,
    arch: os.arch(),
    node: process.version,
  };
}

/** Writes a JSON record to the gitignored bench-results/ directory and returns its path. */
export function writeRecord(name: string, record: Record<string, unknown>): string {
  mkdirSync('bench-results', { recursive: true });
  const file = `bench-results/${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return file;
}
