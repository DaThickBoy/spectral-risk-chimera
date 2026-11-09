/**
 * FX rate recording and the last valid rate for display (task 10.3; design: FX
 * rate recording and last valid rate; R22.3, R25.3, R25.4, R25.5, R30.5, R30.8,
 * R30.12, R33.10).
 *
 * `createRecordingFxService({ fx, unitOfWork, lastValid, clock, ids })` builds the
 * 10.1 `FxService` itself with `createFxService(fx)` and implements the same
 * `FxService` interface around it. The provider used for rates and the provider
 * kind used for last valid keys are the same object (`fx.provider`), so they
 * cannot disagree (D4).
 *
 * Rules:
 * 1. Exactly two results are recorded in `fx_rates`, before they are returned:
 *    the rate of a successful `OBSERVED` result, and the `displayRate` of an
 *    `FX_STALE` result. Identity rates and every `FX_UNAVAILABLE` result
 *    (including `INVALID_RESPONSE` from the FX rule 8 status guard) are never
 *    recorded (D5).
 * 2. One unit of work per record: look up the key `(pair, source, sourceKind,
 *    observedAt)`; an identical record writes nothing; a differing record is
 *    `RATE_CONFLICT` (nothing written, rate not used); otherwise append. The
 *    unit of work commits or rolls back as a whole.
 * 3. Only a successful `OBSERVED` result whose record has committed (or that is
 *    identical to a committed record) updates the last valid store, under
 *    `pair + ":" + fx.provider.kind`. Stale, invalid, future-dated,
 *    conflicting, and unrecorded rates never update it (D5).
 * 4. For `PROVIDER_ERROR` and `INVALID_RESPONSE`, the error carries the stored
 *    rate for that key as a display-only `StaleFxRate` (`lastValid`); it never
 *    makes VaR available. Other causes carry none.
 * 5. Only a `PersistenceError` during recording becomes `RECORD_FAILED`; any
 *    other exception (recording, ids, clock, last valid update) propagates
 *    unchanged (D2).
 * 6. Record ids come from the injected `IdGenerator`; `recordedAt` comes from the
 *    injected `Clock` (D3). Neither appears in `FxRateUsed` or snapshots.
 * 7. OD-20 (approved 2026-11-09): each record also stores the provider's quote as
 *    received (`published`: its own pair and canonical value, the provider's reference
 *    date, the derivation method `AS_PUBLISHED` or `DECIMAL_INVERSE`, and the precision
 *    `SIGNIFICANT_DIGITS_40_ROUND_HALF_UP`), from `rateToBaseQuoted`. The derived `rate` and
 *    the selection are unchanged, and the quote never enters `FxRateUsed`. An identical
 *    re-receipt also needs an identical stored quote; a record written before migration 2
 *    (no quote) matches on its original fields and is never rewritten.
 *
 * Storage is the injected unit of work (in memory until task 5.3, OD-12). The
 * last valid store is in process memory and empty after a restart.
 */
import { createFxService } from '../fx/index.js';
import type {
  FxError,
  FxQuoteProvenance,
  FxRateUsed,
  FxService,
  FxServiceDependencies,
  StaleFxRate,
} from '../fx/index.js';
import { PersistenceError } from '../persistence/ports.js';
import type { FxRateRecord, UnitOfWork } from '../persistence/ports.js';
import { LastValidStore, appError, err } from '../shared/index.js';
import type { Clock, IdGenerator, Result } from '../shared/index.js';

/** A rate used in a calculation that came from the provider (not the identity rate). */
export type ObservedFxRate = Extract<FxRateUsed, { readonly kind: 'OBSERVED' }>;

