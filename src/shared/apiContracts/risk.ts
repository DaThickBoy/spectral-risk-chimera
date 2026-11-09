/**
 * Risk API contracts (task 12.6; design: API routes, Gateway rules; R13.7, R14.10,
 * R14.12, R17.10, R22.5, R35.6). Base and Adjusted VaR are separate `VarEntry`
 * objects, each with its own validity, value or `null`, status, reason, and last
 * valid figure. Financial values are Canonical Decimal Strings; integers are counts.
 */
import { z } from 'zod';
import { IsoDate } from '../schemas.js';
import { IsoUtcMillis } from '../timestamps.js';
import { CanonicalDecimalSchema, PortfolioIdSchema } from './portfolio.js';

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Code = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

export const VarFigureSchema = z.strictObject({
  absolute: CanonicalDecimalSchema,
  rawQuantile: CanonicalDecimalSchema,
  percentOfNav: CanonicalDecimalSchema.nullable(),
});

export const VarEntrySchema = z.strictObject({
  validity: z.enum(['CURRENT', 'STALE', 'LAST_VALID', 'UNAVAILABLE']),
  value: VarFigureSchema.nullable(),
  status: Code,
  reason: Code.nullable(),
  missingKeys: z.array(z.string().min(1)),
  lastValid: z
    .strictObject({ value: VarFigureSchema, calculatedAt: IsoUtcMillis, snapshotHash: Hash })
    .nullable(),
});

export const RiskResponseSchema = z.strictObject({
  portfolioId: z.string().min(1),
  calculatedAt: IsoUtcMillis,
  status: Code,
  flags: z.array(Code),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  nav: CanonicalDecimalSchema.nullable(),
  asOfDate: IsoDate.nullable(),
  observations: z.int().nonnegative(),
  lookbackReturns: z.int().positive().nullable(),
  completeness: z.enum(['COMPLETE', 'REDUCED_LOOKBACK']).nullable(),
  confidence: CanonicalDecimalSchema.nullable(),
  horizonDays: z.literal(1),
  quantileMethod: z.literal('HYNDMAN_FAN_TYPE_7'),
  algorithmVersion: z.string().min(1).nullable(),
  configVersion: z.strictObject({ seq: z.int().positive(), hash: Hash }),
  snapshotHash: Hash.nullable(),
  seriesHashes: z.record(z.string().min(1), Hash),
  precondition: z
    .strictObject({
      currencies: z.array(z.string().regex(/^[A-Z]{3}$/)),
      tickers: z.array(z.string().min(1)),
      observations: z.int().nonnegative().optional(),
      required: z.int().nonnegative().optional(),
      /**
       * Price failures under INSUFFICIENT_DATA (additive): every category that occurred, in the
       * fixed order PRICE_UNAVAILABLE, PRICE_CURRENCY_MISMATCH, each with its own sorted tickers.
       * `baseVaR.reason` is the first entry's reason; `tickers` is the union.
       */
      priceIssues: z
        .array(
          z.strictObject({
            reason: z.enum(['PRICE_UNAVAILABLE', 'PRICE_CURRENCY_MISMATCH']),
            tickers: z.array(z.string().min(1)).min(1),
          }),
        )
        .min(1)
        .optional(),
    })
    .nullable(),
  baseVaR: VarEntrySchema,
  adjustedVaR: VarEntrySchema,
});
export type RiskResponse = z.infer<typeof RiskResponseSchema>;

export const SnapshotParamsSchema = z.strictObject({
  id: PortfolioIdSchema,
  hash: Hash,
});

/** The stored snapshot text is returned as an object; every financial value is a string. */
export const SnapshotResponseSchema = z.strictObject({
  portfolioId: z.string().min(1),
  hash: Hash,
  createdAt: IsoUtcMillis,
  evaluatedAt: IsoUtcMillis,
  snapshot: z.record(z.string(), z.unknown()),
});
export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>;
