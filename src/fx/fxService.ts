/**
 * FX service (task 10.1; R30.1 to R30.5, R30.7, R30.8, R22.3; design: FX rules).
 *
 * `rateToBase(currency, asOf, at)` returns `Rate(X/B)`, the units of base
 * currency B per one unit of X, for converting market values (R30.4).
 *
 * Method and assumptions (financial-rules 13):
 * 1. Direction and pair: `pair` is always the requested `X + B`, `rate` always
 *    `Rate(X/B)`; an inverse quote is converted, never kept in its orientation.
 * 2. Identity: for `X = B` the rate is exactly "1", source `BASE_CURRENCY`,
 *    source kind `IDENTITY`, `observedAt: null`, status `CURRENT` (assigned, not
 *    from `dataStatus`). No provider call; no timestamp is fabricated.
 * 3. Arguments: a three-letter code, a `YYYY-MM-DD` date, and an `IsoUtcMillis`
 *    calculation timestamp `at`, otherwise `TypeError`. A currency outside
 *    `fx.supportedCurrencies` is `FX_UNAVAILABLE` (`UNSUPPORTED_CURRENCY`) with
 *    no provider call.
 * 4. The provider is called as `getRate(X, B, asOf, at, signal)` through `ResilientCall`
 *    (circuit key `fx:<provider name>`), with the attempt signal (U9) and, when
 *    configured, a provider-specific attempt timeout (`attemptTimeoutMs`, for the
 *    ECB adapter `fx.ecb.timeoutMs`). Its `ProviderError` keeps its
 *    classification as an attempt outcome; provider-returned CIRCUIT_OPEN,
 *    CANCELLED, or UNEXPECTED_ERROR are unexpected outcomes (UNEXPECTED_ERROR).
 *    Attempt timeouts and cancellation are classified by `ResilientCall`. A final
 *    `ProviderError` is `FX_UNAVAILABLE` (`PROVIDER_ERROR`, with `providerCode`).
 * 4a. Rules 5 and 6 run inside the `ResilientCall` operation: rejected provider
 *    data is the non-retryable INVALID_RESPONSE outcome, counted by the circuit
 *    breaker, and gives `FX_UNAVAILABLE` (`INVALID_RESPONSE`).
 * 5. The provider result is validated with a strict schema; the pair must be
 *    `(X, B)` or `(B, X)`; `source` and `sourceKind` must equal the configured
 *    provider's `name` and `kind`; the timestamp basis (task 10.4) must be
 *    `PROVIDER` without `conventionId` or `PUBLICATION_CONVENTION` with a valid
 *    `conventionId`, and both are copied unchanged into the result.
 * 6. Selection bound (R30.7): `observedAt <= min(end of asOf in UTC, at)`,
 *    validated independently of the provider. No other rate is requested.
 * 7. Staleness (R30.8): stale when `at - observedAt > fx.maxRateAgeSeconds`
 *    (strictly greater, millisecond resolution), measured here for every source
 *    kind. A stale rate is `FX_STALE` with a display-only `StaleFxRate`.
 * 8. Status of a fresh rate: `dataStatus` with `now` = `at` as a Date: `CURRENT`
 *    for REAL, `DEMO` for DEMO. Any other status is `FX_UNAVAILABLE`
 *    (`INVALID_RESPONSE`); `rateToBase` never throws for it.
 * 9. Arithmetic: direct `toCanonical(d(text))`; inverse
 *    `toCanonical(d('1').dividedBy(d(text)))`, one division in the project
 *    Decimal configuration (40 significant digits, ROUND_HALF_UP).
 * 10. No triangulation, substitution, or fallback.
 * 11. Deterministic: selection and staleness read no clock; results are frozen.
 * 12. No persistence and no last valid value: `lastValid`, `RATE_CONFLICT`, and
 *     `RECORD_FAILED` are declared for task 10.3 and never set here. Rates are
 *     held constant across scenarios (A-9; FX scenario risk is OD-4).
 *
 * Validates: Requirements 30.1, 30.2, 30.3, 30.4, 30.5, 30.7, 30.8, 30.13, 22.3.
 */
