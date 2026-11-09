/**
 * Portfolio, position, and allocation API contracts (tasks 6.1, 11.4, 11.5;
 * design: API routes, Valuation rules, Exposure and Allocation rules, Last valid
 * price rules; R5.2, R20, R30.1, A-7, R4.3).
 *
 * - Financial values are Canonical Decimal Strings, never JSON numbers (R4.3).
 *   Request financial fields accept any decimal text and are canonicalized by
 *   the server; a JSON number is rejected.
 * - Every object is strict: unknown fields are rejected (R29.5).
 * - These are the external shapes; they restate literal unions instead of
 *   importing domain modules, because `web/` may import `shared/` only.
 */
import { z } from 'zod';
import { d, toCanonical } from '../decimal.js';
import { DecimalStringSchema, Iso4217Code, IsoDate } from '../schemas.js';
import { IsoUtcMillis } from '../timestamps.js';

/** Decimal text that is already canonical (responses). */
export const CanonicalDecimalSchema = DecimalStringSchema.refine((text) => toCanonical(d(text)) === text, {
  message: 'expected a canonical decimal string',
});

/** Portfolio identifier: 1 to 64 characters, letters, digits, `.`, `_`, `-`; starts with a letter or digit. */
export const PortfolioIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

export const PortfolioParamsSchema = z.strictObject({ id: PortfolioIdSchema });

/** `POST /portfolios` (task 6.1): `cash` is required, never defaulted; "0" and negative values are valid. */
export const PortfolioCreateSchema = z.strictObject({
  id: PortfolioIdSchema,
  base_currency: Iso4217Code,
  cash: DecimalStringSchema,
});
export type PortfolioCreateRequest = z.infer<typeof PortfolioCreateSchema>;

export const PortfolioSchema = z.strictObject({
  id: PortfolioIdSchema,
  base_currency: Iso4217Code,
  cash: CanonicalDecimalSchema,
});
export type PortfolioDto = z.infer<typeof PortfolioSchema>;

export const VALUATION_STATUSES = [
  'NOT_VALUED',
  'VALUED',
  'PRICE_UNAVAILABLE',
  'PRICE_CURRENCY_MISMATCH',
  'FX_UNAVAILABLE',
  'FX_STALE',
] as const;
const SourceKind = z.enum(['REAL', 'DEMO']);
const NullableDecimal = CanonicalDecimalSchema.nullable();

/** Task 11.5: display-only last valid price (Last valid price rules). */
export const StalePriceDisplaySchema = z.strictObject({
  kind: z.literal('LAST_VALID_DISPLAY'),
  status: z.literal('STALE'),
  label: z.literal('LAST_VALID'),
  ticker: z.string().min(1),
  currency: Iso4217Code,
  price: CanonicalDecimalSchema.refine((text) => d(text).greaterThan(0), {
    message: 'must be greater than 0',
  }),
  asOf: IsoDate,
  source: z.string().min(1),
  sourceKind: SourceKind,
  retrievedAt: IsoUtcMillis,
});
export type StalePriceDisplayDto = z.infer<typeof StalePriceDisplaySchema>;

/** R30.14 / ECB adapter rule 8 (H2): published versus derived ECB rates. */
export const FxAttributionSchema = z.strictObject({
  statement: z.string().min(1),
  derivation: z.enum(['PUBLISHED', 'DERIVED_INVERSE']),
  publishedPair: z.string().regex(/^[A-Z]{6}$/),
  referenceDate: IsoDate.nullable(),
  method: z.enum(['AS_PUBLISHED', 'DECIMAL_INVERSE']),
  precision: z.strictObject({ significantDigits: z.literal(40), rounding: z.literal('ROUND_HALF_UP') }),
  notes: z.array(z.string().min(1)).min(1),
});

