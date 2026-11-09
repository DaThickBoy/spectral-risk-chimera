/**
 * Sentiment emission cadence (task 13.6; design: Sentiment, Emitter; R10.5,
 * R10.6, R10.8).
 *
 * - Drift-corrected schedule on the monotonic clock: tick `k` is due at
 *   `start + k * intervalMs` (target 3,000 ms). Waiting goes through the
 *   injected `Sleeper`. A tick that is late never shifts later ticks; if a tick
 *   is missed entirely, the schedule continues at the next due time rather than
 *   bursting.
 * - On each tick the views of all known tickers are compared with what was last
 *   emitted. Only tickers whose view changed (a new value, a new observation, or
 *   a status change such as ageing to `STALE`) are emitted; nothing is emitted
 *   when nothing changed (R10.6).
 * - Provider arrival never drives the schedule, so arrival jitter cannot move
 *   emission times (cadence level (c), R10.5). The scheduler runs regardless of
 *   connection state, so states keep ageing while disconnected (R10.8).
 * - `emit` failures are reported to `onError`; the schedule continues.
 */
import { canonicalJson } from '../shared/index.js';
import type { Clock, Sleeper } from '../shared/index.js';
import type { SentimentState, SentimentView } from './state.js';

export const EMISSION_INTERVAL_MS = 3000;

export interface SentimentEmitterDependencies {
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly state: SentimentState;
  readonly emit: (updates: readonly SentimentView[], emittedAtMonotonicMs: number) => void;
  readonly onError: (error: unknown) => void;
  readonly intervalMs?: number;
}

export interface SentimentEmitter {
  /** Runs until the signal aborts. */
  run(signal: AbortSignal): Promise<void>;
  /** One comparison and emission, without waiting (also used by `run`). */
  tick(): readonly SentimentView[];
}

export function createSentimentEmitter(deps: SentimentEmitterDependencies): SentimentEmitter {
  const interval = deps.intervalMs ?? EMISSION_INTERVAL_MS;
  if (!Number.isSafeInteger(interval) || interval <= 0) {
    throw new TypeError('intervalMs must be a positive integer.');
  }
  const lastEmitted = new Map<string, string>();

  const tick = (): readonly SentimentView[] => {
    const changed: SentimentView[] = [];
    for (const ticker of deps.state.tickers()) {
      const view = deps.state.view(ticker);
      const text = canonicalJson(view);
      if (lastEmitted.get(ticker) !== text) {
        changed.push(view);
        lastEmitted.set(ticker, text);
      }
    }
    if (changed.length > 0) {
      try {
        deps.emit(changed, deps.clock.monotonicMs());
      } catch (error) {
        deps.onError(error);
      }
    }
    return changed;
  };

  return {
    tick,
    run: async (signal) => {
      const start = deps.clock.monotonicMs();
      let k = 1; // tick number, not a financial value
      while (!signal.aborted) {
        const now = deps.clock.monotonicMs();
        let due = start + k * interval;
        if (due <= now - interval) {
          // Missed whole ticks: continue at the next due time, never in a burst.
          k = Math.floor((now - start) / interval) + 1;
          due = start + k * interval;
        }
        if ((await deps.sleeper.sleep(Math.max(0, due - now), signal)) === 'ABORTED') {
          return;
        }
        tick();
        k += 1;
      }
    },
  };
}