import {
  Iso4217Code,
  appError,
  d,
  dataStatus,
  err,
  isIsoUtcMillis,
  ok,
  toCanonical,
} from '../shared/index.js';
import type {
  AppError,
  AttemptOutcome,
  DataSourceKind,
  DecimalString,
  ProviderError,
  ProviderErrorCode,
  ResilientCall,
  Result,
} from '../shared/index.js';
import { CURRENCY_CODE_PATTERN, ProviderFxRateSchema, endOfUtcDay, isIsoDate } from './normalize.js';
import type { ValidatedProviderFxRate } from './normalize.js';
import type { FxProvider, ObservedAtBasis, ProviderFxRate } from './ports.js';

/** The timestamp basis of a validated rate, with `conventionId` only when present (task 10.4). */
const basisOf = (
  quote: ValidatedProviderFxRate,
): { readonly observedAtBasis: ObservedAtBasis; readonly conventionId?: string } =>
  quote.conventionId === undefined
    ? { observedAtBasis: quote.observedAtBasis }
    : { observedAtBasis: quote.observedAtBasis, conventionId: quote.conventionId };

/** The only FX type a calculation accepts; never stale. */
export type FxRateUsed =
  | {
      readonly kind: 'OBSERVED';
      readonly pair: string;
      readonly rate: DecimalString;
      readonly observedAt: string;
      /** Task 10.4: copied unchanged from the validated provider rate. */
      readonly observedAtBasis: ObservedAtBasis;
      readonly conventionId?: string;
      readonly source: string;
      readonly sourceKind: DataSourceKind;
      readonly status: 'CURRENT' | 'DEMO';
    }
  | {
      readonly kind: 'IDENTITY';
      readonly pair: string;
      readonly rate: '1';
      readonly observedAt: null;
      readonly source: 'BASE_CURRENCY';
      readonly sourceKind: 'IDENTITY';
      readonly status: 'CURRENT';
    };

/** Display only. Its `kind` and `status` make it unassignable to `FxRateUsed`. */
export interface StaleFxRate {
  readonly kind: 'STALE_DISPLAY';
  readonly pair: string;
  readonly rate: DecimalString;
  readonly observedAt: string;
  /** Task 10.4: copied unchanged from the validated provider rate. */
  readonly observedAtBasis: ObservedAtBasis;
  readonly conventionId?: string;
  readonly source: string;
  readonly sourceKind: DataSourceKind;
  readonly status: 'STALE';
}

export type FxUnavailableCause =
  | 'PROVIDER_ERROR'
  | 'INVALID_RESPONSE'
  | 'UNSUPPORTED_CURRENCY'
  // Set only by task 10.3:
  | 'RATE_CONFLICT'
  | 'RECORD_FAILED';

export type FxError =
  | (AppError<'FX_UNAVAILABLE'> & {
      readonly currency: string;
      readonly cause: FxUnavailableCause;
      readonly providerCode?: ProviderErrorCode;
      /** Task 10.3 only; display only. */
      readonly lastValid?: StaleFxRate;
    })
  | (AppError<'FX_STALE'> & { readonly currency: string; readonly displayRate: StaleFxRate });

export interface FxService {
  rateToBase(currency: string, asOf: string, at: string): Promise<Result<FxRateUsed, FxError>>;
}

/** Precision of every FX derivation: the project Decimal configuration (FR-14). */
export const FX_DERIVATION_PRECISION = 'SIGNIFICANT_DIGITS_40_ROUND_HALF_UP';

/**
 * OD-20: the provider's quote behind one rate, as received (canonical text, numerically
 * exact), with how the rate was obtained from it. Never part of `FxRateUsed`, so risk
 * inputs and snapshots are unchanged; the 10.3 recorder persists it.
 */
