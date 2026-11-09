/**
 * Data freshness labels and last-valid-data retention (task 8.2; design:
 * Provider Resilience Layer; R25.3, R25.4, R25.5, R33.10).
 *
 * `dataStatus` is pure. Precedence:
 *   1. `DEMO` when the source kind is DEMO (demo data is never current);
 *   2. `UNAVAILABLE` when the source kind, `observedAt`, `now`, or `maxAgeMs` is
 *      missing or invalid, or `observedAt` lies after `now` (no threshold means no
 *      freshness claim; there is no default);
 *   3. `STALE` when `now - observedAt > maxAgeMs`;
 *   4. `CACHED` when the value was served from the store instead of a fresh fetch;
 *   5. otherwise `CURRENT`.
 * `LAST_VALID` is not a freshness value: it describes that a stored result exists.
 *
 * `LastValidStore` keeps the newest successfully fetched value per key. Only
 * `recordSuccess` writes, so a failed fetch can never overwrite or remove it, and
 * nothing exists for a key that was never fetched successfully. Values are
 * deep-copied on write and read, so callers cannot change stored data.
 */
import { isIsoUtcMillis } from './timestamps.js';

export type DataFreshness = 'CURRENT' | 'STALE' | 'CACHED' | 'UNAVAILABLE' | 'DEMO';
/** Whether data comes from a real provider or a demo source (not the import `SourceKind`). */
export type DataSourceKind = 'REAL' | 'DEMO';

export interface DataStatusInput {
  readonly sourceKind?: DataSourceKind | undefined;
  /** Canonical UTC timestamp of the observation. */
  readonly observedAt?: string | undefined;
  readonly now: Date;
  /** Caller-supplied freshness threshold; absent means `UNAVAILABLE`. */
  readonly maxAgeMs?: number | undefined;
  /** True when the value comes from the store rather than this fetch. */
  readonly fromCache: boolean;
}

export function dataStatus(input: DataStatusInput): DataFreshness {
  if (input.sourceKind === 'DEMO') {
    return 'DEMO';
  }
  const { observedAt, now, maxAgeMs } = input;
  if (
    input.sourceKind !== 'REAL' ||
    !isIsoUtcMillis(observedAt) ||
    !(now instanceof Date) ||
    Number.isNaN(now.getTime()) ||
    typeof maxAgeMs !== 'number' ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs < 0
  ) {
    return 'UNAVAILABLE';
  }
  const ageMs = now.getTime() - Date.parse(observedAt);
  if (ageMs < 0) {
    return 'UNAVAILABLE';
  }
  if (ageMs > maxAgeMs) {
    return 'STALE';
  }
  return input.fromCache === true ? 'CACHED' : 'CURRENT';
}

export interface StoredValue<V> {
  readonly value: V;
  readonly observedAt: string;
}

export class LastValidStore<K, V> {
  private readonly entries = new Map<K, StoredValue<V>>();

  /**
   * Stores a successfully fetched value. An older observation never replaces a
   * newer one. Returns true when the value was stored.
   */
  recordSuccess(key: K, value: V, observedAt: string): boolean {
    if (!isIsoUtcMillis(observedAt)) {
      throw new TypeError('observedAt must be a canonical UTC timestamp.');
    }
    const existing = this.entries.get(key);
    if (existing !== undefined && existing.observedAt > observedAt) {
      return false;
    }
    this.entries.set(key, Object.freeze({ value: structuredClone(value), observedAt }));
    return true;
  }

  /** The last valid value and its observation time, or `undefined` if there never was one. */
  get(key: K): StoredValue<V> | undefined {
    const entry = this.entries.get(key);
    return entry === undefined
      ? undefined
      : { value: structuredClone(entry.value), observedAt: entry.observedAt };
  }

  get size(): number {
    return this.entries.size;
  }
}
