// Test double for SentimentAggregator (task 13.4). Used only in tests; it is NOT a proposal for
// OD-1. It returns the value of the newest REAL observation inside the window (ties broken by the
// smaller value text, so the result does not depend on input order), or null.
import type { SentimentAggregator } from '../../src/sentiment/index.js';

export const latestRealDouble: SentimentAggregator = {
  version: 'test-double-latest-real',
  aggregate: (observations, now, windowSeconds) => {
    const end = Date.parse(now);
    let best: (typeof observations)[number] | undefined;
    for (const o of observations) {
      const age = end - Date.parse(o.observedAt);
      if (o.sourceKind !== 'REAL' || age < 0 || age > windowSeconds * 1000) {
        continue;
      }
      if (
        best === undefined ||
        o.observedAt > best.observedAt ||
        (o.observedAt === best.observedAt && o.value < best.value)
      ) {
        best = o;
      }
    }
    return best === undefined ? null : best.value;
  },
};
