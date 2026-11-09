/**
 * Provider resilience: retries, timeouts, cancellation, and a circuit breaker
 * (task 8.2; design: Provider Resilience Layer; R25.1, R25.2, R25.6 to R25.9, R33.9).
 *
 * `ResilientCall.run(provider, operation, fn, opts)` calls `fn` at most
 * `1 + maxRetries` times and always resolves to a `Result`; it never rejects.
 *
 * - `fn` reports each attempt as an `AttemptOutcome`. Expected failures are
 *   values. A thrown or rejected exception, or a return value that is not an
 *   `AttemptOutcome`, is `UNEXPECTED_ERROR` (non-retryable, never classified as a
 *   network error); the original is logged through the redacting logger and the
 *   returned error is generic. With the run option `exceptionLogging:
 *   'METADATA_ONLY'` (task 21.1, used for NLP providers) the original is never
 *   logged: only provider, operation, code, attempt number, and failure kind.
 * - Retried: network errors, attempt timeouts, HTTP 429, HTTP 5xx. Not retried:
 *   other 4xx, invalid responses, TLS errors, cancellation, open circuits,
 *   unexpected errors.
 * - Backoff before retry r (zero-based) is full jitter:
 *   floor(random() * (min(maxDelayMs, baseDelayMs * 2^r) + 1)) ms. A parseable
 *   `Retry-After` on a retryable HTTP outcome makes the wait max(backoff, it). A
 *   `Retry-After` longer than `maxRetryAfterMs` ends the call at once with that
 *   attempt's own classification (429 RATE_LIMITED, 5xx HTTP_SERVER_ERROR, which
 *   counts toward the circuit); the wait is never shortened to retry earlier.
 * - Every attempt has its own AbortSignal and is raced against its timeout and
 *   the caller's signal, so an `fn` that never settles cannot hang `run`; a late
 *   result or rejection of an abandoned attempt is consumed and ignored.
 * - Elapsed time and the optional `deadlineMs` use the monotonic clock. No attempt
 *   starts and no wait begins that would end at or after the deadline.
 * - Caller cancellation aborts the current attempt or wait at once (`CANCELLED`).
 *
 * Circuit breaker, in memory per provider: complete calls (not attempts) that end
 * in NETWORK_ERROR, TIMEOUT, HTTP_SERVER_ERROR, INVALID_RESPONSE, or TLS_ERROR
 * count; a success resets the count; other failures leave it unchanged. After
 * `failureThreshold` consecutive qualifying failures the circuit opens; calls get
 * CIRCUIT_OPEN without calling `fn`. After `openMs` exactly one half-open probe is
 * admitted: success closes; any other result (qualifying or not) is returned to
 * its caller and reopens the circuit for a fresh full `openMs`, without being
 * counted as a qualifying failure. Outcomes of calls admitted before the circuit
 * opened are ignored while it is open.
 *
 * Time, waiting, and randomness are injected (`Clock`, `Sleeper`, `random`).
 */
import type { Clock } from './clock.js';
import type { AppError } from './errors.js';
import type { Logger } from './logger.js';
import type { Result } from './result.js';
import { parseRetryAfterMs } from './retryAfter.js';
import type { Sleeper } from './sleeper.js';

export type ProviderErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'HTTP_SERVER_ERROR'
  | 'HTTP_CLIENT_ERROR'
  | 'INVALID_RESPONSE'
  | 'CIRCUIT_OPEN'
  | 'CANCELLED'
  | 'TLS_ERROR'
  | 'UNEXPECTED_ERROR';

export type ProviderError = AppError<ProviderErrorCode> & {
  /** Provider identifier (never a URL or payload). */
  readonly provider: string;
  /** Operation identifier. */
  readonly operation: string;
  /** Provider calls actually made. */
  readonly attempts: number;
  /** Whether the final failure is of a retryable kind. */
  readonly retryable: boolean;
  readonly httpStatus?: number;
};

/** One attempt as reported by `fn`. */
export type AttemptOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: 'NETWORK' | 'TIMEOUT' | 'INVALID_RESPONSE' | 'TLS' }
  | { readonly ok: false; readonly failure: 'HTTP'; readonly status: number; readonly retryAfter?: string };

