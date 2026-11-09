/**
 * Guarded SEC client, `getText` only (task 19.2; R6.6 to R6.8, R25.2, R29.8 to
 * R29.11, R29.14, R33.6; design: URL Guard and Client). `getJson` is task 19.3.
 *
 * Pipeline per call:
 * - Options are checked first; an invalid option throws `TypeError` before any
 *   side effect. Per-call limits may only lower the configured limits.
 * - An unset or unusable `SEC_USER_AGENT` gives `SEC_CONFIG_MISSING` with no DNS
 *   query, security event, limiter reservation, or request.
 * - One overall deadline (`timeoutMs`, monotonic) covers DNS, limiter waits,
 *   retries and their waits, every redirect hop, and body streaming.
 * - Each hop: `validate` (first hop) or redirect handling, then `resolveAndCheck`
 *   once with the deadline context (expiry is `SEC_DNS_TIMEOUT` from the guard,
 *   with no security event, and becomes `SEC_TIMEOUT`), then one limiter slot
 *   taken before `ResilientCall.run` (expiry is `SEC_TIMEOUT` and ResilientCall is
 *   never called), then one `ResilientCall.run` whose attempts reuse the hop's
 *   pinned addresses. A retry waits for the limiter inside the attempt; expiry
 *   there aborts the hop's own signal, so ResilientCall ends the call as CANCELLED
 *   (never retried, never counted toward the circuit) and the caller gets
 *   `SEC_TIMEOUT`. Every request goes through the injected `SecTransport`.
 * - Redirects (301, 302, 303, 307, 308 with exactly one Location) are followed
 *   manually: the limit is checked first (`REDIRECT_LIMIT`), then the Location is
 *   validated by the guard (rejections are `SEC_URL_REJECTED` with the guard's
 *   security event), then loops are detected (`REDIRECT_LOOP`) before any DNS
 *   query or request.
 * - Errors are generic and never contain a URL, a Location, a header, or a
 *   socket detail. Bodies are returned as raw bytes (decoding is task 20.2).
 */
import { EnvSchema } from '../config/index.js';
import { appError, assertNever, err, ok } from '../shared/index.js';
import type {
  AppError,
  AttemptOutcome,
  Clock,
  ProviderError,
  ProviderErrorCode,
  ResilientCall,
  Result,
  Sleeper,
} from '../shared/index.js';
import type { SecUrlRejectionReason } from './ports.js';
import type { SecRateLimiter } from './rateLimiter.js';
import type { SecTransport } from './transport.js';
import type {
  ResolvedSecHost,
  SecDnsTimeout,
  SecUrlGuard,
  SecUrlRejected,
  SecurityEventDelivery,
  ValidatedSecUrl,
} from './urlGuard.js';

export interface SecResponse {
  /** 2xx status of the final hop. */
  readonly status: number;
  /** First Content-Type value, as received. */
  readonly contentType?: string;
  /** Raw bytes; charset decoding is task 20.2. */
  readonly body: Uint8Array;
  /** Validated href of the final hop (success results only). */
  readonly finalUrl: string;
}

export type SecErrorCode =
  | 'SEC_CONFIG_MISSING'
  | 'SEC_URL_REJECTED'
  | 'SEC_TIMEOUT'
  | 'SEC_RESPONSE_TOO_LARGE'
  | 'SEC_RATE_LIMITED'
  | 'SEC_TOO_MANY_REDIRECTS'
  | 'SEC_HTTP_ERROR'
  | 'SEC_UNAVAILABLE';

export type SecError = AppError<SecErrorCode> & {
  /** Requests actually started, across all hops. */
  readonly attempts: number;
  readonly httpStatus?: number;
  readonly reason?: SecUrlRejectionReason | 'REDIRECT_LIMIT' | 'REDIRECT_LOOP';
  /** `SEC_URL_REJECTED` only. */
  readonly securityEvent?: SecurityEventDelivery;
  /** Final ResilientCall code, when one exists. */
  readonly cause?: ProviderErrorCode;
};

