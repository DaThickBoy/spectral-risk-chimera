/**
 * ECB FX provider adapter (task 10.2; design: ECB FX adapter rules 1 to 9; R30.3,
 * R30.4, R30.7, R30.13, R30.14, R24.8, R25.7, R25.8). Approved for the Kiroween
 * hackathon demo only (decision H2, EUR base); not a production-provider approval
 * (OD-5 stays open for real use).
 *
 * - Name `ECB-EXR`, kind `REAL`. It answers `getRate(X, EUR)` (and `(EUR, X)`)
 *   with the published quote `{ from: 'EUR', to: X, rate: OBS_VALUE }`; FxService
 *   inverts it into Rate(X/EUR) (FX rules 1 and 9), so every non-euro rate the
 *   application uses is DERIVED (see `fxAttribution`). No other pair, no
 *   triangulation: anything else is `HTTP_CLIENT_ERROR` 404.
 * - Rule 1: one GET to the fixed endpoint for ALL supported non-EUR currencies
 *   (sorted), `endPeriod=<asOf>&lastNObservations=2&detail=dataonly&format=csvdata`,
 *   `Accept: text/csv`, no credentials, over the TLS-verified transport with the
 *   attempt signal. Verified live on 2026-11-09 (U4): the ECB accepts this query
 *   and answers `text/csv` with the fixed header.
 * - Rule 2: `observedAt` is the `ECB-PUB-1600-FRANKFURT-v1` convention instant,
 *   basis `PUBLICATION_CONVENTION`.
 * - Rule 3: the latest row of the currency whose instant is
 *   `<= min(asOf T23:59:59.999Z, at)`; none: 404.
 * - Rule 4: `parseEcbCsv`; any deviation is `INVALID_RESPONSE` (counted by the
 *   circuit breaker through FxService rule 4a).
 * - Rule 5: cache keyed by the exact (`asOf`, `at`); only completed, valid, frozen
 *   responses; LRU bounded by `cacheMaxEntries`. Concurrent callers share one
 *   request; each waits under its own signal; the request is aborted only when
 *   every waiting caller has abandoned it; aborted or failed requests are never
 *   cached.
 * - Rule 6: no client-side limiter; 429 is reported as RATE_LIMITED.
 * - Rule 7: transport outcomes keep their classification; messages name only the
 *   provider and operation, never the URL or body.
 * - No background or scheduled retrieval: a request happens only when FxService
 *   asks for a rate (9.6 retrieval policy unchanged).
 *
 * Known limitation: the `FxProvider` port's `ProviderError` has no Retry-After
 * field, so an ECB `Retry-After` is not passed to `ResilientCall`; the normal
 * backoff applies.
 */
import { CURRENCY_CODE_PATTERN, ECB_SOURCE_NAME, endOfUtcDay, isIsoDate } from '../../fx/index.js';
import type { FxProvider, ProviderFxRate } from '../../fx/index.js';
import { appError, isIsoUtcMillis } from '../../shared/index.js';
import type { AttemptOutcome, ProviderError, ProviderErrorCode, Result } from '../../shared/index.js';
import type { HttpsGetOptions, HttpsResponse } from '../http/index.js';
import { parseEcbCsv } from './ecbCsv.js';
import type { EcbRow } from './ecbCsv.js';
import { ECB_CONVENTION_ID, ecbPublicationInstant } from './ecbConvention.js';

export const ECB_ENDPOINT = 'https://data-api.ecb.europa.eu/service/data/EXR/';
const OPERATION = 'getRate';
const EUR = 'EUR';

/** The 8.2 transport shape (`httpsGet`); tests inject a recording fake. */
export type EcbTransport = (
  url: string,
  options: HttpsGetOptions,
  signal: AbortSignal,
) => Promise<AttemptOutcome<HttpsResponse>>;

export interface EcbFxProviderDependencies {
  readonly transport: EcbTransport;
  /** `fx.supportedCurrencies` without EUR. */
  readonly supportedCurrencies: readonly string[];
  /** `fx.ecb.maxResponseBytes`. */
  readonly maxResponseBytes: number;
  /** `fx.ecb.cacheMaxEntries`. */
  readonly cacheMaxEntries: number;
}