export interface FxQuoteProvenance {
  /** The quote's orientation `from + to` (for the ECB `EUR + X`). */
  readonly pair: string;
  readonly rate: DecimalString;
  /** The provider's reference date, when it reports one (the ECB adapter does). */
  readonly referenceDate?: string;
  /** `AS_PUBLISHED` for a direct quote, `DECIMAL_INVERSE` for `1 / quote` (FX rules 1 and 9). */
  readonly method: 'AS_PUBLISHED' | 'DECIMAL_INVERSE';
  readonly precision: typeof FX_DERIVATION_PRECISION;
}

export interface QuotedFxResult {
  readonly result: Result<FxRateUsed, FxError>;
  /** Present for `OBSERVED` rates and `FX_STALE` display rates; `null` otherwise. */
  readonly quote: FxQuoteProvenance | null;
}

/** The FX service with the quote behind each rate (used by the 10.3 recorder). */
export interface QuotedFxService extends FxService {
  rateToBaseQuoted(currency: string, asOf: string, at: string): Promise<QuotedFxResult>;
}

export interface FxServiceDependencies {
  readonly provider: FxProvider;
  readonly resilientCall: ResilientCall;
  /** `fx.baseCurrency`. */
  readonly baseCurrency: string;
  /** `fx.supportedCurrencies`; must include the base currency. */
  readonly supportedCurrencies: readonly string[];
  /** `fx.maxRateAgeSeconds`; a positive integer, never defaulted. */
  readonly maxRateAgeSeconds: number;
  /**
   * Provider-specific per-attempt timeout replacing `provider.timeoutMs` (for the
   * ECB adapter `fx.ecb.timeoutMs`, R25.7); absent: the shared policy applies.
   */
  readonly attemptTimeoutMs?: number;
}

export const FX_OPERATION = 'getRate';

/** Circuit and status key of an FX provider in `ResilientCall` (FX rule 4). */
export const fxCircuitKey = (providerName: string): string => `fx:${providerName}`;

const isKnownCode = (value: unknown): value is string => Iso4217Code.safeParse(value).success;

function assertDependencies(deps: FxServiceDependencies): void {
  const provider = deps.provider as Partial<FxProvider> | undefined;
  if (
    typeof provider !== 'object' ||
    provider === null ||
    typeof provider.name !== 'string' ||
    provider.name.length === 0 ||
    (provider.kind !== 'REAL' && provider.kind !== 'DEMO') ||
    typeof provider.getRate !== 'function'
  ) {
    throw new TypeError('provider must be an FxProvider with a name and a REAL or DEMO kind.');
  }
  if (typeof (deps.resilientCall as Partial<ResilientCall> | undefined)?.run !== 'function') {
    throw new TypeError('resilientCall must be a ResilientCall.');
  }
  if (!isKnownCode(deps.baseCurrency)) {
    throw new TypeError('baseCurrency must be an ISO 4217 code.');
  }
  const supported: unknown = deps.supportedCurrencies;
  if (
    !Array.isArray(supported) ||
    !supported.every(isKnownCode) ||
    new Set(supported).size !== supported.length ||
    !supported.includes(deps.baseCurrency)
  ) {
    throw new TypeError('supportedCurrencies must be unique ISO 4217 codes including baseCurrency.');
  }
  const seconds = deps.maxRateAgeSeconds;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isSafeInteger(seconds * 1000)) {
    throw new TypeError('maxRateAgeSeconds must be a positive integer.');
  }
  const timeout = deps.attemptTimeoutMs;
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0)) {
    throw new TypeError('attemptTimeoutMs must be a positive integer when present.');
  }
}

/** Thrown inside the attempt; `ResilientCall` reports it as `UNEXPECTED_ERROR` (not retried). */
const unexpectedProviderOutcome = (): Error => new Error('FX provider returned an unexpected outcome.');

/**
 * Maps the provider's `Result` to one `ResilientCall` attempt outcome (FX rule 4),
 * preserving its classification. Provider-returned CIRCUIT_OPEN, CANCELLED, or
 * UNEXPECTED_ERROR, and a value that is not a `Result`, are unexpected provider
 * outcomes. Real attempt timeouts and cancellation never reach this function:
 * `ResilientCall` classifies them from the attempt signal.
 */
