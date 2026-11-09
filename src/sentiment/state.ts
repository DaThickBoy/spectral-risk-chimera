/**
 * Sentiment state, ingestion rules, and freshness (task 13.3, plus the
 * transport-independent ingestion rules of task 13.2; design: Sentiment, REST
 * and WebSocket ingestion flow; FR-8; R9.5, R9.6, R9.8, R9.9, R10.4, R10.6,
 * R15.2, R15.13).
 *
 * `record(observation)`:
 * - `FUTURE_DATED`: `observedAt` more than `sentiment.maxFutureSkewSeconds`
 *   after the clock; rejected and not stored (R9.9).
 * - `DUPLICATE`: same provider and message id, or, without an id, the same
 *   provider, ticker, observation time, and value (R9.5). State changes once.
 * - `HISTORY`: older than the latest accepted observation of the same provider
 *   and ticker; kept as history, never the current state (R9.8).
 * - `ACCEPTED`: becomes the latest observation of its provider and ticker.
 * History is bounded per ticker (`historyLimit`, oldest dropped first). History observations
 * never enter the aggregation, so a late message cannot change the current index.
 *
 * `view(ticker)` (pure in the clock time it reads):
 * - `index`: the aggregate of the ticker's retained observations from the
 *   injected `SentimentAggregator` (OD-1; none is approved, so in production the
 *   index is absent). Its `observedAt` is the observation time of the newest
 *   `REAL` observation inside the aggregation window (interim basis, pending
 *   OD-1), and its status follows FR-8 (`sentimentFreshness`). When the window
 *   becomes empty the last valid index is retained with its timestamp and ages
 *   to `STALE` (R10.6, R15.13); it is never `CURRENT` once older than
 *   `sentiment.maxAgeSeconds`.
 * - `latest`: the newest accepted observation of any provider and source kind,
 *   for display only, with its own status and `DEMO` label.
 * `forRisk(ticker)` gives the engine's `SentimentForRisk` (value, status, source
 * kind, observedAt) or `undefined` when nothing was ever received (`ABSENT`).
 */
import type { SentimentIndex } from '../shared/index.js';
import type { SentimentAggregator } from './aggregator.js';
import { sentimentFreshness } from './freshness.js';
import type { SentimentStatus } from './freshness.js';
import type { SentimentObservation } from './observation.js';

export type RecordOutcome = 'ACCEPTED' | 'DUPLICATE' | 'HISTORY' | 'FUTURE_DATED';

export interface SentimentIndexView {
  readonly value: SentimentIndex;
  readonly observedAt: string;
  /** Provider of the newest REAL observation behind the index (interim basis, pending OD-1). */
  readonly source: string;
  readonly status: Exclude<SentimentStatus, 'UNAVAILABLE'>;
  readonly aggregatorVersion: string;
}

export interface SentimentView {
  readonly ticker: string;
  /** Aggregated index from REAL observations; `null` when none is available. */
  readonly index: SentimentIndexView | null;
  /** Display only: newest accepted observation of any source kind. */
  readonly latest: {
    readonly value: SentimentIndex;
    readonly observedAt: string;
    readonly receivedAt: string;
    readonly provider: string;
    readonly sourceKind: 'REAL' | 'DEMO';
    readonly status: Exclude<SentimentStatus, 'UNAVAILABLE'>;
  } | null;
}

/** The shape the risk engine consumes (`risk/types.ts` `SentimentForRisk`). */
export interface SentimentRiskEntry {
  readonly ticker: string;
  readonly value: SentimentIndex | null;
  readonly status: SentimentStatus;
  readonly sourceKind: 'REAL' | 'DEMO';
  /** Provider behind the value or status (R32.1). */
  readonly source: string;
  readonly aggregatorVersion?: string;
  readonly observedAt?: string;
}

export interface SentimentState {
  record(observation: SentimentObservation): RecordOutcome;
  view(ticker: string): SentimentView;
  forRisk(ticker: string): SentimentRiskEntry | undefined;
  /** Tickers with at least one retained observation, sorted. */
  tickers(): readonly string[];
}

export interface SentimentStateDependencies {
  readonly clock: { nowUtc(): Date };
  /** `sentiment.maxAgeSeconds`. */
  readonly maxAgeSeconds: number;
  /** `sentiment.maxFutureSkewSeconds`. */
  readonly maxFutureSkewSeconds: number;
  /** `sentiment.windowSeconds` (at most `maxAgeSeconds`, enforced by the configuration). */
  readonly windowSeconds: number;
  /** Absent until OD-1 approves a formula (task 13.5). */
  readonly aggregator?: SentimentAggregator;
  /** Retained observations per ticker (a count, not a financial value). */
  readonly historyLimit: number;
}

const positiveInt = (value: number, min: number): boolean => Number.isSafeInteger(value) && value >= min;

const dedupeKey = (o: SentimentObservation): string =>
  o.messageId === undefined
    ? `${o.provider}\u0000${o.ticker}\u0000${o.observedAt}\u0000${o.value}`
    : `${o.provider}\u0000id\u0000${o.messageId}`;

