/**
 * Sentiment aggregator interface (task 13.4; design: Sentiment, Aggregator U-2;
 * R10.1 to R10.3, R21.2). No formula is implemented here: the numeric
 * aggregation is an open decision (OD-1, task 13.5 blocked), and
 * `windowed-mean-v1` is only a proposal.
 *
 * Contract (checked by `test/contracts/sentimentAggregator.contract.ts`, which
 * every implementation must pass):
 * - the result is `null` or a valid `SentimentIndex` in [-1, +1];
 * - deterministic: the same observations and `now` give the same result,
 *   independent of input order;
 * - Decimal.js arithmetic only, on the exact decimal text;
 * - only `REAL` observations contribute; `DEMO` observations never do;
 * - `null` when no `REAL` observation lies within `sentiment.windowSeconds`
 *   before `now`;
 * - `version` identifies the formula and changes whenever it changes.
 */
import type { SentimentIndex } from '../shared/index.js';
import type { SentimentObservation } from './observation.js';

export interface SentimentAggregator {
  readonly version: string;
  /** `now` is `YYYY-MM-DDTHH:mm:ss.sssZ`; `windowSeconds` is `sentiment.windowSeconds`. */
  aggregate(
    observations: readonly SentimentObservation[],
    now: string,
    windowSeconds: number,
  ): SentimentIndex | null;
}
