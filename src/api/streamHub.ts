/**
 * `/stream` client hub (task 15.1; design: API routes `WS /stream`; R10.5,
 * R16.7, R17.10, R19.1, R25.1, R26.9).
 *
 * - `publish` validates every event with the shared `StreamEventSchema` before
 *   anything is sent. An invalid event is refused (`EVENT_INVALID`) and logged
 *   with its type only; nothing from the payload reaches the log. Financial and
 *   sentiment values are decimal strings in the contract, so the serialized
 *   text never carries a JSON number for them.
 * - Bounded memory per client: before a send, the client's unsent bytes
 *   (`bufferedAmount`) plus the new message must fit within `maxBufferedBytes`.
 *   A client that cannot keep up is terminated and removed (`stream.client_dropped`, `SLOW`);
 *   nothing is queued for it in the hub. An event larger than the limit by
 *   itself is refused (`EVENT_TOO_LARGE`) rather than dropping every client.
 * - Bounded clients: `add` refuses a client beyond `maxClients`.
 * - Publishing never throws for a client failure, so a publisher (for example
 *   the 16.3 alert dispatcher) is never interrupted by one connection.
 */
import type { AlertPublisher } from '../app/index.js';
import { StreamEventSchema } from '../shared/index.js';
import type { Logger, StreamEvent } from '../shared/index.js';

/** The part of a `ws` server socket the hub uses. */
export interface StreamClient {
  /** Bytes accepted by `send` but not yet written to the network. */
  readonly bufferedAmount: number;
  send(data: string): void;
  terminate(): void;
}

export interface StreamHubOptions {
  readonly logger: Logger;
  /** Positive integer: connected clients at most. */
  readonly maxClients: number;
  /** Positive integer: unsent bytes per client at most, including the message being sent. */
  readonly maxBufferedBytes: number;
}

export type StreamPublishResult =
  | { readonly ok: true; readonly delivered: number; readonly dropped: number }
  | { readonly ok: false; readonly code: 'EVENT_INVALID' | 'EVENT_TOO_LARGE' };

export interface StreamHub {
  publish(event: StreamEvent): StreamPublishResult;
  /** False when `maxClients` clients are already connected. */
  add(client: StreamClient): boolean;
  remove(client: StreamClient): void;
  readonly clientCount: number;
  readonly maxClients: number;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
}

export function createStreamHub(options: StreamHubOptions): StreamHub {
  positiveInteger(options.maxClients, 'maxClients');
  positiveInteger(options.maxBufferedBytes, 'maxBufferedBytes');
  const clients = new Set<StreamClient>();

  const drop = (client: StreamClient, reason: 'SLOW' | 'SEND_FAILED'): void => {
    clients.delete(client);
    try {
      client.terminate();
    } catch {
      // The connection is already gone; nothing else to release.
    }
    options.logger.warn('stream.client_dropped', { reason });
  };

  return {
    get clientCount() {
      return clients.size;
    },
    maxClients: options.maxClients,
    add: (client) => {
      if (clients.size >= options.maxClients) {
        return false;
      }
      clients.add(client);
      return true;
    },
    remove: (client) => {
      clients.delete(client);
    },
    publish: (event) => {
      const parsed = StreamEventSchema.safeParse(event);
      if (!parsed.success) {
        const type = typeof event === 'object' && event !== null ? String(event.type) : 'unknown';
        options.logger.error('stream.event_invalid', { type: type.slice(0, 64) });
        return { ok: false, code: 'EVENT_INVALID' };
      }
      const text = JSON.stringify(parsed.data);
      const bytes = Buffer.byteLength(text, 'utf8'); // a size, not a financial value
      if (bytes > options.maxBufferedBytes) {
        options.logger.error('stream.event_too_large', { type: parsed.data.type, bytes });
        return { ok: false, code: 'EVENT_TOO_LARGE' };
      }
      let delivered = 0;
      let dropped = 0;
      for (const client of [...clients]) {
        if (client.bufferedAmount + bytes > options.maxBufferedBytes) {
          drop(client, 'SLOW');
          dropped += 1;
          continue;
        }
        try {
          client.send(text);
          delivered += 1;
        } catch {
          drop(client, 'SEND_FAILED');
          dropped += 1;
        }
      }
      return { ok: true, delivered, dropped };
    },
  };
}

/**
 * Task 16.3: the hub as an alert publisher. An event the hub refuses counts as a
 * failed publish (the dispatcher retries). Reaching zero connected dashboards is
 * a successful publish: the alert stays in history for `GET /alerts`.
 */
export function streamAlertPublisher(hub: StreamHub): AlertPublisher {
  return {
    name: 'stream',
    publish: (event) => {
      const result = hub.publish(event);
      if (!result.ok) {
        throw new Error(`Stream refused the alert event: ${result.code}`);
      }
    },
  };
}