export const PositionItemSchema = z.strictObject({
  id: z.string().min(1),
  portfolioId: PortfolioIdSchema,
  ticker: z.string().min(1),
  currency: Iso4217Code,
  signedQuantity: CanonicalDecimalSchema,
  averagePrice: NullableDecimal,
  isShort: z.boolean(),
  updatedAt: IsoUtcMillis,
  source: z.string().min(1),
  marketPrice: NullableDecimal,
  marketValueInstrument: NullableDecimal,
  marketValueBase: NullableDecimal,
  allocationPct: NullableDecimal,
  valuationStatus: z.enum(VALUATION_STATUSES),
  priceAsOf: IsoDate.nullable(),
  /** The quote used (VALUED, FX_UNAVAILABLE, FX_STALE); otherwise null. */
  priceProvenance: z
    .strictObject({
      asOf: IsoDate,
      source: z.string().min(1),
      sourceKind: SourceKind,
      retrievedAt: IsoUtcMillis,
    })
    .nullable(),
  /** The FX rate used (VALUED only); otherwise null. */
  fxRate: z
    .strictObject({
      pair: z.string().regex(/^[A-Z]{6}$/),
      rate: CanonicalDecimalSchema,
      observedAt: IsoUtcMillis.nullable(),
      observedAtBasis: z.enum(['PROVIDER', 'PUBLICATION_CONVENTION']).optional(),
      conventionId: z.string().min(1).optional(),
      source: z.string().min(1),
      sourceKind: z.enum(['REAL', 'DEMO', 'IDENTITY']),
      status: z.enum(['CURRENT', 'DEMO']),
      /**
       * R30.14 / ECB adapter rule 8 (H2): present only for ECB-sourced rates. States the
       * source, whether the value is the published reference rate or DERIVED by inverting
       * it, the published pair, and the notes to display with it.
       */
      attribution: FxAttributionSchema.optional(),
      /**
       * OD-20: the provider's quote behind an OBSERVED rate, read back from `fx_rates` (for the
       * ECB the published `EUR -> X` reference rate, never the derived rate). `null` when the
       * stored record has none (written before migration 2); absent for the identity rate.
       */
      quote: z
        .strictObject({
          pair: z.string().regex(/^[A-Z]{6}$/),
          rate: CanonicalDecimalSchema,
          referenceDate: IsoDate.nullable(),
          method: z.enum(['AS_PUBLISHED', 'DECIMAL_INVERSE']),
          precision: z.literal('SIGNIFICANT_DIGITS_40_ROUND_HALF_UP'),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
  /** Why no price was used (PRICE_UNAVAILABLE only). */
  priceUnavailable: z
    .strictObject({
      cause: z.enum(['PROVIDER_ERROR', 'INVALID_RESPONSE', 'FUTURE_DATED']),
      providerCode: z.string().min(1).optional(),
    })
    .nullable(),
  /** Why no FX rate was used (FX_UNAVAILABLE and FX_STALE only). */
  fxUnavailable: z
    .strictObject({
      code: z.enum(['FX_UNAVAILABLE', 'FX_STALE']),
      currency: Iso4217Code,
      cause: z.string().min(1).optional(),
      providerCode: z.string().min(1).optional(),
    })
    .nullable(),
  /** Task 11.5, display only; present only for an eligible PRICE_UNAVAILABLE. */
  lastValid: StalePriceDisplaySchema.optional(),
});
export type PositionItemDto = z.infer<typeof PositionItemSchema>;

export const PositionsResponseSchema = z.strictObject({
  portfolioId: PortfolioIdSchema,
  baseCurrency: Iso4217Code,
  /** The valuation run's calculation timestamp. */
  at: IsoUtcMillis,
  positions: z.array(PositionItemSchema),
});
export type PositionsResponse = z.infer<typeof PositionsResponseSchema>;

const MeasuresSchema = z.strictObject({
  long: CanonicalDecimalSchema,
  short: CanonicalDecimalSchema,
  gross: CanonicalDecimalSchema,
  net: CanonicalDecimalSchema,
  cash: CanonicalDecimalSchema,
  nav: CanonicalDecimalSchema,
  /** The denominator used (FR-10, R20.6). */
  allocationDenominator: CanonicalDecimalSchema,
});

const LineSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('POSITION'),
    ticker: z.string().min(1),
    valueBase: CanonicalDecimalSchema,
    pct: CanonicalDecimalSchema,
  }),
  z.strictObject({ kind: z.literal('CASH'), valueBase: CanonicalDecimalSchema, pct: CanonicalDecimalSchema }),
]);

const ExposureLineSchema = z.strictObject({ ticker: z.string().min(1), valueBase: CanonicalDecimalSchema });

export const ExposureSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('OK'),
    navStatus: z.enum(['NAV_POSITIVE', 'NAV_NOT_POSITIVE']),
    measures: MeasuresSchema,
  }),
  z.strictObject({
    status: z.literal('EXPOSURE_UNAVAILABLE'),
    reason: z.literal('VALUATION_INCOMPLETE'),
    unvalued: z.array(
      z.strictObject({ ticker: z.string().min(1), valuationStatus: z.enum(VALUATION_STATUSES) }),
    ),
    cash: CanonicalDecimalSchema,
  }),
]);

export const AllocationSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ELIGIBLE'),
    measures: MeasuresSchema,
    lines: z.array(LineSchema),
    total: CanonicalDecimalSchema,
  }),
  z.strictObject({
    status: z.literal('INELIGIBLE'),
    reasons: z.array(z.enum(['SHORT_POSITIONS', 'NEGATIVE_CASH', 'LEVERAGE'])),
    measures: MeasuresSchema,
    lines: z.array(LineSchema),
    shortPositions: z.array(ExposureLineSchema),
  }),
  z.strictObject({
    status: z.literal('ALLOCATION_UNAVAILABLE'),
    reason: z.literal('DENOMINATOR_NOT_POSITIVE'),
    measures: MeasuresSchema,
  }),
]);

/** `GET /portfolios/:id/allocation`: raw exposure values are separate from percentages (R20.8). */
export const AllocationResponseSchema = z.strictObject({
  portfolioId: PortfolioIdSchema,
  baseCurrency: Iso4217Code,
  at: IsoUtcMillis,
  exposure: ExposureSchema,
  /** `null` when exposure is unavailable (no allocation from incomplete data). */
  allocation: AllocationSchema.nullable(),
});
export type AllocationResponse = z.infer<typeof AllocationResponseSchema>;
