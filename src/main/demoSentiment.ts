/**
 * DEMO sentiment fixture for the explicit demonstration mode (Kiroween decision A1, recorded as
 * DR-KW-1 H9, approved 2026-11-10). Display only.
 *
 * - Provider `demo-sentiment-fixture` with `kind: 'DEMO'`: every observation it produces carries
 *   `sourceKind: 'DEMO'` (the kind comes from the provider, never from the message, R9.7).
 * - Four fixed observations, observed and received at 2026-11-06T15:55:00.000Z, five minutes
 *   before the replay reference clock (2026-11-06T16:00:00.000Z), so they are CURRENT under the
 *   demo-only `sentiment.maxAgeSeconds` 900. With any other clock they keep these timestamps
 *   and show their true age (for example STALE); nothing is re-stamped.
 * - It has no `fetchLatest`: it is never polled, makes no network request, and is not
 *   registered as a provider. `start.ts` records its observations into the sentiment state
 *   once, through the ordinary validation (`normalizeObservation`) and `record` paths.
 * - DEMO sentiment never enters Adjusted VaR (the engine sees `value: null`, status `DEMO`)
 *   and never alerts (R15, R30.11, H7). DEMO-UK -0.72 is deliberately below the -0.60
 *   threshold to show that it still cannot trigger the adjustment.
 * - These are invented values, not market data. No aggregator exists (OD-1 stays open).
 */
import { normalizeObservation } from '../sentiment/index.js';
import type { SentimentObservation, SentimentProvider } from '../sentiment/index.js';

export const DEMO_SENTIMENT_PROVIDER = 'demo-sentiment-fixture';
/** Observation and receipt time of every fixture observation. */
export const DEMO_SENTIMENT_OBSERVED_AT = '2026-11-06T15:55:00.000Z';

/** The approved fixture values (exact decimal text in [-1, +1]). */
export const DEMO_SENTIMENT_VALUES: readonly { readonly ticker: string; readonly value: string }[] = [
  { ticker: 'DEMO-A', value: '0.15' },
  { ticker: 'DEMO-EU', value: '-0.35' },
  { ticker: 'DEMO-UK', value: '-0.72' },
  { ticker: 'DEMO-US', value: '0.42' },
];

export class DemoSentimentFixture implements SentimentProvider {
  readonly name = DEMO_SENTIMENT_PROVIDER;
  readonly kind = 'DEMO' as const;

  /** The fixture observations, validated like any provider message. */
  observations(): SentimentObservation[] {
    return DEMO_SENTIMENT_VALUES.map((entry) => {
      const result = normalizeObservation(
        { ticker: entry.ticker, value: entry.value, observedAt: DEMO_SENTIMENT_OBSERVED_AT },
        { provider: this.name, sourceKind: this.kind, receivedAt: DEMO_SENTIMENT_OBSERVED_AT },
      );
      if (!result.ok) {
        throw new TypeError(`The DEMO sentiment fixture for ${entry.ticker} is invalid.`);
      }
      return result.value;
    });
  }
}
