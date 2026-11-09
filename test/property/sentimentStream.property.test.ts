// Validates: Requirements 9.5, 9.8, 9.9, 10.2, 33.5
// Property 29: Bounded memory under load, and Property 30: Sentiment ingestion robustness
// (task 13.2; design: Correctness Properties). The queue is compared with an independent model.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createSentimentState, createSentimentStream } from '../../src/sentiment/index.js';
import type { SentimentObservation } from '../../src/sentiment/index.js';
import {
  FakeClock,
  FakeSleeper,
  SentimentIndexSchema,
  brandDecimalString,
  createLogger,
} from '../../src/shared/index.js';
import type { SentimentIndex } from '../../src/shared/index.js';
import { fakeTransport } from '../helpers/fakeStream.js';
import { latestRealDouble } from '../helpers/sentimentAggregatorDouble.js';

const T0 = '2026-11-08T12:00:00.000Z';
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const msgArb = fc.record({
  ticker: fc.constantFrom('AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'),
  second: fc.integer({ min: 0, max: 59 }),
});

describe('Property 29: Bounded memory under load', () => {
  it('the queue never exceeds maxQueueSize and the dropped counter matches a model', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.array(msgArb, { maxLength: 60 }),
        async (max, burst) => {
          const clock = new FakeClock(T0);
          const fake = fakeTransport(['OPEN']);
          const sunk: SentimentObservation[] = [];
          const stream = createSentimentStream({
            provider: { name: 'p', kind: 'REAL' },
            transport: fake.transport,
            decode: (text) => JSON.parse(text) as unknown,
            clock,
            sleeper: new FakeSleeper(clock),
            random: () => 0,
            logger: createLogger({ clock, sink: () => undefined }),
            reconnect: { initialDelaySeconds: 1, maxDelaySeconds: 1, maxAttempts: 1, jitter: false },
            maxQueueSize: max,
            sink: (o) => sunk.push(o),
            onRejected: () => undefined,
            onStatus: () => undefined,
          });
          const controller = new AbortController();
          const running = stream.run(controller.signal);
          await flush();
          // Model: keyed FIFO with in-place replacement for newer, direct sink for older, drop-oldest when full.
          const model = new Map<string, string>();
          let dropped = 0;
          for (const m of burst) {
            const observedAt = `2026-11-08T11:59:${String(m.second).padStart(2, '0')}.000Z`;
            fake.connections[0]?.send(JSON.stringify({ ticker: m.ticker, value: '0.1', observedAt }));
            const queued = model.get(m.ticker);
            if (queued !== undefined && observedAt < queued) {
              // older: straight to the sink
            } else if (queued !== undefined) {
              model.set(m.ticker, observedAt);
            } else {
              if (model.size >= max) {
                const oldest = model.keys().next();
                if (!oldest.done) {
                  model.delete(oldest.value);
                }
                dropped += 1;
              }
              model.set(m.ticker, observedAt);
            }
            expect(stream.queueSize).toBeLessThanOrEqual(max);
            expect(stream.queueSize).toBe(model.size);
          }
          expect(stream.droppedCount).toBe(dropped);
          await flush();
          expect(stream.queueSize).toBe(0);
          controller.abort();
          await running;
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('Property 30: Sentiment ingestion robustness', () => {
  it('duplicates change state once, older never overwrite, future-dated are rejected, aggregates stay in [-1, 1]', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.option(fc.constantFrom('m1', 'm2', 'm3'), { nil: undefined }),
            offset: fc.integer({ min: -600, max: 10 }),
            value: fc
              .integer({ min: -99, max: 99 })
              .map((v) => `${v < 0 ? '-' : ''}0.${String(Math.abs(v)).padStart(2, '0')}`),
          }),
          { maxLength: 30 },
        ),
        (messages) => {
          const clock = new FakeClock(T0);
          const state = createSentimentState({
            clock,
            maxAgeSeconds: 900,
            maxFutureSkewSeconds: 5,
            windowSeconds: 300,
            historyLimit: 1000,
            aggregator: latestRealDouble,
          });
          let latest: string | undefined;
          const seen = new Set<string>();
          for (const m of messages) {
            const observedAt = new Date(Date.parse(T0) + m.offset * 1000).toISOString();
            const value = m.value;
            const o: SentimentObservation = {
              provider: 'p',
              sourceKind: 'REAL',
              ticker: 'AAA',
              value: brandDecimalString(value) as SentimentIndex,
              observedAt,
              receivedAt: T0,
              ...(m.id === undefined ? {} : { messageId: m.id }),
            };
            const key = m.id === undefined ? `${observedAt}|${value}` : `id|${m.id}`;
            const outcome = state.record(o);
            if (m.offset > 5) {
              expect(outcome).toBe('FUTURE_DATED');
              continue;
            }
            if (seen.has(key)) {
              expect(outcome).toBe('DUPLICATE');
              continue;
            }
            seen.add(key);
            if (latest !== undefined && observedAt < latest) {
              expect(outcome).toBe('HISTORY');
            } else {
              expect(outcome).toBe('ACCEPTED');
              latest = observedAt;
            }
            expect(state.view('AAA').latest?.observedAt).toBe(latest);
            const index = state.view('AAA').index;
            if (index !== null) {
              expect(SentimentIndexSchema.safeParse(index.value).success).toBe(true);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
