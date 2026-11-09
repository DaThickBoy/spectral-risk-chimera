/**
 * Market data price attempt mapping (task 11.1; design: Valuation rule 4; R25.2,
 * R25.8, R25.9).
 *
 * Maps one `getLatestPrice` `Result` to one `ResilientCall` attempt outcome,
 * exactly as FX rule 4 maps an FX provider result, preserving the provider's
 * classification:
 * `NETWORK_ERROR` → `NETWORK`, `TIMEOUT` → `TIMEOUT`, `TLS_ERROR` → `TLS`,
 * `INVALID_RESPONSE` → `INVALID_RESPONSE`, `RATE_LIMITED` → HTTP 429,
 * `HTTP_CLIENT_ERROR` and `HTTP_SERVER_ERROR` → HTTP with their status (400 or 500
 * when the status is missing or outside its class).
 *
 * A provider-returned `CIRCUIT_OPEN`, `CANCELLED`, or `UNEXPECTED_ERROR`, or a
 * value that is not a `Result`, is an unexpected provider outcome: this function
 * throws, and `ResilientCall` reports `UNEXPECTED_ERROR` (not retried, R25.9).
 * Attempt timeouts and cancellation are classified by `ResilientCall` from the
 * attempt signal, never here.
 */
import type { ProviderQuote } from '../marketdata/index.js';
import type { AttemptOutcome, ProviderError, Result } from '../shared/index.js';

const unexpectedProviderOutcome = (): Error =>
  new Error('Market data provider returned an unexpected outcome.');

/** Also maps `getDailySeries` results (task 9.6 retrieval), with the same classification. */
export function toPriceAttempt(
  result: Result<ProviderQuote, ProviderError> | Result<unknown, ProviderError>,
): AttemptOutcome<unknown> {
  const candidate = result as unknown as { ok?: unknown } | null;
  if (typeof candidate !== 'object' || candidate === null || typeof candidate.ok !== 'boolean') {
    throw unexpectedProviderOutcome();
  }
  if (!result.ok && (typeof result.error !== 'object' || result.error === null)) {
    throw unexpectedProviderOutcome();
  }
  if (result.ok) {
    return { ok: true, value: result.value as unknown };
  }
  const { code, httpStatus } = result.error;
  const inRange = (min: number, max: number): boolean =>
    typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= min && httpStatus <= max;
  switch (code) {
    case 'NETWORK_ERROR':
      return { ok: false, failure: 'NETWORK' };
    case 'TIMEOUT':
      return { ok: false, failure: 'TIMEOUT' };
    case 'TLS_ERROR':
      return { ok: false, failure: 'TLS' };
    case 'INVALID_RESPONSE':
      return { ok: false, failure: 'INVALID_RESPONSE' };
    case 'RATE_LIMITED':
      return { ok: false, failure: 'HTTP', status: 429 };
    case 'HTTP_CLIENT_ERROR':
      return {
        ok: false,
        failure: 'HTTP',
        status: inRange(400, 499) && httpStatus !== 429 ? (httpStatus as number) : 400,
      };
    case 'HTTP_SERVER_ERROR':
      return { ok: false, failure: 'HTTP', status: inRange(500, 599) ? (httpStatus as number) : 500 };
    case 'CIRCUIT_OPEN':
    case 'CANCELLED':
    case 'UNEXPECTED_ERROR':
    default:
      throw unexpectedProviderOutcome();
  }
}
