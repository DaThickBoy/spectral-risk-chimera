/**
 * TLS-verified HTTPS GET transport for provider adapters (task 8.2; R24.8,
 * design: Provider Resilience Layer, TLS).
 *
 * - Certificate verification is always on: every request sets
 *   `rejectUnauthorized: true` explicitly, which also overrides the Node.js
 *   environment switch that would otherwise disable verification. The options
 *   type has no field for a custom CA, `rejectUnauthorized`, or
 *   `checkServerIdentity`, so no caller, configuration, or test can weaken it.
 * - Only `https:` URLs are accepted (anything else is a programmer error).
 * - The response body is read up to `maxBytes`; a larger body is an invalid
 *   response, and the connection is closed.
 * - Every outcome is an `AttemptOutcome` for `ResilientCall`:
 *   2xx -> ok; any other status -> `HTTP` with `Retry-After`; abort -> `TIMEOUT`;
 *   a certificate or TLS verification error -> `TLS` (`TLS_ERROR`: not retried,
 *   counts toward the circuit; no certificate detail is passed on); any other
 *   socket or DNS error -> `NETWORK`.
 * - SEC address pinning is not handled here (task 19.2).
 */
import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { AttemptOutcome } from '../../shared/index.js';

export interface HttpsGetOptions {
  readonly headers?: Readonly<Record<string, string>>;
  /** Maximum response body size in bytes. */
  readonly maxBytes: number;
}

export interface HttpsResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Uint8Array;
}

const TLS_ERROR_CODE = /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/;

function isTlsVerificationError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TLS_ERROR_CODE.test(code);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readBody(response: IncomingMessage, maxBytes: number): Promise<Uint8Array | 'TOO_LARGE'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        response.destroy();
        resolve('TOO_LARGE');
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    response.on('error', reject);
  });
}

/** One HTTPS GET with certificate verification always on. */
export async function httpsGet(
  url: string,
  options: HttpsGetOptions,
  signal: AbortSignal,
): Promise<AttemptOutcome<HttpsResponse>> {
  const target = new URL(url);
  if (target.protocol !== 'https:') {
    throw new TypeError('httpsGet accepts only https: URLs.');
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative integer.');
  }
  try {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(target, {
        method: 'GET',
        headers: { ...options.headers },
        signal,
        rejectUnauthorized: true,
      });
      req.on('response', resolve);
      req.on('error', reject);
      req.end();
    });
    const status = response.statusCode ?? 0;
    if (status < 200 || status > 299) {
      response.resume();
      const retryAfter = firstHeader(response.headers['retry-after']);
      return { ok: false, failure: 'HTTP', status, ...(retryAfter === undefined ? {} : { retryAfter }) };
    }
    const body = await readBody(response, options.maxBytes);
    if (body === 'TOO_LARGE') {
      return { ok: false, failure: 'INVALID_RESPONSE' };
    }
    return { ok: true, value: { status, headers: { ...response.headers }, body } };
  } catch (error) {
    if (signal.aborted) {
      return { ok: false, failure: 'TIMEOUT' };
    }
    if (isTlsVerificationError(error)) {
      return { ok: false, failure: 'TLS' };
    }
    return { ok: false, failure: 'NETWORK' };
  }
}