export interface RetryPolicy {
  /** Additional attempts after the first (provider.maxRetries). */
  readonly maxRetries: number;
  /** Per-attempt timeout (provider.timeoutMs, or a provider-specific timeout). */
  readonly attemptTimeoutMs: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /**
   * Largest `Retry-After` wait honoured (provider.retryAfter.maxMs). A longer valid
   * `Retry-After` ends the call at once with the attempt's own code (429 RATE_LIMITED,
   * 5xx HTTP_SERVER_ERROR) instead of waiting or retrying early.
   */
  readonly maxRetryAfterMs: number;
  /** Optional overall budget for the complete call. */
  readonly deadlineMs?: number;
}

export interface CircuitPolicy {
  readonly failureThreshold: number;
  readonly openMs: number;
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type ProviderState = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE';

export interface ProviderStatus {
  readonly provider: string;
  readonly state: ProviderState;
  readonly circuit: CircuitState;
  /** Wall-clock time of the last change of `state`. */
  readonly since: string;
  /** Code of the last failed call (open-circuit and cancelled calls excluded). */
  readonly lastErrorCode?: ProviderErrorCode;
}

/**
 * How an unexpected exception or malformed outcome is logged (task 21.1).
 * `FULL` (the default, 8.2 behaviour) logs the original through the redacting
 * logger. `METADATA_ONLY` never logs the original exception, its message, or the
 * returned value: only the provider identity, operation, code, attempt number, and
 * failure kind. Any value other than `FULL` is treated as `METADATA_ONLY`.
 */
export type ExceptionLogging = 'FULL' | 'METADATA_ONLY';

export type RunOptions = Partial<RetryPolicy> & {
  readonly signal?: AbortSignal;
  readonly exceptionLogging?: ExceptionLogging;
};

export interface ResilientCall {
  run<T>(
    provider: string,
    operation: string,
    fn: (signal: AbortSignal) => Promise<AttemptOutcome<T>>,
    opts?: RunOptions,
  ): Promise<Result<T, ProviderError>>;
  status(provider: string): ProviderStatus;
}

export interface ResilientCallDependencies {
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  /** Uniform random number in [0, 1), for jitter. */
  readonly random: () => number;
  readonly logger: Logger;
  readonly retry: Omit<RetryPolicy, 'deadlineMs'>;
  readonly circuit: CircuitPolicy;
}

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set([
  'NETWORK_ERROR',
  'TIMEOUT',
  'RATE_LIMITED',
  'HTTP_SERVER_ERROR',
]);
const QUALIFYING: ReadonlySet<ProviderErrorCode> = new Set([
  'NETWORK_ERROR',
  'TIMEOUT',
  'HTTP_SERVER_ERROR',
  'INVALID_RESPONSE',
  'TLS_ERROR',
]);

interface Failure {
  readonly code: ProviderErrorCode;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
}

type AttemptResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Failure };

interface CircuitRecord {
  circuit: CircuitState;
  consecutiveFailures: number;
  openedAt: number;
  probeInFlight: boolean;
  retrying: number;
  state: ProviderState;
  since: string;
  lastErrorCode?: ProviderErrorCode;
}

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Rejects a policy that would make retries or waits ill-defined (a programmer error). */
function validatePolicy(policy: RetryPolicy, circuit: CircuitPolicy): void {
  const ok =
    isNonNegativeInteger(policy.maxRetries) &&
    isNonNegativeInteger(policy.attemptTimeoutMs) &&
    policy.attemptTimeoutMs > 0 &&
    isNonNegativeInteger(policy.baseDelayMs) &&
    isNonNegativeInteger(policy.maxDelayMs) &&
    policy.baseDelayMs <= policy.maxDelayMs &&
    isNonNegativeInteger(policy.maxRetryAfterMs) &&
    policy.maxRetryAfterMs > 0 &&
    (policy.deadlineMs === undefined || isNonNegativeInteger(policy.deadlineMs)) &&
    isNonNegativeInteger(circuit.failureThreshold) &&
    circuit.failureThreshold > 0 &&
    isNonNegativeInteger(circuit.openMs);
  if (!ok) {
    throw new RangeError('Invalid retry or circuit policy.');
  }
}

