/**
 * Filing analyzer (task 21.1; R7.1, R7.7, R8.3 to R8.7, R21.1, R21.3, R21.5,
 * R33.7; design: NLP port and FilingRiskScore).
 *
 * - `analyze` accepts only a `FilingText` (TypeError otherwise, before any provider
 *   call), so sentiment text can never reach filing scoring (R8.6).
 * - One `ResilientCall.run` per analysis, with `attemptTimeoutMs = nlp.timeoutMs`
 *   and `maxRetries = nlp.maxRetries`; backoff, the Retry-After limit, and the
 *   circuit come from the injected ResilientCall (`provider.*`, 8.2).
 * - Inside each attempt the provider's success value is validated with
 *   `FilingAnalysisSchema`. Invalid output becomes the non-retryable outcome
 *   `INVALID_RESPONSE`; it is never retried, clamped, coerced, trimmed, or
 *   defaulted. Valid output is returned exactly as received.
 * - Failures are always `NLP_FAILED` with no score (R7.7, R33.7) and a typed
 *   cause: NLP_TIMEOUT, NLP_INVALID_OUTPUT, or the final ResilientCall code.
 * - The analyzer sets `mode`, `sourceKind`, and `analyzedAt` (injected Clock);
 *   providers cannot. A `FallbackNlpProvider` (or no provider) is `FALLBACK` /
 *   `DEMO`; anything else is `REAL` / `REAL`. A failed primary is never replaced
 *   by the fallback.
 * - Identities: `nlp-filing:real:<name>` and `nlp-filing:fallback`, so the
 *   primary and the fallback never share circuit state.
 * - Privacy: a provider exception or rejection is replaced inside the attempt by
 *   a contentless `NlpProviderException`, and every run uses
 *   `exceptionLogging: 'METADATA_ONLY'`, so no provider exception, message, or
 *   filing text is ever logged; only identity, code, attempt number, and failure
 *   kind. Validation failures are not logged at all.
 * - The method `fallback-placeholder` is reserved for `FallbackNlpProvider`: a
 *   REAL provider returning it is `NLP_INVALID_OUTPUT` (not retried).
 * - No chunking or input-length logic (21.2, OD-15). No audit entry (21.3 or the
 *   app layer; `nlp/` cannot import `audit/`).
 */
import { FilingText, appError, assertNever, err, ok } from '../shared/index.js';
import type {
  AppError,
  AttemptOutcome,
  Clock,
  ProviderError,
  ProviderErrorCode,
  ResilientCall,
  Result,
} from '../shared/index.js';
import { FALLBACK_METHOD, FallbackNlpProvider } from './fallbackProvider.js';
import { FilingAnalysisSchema } from './ports.js';
import type { FilingAnalysis, FilingNlpProvider } from './ports.js';

export type NlpMode = 'REAL' | 'FALLBACK';
export type NlpSourceKind = 'REAL' | 'DEMO';

export type NlpFailureCause = 'NLP_TIMEOUT' | 'NLP_INVALID_OUTPUT' | Exclude<ProviderErrorCode, 'TIMEOUT'>;

export type NlpError = AppError<'NLP_FAILED'> & {
  readonly cause: NlpFailureCause;
  /** Provider name. */
  readonly provider: string;
  readonly mode: NlpMode;
  /** Provider calls made. */
  readonly attempts: number;
  readonly httpStatus?: number;
};

export interface FilingAnalysisResult {
  readonly analysis: FilingAnalysis;
  readonly provider: string;
  readonly mode: NlpMode;
  readonly sourceKind: NlpSourceKind;
  /** `clock.nowUtc()` when the analysis completed, `YYYY-MM-DDTHH:mm:ss.sssZ`. */
  readonly analyzedAt: string;
}

export interface FilingAnalyzer {
  analyze(text: FilingText): Promise<Result<FilingAnalysisResult, NlpError>>;
}

export interface FilingAnalyzerSettings {
  /** `nlp.timeoutMs`. */
  readonly timeoutMs: number;
  /** `nlp.maxRetries`. */
  readonly maxRetries: number;
}

export interface FilingAnalyzerDependencies {
  /** The configured provider; absent means the fallback provider. */
  readonly provider?: FilingNlpProvider;
  readonly resilience: ResilientCall;
  readonly clock: Clock;
  readonly settings: FilingAnalyzerSettings;
}

const PROVIDER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const OPERATION = 'analyzeFiling';

