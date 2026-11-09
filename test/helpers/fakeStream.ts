// A scripted StreamTransport for sentiment stream tests (task 13.2). Each connect() call takes
// the next scripted outcome; an open connection exposes send/close to the test.
import type { ConnectFailure, StreamHandlers, StreamTransport } from '../../src/sentiment/index.js';

export interface OpenConnection {
  send(text: string): void;
  sendInvalid(): void;
  /** Server-side close. */
  drop(): void;
  closedByClient: boolean;
}

export function fakeTransport(outcomes: readonly ('OPEN' | ConnectFailure)[]): {
  transport: StreamTransport;
  connections: OpenConnection[];
  calls: number[];
} {
  const connections: OpenConnection[] = [];
  const calls: number[] = [];
  const transport: StreamTransport = {
    connect: (handlers: StreamHandlers) => {
      const outcome = outcomes[Math.min(calls.length, outcomes.length - 1)] ?? 'NETWORK';
      calls.push(calls.length);
      if (outcome !== 'OPEN') {
        return Promise.resolve({ ok: false, failure: outcome });
      }
      let open = true;
      const connection: OpenConnection = {
        send: (text) => open && handlers.onText(text),
        sendInvalid: () => open && handlers.onInvalidMessage(),
        drop: () => {
          if (open) {
            open = false;
            handlers.onClose();
          }
        },
        closedByClient: false,
      };
      connections.push(connection);
      return Promise.resolve({
        ok: true,
        connection: {
          close: () => {
            connection.closedByClient = true;
            connection.drop();
          },
        },
      });
    },
  };
  return { transport, connections, calls };
}