export interface SecGetTextOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export interface SecClient {
  getText(url: string, opts?: SecGetTextOptions): Promise<Result<SecResponse, SecError>>;
}

export interface SecClientLimits {
  /** `sec.timeoutMs`: one overall deadline per call. */
  readonly timeoutMs: number;
  /** `sec.maxResponseBytes`. */
  readonly maxResponseBytes: number;
  /** `sec.maxRedirects`. */
  readonly maxRedirects: number;
}

export interface SecClientDependencies {
  readonly guard: SecUrlGuard;
  readonly transport: SecTransport;
  readonly limiter: SecRateLimiter;
  readonly resilience: ResilientCall;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  /** The `SEC_USER_AGENT` value, or `undefined` when unset. */
  readonly userAgent: string | undefined;
  readonly limits: SecClientLimits;
}

const PROVIDER = 'sec-edgar';
const OPERATION = 'getText';
const FOLLOWED_REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const OPTION_KEYS: ReadonlySet<string> = new Set(['maxBytes', 'timeoutMs']);
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

type HopValue =
  | {
      readonly kind: 'BODY';
      readonly status: number;
      readonly contentType?: string;
      readonly body: Uint8Array;
    }
  | { readonly kind: 'REDIRECT'; readonly location: string };

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** The usable User-Agent, or undefined when unset or unusable. */
function usableUserAgent(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const parsed = EnvSchema.shape.SEC_USER_AGENT.safeParse(value);
  if (!parsed.success || parsed.data === undefined || !PRINTABLE_ASCII.test(parsed.data)) {
    return undefined;
  }
  return parsed.data;
}

/** Effective limits; throws TypeError for any invalid option (before side effects). */
function effectiveLimits(opts: unknown, limits: SecClientLimits): { maxBytes: number; timeoutMs: number } {
  if (opts === undefined) {
    return { maxBytes: limits.maxResponseBytes, timeoutMs: limits.timeoutMs };
  }
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
    throw new TypeError('getText options must be an object.');
  }
  for (const key of Object.keys(opts)) {
    if (!OPTION_KEYS.has(key)) {
      throw new TypeError('getText options contain an unknown key.');
    }
  }
  const pick = (key: 'maxBytes' | 'timeoutMs', configured: number): number => {
    const value = (opts as Record<string, unknown>)[key];
    if (value === undefined) {
      return configured;
    }
    if (!isPositiveSafeInteger(value) || value > configured) {
      throw new TypeError(
        `getText option ${key} must be a positive integer no greater than the configured limit.`,
      );
    }
    return value;
  };
  return {
    maxBytes: pick('maxBytes', limits.maxResponseBytes),
    timeoutMs: pick('timeoutMs', limits.timeoutMs),
  };
}

const stripForParser = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');

/**
 * The URL to validate for a redirect `Location`. An absolute URL is used as
 * received; a scheme-relative reference is prefixed with `https:` so its authority
 * is checked as written (the parser would drop an empty userinfo); any other
 * reference is resolved against the current validated href.
 */
function redirectCandidate(location: string, currentHref: string): string {
  if (URL.canParse(location)) {
    return location;
  }
  const cleaned = stripForParser(location);
  if (/^[/\\]{2}/.test(cleaned)) {
    return `https:${cleaned}`;
  }
  try {
    return new URL(location, currentHref).href;
  } catch {
    return location;
  }
}

function requestPath(url: ValidatedSecUrl): string {
  const parsed = new URL(url.href);
  return `${parsed.pathname}${parsed.search}`;
}

