/**
 * Sentiment provider port and fixture provider (task 13.1; design: Sentiment;
 * R9.1, R9.7, R26.3).
 *
 * `fetchLatest` is one REST attempt: it returns the raw, unvalidated payload (a
 * list of messages) or a failure classification, and the poller runs it through
 * `ResilientCall` (timeouts, retries on 429/5xx with `Retry-After`, circuit
 * breaker; R25). The WebSocket `subscribe` side arrives with task 13.2. The
 * provider's `kind` decides the source kind of every observation (R9.7).
 */
import type { AttemptOutcome, DataSourceKind } from '../shared/index.js';

export interface SentimentProvider {
  readonly name: string;
  readonly kind: DataSourceKind;
  /** One attempt; the success value is unvalidated and is checked message by message. */
  fetchLatest?(tickers: readonly string[], signal: AbortSignal): Promise<AttemptOutcome<unknown>>;
}

export interface FixtureSentimentProviderOptions {
  readonly name: string;
  readonly kind: DataSourceKind;
  /** Outcomes returned in order; the last one repeats. */
  readonly responses: readonly AttemptOutcome<unknown>[];
}

/** A provider for tests and demonstrations; it never contacts a network. */
export class FixtureSentimentProvider implements SentimentProvider {
  readonly name: string;
  readonly kind: DataSourceKind;
  readonly calls: (readonly string[])[] = [];
  private readonly responses: readonly AttemptOutcome<unknown>[];

  constructor(options: FixtureSentimentProviderOptions) {
    if (options.responses.length === 0) {
      throw new TypeError('FixtureSentimentProvider needs at least one response.');
    }
    this.name = options.name;
    this.kind = options.kind;
    this.responses = options.responses;
  }

  fetchLatest(tickers: readonly string[]): Promise<AttemptOutcome<unknown>> {
    const index = Math.min(this.calls.length, this.responses.length - 1); // index only
    this.calls.push([...tickers]);
    const response = this.responses[index];
    if (response === undefined) {
      throw new TypeError('FixtureSentimentProvider has no response.');
    }
    return Promise.resolve(response);
  }
}
