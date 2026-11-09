/**
 * REST sentiment poller (task 13.1; design: Sentiment, REST poller; R9.1, R9.5,
 * R10.7, R25.1, R25.2).
 *
 * - Each poll is one `ResilientCall` run under the provider's name, operation
 *   `fetchLatest`, so timeouts, retries, `Retry-After`, and the circuit breaker
 *   apply (R25). A payload that is not a list of messages is `INVALID_RESPONSE`
 *   (non-retryable, counts toward the circuit breaker).
 * - Every message is validated on its own (`normalizeObservation`). An invalid
 *   message is reported to `onRejected` (the app layer audits it as
 *   `VALIDATION`) and never clamped; the other messages are still delivered
 *   (R9.5, R10.7). Valid observations go to `sink` in received order.
 * - `run` polls every `sentiment.rest.pollSeconds` (class O, optional) until the
 *   signal aborts; a failed poll is reported to `onProviderError` and polling
 *   continues. Waiting goes through the injected `Sleeper`.
 */
import type { Clock, ProviderError, ResilientCall, Sleeper } from '../shared/index.js';
import { normalizeObservation } from './observation.js';
import type { ObservationRejection, SentimentObservation } from './observation.js';
import type { SentimentProvider } from './provider.js';

export const SENTIMENT_FETCH_OPERATION = 'fetchLatest';

export interface PollSummary {
  readonly accepted: number;
  readonly rejected: number;
}

export interface SentimentPoller {
  pollOnce(signal?: AbortSignal): Promise<PollSummary | ProviderError>;
  run(signal: AbortSignal): Promise<void>;
}

export interface SentimentPollerDependencies {
  readonly provider: SentimentProvider;
  readonly resilientCall: ResilientCall;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  /** `sentiment.rest.pollSeconds`: a positive integer. */
  readonly pollSeconds: number;
  readonly tickers: () => readonly string[];
  readonly sink: (observation: SentimentObservation) => void;
  readonly onRejected: (rejection: ObservationRejection, context: { readonly provider: string }) => void;
  readonly onProviderError: (error: ProviderError) => void;
}

export function createSentimentPoller(deps: SentimentPollerDependencies): SentimentPoller {
  const { provider } = deps;
  const fetch = provider.fetchLatest?.bind(provider);
  if (fetch === undefined) {
    throw new TypeError('The sentiment provider has no REST fetchLatest operation.');
  }
  if (!Number.isSafeInteger(deps.pollSeconds) || deps.pollSeconds <= 0) {
    throw new TypeError('pollSeconds must be a positive integer.');
  }

  const pollOnce = async (signal?: AbortSignal): Promise<PollSummary | ProviderError> => {
    const tickers = [...deps.tickers()];
    const result = await deps.resilientCall.run<readonly unknown[]>(
      provider.name,
      SENTIMENT_FETCH_OPERATION,
      async (attemptSignal) => {
        const outcome = await fetch(tickers, attemptSignal);
        if (!outcome.ok) {
          return outcome;
        }
        return Array.isArray(outcome.value)
          ? { ok: true, value: outcome.value as readonly unknown[] }
          : { ok: false, failure: 'INVALID_RESPONSE' };
      },
      signal === undefined ? {} : { signal },
    );
    if (!result.ok) {
      return result.error;
    }
    const receivedAt = deps.clock.nowUtc().toISOString();
    let accepted = 0;
    let rejected = 0;
    for (const message of result.value) {
      const observation = normalizeObservation(message, {
        provider: provider.name,
        sourceKind: provider.kind,
        receivedAt,
      });
      if (observation.ok) {
        accepted += 1;
        deps.sink(observation.value);
      } else {
        rejected += 1;
        deps.onRejected(observation.error, { provider: provider.name });
      }
    }
    return { accepted, rejected };
  };

  return {
    pollOnce,
    run: async (signal) => {
      while (!signal.aborted) {
        const outcome = await pollOnce(signal);
        if ('code' in outcome) {
          deps.onProviderError(outcome);
        }
        if ((await deps.sleeper.sleep(deps.pollSeconds * 1000, signal)) === 'ABORTED') {
          return;
        }
      }
    },
  };
}
