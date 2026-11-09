/**
 * WebSocket sentiment subscription logic (task 13.2; design: Sentiment, REST and
 * WebSocket ingestion flow; R9.2 to R9.5, R10.8, R24.8, R33.5).
 *
 * Transport-independent: the concrete `wss://` client is an adapter behind
 * `StreamTransport` (`src/adapters/ws/`), which enforces TLS verification, a
 * maximum message size, and no compression. This module:
 * - decodes each text message with the injected decoder (the vendor format and
 *   its lossless JSON parser arrive with task 13.8, OD-13 and OD-16), then
 *   validates it (`normalizeObservation`); invalid messages are reported to
 *   `onRejected`, never clamped, and never stop the stream (R9.5);
 * - offers valid observations to a `BoundedQueue` (`ws.maxQueueSize`) keyed by
 *   provider and ticker: a newer observation replaces a queued one, an older one
 *   goes straight to the sink (it can only become history, R9.8), and when the
 *   queue is full the oldest entry is dropped and counted. Drops are logged at
 *   most once per minute with the dropped count (R33.5);
 * - drains the queue into `sink` (the 13.3 state applies deduplication, ordering,
 *   and the future-skew rule, so reconnect duplicates change state once, R10.8);
 * - reconnects after a close or a failed connection with exponential backoff
 *   (`sentiment.reconnect`: initial delay, maximum delay, maximum attempts,
 *   optional full jitter from the injected `random`). A successful connection
 *   resets the attempt count. After `maxAttempts` consecutive failures it stops
 *   with `GAVE_UP`. Waiting goes through the injected `Sleeper`.
 * The emission scheduler (13.6) is independent and keeps running while
 * disconnected, so states age to `STALE` (R10.8).
 */
import { BoundedQueue } from '../shared/index.js';
import type { Clock, DataSourceKind, Logger, Sleeper } from '../shared/index.js';
import { normalizeObservation } from './observation.js';
import type { ObservationRejection, SentimentObservation } from './observation.js';

export type ConnectFailure = 'TLS' | 'NETWORK' | 'TIMEOUT' | 'REJECTED';

export interface StreamHandlers {
  onText(text: string): void;
  /** A binary or oversized message, or any other protocol-level violation. */
  onInvalidMessage(): void;
  onClose(): void;
}

export interface StreamConnection {
  close(): void;
}

/** Port implemented by the `wss://` adapter. */
export interface StreamTransport {
  connect(
    handlers: StreamHandlers,
    signal: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly connection: StreamConnection }
    | { readonly ok: false; readonly failure: ConnectFailure }
  >;
}

export interface ReconnectPolicy {
  readonly initialDelaySeconds: number;
  readonly maxDelaySeconds: number;
  readonly maxAttempts: number;
  readonly jitter: boolean;
}

export type StreamStatus = 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'GAVE_UP' | 'STOPPED';

export interface SentimentStreamDependencies {
  readonly provider: { readonly name: string; readonly kind: DataSourceKind };
  readonly transport: StreamTransport;
  /** Turns one text message into the unvalidated message object, or `undefined` if it cannot be decoded. */
  readonly decode: (text: string) => unknown;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly random: () => number;
  readonly logger: Logger;
  readonly reconnect: ReconnectPolicy;
  /** `ws.maxQueueSize`. */
  readonly maxQueueSize: number;
  readonly sink: (observation: SentimentObservation) => void;
  readonly onRejected: (
    rejection: ObservationRejection | { readonly reason: 'UNDECODABLE' | 'BINARY_OR_OVERSIZED' },
  ) => void;
  readonly onStatus: (status: StreamStatus, detail?: ConnectFailure) => void;
}

export interface SentimentStream {
  run(signal: AbortSignal): Promise<'GAVE_UP' | 'STOPPED'>;
  readonly droppedCount: number;
  /** Queued observations replaced by a newer one for the same provider and ticker. */
  readonly coalescedCount: number;
  readonly queueSize: number;
}

const DROP_LOG_INTERVAL_MS = 60_000;

const positiveInt = (v: number, min: number): boolean => Number.isSafeInteger(v) && v >= min;

/** Backoff before reconnect attempt `attempt` (0-based): min(max, initial * 2^attempt), full jitter if enabled. */
export function reconnectDelayMs(policy: ReconnectPolicy, attempt: number, random: () => number): number {
  const ceiling = Math.min(policy.maxDelaySeconds * 1000, policy.initialDelaySeconds * 1000 * 2 ** attempt);
  return policy.jitter ? Math.floor(random() * ceiling) : ceiling; // milliseconds, not a financial value
}

