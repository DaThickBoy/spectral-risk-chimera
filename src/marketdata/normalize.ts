/**
 * Market data payload normalization (task 9.1; R4.2, R4.6, R12.3, R12.6; design:
 * Market Data and FX, Port and normalization).
 *
 * The input is an already-parsed, unvalidated payload: an in-code fixture object,
 * or the lossless JSON parser's output in a real adapter (9.6). This module
 * checks structure and lexical form only, with strict Zod schemas:
 *
 * - Series observations keep observation-level defects for task 9.2, which
 *   discards and counts them (FR-3.1, FR-3.2, AT-MD-03, AT-MD-04):
 *   a decimal of any sign is kept exactly as text (no canonicalization); an
 *   absent or `null` adjusted close is `MISSING`; the strings `NaN`, `Infinity`,
 *   and `-Infinity` are `NOT_FINITE` markers. Weekend dates and duplicates stay.
 * - These reject the whole payload (`INVALID_RESPONSE`): exponent notation (as a
 *   string or a `LosslessJsonNumber`), a JavaScript number, any other text or
 *   type, a date that is not a real `YYYY-MM-DD` date (timestamps included), a
 *   currency failing `Iso4217Code`, an unknown field, or a ticker that is not
 *   exactly the requested ticker (no trimming or case folding).
 * - Quotes are strict: a positive decimal price only.
 *
 * Nothing is clamped, filled, defaulted, sorted, or converted to a native
 * number. Errors carry a reason code and never any payload text.
 */
import { z } from 'zod';
import {
  DECIMAL_TEXT_PATTERN,
  IsoDate,
  Iso4217Code,
  LosslessJsonNumber,
  PositiveDecimalString,
  appError,
  brandDecimalString,
  canonicalJson,
  err,
  ok,
  sha256Hex,
} from '../shared/index.js';
import type { AppError, DataSourceKind, Result } from '../shared/index.js';
import type {
  DateRange,
  NonFiniteMarker,
  ProviderObservation,
  ProviderQuote,
  ProviderSeries,
} from './ports.js';

export type NormalizeFailureReason = 'SCHEMA' | 'TICKER_MISMATCH';

export type NormalizeError = AppError<'INVALID_RESPONSE'> & { readonly reason: NormalizeFailureReason };

export interface NormalizeContext {
  /** The ticker the caller requested; the payload must match it exactly. */
  readonly ticker: string;
  readonly source: string;
  readonly sourceKind: DataSourceKind;
  /** `YYYY-MM-DDTHH:mm:ss.sssZ`. */
  readonly retrievedAt: string;
}

const NON_FINITE: ReadonlySet<string> = new Set<NonFiniteMarker>(['NaN', 'Infinity', '-Infinity']);

/** Throws `TypeError` unless `ticker` is a non-empty string (a programmer error). */
export function assertTicker(ticker: unknown): asserts ticker is string {
  if (typeof ticker !== 'string' || ticker.length === 0) {
    throw new TypeError('ticker must be a non-empty string.');
  }
}

/** Throws `TypeError` unless `range` has valid `YYYY-MM-DD` dates with `from <= to`. */
export function assertDateRange(range: unknown): asserts range is DateRange {
  const value = range as { from?: unknown; to?: unknown } | null;
  if (
    typeof value !== 'object' ||
    value === null ||
    !IsoDate.safeParse(value.from).success ||
    !IsoDate.safeParse(value.to).success ||
    (value.from as string) > (value.to as string)
  ) {
    throw new TypeError('range must be { from, to } with valid YYYY-MM-DD dates and from <= to.');
  }
}

const observationSchema = z
  .strictObject({
    date: IsoDate,
    adjustedClose: z.union([z.null(), z.string(), z.instanceof(LosslessJsonNumber)]).optional(),
  })
  .transform((input, ctx): ProviderObservation => {
    const value = input.adjustedClose;
    if (value === undefined || value === null) {
      return { date: input.date, adjustedClose: null, defect: 'MISSING' };
    }
    if (typeof value === 'string' && NON_FINITE.has(value)) {
      return {
        date: input.date,
        adjustedClose: null,
        defect: 'NOT_FINITE',
        nonFinite: value as NonFiniteMarker,
      };
    }
    const text = typeof value === 'string' ? value : value.text;
    if (!DECIMAL_TEXT_PATTERN.test(text)) {
      // Exponent notation and any other malformed text (R4.6).
      ctx.addIssue({
        code: 'custom',
        message: 'MALFORMED_NUMBER: expected a decimal string without exponent',
      });
      return z.NEVER;
    }
    return { date: input.date, adjustedClose: brandDecimalString(text) };
  });

export const SeriesPayloadSchema = z.strictObject({
  ticker: z.string(),
  currency: Iso4217Code,
  observations: z.array(observationSchema),
});

export const QuotePayloadSchema = z.strictObject({
  ticker: z.string(),
  currency: Iso4217Code,
  asOf: IsoDate,
  price: z
    .union([z.string(), z.instanceof(LosslessJsonNumber)])
    .transform((value) => (typeof value === 'string' ? value : value.text))
    .pipe(PositiveDecimalString),
});

const invalid = (reason: NormalizeFailureReason): { ok: false; error: NormalizeError } =>
  err({ ...appError('INVALID_RESPONSE', `Market data payload rejected (${reason}).`), reason });

const tickerMatches = (received: string, requested: string): boolean =>
  received.length > 0 && received === requested;

/** Normalizes a series payload and keeps the observations within `range`. */
export function normalizeSeries(
  payload: unknown,
  range: DateRange,
  context: NormalizeContext,
): Result<ProviderSeries, NormalizeError> {
  assertTicker(context.ticker);
  assertDateRange(range);
  const parsed = SeriesPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return invalid('SCHEMA');
  }
  if (!tickerMatches(parsed.data.ticker, context.ticker)) {
    return invalid('TICKER_MISMATCH');
  }
  const { ticker, currency } = parsed.data;
  const observations = Object.freeze(
    parsed.data.observations
      .filter((observation) => observation.date >= range.from && observation.date <= range.to)
      .map((observation) => Object.freeze({ ...observation })),
  ) as readonly ProviderObservation[];
  const contentHash = sha256Hex(canonicalJson({ ticker, currency, observations }));
  return ok(
    Object.freeze({
      ticker,
      currency,
      source: context.source,
      sourceKind: context.sourceKind,
      retrievedAt: context.retrievedAt,
      observations,
      contentHash,
    }),
  );
}

/** Normalizes one quote payload (strict: a positive decimal price only). */
export function normalizeQuote(
  payload: unknown,
  context: NormalizeContext,
): Result<ProviderQuote, NormalizeError> {
  assertTicker(context.ticker);
  const parsed = QuotePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return invalid('SCHEMA');
  }
  if (!tickerMatches(parsed.data.ticker, context.ticker)) {
    return invalid('TICKER_MISMATCH');
  }
  return ok(
    Object.freeze({
      ticker: parsed.data.ticker,
      currency: parsed.data.currency,
      price: parsed.data.price,
      asOf: parsed.data.asOf,
      source: context.source,
      sourceKind: context.sourceKind,
      retrievedAt: context.retrievedAt,
    }),
  );
}