export function createSentimentState(deps: SentimentStateDependencies): SentimentState {
  if (
    !positiveInt(deps.maxAgeSeconds, 1) ||
    !positiveInt(deps.maxFutureSkewSeconds, 0) ||
    !positiveInt(deps.windowSeconds, 1) ||
    deps.windowSeconds > deps.maxAgeSeconds ||
    !positiveInt(deps.historyLimit, 1)
  ) {
    throw new TypeError(
      'Sentiment state settings are invalid (windowSeconds must not exceed maxAgeSeconds).',
    );
  }
  /** ticker -> retained observations in arrival order; history ones never enter the index (R9.8). */
  const retained = new Map<
    string,
    { readonly observation: SentimentObservation; readonly history: boolean }[]
  >();
  /** provider + ticker -> latest accepted observation time. */
  const latestByProvider = new Map<string, string>();
  /** ticker -> newest accepted observation (any provider). */
  const latestByTicker = new Map<string, SentimentObservation>();
  /** Dedupe keys, bounded together with the retained observations. */
  const seen = new Map<string, number>();
  /** ticker -> last valid index (R10.6). */
  const lastIndex = new Map<
    string,
    { value: SentimentIndex; observedAt: string; source: string; aggregatorVersion: string }
  >();

  const now = (): string => deps.clock.nowUtc().toISOString();
  const statusOf = (observedAt: string, at: string): Exclude<SentimentStatus, 'UNAVAILABLE'> =>
    sentimentFreshness(observedAt, at, deps.maxAgeSeconds) === 'CURRENT' ? 'CURRENT' : 'STALE';

  const retain = (observation: SentimentObservation, history: boolean): void => {
    const list = retained.get(observation.ticker) ?? [];
    list.push({ observation, history });
    while (list.length > deps.historyLimit) {
      const dropped = list.shift();
      if (dropped !== undefined) {
        const key = dedupeKey(dropped.observation);
        const count = (seen.get(key) ?? 1) - 1;
        if (count <= 0) {
          seen.delete(key);
        } else {
          seen.set(key, count);
        }
      }
    }
    retained.set(observation.ticker, list);
    const key = dedupeKey(observation);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  };

  /** Newest REAL observation inside the window ending at `at`. */
  const newestRealInWindow = (
    list: readonly SentimentObservation[],
    at: string,
  ): SentimentObservation | undefined => {
    const end = Date.parse(at);
    let newest: SentimentObservation | undefined;
    for (const o of list) {
      const t = Date.parse(o.observedAt);
      if (o.sourceKind === 'REAL' && t <= end && end - t <= deps.windowSeconds * 1000) {
        if (newest === undefined || o.observedAt > newest.observedAt) {
          newest = o;
        }
      }
    }
    return newest;
  };

  const currentIndex = (ticker: string, at: string): SentimentIndexView | null => {
    const list = (retained.get(ticker) ?? []).filter((e) => !e.history).map((e) => e.observation);
    const aggregator = deps.aggregator;
    if (aggregator !== undefined) {
      const value = aggregator.aggregate(list, at, deps.windowSeconds);
      const asOf = newestRealInWindow(list, at);
      if (value !== null && asOf !== undefined) {
        lastIndex.set(ticker, {
          value,
          observedAt: asOf.observedAt,
          source: asOf.provider,
          aggregatorVersion: aggregator.version,
        });
      }
    }
    const last = lastIndex.get(ticker);
    return last === undefined ? null : { ...last, status: statusOf(last.observedAt, at) };
  };

  return {
    record: (observation) => {
      const at = now();
      if (Date.parse(observation.observedAt) - Date.parse(at) > deps.maxFutureSkewSeconds * 1000) {
        return 'FUTURE_DATED';
      }
      if (seen.has(dedupeKey(observation))) {
        return 'DUPLICATE';
      }
      const providerKey = `${observation.provider}\u0000${observation.ticker}`;
      const latest = latestByProvider.get(providerKey);
      if (latest !== undefined && observation.observedAt < latest) {
        retain(observation, true);
        return 'HISTORY';
      }
      retain(observation, false);
      latestByProvider.set(providerKey, observation.observedAt);
      const newest = latestByTicker.get(observation.ticker);
      if (newest === undefined || observation.observedAt >= newest.observedAt) {
        latestByTicker.set(observation.ticker, observation);
      }
      // R10.4: the index is updated on arrival, so the last valid value never depends on reads.
      currentIndex(observation.ticker, at);
      return 'ACCEPTED';
    },
    view: (ticker) => {
      const at = now();
      const latest = latestByTicker.get(ticker);
      return {
        ticker,
        index: currentIndex(ticker, at),
        latest:
          latest === undefined
            ? null
            : {
                value: latest.value,
                observedAt: latest.observedAt,
                receivedAt: latest.receivedAt,
                provider: latest.provider,
                sourceKind: latest.sourceKind,
                status: statusOf(latest.observedAt, at),
              },
      };
    },
    forRisk: (ticker) => {
      const at = now();
      const latest = latestByTicker.get(ticker);
      if (latest === undefined) {
        return undefined;
      }
      const index = currentIndex(ticker, at);
      if (index !== null) {
        return {
          ticker,
          value: index.value,
          status: index.status,
          sourceKind: 'REAL',
          source: index.source,
          aggregatorVersion: index.aggregatorVersion,
          observedAt: index.observedAt,
        };
      }
      const newestReal = (retained.get(ticker) ?? [])
        .filter((e) => e.observation.sourceKind === 'REAL')
        .map((e) => e.observation)
        .reduce<SentimentObservation | undefined>(
          (a, o) => (a === undefined || o.observedAt > a.observedAt ? o : a),
          undefined,
        );
      return newestReal !== undefined
        ? { ticker, value: null, status: 'UNAVAILABLE', sourceKind: 'REAL', source: newestReal.provider }
        : {
            ticker,
            value: null,
            status: statusOf(latest.observedAt, at),
            sourceKind: 'DEMO',
            source: latest.provider,
            observedAt: latest.observedAt,
          };
    },
    tickers: () => [...retained.keys()].sort(),
  };
}