export function createSentimentStream(deps: SentimentStreamDependencies): SentimentStream {
  const policy = deps.reconnect;
  if (
    !positiveInt(policy.initialDelaySeconds, 1) ||
    !positiveInt(policy.maxDelaySeconds, 1) ||
    policy.maxDelaySeconds < policy.initialDelaySeconds ||
    !positiveInt(policy.maxAttempts, 1)
  ) {
    throw new TypeError('sentiment.reconnect settings are invalid.');
  }
  const queue = new BoundedQueue<string, SentimentObservation>(
    deps.maxQueueSize,
    (o) => `${o.provider}\u0000${o.ticker}`,
  );
  /** Queued observation time per key, so an older arrival never replaces a newer queued one. */
  const queuedAt = new Map<string, string>();
  let lastDropLogMs: number | undefined;
  let coalesced = 0;
  let draining = false;

  const drain = (): void => {
    if (draining) {
      return;
    }
    draining = true;
    try {
      for (let next = queue.take(); next !== undefined; next = queue.take()) {
        queuedAt.delete(`${next.provider}\u0000${next.ticker}`);
        deps.sink(next);
      }
    } finally {
      draining = false;
    }
  };

  const logDrops = (): void => {
    const now = deps.clock.monotonicMs();
    if (lastDropLogMs === undefined || now - lastDropLogMs >= DROP_LOG_INTERVAL_MS) {
      lastDropLogMs = now;
      deps.logger.warn('sentiment.queue_dropped', {
        provider: deps.provider.name,
        droppedCount: queue.droppedCount,
      });
    }
  };

  const onText = (text: string): void => {
    let decoded: unknown;
    try {
      decoded = deps.decode(text);
    } catch {
      decoded = undefined;
    }
    if (decoded === undefined) {
      deps.onRejected({ reason: 'UNDECODABLE' });
      return;
    }
    const observation = normalizeObservation(decoded, {
      provider: deps.provider.name,
      sourceKind: deps.provider.kind,
      receivedAt: deps.clock.nowUtc().toISOString(),
    });
    if (!observation.ok) {
      deps.onRejected(observation.error);
      return;
    }
    const o = observation.value;
    const key = `${o.provider}\u0000${o.ticker}`;
    const queued = queuedAt.get(key);
    if (queued !== undefined && o.observedAt < queued) {
      deps.sink(o); // older than the queued one: history only (R9.8), never replaces it
      return;
    }
    const offered = queue.offer(o);
    if (offered === 'COALESCED') {
      coalesced += 1;
    }
    if (offered === 'DROPPED_OLDEST') {
      // `queuedAt` mirrors the queue's insertion order, so its first key is the dropped entry.
      const dropped = queuedAt.keys().next();
      if (!dropped.done) {
        queuedAt.delete(dropped.value);
      }
      logDrops();
    }
    queuedAt.set(key, o.observedAt);
    queueMicrotask(drain);
  };

  return {
    get droppedCount() {
      return queue.droppedCount;
    },
    get coalescedCount() {
      return coalesced;
    },
    get queueSize() {
      return queue.size;
    },
    run: async (signal) => {
      let attempt = 0; // consecutive failures, a count
      while (!signal.aborted) {
        deps.onStatus('CONNECTING');
        let closed: () => void = () => undefined;
        const closedPromise = new Promise<void>((resolve) => {
          closed = resolve;
        });
        const result = await deps.transport.connect(
          {
            onText,
            onInvalidMessage: () => deps.onRejected({ reason: 'BINARY_OR_OVERSIZED' }),
            onClose: () => closed(),
          },
          signal,
        );
        if (result.ok) {
          attempt = 0;
          deps.onStatus('CONNECTED');
          const onAbort = (): void => result.connection.close();
          signal.addEventListener('abort', onAbort, { once: true });
          await closedPromise;
          signal.removeEventListener('abort', onAbort);
          drain();
          if (signal.aborted) {
            break;
          }
          deps.onStatus('DISCONNECTED');
        } else {
          if (signal.aborted) {
            break;
          }
          deps.onStatus('DISCONNECTED', result.failure);
          attempt += 1;
          if (attempt >= policy.maxAttempts) {
            deps.onStatus('GAVE_UP');
            return 'GAVE_UP';
          }
        }
        // The first wait after a close or a first failure uses the initial delay, then doubles.
        const delay = reconnectDelayMs(policy, Math.max(0, attempt - 1), deps.random);
        if ((await deps.sleeper.sleep(delay, signal)) === 'ABORTED') {
          break;
        }
      }
      deps.onStatus('STOPPED');
      return 'STOPPED';
    },
  };
}
