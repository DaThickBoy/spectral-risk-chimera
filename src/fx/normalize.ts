/**
 * FX payload schemas (task 10.1; R4.2, R4.6, R30.5; design: FX rules 3 and 5).
 *
 * Strict Zod schemas, so unknown fields are rejected and nothing is coerced,
 * clamped, or defaulted:
 * - `rate`: positive decimal text in the fixed grammar (no exponent, separators,
 *   `NaN`, or `Infinity`). A `LosslessJsonNumber` (from a real adapter's lossless
 *   parser, task 10.2) contributes its exact source text. A JavaScript number is
 *   rejected.
 * - `observedAt`: the shared `IsoUtcMillis` form `YYYY-MM-DDTHH:mm:ss.sssZ`.
 * - `from`, `to`: ISO 4217 codes known to the runtime (`Iso4217Code`).
 * - `observedAtBasis` and `conventionId` (task 10.4): see `ProviderFxRateSchema`.
 *
 * `ProviderFxRateSchema` validates a provider result (FX rule 5). The fixture
 * provider stores entries without provenance and validates them with
 * `FxFixtureEntrySchema`; it adds its own name and kind.
 */
import { z } from 'zod';
import {
  Iso4217Code,
  IsoDate,
  IsoUtcMillis,
  LosslessJsonNumber,
  PositiveDecimalString,
} from '../shared/index.js';

const RateText = z
  .union([z.string(), z.instanceof(LosslessJsonNumber)])
  .transform((value) => (typeof value === 'string' ? value : value.text))
  .pipe(PositiveDecimalString);

export const FxFixtureEntrySchema = z.strictObject({
  from: Iso4217Code,
  to: Iso4217Code,
  rate: RateText,
  observedAt: IsoUtcMillis,
});

/** Identifier of a publication-time convention (task 10.4, R30.13). */
export const CONVENTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Provider result (FX rule 5). The timestamp basis (task 10.4) allows exactly two
 * combinations: `PROVIDER` without `conventionId`, and `PUBLICATION_CONVENTION`
 * with a `conventionId` matching `CONVENTION_ID_PATTERN`. A missing or unknown
 * basis, or any other combination, fails.
 */
export const ProviderFxRateSchema = z
  .strictObject({
    from: Iso4217Code,
    to: Iso4217Code,
    rate: RateText,
    observedAt: IsoUtcMillis,
    observedAtBasis: z.enum(['PROVIDER', 'PUBLICATION_CONVENTION']),
    conventionId: z.string().regex(CONVENTION_ID_PATTERN).optional(),
    // OD-20: the provider's reference date, kept as provenance; it never selects a rate.
    referenceDate: IsoDate.optional(),
    source: z.string().min(1),
    sourceKind: z.enum(['REAL', 'DEMO']),
  })
  .refine((rate) => (rate.observedAtBasis === 'PROVIDER') === (rate.conventionId === undefined), {
    message: 'PROVIDER has no conventionId; PUBLICATION_CONVENTION requires one',
  });

export type FxFixtureEntry = z.infer<typeof FxFixtureEntrySchema>;
export type ValidatedProviderFxRate = z.infer<typeof ProviderFxRateSchema>;

/** Three upper-case letters; the shape required of a requested currency (FX rule 3). */
export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/** True for a real `YYYY-MM-DD` calendar date. */
export const isIsoDate = (value: unknown): value is string => IsoDate.safeParse(value).success;

/** The last instant of `asOf` in UTC, in `IsoUtcMillis` form (FX rule 6). */
export const endOfUtcDay = (asOf: string): string => `${asOf}T23:59:59.999Z`;