/**
 * Replaces any provider exception before it reaches ResilientCall. It has a fixed
 * message and no `cause`, so the original (which may contain filing text) is
 * never logged or returned, whatever the logging mode.
 */
class NlpProviderException extends Error {
  constructor() {
    super('NLP provider call failed.');
    this.name = 'NlpProviderException';
  }
}

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function causeOf(error: ProviderError, invalidOutput: boolean): NlpFailureCause {
  switch (error.code) {
    case 'TIMEOUT':
      return 'NLP_TIMEOUT';
    case 'INVALID_RESPONSE':
      return invalidOutput ? 'NLP_INVALID_OUTPUT' : 'INVALID_RESPONSE';
    case 'NETWORK_ERROR':
    case 'RATE_LIMITED':
    case 'HTTP_SERVER_ERROR':
    case 'HTTP_CLIENT_ERROR':
    case 'CIRCUIT_OPEN':
    case 'CANCELLED':
    case 'TLS_ERROR':
    case 'UNEXPECTED_ERROR':
      return error.code;
    default:
      return assertNever(error.code);
  }
}

export function createFilingAnalyzer(dependencies: FilingAnalyzerDependencies): FilingAnalyzer {
  const { resilience, clock, settings } = dependencies;
  if (!isPositiveSafeInteger(settings.timeoutMs) || !isNonNegativeSafeInteger(settings.maxRetries)) {
    throw new RangeError(
      'nlp.timeoutMs must be a positive integer and nlp.maxRetries a non-negative integer.',
    );
  }
  const provider = dependencies.provider ?? new FallbackNlpProvider();
  if (typeof provider.name !== 'string' || !PROVIDER_NAME.test(provider.name)) {
    throw new TypeError('NLP provider name must match [a-z0-9][a-z0-9._-]{0,63}.');
  }
  const mode: NlpMode = provider instanceof FallbackNlpProvider ? 'FALLBACK' : 'REAL';
  const sourceKind: NlpSourceKind = mode === 'FALLBACK' ? 'DEMO' : 'REAL';
  const identity = mode === 'FALLBACK' ? 'nlp-filing:fallback' : `nlp-filing:real:${provider.name}`;
  const providerName = provider.name;

  const failure = (error: ProviderError, invalidOutput: boolean): { ok: false; error: NlpError } =>
    err({
      ...appError('NLP_FAILED', 'Filing analysis failed (NLP_FAILED).'),
      cause: causeOf(error, invalidOutput),
      provider: providerName,
      mode,
      attempts: error.attempts,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    });

  return {
    analyze: async (text) => {
      if (!(text instanceof FilingText)) {
        throw new TypeError('FilingAnalyzer.analyze accepts only FilingText.');
      }
      let invalidOutput = false;
      const attempt = async (signal: AbortSignal): Promise<AttemptOutcome<FilingAnalysis>> => {
        invalidOutput = false;
        let outcome: unknown;
        try {
          outcome = await provider.analyzeFiling(text, signal);
        } catch {
          // The original exception may contain filing text: it never leaves this module.
          throw new NlpProviderException();
        }
        if (
          typeof outcome === 'object' &&
          outcome !== null &&
          (outcome as { ok?: unknown }).ok === true &&
          'value' in outcome
        ) {
          const parsed = FilingAnalysisSchema.safeParse((outcome as { value: unknown }).value);
          if (!parsed.success || (mode === 'REAL' && parsed.data.method === FALLBACK_METHOD)) {
            // Invalid output, or a REAL provider claiming the reserved fallback method.
            invalidOutput = true;
            return { ok: false, failure: 'INVALID_RESPONSE' };
          }
          return { ok: true, value: parsed.data };
        }
        // Failures (and anything malformed) go to ResilientCall unchanged.
        return outcome as AttemptOutcome<FilingAnalysis>;
      };

      const result = await resilience.run(identity, OPERATION, attempt, {
        attemptTimeoutMs: settings.timeoutMs,
        maxRetries: settings.maxRetries,
        // Provider exceptions may contain filing text: log only safe metadata.
        exceptionLogging: 'METADATA_ONLY',
      });
      if (!result.ok) {
        return failure(result.error, invalidOutput);
      }
      return ok(
        Object.freeze({
          analysis: Object.freeze({
            ...result.value,
            categories: Object.freeze([...result.value.categories]),
          }),
          provider: providerName,
          mode,
          sourceKind,
          analyzedAt: clock.nowUtc().toISOString(),
        }) as FilingAnalysisResult,
      );
    },
  };
}
