/**
 * The `SecTransport` port (task 19.2; design: URL Guard and Client).
 *
 * One pinned HTTPS GET to an allowlisted SEC host. The transport receives the
 * guard's `ResolvedSecHost`, connects only to its validated addresses, and uses
 * the allowlisted hostname for TLS verification, SNI, and the `Host` header. It
 * never resolves a hostname itself and never rejects: every failure is an outcome.
 * The production adapter lives in `adapters/sec/`; `sec/` never imports it.
 */
import type { ResolvedSecHost } from './urlGuard.js';

export interface SecTransportRequest {
  /** Pinned target: hostname for SNI, verification, and Host; validated addresses only. */
  readonly host: ResolvedSecHost;
  /** Pathname and search of the validated href. */
  readonly path: string;
  /** Exactly Host, User-Agent, Accept-Encoding, and Connection. */
  readonly headers: Readonly<Record<string, string>>;
  /** Largest accepted 2xx body in bytes. */
  readonly maxBytes: number;
  /** Aborted by the attempt timeout or the overall deadline. */
  readonly signal: AbortSignal;
}

export type SecTransportOutcome =
  | {
      readonly ok: true;
      readonly status: number;
      /** Every `Location` value received, from the raw headers. */
      readonly locations: readonly string[];
      readonly retryAfter?: string;
      readonly contentType?: string;
      /** Empty unless the status is 2xx. */
      readonly body: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly failure: 'NETWORK' | 'TIMEOUT' | 'TLS' | 'TOO_LARGE' | 'INVALID_RESPONSE';
    };

export interface SecTransport {
  /** Never rejects. */
  request(request: SecTransportRequest): Promise<SecTransportOutcome>;
}
