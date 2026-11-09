// Task 13.7: sentiment message handler timing (R33.4). Run with `npm run bench:sentiment`; never part
// of `npm test` or CI. Enforcement waits for task 25.1 and the reference environment (OD-2,
// AT-BEN-02 record only).
//
// Timed scope: the per-message ingestion path of a connected stream: decode, Zod validation and
// normalization, the bounded queue, and the 13.3 state (dedupe, ordering, future skew). The
// network transport and the vendor parser (13.8) are excluded. Procedure: 3 warm-up and 20
// measured runs of 1,000 messages each on the monotonic `performance.now()`; the per-message time
// of a run is its duration / 1,000; p95 by nearest rank (19th of 20 sorted).
// Tests: AT-BEN-02
// Validates: Requirements 33.4
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { FakeClock, FakeSleeper } from '../../src/shared/index.js';
import { benchMessage, environmentRecord, streamHarness, writeRecord } from '../helpers/streamHarness.js';

const WARM_UP = 3;
const MEASURED = 20;
const MESSAGES = 1000;
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

it('sentiment handler timing (R33.4)', async () => {
  const clock = new FakeClock('2026-11-08T12:00:00.000Z');
  const h = streamHarness(clock, new FakeSleeper(clock), 1000);
  const controller = new AbortController();
  const running = h.stream.run(controller.signal);
  await flush();
  const connection = h.fake.connections[0];
  const observedAt = clock.nowUtc().toISOString();
  let next = 0;
  const once = async (): Promise<number> => {
    const texts = Array.from({ length: MESSAGES }, () => benchMessage(next++, observedAt));
    const start = performance.now();
    for (const text of texts) {
      connection?.send(text);
    }
    await flush(); // the queue drains on a microtask
    return performance.now() - start;
  };
  for (let i = 0; i < WARM_UP; i += 1) {
    await once();
  }
  const perMessageUs: number[] = [];
  for (let i = 0; i < MEASURED; i += 1) {
    perMessageUs.push(((await once()) * 1000) / MESSAGES); // microseconds, a timing
  }
  controller.abort();
  await running;
  const p95 = [...perMessageUs].sort((a, b) => a - b)[18] ?? Number.NaN;
  const file = writeRecord('sentiment-handler', {
    benchmark: 'sentiment-handler',
    timedScope: 'decode, validate, queue, state record (per message)',
    warmUpRuns: WARM_UP,
    measuredRuns: MEASURED,
    messagesPerRun: MESSAGES,
    perMessageUs: perMessageUs.map((us) => us.toFixed(3)),
    p95PerMessageUs: p95.toFixed(3),
    enforced: false,
    rejected: h.rejected(),
    environment: environmentRecord(),
    recordedAt: new Date().toISOString(),
  });
  process.stdout.write(
    `Sentiment handler p95 ${p95.toFixed(3)} us per message (not enforced); record: ${file}\n`,
  );
  expect(perMessageUs).toHaveLength(MEASURED);
  expect(h.rejected()).toBe(0);
}, 300_000);