/** The fixed query URL for the sorted currencies and `asOf` (rule 1). */
export function ecbQueryUrl(currencies: readonly string[], asOf: string): string {
  const key = `D.${[...currencies].sort().join('+')}.EUR.SP00.A`;
  return `${ECB_ENDPOINT}${key}?endPeriod=${asOf}&lastNObservations=2&detail=dataonly&format=csvdata`;
}

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set([
  'NETWORK_ERROR',
  'TIMEOUT',
  'RATE_LIMITED',
  'HTTP_SERVER_ERROR',
]);

function failure(code: ProviderErrorCode, httpStatus?: number): { ok: false; error: ProviderError } {
  return {
    ok: false,
    error: Object.freeze({
      ...appError(code, `Provider call ${ECB_SOURCE_NAME} ${OPERATION} failed (${code}).`),
      provider: ECB_SOURCE_NAME,
      operation: OPERATION,
      attempts: 1,
      retryable: RETRYABLE.has(code),
      ...(httpStatus === undefined ? {} : { httpStatus }),
    }),
  };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

type Rows = Result<readonly EcbRow[], ProviderError>;

interface Flight {
  readonly promise: Promise<Rows>;
  readonly controller: AbortController;
  waiters: number;
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function createEcbFxProvider(deps: EcbFxProviderDependencies): FxProvider {
  if (typeof deps.transport !== 'function') {
    throw new TypeError('transport must be a function.');
  }
  const supported: unknown = deps.supportedCurrencies;
  if (
    !Array.isArray(supported) ||
    !supported.every(
      (code) => typeof code === 'string' && CURRENCY_CODE_PATTERN.test(code) && code !== EUR,
    ) ||
    new Set(supported).size !== supported.length
  ) {
    throw new TypeError('supportedCurrencies must be unique non-EUR currency codes.');
  }
  if (!isPositiveInteger(deps.maxResponseBytes) || !isPositiveInteger(deps.cacheMaxEntries)) {
    throw new TypeError('maxResponseBytes and cacheMaxEntries must be positive integers.');
  }
  const currencies: readonly string[] = Object.freeze([...(supported as string[])].sort());
  const { transport, maxResponseBytes, cacheMaxEntries } = deps;
  const cache = new Map<string, readonly EcbRow[]>();
  const inflight = new Map<string, Flight>();

  /** One request for every supported currency (rule 1); never throws for a provider failure. */
  const fetchRows = async (asOf: string, signal: AbortSignal): Promise<Rows> => {
    if (currencies.length === 0) {
      return { ok: true, value: Object.freeze([]) };
    }
    const outcome = await transport(
      ecbQueryUrl(currencies, asOf),
      { headers: { Accept: 'text/csv' }, maxBytes: maxResponseBytes },
      signal,
    );
    if (!outcome.ok) {
      switch (outcome.failure) {
        case 'NETWORK':
          return failure('NETWORK_ERROR');
        case 'TIMEOUT':
          return failure('TIMEOUT');
        case 'TLS':
          return failure('TLS_ERROR');
        case 'INVALID_RESPONSE':
          return failure('INVALID_RESPONSE');
        case 'HTTP':
          if (outcome.status === 429) {
            return failure('RATE_LIMITED', 429);
          }
          return outcome.status >= 500 && outcome.status <= 599
            ? failure('HTTP_SERVER_ERROR', outcome.status)
            : failure('HTTP_CLIENT_ERROR', outcome.status);
      }
    }
    const parsed = parseEcbCsv(outcome.value.body, {
      contentType: firstHeader(outcome.value.headers['content-type']),
      requested: currencies,
      asOf,
      maxBytes: maxResponseBytes,
    });
    return parsed.ok ? { ok: true, value: parsed.value } : failure('INVALID_RESPONSE');
  };

  const remember = (key: string, rows: readonly EcbRow[]): void => {
    cache.delete(key);
    cache.set(key, rows);
    while (cache.size > cacheMaxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done === true) {
        break;
      }
      cache.delete(oldest.value);
    }
  };

  /** Rule 5: cached rows, or a shared in-flight request awaited under the caller's own signal. */
  const rowsFor = (asOf: string, at: string, signal: AbortSignal): Promise<Rows> => {
    const key = `${asOf}|${at}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      remember(key, cached); // refresh LRU position
      return Promise.resolve({ ok: true, value: cached });
    }
    let flight = inflight.get(key);
    if (flight === undefined) {
      const controller = new AbortController();
      const created: Flight = {
        controller,
        waiters: 0,
        promise: fetchRows(asOf, controller.signal).then(
          (result) => {
            if (inflight.get(key) === created) {
              inflight.delete(key);
            }
            if (result.ok && !controller.signal.aborted) {
              remember(key, result.value);
            }
            return result;
          },
          () => {
            if (inflight.get(key) === created) {
              inflight.delete(key);
            }
            return failure('UNEXPECTED_ERROR');
          },
        ),
      };
      inflight.set(key, created);
      flight = created;
    }
    const shared = flight;
    shared.waiters += 1;
    return new Promise<Rows>((resolve) => {
      let settled = false;
      const abandon = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        shared.waiters -= 1;
        if (shared.waiters === 0) {
          // The last waiting caller left: abort and discard the shared request (never cached).
          shared.controller.abort();
          if (inflight.get(key) === shared) {
            inflight.delete(key);
          }
        }
        resolve(failure('TIMEOUT'));
      };
      signal.addEventListener('abort', abandon, { once: true });
      void shared.promise.then((result) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener('abort', abandon);
        shared.waiters -= 1;
        resolve(result);
      });
    });
  };

  /** Rule 3 on the shared rows of (asOf, at). */
  const lookup = async (
    quoted: string,
    asOf: string,
    at: string,
    signal: AbortSignal,
  ): Promise<Result<ProviderFxRate, ProviderError>> => {
    const rows = await rowsFor(asOf, at, signal);
    if (!rows.ok) {
      return rows;
    }
    // Fixed-width IsoUtcMillis text compares chronologically.
    const endOfDay = endOfUtcDay(asOf);
    const bound = endOfDay < at ? endOfDay : at;
    let chosen: { readonly row: EcbRow; readonly instant: string } | undefined;
    for (const row of rows.value) {
      if (row.currency !== quoted) {
        continue;
      }
      const instant = ecbPublicationInstant(row.date);
      if (instant <= bound && (chosen === undefined || row.date > chosen.row.date)) {
        chosen = { row, instant };
      }
    }
    if (chosen === undefined) {
      return failure('HTTP_CLIENT_ERROR', 404);
    }
    return {
      ok: true,
      value: Object.freeze({
        from: EUR,
        to: quoted,
        rate: chosen.row.value,
        observedAt: chosen.instant,
        observedAtBasis: 'PUBLICATION_CONVENTION',
        conventionId: ECB_CONVENTION_ID,
        // OD-20: the ECB reference date D of the published observation.
        referenceDate: chosen.row.date,
        source: ECB_SOURCE_NAME,
        sourceKind: 'REAL',
      }),
    };
  };

  return Object.freeze({
    name: ECB_SOURCE_NAME,
    kind: 'REAL' as const,
    // Not async: argument errors are thrown synchronously, like the fixture provider.
    getRate: (
      from: string,
      to: string,
      asOf: string,
      at: string,
      signal: AbortSignal,
    ): Promise<Result<ProviderFxRate, ProviderError>> => {
      if (typeof from !== 'string' || !CURRENCY_CODE_PATTERN.test(from)) {
        throw new TypeError('from must be a three-letter currency code.');
      }
      if (typeof to !== 'string' || !CURRENCY_CODE_PATTERN.test(to)) {
        throw new TypeError('to must be a three-letter currency code.');
      }
      if (!isIsoDate(asOf)) {
        throw new TypeError('asOf must be a valid YYYY-MM-DD date.');
      }
      if (!isIsoUtcMillis(at)) {
        throw new TypeError('at must be a UTC timestamp YYYY-MM-DDTHH:mm:ss.sssZ.');
      }
      if (!(signal instanceof AbortSignal)) {
        throw new TypeError('signal must be an AbortSignal.');
      }
      if (signal.aborted) {
        return Promise.resolve(failure('TIMEOUT'));
      }
      // Only euro reference rates exist; no other pair and no triangulation.
      const quoted = to === EUR && from !== EUR ? from : from === EUR && to !== EUR ? to : undefined;
      if (quoted === undefined || !currencies.includes(quoted)) {
        return Promise.resolve(failure('HTTP_CLIENT_ERROR', 404));
      }
      return lookup(quoted, asOf, at, signal);
    },
  });
}
