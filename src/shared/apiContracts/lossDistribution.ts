/**
 * Loss-distribution contract (Kiroween decision A2, approved 2026-11-10): the histogram of the
 * Base VaR scenario losses shown under the positions. Built by the backend
 * (`src/app/lossDistribution.ts` over `lossHistogram` in `src/risk/`); the dashboard only
 * renders it.
 *
 * - Edges, width, and the VaR marker are Canonical Decimal Strings, exact and unrounded
 *   (`lower`, `upper`, `rawQuantile`). `*Display` strings are the FR-14 money text
 *   (ROUND_HALF_UP to the base currency's minor units) for axis labels only.
 * - Counts, the bucket count, and the marker's bucket index are integers (not financial values).
 * - `varMarker.position` is the marker's plotting coordinate in bucket-width units
 *   (0 to `bucketCount`), display only; the chart adapter converts it with `toChartNumber`.
 * - An empty or unusable distribution is `UNAVAILABLE` with a reason: never bars of zero.
 */
import { z } from 'zod';
import { Iso4217Code, IsoDate } from '../schemas.js';
import { IsoUtcMillis } from '../timestamps.js';
import { CanonicalDecimalSchema } from './portfolio.js';

const Count = z.int().nonnegative();
const DisplayText = z.string().min(1);

export const LOSS_DISTRIBUTION_UNAVAILABLE_REASONS = [
  /** Base VaR has no current figure (its own status explains why). */
  'BASE_VAR_UNAVAILABLE',
  /** The latest result has no stored snapshot to read the scenarios from. */
  'NO_SNAPSHOT',
  /** The stored snapshot could not be recomputed and verified (R32.4). */
  'SNAPSHOT_RECOMPUTE_FAILED',
  /** The scenarios belong to a different snapshot than the shown risk result (for example a newer one). */
  'SNAPSHOT_MISMATCH',
  /** Fewer than two scenario losses. */
  'INSUFFICIENT_SCENARIOS',
  /** The scenario count differs from the Base VaR observations. */
  'SCENARIO_COUNT_MISMATCH',
  /** The recomputed quantile differs from the stored Base VaR quantile. */
  'QUANTILE_MISMATCH',
] as const;

export const LossBucketSchema = z.strictObject({
  /** Inclusive lower edge, exact. */
  lower: CanonicalDecimalSchema,
  /** Upper edge, exact; exclusive except for the last bucket. */
  upper: CanonicalDecimalSchema,
  upperInclusive: z.boolean(),
  count: Count,
  lowerDisplay: DisplayText,
  upperDisplay: DisplayText,
});

const AvailableSchema = z.strictObject({
  status: z.literal('AVAILABLE'),
  metric: z.literal('BASE_VAR_SCENARIO_LOSSES'),
  currency: Iso4217Code,
  confidence: CanonicalDecimalSchema,
  horizonDays: z.literal(1),
  quantileMethod: z.literal('HYNDMAN_FAN_TYPE_7'),
  calculatedAt: IsoUtcMillis,
  /** End dates of the first and last daily return used as scenarios. */
  scenarioWindow: z.strictObject({ firstDate: IsoDate, lastDate: IsoDate }),
  scenarioCount: z.int().min(2),
  bucketCount: z.int().min(1),
  width: CanonicalDecimalSchema,
  widthDisplay: DisplayText,
  min: CanonicalDecimalSchema,
  max: CanonicalDecimalSchema,
  buckets: z.array(LossBucketSchema).min(1),
  varMarker: z.strictObject({
    /** The raw, unrounded Type 7 quantile (may be negative; Base VaR floors it at zero). */
    rawQuantile: CanonicalDecimalSchema,
    rawQuantileDisplay: DisplayText,
    confidence: CanonicalDecimalSchema,
    bucketIndex: Count,
    /** Scenario losses strictly greater than `rawQuantile`. */
    scenariosAbove: Count,
    /** Plotting coordinate in bucket-width units (display only). */
    position: CanonicalDecimalSchema,
  }),
});

const UnavailableSchema = z.strictObject({
  status: z.literal('UNAVAILABLE'),
  reason: z.enum(LOSS_DISTRIBUTION_UNAVAILABLE_REASONS),
  explanation: z.string().min(1),
});

export const LossDistributionSchema = z
  .discriminatedUnion('status', [AvailableSchema, UnavailableSchema])
  .superRefine((value, ctx) => {
    if (value.status !== 'AVAILABLE') return;
    // Structural integrity only (integer counts and indexes; no financial arithmetic).
    if (value.buckets.length !== value.bucketCount) {
      ctx.addIssue({ code: 'custom', message: 'buckets must have bucketCount entries' });
    }
    let total = 0;
    for (const [i, bucket] of value.buckets.entries()) {
      total += bucket.count;
      if (bucket.upperInclusive !== (i === value.buckets.length - 1)) {
        ctx.addIssue({ code: 'custom', message: 'only the last bucket includes its upper edge' });
      }
    }
    if (total !== value.scenarioCount) {
      ctx.addIssue({ code: 'custom', message: 'bucket counts must sum to scenarioCount' });
    }
    if (value.varMarker.bucketIndex >= value.bucketCount) {
      ctx.addIssue({ code: 'custom', message: 'varMarker.bucketIndex is out of range' });
    }
    if (value.varMarker.scenariosAbove >= value.scenarioCount) {
      ctx.addIssue({ code: 'custom', message: 'varMarker.scenariosAbove is out of range' });
    }
  });
export type LossDistribution = z.infer<typeof LossDistributionSchema>;
export type LossBucket = z.infer<typeof LossBucketSchema>;
