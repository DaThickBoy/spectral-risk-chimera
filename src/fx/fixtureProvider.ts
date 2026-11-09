/**
 * In-code fixture FX provider (task 10.1, decision F14; R30.3; design: FX rules).
 *
 * Holds rate entries in code: no JSON files and no parser (OD-16 is untouched).
 * Its kind is `DEMO`, so every result has `sourceKind: 'DEMO'` and its `source` is
 * the provider name; it can never pass as real data. It makes no network call and
 * does not use `ResilientCall` (the service does).
 *
 * `getRate(from, to, asOf)`:
 * - Every entry is validated with `FxFixtureEntrySchema` on each call; any
 *   malformed entry makes the call `INVALID_RESPONSE` (nothing is skipped or
 *   repaired).
 * - Candidates are the entries for `(from, to)` or the inverse `(to, from)`
 *   with `observedAt <= min(end of asOf in UTC, at)`. The latest one is returned
 *   in its stored orientation. Two equally latest candidates are ambiguous:
 *   `INVALID_RESPONSE` (never picked arbitrarily).
 * - Every rate has `observedAtBasis: 'PROVIDER'`: entries carry their own
 *   explicit `observedAt` (task 10.4).
 * - No candidate: `HTTP_CLIENT_ERROR` with `httpStatus: 404`.
 * - An argument that is not a three-letter code, a valid `YYYY-MM-DD` date, or an
 *   `IsoUtcMillis` timestamp throws `TypeError` before any lookup.
 */
import { appError, isIsoUtcMillis } from '../shared/index.js';
import type { ProviderError, Result } from '../shared/index.js';
import { CURRENCY_CODE_PATTERN, FxFixtureEntrySchema, endOfUtcDay, isIsoDate } from './normalize.js';
import type { FxFixtureEntry } from './normalize.js';
import type { FxProvider, ProviderFxRate } from './ports.js';

export interface FixtureFxProviderOptions {
  readonly name: string;
  /** Unvalidated entries `{ from, to, rate, observedAt }`; `rate` is units of `to` per one `from`. */
  readonly rates: readonly unknown[];
}

const OPERATION = 'getRate';

export class FixtureFxProvider implements FxProvider {
  readonly name: string;
  readonly kind = 'DEMO' as const;
  readonly #rates: readonly unknown[];

  constructor(options: FixtureFxProviderOptions) {
    if (typeof options.name !== 'string' || options.name.length === 0) {
      throw new TypeError('name must be a non-empty string.');
    }
    if (!Array.isArray(options.rates)) {
      throw new TypeError('rates must be an array.');
    }
    this.name = options.name;
    this.#rates = [...options.rates];
  }

  getRate(
    from: string,
    to: string,
    asOf: string,
    at: string,
  ): Promise<Result<ProviderFxRate, ProviderError>> {
    if (typeof from !== 'string' || !CURRENCY_CODE_PATTERN.test(from)) {
      throw new TypeError('from must be a three-letter currency code.');
    }
    if (typeof to !== 'string' || !CURRENCY_CODE_PATTERN.test(to)) {
      throw new TypeError('to must be a three-letter currency code.');
    }
    if (!isIsoDate(asOf)) {
      throw new TypeError('asOf must be a valid YYYY-MM-DD date.');
    }
    if (!isIsoUtcMillis(at)) {
      throw new TypeError('at must be a UTC timestamp YYYY-MM-DDTHH:mm:ss.sssZ.');
    }
    const entries: FxFixtureEntry[] = [];
    for (const raw of this.#rates) {
      const parsed = FxFixtureEntrySchema.safeParse(raw);
      if (!parsed.success) {
        return Promise.resolve(this.#fail('INVALID_RESPONSE'));
      }
      entries.push(parsed.data);
    }
    // Fixed-width IsoUtcMillis text: ordinal order is chronological.
    const endOfDay = endOfUtcDay(asOf);
    const bound = endOfDay < at ? endOfDay : at;
    const candidates = entries.filter(
      (entry) =>
        ((entry.from === from && entry.to === to) || (entry.from === to && entry.to === from)) &&
        entry.observedAt <= bound,
    );
    if (candidates.length === 0) {
      return Promise.resolve(this.#fail('HTTP_CLIENT_ERROR', 404));
    }
    // Fixed-width IsoUtcMillis text: ordinal order is chronological.
    const latestAt = candidates.reduce(
      (latest, entry) => (entry.observedAt > latest ? entry.observedAt : latest),
      '',
    );
    const latest = candidates.filter((entry) => entry.observedAt === latestAt);
    const [chosen] = latest;
    if (chosen === undefined || latest.length > 1) {
      return Promise.resolve(this.#fail('INVALID_RESPONSE'));
    }
    return Promise.resolve({
      ok: true,
      value: Object.freeze({
        from: chosen.from,
        to: chosen.to,
        rate: chosen.rate,
        observedAt: chosen.observedAt,
        // Fixture entries carry explicit timestamps (task 10.4).
        observedAtBasis: 'PROVIDER',
        source: this.name,
        sourceKind: this.kind,
      }),
    });
  }

  #fail(
    code: 'INVALID_RESPONSE' | 'HTTP_CLIENT_ERROR',
    httpStatus?: number,
  ): {
    ok: false;
    error: ProviderError;
  } {
    return {
      ok: false,
      error: {
        ...appError(code, `Provider call ${this.name} ${OPERATION} failed (${code}).`),
        provider: this.name,
        operation: OPERATION,
        attempts: 1,
        retryable: false,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      },
    };
  }
}
