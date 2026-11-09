/**
 * Series cleaner (task 9.2; FR-3.1, FR-3.2, FR-3.3; R12.5, R12.8; design:
 * Cleaning rules).
 *
 * Turns a `ProviderSeries` (task 9.1: normalized, received order, observation
 * defects kept) into a sorted, cleaned `PriceSeries`. Pure; the input is never
 * modified and the result is frozen.
 *
 * 1. Each observation is classified at most once, in this priority order:
 *    MISSING, NOT_FINITE, NON_POSITIVE (not strictly greater than 0 by Decimal
 *    comparison), NON_TRADING_DATE (the calendar). Classified observations are
 *    discarded and counted, never filled.
 * 2. Only the remaining valid observations take part in duplicate handling.
 * 3. Valid observations of one date whose prices are all `Decimal.equals()`
 *    collapse to the first-received one, whose text is kept unchanged (no
 *    canonicalization); each additional one counts as `duplicateCollapsed`.
 * 4. If two valid prices of one date differ, every observation of that date is
 *    excluded and counted as `conflicting`, the date is listed in the sorted,
 *    unique `conflictDates`, and `conflict` is true. A conflict invalidates the
 *    WHOLE series (DATA_CONFLICT, FR-3.3); the non-conflicting dates are kept
 *    only for identification, and task 9.3 must not calculate returns from it.
 * 5. Kept observations are sorted ascending by date (unique dates).
 * 6. received = kept + missing + nonFinite + nonPositive + nonTradingDate
 *    + duplicateCollapsed + conflicting.
 * 7. `source`, `sourceKind`, and `retrievedAt` are copied; no freshness status is
 *    assigned. `contentHash = sha256Hex(canonicalJson({ ticker, currency,
 *    observations }))` over the cleaned, sorted observations, excluding
 *    provenance, discard counts, and conflict metadata.
 */
import { canonicalJson, d, sha256Hex } from '../shared/index.js';
import type { DataSourceKind, DecimalString } from '../shared/index.js';
import type { TradingCalendar } from './calendar.js';
import type { ProviderSeries } from './ports.js';

export interface PriceObservation {
  readonly date: string;
  readonly adjustedClose: DecimalString;
}

export interface PriceSeries {
  readonly ticker: string;
  readonly currency: string;
  readonly source: string;
  readonly sourceKind: DataSourceKind;
  readonly retrievedAt: string;
  /** Sorted ascending by date; unique dates; positive, finite prices on trading dates. */
  readonly observations: readonly PriceObservation[];
  /** `sha256Hex(canonicalJson({ ticker, currency, observations }))`. */
  readonly contentHash: string;
}

export interface DiscardCounts {
  readonly missing: number;
  readonly nonFinite: number;
  readonly nonPositive: number;
  readonly nonTradingDate: number;
  readonly duplicateCollapsed: number;
  readonly conflicting: number;
}

export interface CleanResult {
  readonly series: PriceSeries;
  readonly discarded: DiscardCounts;
  /** True: the whole series is invalid (DATA_CONFLICT). */
  readonly conflict: boolean;
  /** Sorted, unique; empty when `conflict` is false. */
  readonly conflictDates: readonly string[];
}

export interface SeriesCleaner {
  clean(raw: ProviderSeries): CleanResult;
}

const byDate = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function createSeriesCleaner(calendar: TradingCalendar): SeriesCleaner {
  return {
    clean: (raw) => {
      // Counts are integers (not financial values).
      let missing = 0;
      let nonFinite = 0;
      let nonPositive = 0;
      let nonTradingDate = 0;
      let duplicateCollapsed = 0;
      let conflicting = 0;

      // Steps 1 and 2: classify once, in priority order; keep valid observations by date.
      const groups = new Map<string, PriceObservation[]>();
      for (const observation of raw.observations) {
        if ('defect' in observation) {
          if (observation.defect === 'MISSING') {
            missing += 1;
          } else {
            nonFinite += 1;
          }
          continue;
        }
        if (!d(observation.adjustedClose).greaterThan(0)) {
          nonPositive += 1;
          continue;
        }
        if (!calendar.isTradingDay(observation.date)) {
          nonTradingDate += 1;
          continue;
        }
        const group = groups.get(observation.date);
        const valid = { date: observation.date, adjustedClose: observation.adjustedClose };
        if (group === undefined) {
          groups.set(observation.date, [valid]);
        } else {
          group.push(valid);
        }
      }

      // Steps 3 and 4: collapse identical duplicates; exclude conflicting dates.
      const kept: PriceObservation[] = [];
      const conflictDates: string[] = [];
      for (const [date, group] of groups) {
        const [first, ...rest] = group;
        if (first === undefined) {
          continue;
        }
        const reference = d(first.adjustedClose);
        if (rest.every((other) => d(other.adjustedClose).equals(reference))) {
          kept.push(Object.freeze({ date: first.date, adjustedClose: first.adjustedClose }));
          duplicateCollapsed += rest.length;
        } else {
          conflicting += group.length;
          conflictDates.push(date);
        }
      }

      // Step 5: sort (dates are unique after grouping).
      kept.sort((a, b) => byDate(a.date, b.date));
      conflictDates.sort(byDate);

      const observations = Object.freeze(kept) as readonly PriceObservation[];
      const { ticker, currency } = raw;
      const series: PriceSeries = Object.freeze({
        ticker,
        currency,
        source: raw.source,
        sourceKind: raw.sourceKind,
        retrievedAt: raw.retrievedAt,
        observations,
        contentHash: sha256Hex(canonicalJson({ ticker, currency, observations })),
      });
      return Object.freeze({
        series,
        discarded: Object.freeze({
          missing,
          nonFinite,
          nonPositive,
          nonTradingDate,
          duplicateCollapsed,
          conflicting,
        }),
        conflict: conflictDates.length > 0,
        conflictDates: Object.freeze(conflictDates) as readonly string[],
      });
    },
  };
}