function toAttempt(result: Result<ProviderFxRate, ProviderError>): AttemptOutcome<unknown> {
  const candidate = result as unknown as { ok?: unknown; error?: { code?: unknown } } | null;
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
      // Unexpected provider outcome; ResilientCall reports UNEXPECTED_ERROR (not retried).
      throw unexpectedProviderOutcome();
  }
}

/** A provider rate that passed FX rules 5 and 6. */
interface AcceptedQuote {
  readonly quote: ValidatedProviderFxRate;
  /** True for `(X, B)`, false for the inverse `(B, X)`. */
  readonly direct: boolean;
}

export function createFxService(deps: FxServiceDependencies): QuotedFxService {
  assertDependencies(deps);
  const { provider, resilientCall, baseCurrency, attemptTimeoutMs } = deps;
  const supported: ReadonlySet<string> = new Set(deps.supportedCurrencies);
  const maxAgeMs = deps.maxRateAgeSeconds * 1000;
  const circuitKey = fxCircuitKey(provider.name);

  /** FX rules 5 and 6; `undefined` when the provider data must be rejected. */
  const acceptQuote = (
    value: unknown,
    currency: string,
    asOf: string,
    at: string,
  ): AcceptedQuote | undefined => {
    const parsed = ProviderFxRateSchema.safeParse(value);
    if (!parsed.success) {
      return undefined;
    }
    const quote = parsed.data;
    const direct = quote.from === currency && quote.to === baseCurrency;
    const inverse = quote.from === baseCurrency && quote.to === currency;
    if ((!direct && !inverse) || quote.source !== provider.name || quote.sourceKind !== provider.kind) {
      return undefined;
    }
    // Selection bound, validated independently of the provider. Fixed-width
    // IsoUtcMillis text compares chronologically.
    const endOfDay = endOfUtcDay(asOf);
    const bound = endOfDay < at ? endOfDay : at;
    if (quote.observedAt > bound) {
      return undefined;
    }
    return { quote, direct };
  };

  const unavailable = (
    currency: string,
    cause: 'PROVIDER_ERROR' | 'INVALID_RESPONSE' | 'UNSUPPORTED_CURRENCY',
    providerCode?: ProviderErrorCode,
  ): { readonly ok: false; readonly error: FxError } =>
    err(
      Object.freeze({
        ...appError('FX_UNAVAILABLE', `FX rate ${currency}${baseCurrency} is unavailable (${cause}).`),
        currency,
        cause,
        ...(providerCode === undefined ? {} : { providerCode }),
      }),
    );

  const evaluate = async (
    currency: string,
    asOf: string,
    at: string,
    onQuote: (quote: FxQuoteProvenance) => void,
  ): Promise<Result<FxRateUsed, FxError>> => {
    {
      // Rule 3: programmer errors throw before anything else.
      if (typeof currency !== 'string' || !CURRENCY_CODE_PATTERN.test(currency)) {
        throw new TypeError('currency must be a three-letter currency code.');
      }
      if (!isIsoDate(asOf)) {
        throw new TypeError('asOf must be a valid YYYY-MM-DD date.');
      }
      if (!isIsoUtcMillis(at)) {
        throw new TypeError('at must be a UTC timestamp YYYY-MM-DDTHH:mm:ss.sssZ.');
      }
      const pair = `${currency}${baseCurrency}`;

      // Rule 2: identity.
      if (currency === baseCurrency) {
        return ok(
          Object.freeze({
            kind: 'IDENTITY',
            pair,
            rate: '1',
            observedAt: null,
            source: 'BASE_CURRENCY',
            sourceKind: 'IDENTITY',
            status: 'CURRENT',
          }),
        );
      }
      if (!supported.has(currency)) {
        return unavailable(currency, 'UNSUPPORTED_CURRENCY');
      }

      // Rules 4, 4a, 5, and 6: one provider call through ResilientCall. Validation runs
      // inside the operation, so invalid provider data is a non-retryable INVALID_RESPONSE
      // outcome that counts toward the circuit breaker (task 8.2).
      let attempts = 0;
      let rejectedAttempt = 0;
      const called = await resilientCall.run<AcceptedQuote>(
        circuitKey,
        FX_OPERATION,
        async (signal) => {
          attempts += 1;
          const attempt = attempts; // index only, not a financial value
          // U9: the attempt signal reaches the provider, so a timed-out attempt stops its I/O.
          const outcome = toAttempt(await provider.getRate(currency, baseCurrency, asOf, at, signal));
          if (!outcome.ok) {
            return outcome;
          }
          const accepted = acceptQuote(outcome.value, currency, asOf, at);
          if (accepted === undefined) {
            rejectedAttempt = attempt;
            return { ok: false, failure: 'INVALID_RESPONSE' };
          }
          return { ok: true, value: accepted };
        },
        attemptTimeoutMs === undefined ? undefined : { attemptTimeoutMs },
      );
      if (!called.ok) {
        // Rule 4a: only the last attempt's own rejection counts as the service's INVALID_RESPONSE.
        return called.error.code === 'INVALID_RESPONSE' && rejectedAttempt === attempts
          ? unavailable(currency, 'INVALID_RESPONSE')
          : unavailable(currency, 'PROVIDER_ERROR', called.error.code);
      }
      const { quote, direct } = called.value;

      // Rule 9: Rate(X/B) as a canonical decimal string.
      const rate = direct ? toCanonical(d(quote.rate)) : toCanonical(d('1').dividedBy(d(quote.rate)));
      // OD-20: the provider's quote as received (canonical text), beside the derived rate.
      onQuote(
        Object.freeze({
          pair: `${quote.from}${quote.to}`,
          rate: toCanonical(d(quote.rate)),
          ...(quote.referenceDate === undefined ? {} : { referenceDate: quote.referenceDate }),
          method: direct ? 'AS_PUBLISHED' : 'DECIMAL_INVERSE',
          precision: FX_DERIVATION_PRECISION,
        }),
      );

      // Rule 7: staleness, for every source kind (age in ms; integers, not financial values).
      const ageMs = Date.parse(at) - Date.parse(quote.observedAt);
      if (ageMs > maxAgeMs) {
        const displayRate: StaleFxRate = Object.freeze({
          kind: 'STALE_DISPLAY',
          pair,
          rate,
          observedAt: quote.observedAt,
          ...basisOf(quote),
          source: quote.source,
          sourceKind: quote.sourceKind,
          status: 'STALE',
        });
        return err(
          Object.freeze({
            ...appError('FX_STALE', `FX rate ${pair} is older than the maximum rate age.`),
            currency,
            displayRate,
          }),
        );
      }

      // Rule 8: status of a fresh rate.
      const status = dataStatus({
        sourceKind: quote.sourceKind,
        observedAt: quote.observedAt,
        now: new Date(at),
        maxAgeMs,
        fromCache: false,
      });
      if (status !== 'CURRENT' && status !== 'DEMO') {
        // Not expected after rules 5 to 7. Never thrown: the Result contract holds.
        return unavailable(currency, 'INVALID_RESPONSE');
      }
      return ok(
        Object.freeze({
          kind: 'OBSERVED',
          pair,
          rate,
          observedAt: quote.observedAt,
          ...basisOf(quote),
          source: quote.source,
          sourceKind: quote.sourceKind,
          status,
        }),
      );
    }
  };

  return {
    rateToBase: (currency, asOf, at) => evaluate(currency, asOf, at, () => undefined),
    rateToBaseQuoted: async (currency, asOf, at) => {
      let quote: FxQuoteProvenance | null = null;
      const result = await evaluate(currency, asOf, at, (q) => {
        quote = q;
      });
      // A quote is reported only with the rate it explains: OBSERVED, or the display rate of FX_STALE.
      const explained = result.ok ? result.value.kind === 'OBSERVED' : result.error.code === 'FX_STALE';
      return Object.freeze({ result, quote: explained ? quote : null });
    },
  };
}