/** Maps a validated attempt outcome to a failure; `undefined` for anything that is not an AttemptOutcome. */
function classifyOutcome<T>(outcome: unknown, now: Date): AttemptResult<T> | undefined {
  if (typeof outcome !== 'object' || outcome === null) {
    return undefined;
  }
  const record = outcome as Record<string, unknown>;
  if (record['ok'] === true) {
    return 'value' in record ? { ok: true, value: record['value'] as T } : undefined;
  }
  if (record['ok'] !== false) {
    return undefined;
  }
  switch (record['failure']) {
    case 'NETWORK':
      return { ok: false, failure: { code: 'NETWORK_ERROR' } };
    case 'TIMEOUT':
      return { ok: false, failure: { code: 'TIMEOUT' } };
    case 'INVALID_RESPONSE':
      return { ok: false, failure: { code: 'INVALID_RESPONSE' } };
    case 'TLS':
      return { ok: false, failure: { code: 'TLS_ERROR' } };
    case 'HTTP': {
      const status = record['status'];
      const retryAfter = record['retryAfter'];
      if (!Number.isSafeInteger(status) || (retryAfter !== undefined && typeof retryAfter !== 'string')) {
        return undefined;
      }
      const httpStatus = status as number;
      if (httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599)) {
        const retryAfterMs = parseRetryAfterMs(retryAfter as string | undefined, now);
        return {
          ok: false,
          failure: {
            code: httpStatus === 429 ? 'RATE_LIMITED' : 'HTTP_SERVER_ERROR',
            httpStatus,
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          },
        };
      }
      if (httpStatus >= 400 && httpStatus <= 499) {
        return { ok: false, failure: { code: 'HTTP_CLIENT_ERROR', httpStatus } };
      }
      return { ok: false, failure: { code: 'INVALID_RESPONSE', httpStatus } };
    }
    default:
      return undefined;
  }
}

