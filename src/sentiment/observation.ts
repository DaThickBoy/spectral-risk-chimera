/**
 * Sentiment observations: schema and normalization (task 13.1; design:
 * Sentiment, `SentimentObservationSchema`; R9.3, R9.6, R9.7, R10.7, R21.2,
 * R21.3, R4.6).
 *
 * A provider message is an already-parsed, unvalidated value: an in-code
 * fixture object, or the lossless JSON parser's output in a real adapter
 * (13.8). It is checked with a strict Zod schema:
 * - `ticker`: the shared `TickerSchema` (fixed pattern, R28.7);
 * - `value`: decimal text (a string or a `LosslessJsonNumber`) in the fixed
 *   grammar (R4.6: no exponent, no `NaN`, no `Infinity`) and within [-1, +1]
 *   (`SentimentIndexSchema`). Out of range is rejected, never clamped (R10.7);
 * - `observedAt`: ISO 8601 with `Z` or an offset and at most millisecond
 *   precision, normalized to `YYYY-MM-DDTHH:mm:ss.sssZ` (never rounded);
 * - `messageId`: optional, 1 to 128 characters;
 * - unknown fields, including any `sourceKind`, are rejected: the source kind
 *   comes only from the provider (`REAL` or `DEMO`, R9.7), so a demo provider can
 *   never produce a `REAL` observation.
 * Every valid observation records provider, observation time, and receipt time
 * (R9.6). Rejections carry a fixed reason and never any payload text.
 */
import { z } from 'zod';
import {
  IsoTimestamp,
  LosslessJsonNumber,
  SentimentIndexSchema,
  TickerSchema,
  appError,
  err,
  isDecimalText,
  ok,
} from '../shared/index.js';
import type { AppError, DataSourceKind, Result, SentimentIndex } from '../shared/index.js';

export interface SentimentObservation {
  readonly provider: string;
  readonly sourceKind: DataSourceKind;
  readonly messageId?: string;
  readonly ticker: string;
  /** Exact decimal text in [-1, +1]. */
  readonly value: SentimentIndex;
  /** `YYYY-MM-DDTHH:mm:ss.sssZ`. */
  readonly observedAt: string;
  /** Receipt time from the injected Clock, `YYYY-MM-DDTHH:mm:ss.sssZ`. */
  readonly receivedAt: string;
}

export type ObservationRejectReason = 'SCHEMA' | 'MALFORMED_NUMBER' | 'OUT_OF_RANGE' | 'INVALID_TIMESTAMP';

export type ObservationRejection = AppError<'SENTIMENT_INVALID'> & {
  readonly reason: ObservationRejectReason;
};

/** Payload shape of one message (strict); the value is checked separately for a precise reason. */
export const SentimentObservationSchema = z.strictObject({
  messageId: z.string().min(1).max(128).optional(),
  ticker: TickerSchema,
  value: z.union([z.string(), z.instanceof(LosslessJsonNumber)]),
  observedAt: IsoTimestamp,
});

/** At most three fractional digits, so normalization to milliseconds never rounds. */
const FRACTION = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/;

/** `observedAt` in the fixed UTC millisecond form, or undefined. Timestamps are not financial values. */
export function normalizeObservedAt(text: string): string | undefined {
  const fraction = FRACTION.exec(text)?.[1];
  if (fraction !== undefined && fraction.length > 3) {
    return undefined;
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) {
    return undefined;
  }
  const iso = new Date(ms).toISOString();
  return /^\d{4}-/.test(iso) ? iso : undefined;
}

const reject = (reason: ObservationRejectReason): Result<never, ObservationRejection> =>
  err({ ...appError('SENTIMENT_INVALID', `Sentiment observation rejected (${reason}).`), reason });

/** Validates one raw message from `provider` and stamps it with the provider kind and receipt time. */
export function normalizeObservation(
  raw: unknown,
  context: { readonly provider: string; readonly sourceKind: DataSourceKind; readonly receivedAt: string },
): Result<SentimentObservation, ObservationRejection> {
  const shape = SentimentObservationSchema.safeParse(raw);
  if (!shape.success) {
    return reject('SCHEMA');
  }
  const text = shape.data.value instanceof LosslessJsonNumber ? shape.data.value.text : shape.data.value;
  if (!isDecimalText(text)) {
    return reject('MALFORMED_NUMBER');
  }
  const value = SentimentIndexSchema.safeParse(text);
  if (!value.success) {
    return reject('OUT_OF_RANGE');
  }
  const observedAt = normalizeObservedAt(shape.data.observedAt);
  if (observedAt === undefined) {
    return reject('INVALID_TIMESTAMP');
  }
  return ok(
    Object.freeze({
      provider: context.provider,
      sourceKind: context.sourceKind,
      ...(shape.data.messageId === undefined ? {} : { messageId: shape.data.messageId }),
      ticker: shape.data.ticker,
      value: value.data,
      observedAt,
      receivedAt: context.receivedAt,
    }),
  );
}
