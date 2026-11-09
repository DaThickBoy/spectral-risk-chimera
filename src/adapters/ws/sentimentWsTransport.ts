/**
 * `wss://` transport for sentiment streams (task 13.2; R9.2, R24.8, R33.5),
 * built on `ws@8.22.2` (exact pin, approved).
 *
 * - Only `wss:` URLs are accepted (anything else is a programmer error).
 * - Certificate verification is always on: `rejectUnauthorized: true` is set
 *   explicitly, which also overrides the Node.js environment switch. The options
 *   type has no field for a custom CA, `rejectUnauthorized`, or
 *   `checkServerIdentity`, so no caller or configuration can weaken it. Tests that
 *   need a trusted local server add the test CA to the process default store.
 * - Inbound messages are bounded by `maxPayloadBytes` (`ws` closes the
 *   connection with 1009 when exceeded); per-message compression is disabled, so
 *   a small compressed frame cannot expand in memory; redirects are not followed;
 *   the opening handshake is bounded by `handshakeTimeoutMs`.
 * - Binary messages are protocol violations reported to `onInvalidMessage`.
 * - Connect failures are classified without detail: a certificate or TLS error
 *   is `TLS`, a non-101 response is `REJECTED`, a handshake timeout is `TIMEOUT`,
 *   anything else `NETWORK`.
 */
import WebSocket from 'ws';
import type { ConnectFailure, StreamTransport } from '../../sentiment/index.js';

export interface WsTransportOptions {
  readonly url: string;
  /** Maximum size of one inbound message in bytes (positive integer). */
  readonly maxPayloadBytes: number;
  /** Maximum duration of the opening handshake in milliseconds (positive integer). */
  readonly handshakeTimeoutMs: number;
  /** Request headers (for example an API key from the environment); never logged here. */
  readonly headers?: Readonly<Record<string, string>>;
}

const TLS_ERROR_CODE = /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/;

function classify(error: unknown): ConnectFailure {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TLS_ERROR_CODE.test(code)) {
    return 'TLS';
  }
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && message.includes('Opening handshake has timed out')) {
    return 'TIMEOUT';
  }
  return 'NETWORK';
}

const positiveInt = (v: number): boolean => Number.isSafeInteger(v) && v > 0;

export function createWsStreamTransport(options: WsTransportOptions): StreamTransport {
  const target = new URL(options.url);
  if (target.protocol !== 'wss:') {
    throw new TypeError('The sentiment stream accepts only wss: URLs.');
  }
  if (!positiveInt(options.maxPayloadBytes) || !positiveInt(options.handshakeTimeoutMs)) {
    throw new RangeError('maxPayloadBytes and handshakeTimeoutMs must be positive integers.');
  }
  return {
    connect: (handlers, signal) =>
      new Promise((resolve) => {
        if (signal.aborted) {
          resolve({ ok: false, failure: 'NETWORK' });
          return;
        }
        const socket = new WebSocket(target, {
          rejectUnauthorized: true,
          maxPayload: options.maxPayloadBytes,
          perMessageDeflate: false,
          followRedirects: false,
          handshakeTimeout: options.handshakeTimeoutMs,
          headers: { ...options.headers },
        });
        let opened = false;
        let settled = false;
        const settle = (value: Parameters<typeof resolve>[0]): void => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        const onAbort = (): void => {
          socket.terminate();
          settle({ ok: false, failure: 'NETWORK' });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        socket.on('unexpected-response', (_request, response) => {
          response.resume();
          socket.terminate();
          settle({ ok: false, failure: 'REJECTED' });
        });
        socket.on('open', () => {
          opened = true;
          settle({ ok: true, connection: { close: () => socket.close(1000) } });
        });
        socket.on('message', (data, isBinary) => {
          if (isBinary) {
            handlers.onInvalidMessage();
            return;
          }
          const text = Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8');
          handlers.onText(text);
        });
        socket.on('error', (error) => {
          if (!opened) {
            settle({ ok: false, failure: classify(error) });
            return;
          }
          if ((error as { code?: unknown }).code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
            handlers.onInvalidMessage();
          }
        });
        socket.on('close', () => {
          signal.removeEventListener('abort', onAbort);
          if (opened) {
            handlers.onClose();
          } else {
            settle({ ok: false, failure: 'NETWORK' });
          }
        });
      }),
  };
}