export function createResilientCall(deps: ResilientCallDependencies): ResilientCall {
  const { clock, sleeper, random, logger } = deps;
  const circuits = new Map<string, CircuitRecord>();
  const nowIso = (): string => clock.nowUtc().toISOString();

  const recordOf = (provider: string): CircuitRecord => {
    let record = circuits.get(provider);
    if (record === undefined) {
      record = {
        circuit: 'CLOSED',
        consecutiveFailures: 0,
        openedAt: 0,
        probeInFlight: false,
        retrying: 0,
        state: 'AVAILABLE',
        since: nowIso(),
      };
      circuits.set(provider, record);
    }
    return record;
  };

  const refresh = (record: CircuitRecord): void => {
    const state: ProviderState =
      record.circuit === 'OPEN'
        ? 'UNAVAILABLE'
        : record.circuit === 'HALF_OPEN' || record.retrying > 0
          ? 'DEGRADED'
          : 'AVAILABLE';
    if (state !== record.state) {
      record.state = state;
      record.since = nowIso();
    }
  };

  type UnexpectedKind = 'EXCEPTION' | 'MALFORMED_OUTCOME' | 'INTERNAL';

  const logUnexpected = (
    provider: string,
    operation: string,
    error: unknown,
    detail: { readonly metadataOnly: boolean; readonly kind: UnexpectedKind; readonly attempt?: number },
  ): void => {
    try {
      if (detail.metadataOnly) {
        // Never the original: no exception object, message, stack, or returned value.
        logger.error('Provider call failed with an unexpected exception.', {
          code: 'UNEXPECTED_ERROR',
          provider,
          operation,
          failure: detail.kind,
          ...(detail.attempt === undefined ? {} : { attempt: detail.attempt }),
        });
        return;
      }
      logger.error('Provider call failed with an unexpected exception.', {
        code: 'UNEXPECTED_ERROR',
        provider,
        operation,
        error,
      });
    } catch {
      // A failing logger never changes the result.
    }
  };

  const isMetadataOnly = (opts: RunOptions | undefined): boolean =>
    opts?.exceptionLogging !== undefined && opts.exceptionLogging !== 'FULL';

  const fail = (
    provider: string,
    operation: string,
    failure: Failure,
    attempts: number,
  ): { ok: false; error: ProviderError } => ({
    ok: false,
    error: {
      code: failure.code,
      message: `Provider call ${provider} ${operation} failed (${failure.code}).`,
      provider,
      operation,
      attempts,
      retryable: RETRYABLE.has(failure.code),
      ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
    },
  });

  /** One attempt, raced against its timeout and the caller's cancellation. */
  async function attempt<T>(
    provider: string,
    operation: string,
    fn: (signal: AbortSignal) => Promise<AttemptOutcome<T>>,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
    logging: { readonly metadataOnly: boolean; readonly attempt: number },
  ): Promise<AttemptResult<T>> {
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    try {
      type Settled = { kind: 'value'; value: unknown } | { kind: 'error'; error: unknown };
      // Promise.resolve().then(...) also captures a synchronous throw from fn.
      const settled: Promise<Settled> = Promise.resolve()
        .then(() => fn(controller.signal))
        .then(
          (value): Settled => ({ kind: 'value', value }),
          (error: unknown): Settled => ({ kind: 'error', error }),
        );
      type Timed = { kind: 'timeout' } | { kind: 'aborted' };
      const timer: Promise<Timed> = sleeper
        .sleep(timeoutMs, controller.signal)
        .then((outcome): Timed => (outcome === 'ELAPSED' ? { kind: 'timeout' } : { kind: 'aborted' }));
      const first = await Promise.race([settled, timer]);
      if (callerSignal?.aborted === true) {
        return { ok: false, failure: { code: 'CANCELLED' } };
      }
      if (first.kind === 'timeout') {
        return { ok: false, failure: { code: 'TIMEOUT' } };
      }
      if (first.kind === 'aborted') {
        // Only the caller can abort the attempt before the race ends.
        return { ok: false, failure: { code: 'CANCELLED' } };
      }
      if (first.kind === 'error') {
        logUnexpected(provider, operation, first.error, { ...logging, kind: 'EXCEPTION' });
        return { ok: false, failure: { code: 'UNEXPECTED_ERROR' } };
      }
      const classified = classifyOutcome<T>(first.value, clock.nowUtc());
      if (classified === undefined) {
        logUnexpected(
          provider,
          operation,
          new TypeError('fn returned a value that is not an AttemptOutcome.'),
          {
            ...logging,
            kind: 'MALFORMED_OUTCOME',
          },
        );
        return { ok: false, failure: { code: 'UNEXPECTED_ERROR' } };
      }
      return classified;
    } finally {
      // Ends the attempt: aborts fn and the timeout timer. A late settlement is ignored.
      controller.abort();
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }

  function backoffMs(retry: number, policy: RetryPolicy): number {
    const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** retry);
    const r = random();
    if (typeof r !== 'number' || !(r >= 0 && r < 1)) {
      throw new RangeError('random() must return a number in [0, 1).');
    }
    return Math.floor(r * (cap + 1));
  }

  async function execute<T>(
    provider: string,
    operation: string,
    fn: (signal: AbortSignal) => Promise<AttemptOutcome<T>>,
    opts: RunOptions,
  ): Promise<Result<T, ProviderError>> {
    const { signal, exceptionLogging, ...overrides } = opts;
    const metadataOnly = exceptionLogging !== undefined && exceptionLogging !== 'FULL';
    const policy: RetryPolicy = { ...deps.retry, ...overrides };
    validatePolicy(policy, deps.circuit);
    if (typeof fn !== 'function') {
      throw new TypeError('ResilientCall.run requires a function.');
    }
    if (signal?.aborted === true) {
      return fail(provider, operation, { code: 'CANCELLED' }, 0);
    }

    const record = recordOf(provider);
    let probe = false;
    if (record.circuit === 'OPEN') {
      if (clock.monotonicMs() - record.openedAt < deps.circuit.openMs) {
        return fail(provider, operation, { code: 'CIRCUIT_OPEN' }, 0);
      }
      record.circuit = 'HALF_OPEN';
    }
    if (record.circuit === 'HALF_OPEN') {
      if (record.probeInFlight) {
        return fail(provider, operation, { code: 'CIRCUIT_OPEN' }, 0);
      }
      record.probeInFlight = true;
      probe = true;
    }
    refresh(record);

    let attempts = 0;
    let last: Failure | undefined;
    let final: Failure | undefined;
    let value: { readonly v: T } | undefined;
    try {
      const start = clock.monotonicMs();
      const deadline = policy.deadlineMs === undefined ? undefined : start + policy.deadlineMs;
      for (let retry = 0; ; retry += 1) {
        const remaining = deadline === undefined ? Infinity : deadline - clock.monotonicMs();
        if (remaining <= 0) {
          final = last ?? { code: 'TIMEOUT' };
          break;
        }
        attempts += 1;
        const outcome = await attempt(
          provider,
          operation,
          fn,
          Math.min(policy.attemptTimeoutMs, remaining),
          signal,
          { metadataOnly, attempt: attempts },
        );
        if (outcome.ok) {
          value = { v: outcome.value };
          break;
        }
        if (outcome.failure.code === 'CANCELLED') {
          final = outcome.failure;
          break;
        }
        last = outcome.failure;
        if (!RETRYABLE.has(last.code) || retry >= policy.maxRetries) {
          final = last;
          break;
        }
        if (last.retryAfterMs !== undefined && last.retryAfterMs > policy.maxRetryAfterMs) {
          // The provider asks for a longer pause than allowed: stop now, never retry earlier.
          // The failure keeps its own classification (429 RATE_LIMITED, 5xx HTTP_SERVER_ERROR).
          final = last;
          break;
        }
        const wait = Math.max(backoffMs(retry, policy), last.retryAfterMs ?? 0);
        if (deadline !== undefined && clock.monotonicMs() + wait >= deadline) {
          final = last;
          break;
        }
        record.retrying += 1;
        refresh(record);
        let slept: Awaited<ReturnType<Sleeper['sleep']>>;
        try {
          slept = await sleeper.sleep(wait, signal);
        } finally {
          record.retrying -= 1;
          refresh(record);
        }
        if (slept === 'ABORTED') {
          final = { code: 'CANCELLED' };
          break;
        }
      }
    } finally {
      settleCircuit(record, probe, attempts, value !== undefined, final);
    }
    if (value !== undefined) {
      return { ok: true, value: value.v };
    }
    return fail(provider, operation, final ?? { code: 'UNEXPECTED_ERROR' }, attempts);
  }

  function settleCircuit(
    record: CircuitRecord,
    probe: boolean,
    attempts: number,
    succeeded: boolean,
    failure: Failure | undefined,
  ): void {
    if (probe) {
      record.probeInFlight = false;
    }
    if (failure !== undefined && failure.code !== 'CANCELLED' && failure.code !== 'CIRCUIT_OPEN') {
      record.lastErrorCode = failure.code;
    }
    if (probe) {
      // The single half-open probe decides: success closes; any other result, qualifying or
      // not, reopens the circuit for a fresh full cooldown (a non-qualifying result is not
      // counted as a qualifying failure; the count only matters while closed).
      if (succeeded) {
        record.circuit = 'CLOSED';
        record.consecutiveFailures = 0;
      } else {
        record.circuit = 'OPEN';
        record.openedAt = clock.monotonicMs();
      }
      refresh(record);
      return;
    }
    const admittedWhileOpen = record.circuit !== 'CLOSED';
    if (attempts === 0 || admittedWhileOpen) {
      refresh(record);
      return;
    }
    if (succeeded) {
      record.consecutiveFailures = 0;
    } else if (failure !== undefined && QUALIFYING.has(failure.code)) {
      record.consecutiveFailures += 1;
      if (record.consecutiveFailures >= deps.circuit.failureThreshold) {
        record.circuit = 'OPEN';
        record.openedAt = clock.monotonicMs();
      }
    }
    refresh(record);
  }

  return {
    run: async (provider, operation, fn, opts = {}) => {
      try {
        return await execute(provider, operation, fn, opts);
      } catch (error) {
        logUnexpected(provider, operation, error, { metadataOnly: isMetadataOnly(opts), kind: 'INTERNAL' });
        return fail(provider, operation, { code: 'UNEXPECTED_ERROR' }, 0);
      }
    },
    status: (provider) => {
      const record = recordOf(provider);
      return {
        provider,
        state: record.state,
        circuit: record.circuit,
        since: record.since,
        ...(record.lastErrorCode === undefined ? {} : { lastErrorCode: record.lastErrorCode }),
      };
    },
  };
}
