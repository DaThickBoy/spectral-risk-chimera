/**
 * Dashboard view models with signal separation (task 17.1; design: View models
 * (signal separation); R11.6, R11.7, R17.1 to R17.4, R17.6 to R17.10, R35.2,
 * R35.3, R35.6; Property 12).
 *
 * - Base VaR and Adjusted VaR are separate `VarView` entries, each with its own
 *   validity, status, reason, and labelled last valid figure. An unavailable
 *   entry has `value: null`; the Base figure never appears in the Adjusted entry.
 * - `sentiment` (SentimentIndex, -1 to +1) and `filing` (FilingRiskScore, 0 to
 *   1) are separate objects. There is deliberately no field derived from both,
 *   and no overall, composite, blended, or ranked member.
 * - Financial values are Canonical Decimal Strings; an unavailable value is
 *   `null` with its status, never `"0"`. Integers are counts.
 * - `riskContribution` is always `null` (U-8, OD-10): shown as "not available".
 */
import { z } from 'zod';
import { IsoDate, Iso4217Code } from '../schemas.js';
import { IsoUtcMillis } from '../timestamps.js';
import {
  CanonicalDecimalSchema,
  PortfolioIdSchema,
  StalePriceDisplaySchema,
  VALUATION_STATUSES,
} from './portfolio.js';
import { VarFigureSchema } from './risk.js';

const Code = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const SignedUnit = CanonicalDecimalSchema; // range is validated where the value is created (13.1)

export const VarViewSchema = z.strictObject({
  validity: z.enum(['CURRENT', 'STALE', 'LAST_VALID', 'UNAVAILABLE']),
  value: VarFigureSchema.nullable(),
  status: Code,
  reason: z.strictObject({
    missingConfigKeys: z.array(z.string().min(1)),
    ineligibleTickers: z.array(z.strictObject({ ticker: z.string().min(1), sentimentStatus: Code })),
    /** Fixed reason code of a failed precondition or invalid input; `null` otherwise. */
    code: Code.nullable(),
  }),
  lastValid: z.strictObject({ value: VarFigureSchema, calculatedAt: IsoUtcMillis }).nullable(),
});

export const AssetSentimentSchema = z.strictObject({
  /** SentimentIndex, -1 (bearish) to +1 (bullish). */
  value: SignedUnit.nullable(),
  status: z.enum(['CURRENT', 'STALE', 'UNAVAILABLE']),
  /** `null` exactly when no observation exists. */
  sourceKind: z.enum(['REAL', 'DEMO']).nullable(),
  observedAt: IsoUtcMillis.nullable(),
  /** Display basis: the aggregated REAL index, or the latest observation when there is no index. */
  basis: z.enum(['INDEX', 'LATEST_OBSERVATION', 'NONE']),
});

export const AssetFilingSchema = z.strictObject({
  /** FilingRiskScore, 0 (low) to 1 (high). `null` until the filing pipeline exists. */
  score: CanonicalDecimalSchema.nullable(),
  status: z.enum(['CURRENT', 'STALE', 'SUPERSEDED', 'FALLBACK', 'UNAVAILABLE']),
  filingDate: IsoDate.nullable(),
  sourceKind: z.enum(['REAL', 'DEMO']).nullable(),
});

export const AssetRiskRowSchema = z.strictObject({
  ticker: z.string().min(1),
  currency: Iso4217Code,
  signedQuantity: CanonicalDecimalSchema,
  marketPrice: CanonicalDecimalSchema.nullable(),
  priceProvenance: z
    .strictObject({
      asOf: IsoDate,
      source: z.string().min(1),
      sourceKind: z.enum(['REAL', 'DEMO']),
      retrievedAt: IsoUtcMillis,
    })
    .nullable(),
  /** Display only (11.5); non-null only with PRICE_UNAVAILABLE; never feeds any figure. */
  lastValidPrice: StalePriceDisplaySchema.nullable(),
  marketValueBase: CanonicalDecimalSchema.nullable(),
  valuationStatus: z.enum(VALUATION_STATUSES),
  allocationPct: CanonicalDecimalSchema.nullable(),
  sentiment: AssetSentimentSchema,
  filing: AssetFilingSchema,
  adjustment: z.strictObject({
    triggered: z.boolean(),
    effectiveSentiment: SignedUnit.nullable(),
    direction: z.enum(['LONG', 'SHORT']).nullable(),
    multiplier: CanonicalDecimalSchema.nullable(),
  }),
  riskContribution: z.null(),
});
export type AssetRiskRow = z.infer<typeof AssetRiskRowSchema>;

export const PortfolioRiskViewSchema = z.strictObject({
  portfolioId: PortfolioIdSchema,
  baseCurrency: Iso4217Code,
  exposure: z.strictObject({
    status: z.enum(['OK', 'EXPOSURE_UNAVAILABLE']),
    nav: CanonicalDecimalSchema.nullable(),
    long: CanonicalDecimalSchema.nullable(),
    short: CanonicalDecimalSchema.nullable(),
    gross: CanonicalDecimalSchema.nullable(),
    net: CanonicalDecimalSchema.nullable(),
    cash: CanonicalDecimalSchema,
  }),
  confidence: CanonicalDecimalSchema.nullable(),
  horizonDays: z.literal(1),
  baseVaR: VarViewSchema,
  sentimentAdjustedVaR: VarViewSchema,
  /** Adjusted minus Base absolute VaR; `null` unless both values are present. */
  varDifference: CanonicalDecimalSchema.nullable(),
  /** R35.6: why Adjusted VaR differs from Base VaR, that nothing triggered, or why it is unavailable. */
  adjustmentExplanation: z.string().min(1),
  assets: z.array(AssetRiskRowSchema),
  calculation: z.strictObject({
    status: Code,
    flags: z.array(Code),
    missingConfigKeys: z.array(z.string().min(1)),
    asOfDate: IsoDate.nullable(),
    calculatedAt: IsoUtcMillis.nullable(),
  }),
});
export type PortfolioRiskView = z.infer<typeof PortfolioRiskViewSchema>;
export type VarView = z.infer<typeof VarViewSchema>;