export interface RecordingFxServiceDependencies {
  /** The same dependencies that build the wrapped 10.1 `FxService`. */
  readonly fx: FxServiceDependencies;
  readonly unitOfWork: UnitOfWork;
  readonly lastValid: LastValidStore<string, ObservedFxRate>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

type RecordOutcome = 'RECORDED' | 'IDENTICAL' | 'CONFLICT' | 'RECORD_FAILED';

/** The recorded facts of an observed or stale rate (both carry the same fields). */
type RecordedRate = ObservedFxRate | StaleFxRate;

/**
 * True when a stored record holds exactly the same observation. OD-20: a stored quote must
 * also match; a row written before migration 2 (no quote) matches on the original fields
 * only, so a re-receipt never rewrites history (append-only).
 */
const sameObservation = (
  stored: FxRateRecord,
  rate: RecordedRate,
  quote: FxQuoteProvenance | null,
): boolean =>
  stored.rate === rate.rate &&
  stored.observedAtBasis === rate.observedAtBasis &&
  stored.conventionId === rate.conventionId &&
  (stored.published === undefined ||
    (quote !== null &&
      stored.published.pair === quote.pair &&
      stored.published.rate === quote.rate &&
      stored.published.referenceDate === quote.referenceDate &&
      stored.published.method === quote.method &&
      stored.published.precision === quote.precision));

function assertDependencies(deps: RecordingFxServiceDependencies): void {
  if (typeof (deps.unitOfWork as Partial<UnitOfWork> | undefined)?.run !== 'function') {
    throw new TypeError('unitOfWork must be a UnitOfWork.');
  }
  if (!(deps.lastValid instanceof LastValidStore)) {
    throw new TypeError('lastValid must be a LastValidStore.');
  }
  if (typeof (deps.clock as Partial<Clock> | undefined)?.nowUtc !== 'function') {
    throw new TypeError('clock must be a Clock.');
  }
  if (typeof (deps.ids as Partial<IdGenerator> | undefined)?.next !== 'function') {
    throw new TypeError('ids must be an IdGenerator.');
  }
}

export function createRecordingFxService(deps: RecordingFxServiceDependencies): FxService {
  assertDependencies(deps);
  // createFxService validates `fx` (including the provider) and throws TypeError otherwise.
  const inner = createFxService(deps.fx);
  const { unitOfWork, lastValid, clock, ids } = deps;
  // D4: the kind comes from the same provider object the wrapped service uses.
  const providerKind = deps.fx.provider.kind;
  const baseCurrency = deps.fx.baseCurrency;
  const lastValidKey = (pair: string): string => `${pair}:${providerKind}`;

  const failed = (
    currency: string,
    cause: 'RATE_CONFLICT' | 'RECORD_FAILED',
  ): { readonly ok: false; readonly error: FxError } =>
    err(
      Object.freeze({
        ...appError('FX_UNAVAILABLE', `FX rate ${currency}${baseCurrency} is unavailable (${cause}).`),
        currency,
        cause,
      }),
    );

  /** Rule 2: one unit of work; only PersistenceError becomes RECORD_FAILED (rule 5). */
  const record = (rate: RecordedRate, quote: FxQuoteProvenance | null): RecordOutcome => {
    try {
      // Synchronous callback: never async, never returns a promise.
      return unitOfWork.run((tx): RecordOutcome => {
        const existing = tx.fxRates.findByKey(rate.pair, rate.source, rate.sourceKind, rate.observedAt);
        if (existing !== undefined) {
          return sameObservation(existing, rate, quote) ? 'IDENTICAL' : 'CONFLICT';
        }
        // The id and recordedAt are taken only when a record is actually appended.
        tx.fxRates.append({
          id: ids.next(),
          pair: rate.pair,
          rate: rate.rate,
          observedAt: rate.observedAt,
          observedAtBasis: rate.observedAtBasis,
          ...(rate.conventionId === undefined ? {} : { conventionId: rate.conventionId }),
          source: rate.source,
          sourceKind: rate.sourceKind,
          recordedAt: clock.nowUtc().toISOString(),
          // OD-20: the provider's quote beside the derived rate (published value, never the rate).
          ...(quote === null
            ? {}
            : {
                published: {
                  pair: quote.pair,
                  rate: quote.rate,
                  ...(quote.referenceDate === undefined ? {} : { referenceDate: quote.referenceDate }),
                  method: quote.method,
                  precision: quote.precision,
                },
              }),
        });
        return 'RECORDED';
      });
    } catch (error) {
      if (error instanceof PersistenceError) {
        return 'RECORD_FAILED';
      }
      throw error;
    }
  };

  /** Rule 4: the stored last valid rate as a display-only StaleFxRate. */
  const lastValidFor = (pair: string): StaleFxRate | undefined => {
    const stored = lastValid.get(lastValidKey(pair));
    if (stored === undefined) {
      return undefined;
    }
    const rate = stored.value;
    return Object.freeze({
      kind: 'STALE_DISPLAY',
      pair: rate.pair,
      rate: rate.rate,
      observedAt: rate.observedAt,
      observedAtBasis: rate.observedAtBasis,
      ...(rate.conventionId === undefined ? {} : { conventionId: rate.conventionId }),
      source: rate.source,
      sourceKind: rate.sourceKind,
      status: 'STALE',
    });
  };

  return {
    rateToBase: async (currency, asOf, at): Promise<Result<FxRateUsed, FxError>> => {
      const { result, quote } = await inner.rateToBaseQuoted(currency, asOf, at);

      if (result.ok) {
        if (result.value.kind === 'IDENTITY') {
          return result; // never recorded
        }
        const observed = result.value;
        const outcome = record(observed, quote);
        if (outcome === 'CONFLICT') {
          return failed(currency, 'RATE_CONFLICT');
        }
        if (outcome === 'RECORD_FAILED') {
          return failed(currency, 'RECORD_FAILED');
        }
        // Rule 3: only after the record has committed (or matches a committed one).
        lastValid.recordSuccess(lastValidKey(observed.pair), observed, observed.observedAt);
        return result;
      }

      const error = result.error;
      if (error.code === 'FX_STALE') {
        const outcome = record(error.displayRate, quote);
        if (outcome === 'CONFLICT') {
          return failed(currency, 'RATE_CONFLICT');
        }
        if (outcome === 'RECORD_FAILED') {
          return failed(currency, 'RECORD_FAILED');
        }
        return result; // recorded; the last valid store is not updated
      }

      // FX_UNAVAILABLE: never recorded (rule 1).
      if (error.cause === 'PROVIDER_ERROR' || error.cause === 'INVALID_RESPONSE') {
        const shown = lastValidFor(`${currency}${baseCurrency}`);
        if (shown !== undefined) {
          return err(Object.freeze({ ...error, lastValid: shown }));
        }
      }
      return result;
    },
  };
}