export function createSecClient(dependencies: SecClientDependencies): SecClient {
  const { guard, transport, limiter, resilience, clock, sleeper, limits } = dependencies;
  if (
    !isPositiveSafeInteger(limits.timeoutMs) ||
    !isPositiveSafeInteger(limits.maxResponseBytes) ||
    !isPositiveSafeInteger(limits.maxRedirects)
  ) {
    throw new RangeError('SEC client limits must be positive integers.');
  }
  const userAgent = usableUserAgent(dependencies.userAgent);

  const failure = (
    code: SecErrorCode,
    attempts: number,
    extra: Omit<SecError, 'code' | 'message' | 'attempts'> = {},
  ): { ok: false; error: SecError } =>
    err({ ...appError(code, `SEC request failed (${code}).`), attempts, ...extra });

  const rejected = (rejection: SecUrlRejected, attempts: number): { ok: false; error: SecError } =>
    failure('SEC_URL_REJECTED', attempts, {
      reason: rejection.reason,
      securityEvent: rejection.securityEvent,
    });

  const fromProvider = (
    error: ProviderError,
    attempts: number,
    oversized: boolean,
  ): { ok: false; error: SecError } => {
    const extra = {
      cause: error.code,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    };
    switch (error.code) {
      case 'TIMEOUT':
        return failure('SEC_TIMEOUT', attempts, extra);
      case 'RATE_LIMITED':
        return failure('SEC_RATE_LIMITED', attempts, extra);
      case 'HTTP_CLIENT_ERROR':
        return failure('SEC_HTTP_ERROR', attempts, extra);
      case 'INVALID_RESPONSE':
        return failure(oversized ? 'SEC_RESPONSE_TOO_LARGE' : 'SEC_UNAVAILABLE', attempts, extra);
      case 'NETWORK_ERROR':
      case 'HTTP_SERVER_ERROR':
      case 'TLS_ERROR':
      case 'CIRCUIT_OPEN':
      case 'CANCELLED':
      case 'UNEXPECTED_ERROR':
        return failure('SEC_UNAVAILABLE', attempts, extra);
      default:
        return assertNever(error.code);
    }
  };

  /** Whole milliseconds left before the deadline (an integer, not a financial value). */
  const remainingMs = (deadline: number): number => Math.floor(deadline - clock.monotonicMs());

  /**
   * `resolveAndCheck` with the deadline context: a signal aborted by a `Sleeper`
   * timer when the remaining budget ends, and that budget as the lookup timeout.
   * The guard returns `SEC_DNS_TIMEOUT` (no security event) on expiry.
   */
  const resolveWithin = async (
    url: ValidatedSecUrl,
    budgetMs: number,
  ): Promise<Result<ResolvedSecHost, SecUrlRejected | SecDnsTimeout>> => {
    const deadline = new AbortController();
    const timer = new AbortController();
    void sleeper.sleep(budgetMs, timer.signal).then((outcome) => {
      if (outcome === 'ELAPSED') {
        deadline.abort();
      }
    });
    try {
      return await guard.resolveAndCheck(url, { signal: deadline.signal, timeoutMs: budgetMs });
    } finally {
      timer.abort();
    }
  };

  return {
    getText: async (url, opts) => {
      const effective = effectiveLimits(opts, limits);
      if (userAgent === undefined) {
        return failure('SEC_CONFIG_MISSING', 0);
      }
      const deadline = clock.monotonicMs() + effective.timeoutMs;
      let attempts = 0;

      const first = guard.validate(url);
      if (!first.ok) {
        return rejected(first.error, attempts);
      }
      let current: ValidatedSecUrl = first.value;
      const visited = new Set<string>();
      let redirects = 0;

      for (;;) {
        visited.add(current.href);

        const dnsBudget = remainingMs(deadline);
        if (dnsBudget <= 0) {
          return failure('SEC_TIMEOUT', attempts);
        }
        const resolution = await resolveWithin(current, dnsBudget);
        if (!resolution.ok) {
          return resolution.error.code === 'SEC_DNS_TIMEOUT'
            ? failure('SEC_TIMEOUT', attempts)
            : rejected(resolution.error, attempts);
        }
        const host = resolution.value;

        // The first attempt's slot is taken before ResilientCall runs. If the limiter
        // cannot grant a slot before the deadline, nothing reaches the provider, and
        // ResilientCall (its retries, circuit, and status) is never involved.
        const hop = new AbortController();
        const firstPermit = await limiter.acquire(deadline, hop.signal);
        if (firstPermit !== 'GRANTED') {
          return failure('SEC_TIMEOUT', attempts);
        }
        const budget = remainingMs(deadline);
        if (budget <= 0) {
          return failure('SEC_TIMEOUT', attempts);
        }
        const path = requestPath(current);
        const headers = {
          Host: host.hostname,
          'User-Agent': userAgent,
          'Accept-Encoding': 'identity',
          Connection: 'close',
        };
        let oversized = false;
        let permitHeld = true;
        let limiterExpired = false;

        const attempt = async (signal: AbortSignal): Promise<AttemptOutcome<HopValue>> => {
          oversized = false;
          if (permitHeld) {
            permitHeld = false;
          } else {
            const permit = await limiter.acquire(deadline, signal);
            if (permit !== 'GRANTED') {
              // A retry that cannot get a slot never reaches the provider. Aborting the
              // hop's own signal ends the call as CANCELLED, which ResilientCall neither
              // retries nor counts toward the circuit (8.2); the caller gets SEC_TIMEOUT.
              limiterExpired = true;
              hop.abort();
              return { ok: false, failure: 'TIMEOUT' };
            }
          }
          if (signal.aborted) {
            return { ok: false, failure: 'TIMEOUT' };
          }
          attempts += 1;
          const outcome = await transport.request({
            host,
            path,
            headers,
            maxBytes: effective.maxBytes,
            signal,
          });
          if (!outcome.ok) {
            switch (outcome.failure) {
              case 'TOO_LARGE':
                oversized = true;
                return { ok: false, failure: 'INVALID_RESPONSE' };
              case 'NETWORK':
              case 'TIMEOUT':
              case 'TLS':
              case 'INVALID_RESPONSE':
                return { ok: false, failure: outcome.failure };
              default:
                return assertNever(outcome.failure);
            }
          }
          const { status } = outcome;
          if (status >= 200 && status <= 299) {
            return {
              ok: true,
              value: {
                kind: 'BODY',
                status,
                body: outcome.body,
                ...(outcome.contentType === undefined ? {} : { contentType: outcome.contentType }),
              },
            };
          }
          if (status >= 300 && status <= 399) {
            const [location, ...extra] = outcome.locations;
            if (!FOLLOWED_REDIRECTS.has(status) || location === undefined || extra.length > 0) {
              return { ok: false, failure: 'INVALID_RESPONSE' };
            }
            return { ok: true, value: { kind: 'REDIRECT', location } };
          }
          return {
            ok: false,
            failure: 'HTTP',
            status,
            ...(outcome.retryAfter === undefined ? {} : { retryAfter: outcome.retryAfter }),
          };
        };

        const result = await resilience.run(PROVIDER, OPERATION, attempt, {
          attemptTimeoutMs: budget,
          deadlineMs: budget,
          signal: hop.signal,
        });
        if (!result.ok) {
          if (limiterExpired) {
            // The retry never reached the provider (CANCELLED inside ResilientCall).
            return failure('SEC_TIMEOUT', attempts);
          }
          return fromProvider(result.error, attempts, oversized);
        }
        const reply = result.value;
        if (reply.kind === 'BODY') {
          return ok({
            status: reply.status,
            body: reply.body,
            finalUrl: current.href,
            ...(reply.contentType === undefined ? {} : { contentType: reply.contentType }),
          });
        }

        if (redirects >= limits.maxRedirects) {
          return failure('SEC_TOO_MANY_REDIRECTS', attempts, { reason: 'REDIRECT_LIMIT' });
        }
        redirects += 1;
        const next = guard.validate(redirectCandidate(reply.location, current.href));
        if (!next.ok) {
          return rejected(next.error, attempts);
        }
        if (visited.has(next.value.href)) {
          return failure('SEC_TOO_MANY_REDIRECTS', attempts, { reason: 'REDIRECT_LOOP' });
        }
        current = next.value;
      }
    },
  };
}
