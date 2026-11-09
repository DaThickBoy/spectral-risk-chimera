/**
 * Attribution of published FX reference rates (R30.14; design: ECB adapter rule 8;
 * Kiroween decision H2).
 *
 * The ECB publishes euro foreign exchange reference rates only as `EUR -> X` (units
 * of X per one euro). With the EUR base, `FxService` always requests `X -> EUR` and
 * inverts the published value with one Decimal division (FX rules 1 and 9), so every
 * ECB rate it uses for a non-euro currency is a DERIVED value, not a published one.
 *
 * `fxAttribution` states this from the rate's provenance alone (source, source kind,
 * requested pair, and observation time), so no stored record or snapshot shape changes:
 * - `PUBLISHED`: the requested pair is the published orientation `EUR + X`; the value
 *   is the published text, canonicalized (no arithmetic).
 * - `DERIVED_INVERSE`: the requested pair is `X + EUR`, the inverse of the published
 *   `EUR + X`, computed as `1 / published` with Decimal.js at 40 significant digits,
 *   ROUND_HALF_UP (FR-14; the project Decimal configuration).
 * - `referenceDate`: the ECB reference date D. Under the convention
 *   `ECB-PUB-1600-FRANKFURT-v1` the instant is D at 14:00Z or 15:00Z, so D is the
 *   instant's UTC date.
 * Rates from any other source have no attribution (`undefined`). The published
 * observation text itself is not retained by the FX service or `fx_rates`; only the
 * recorded fixtures and the live response contain it (open provenance decision).
 */

/** Provider name (and so `source`) of the ECB adapter (task 10.2). */
export const ECB_SOURCE_NAME = 'ECB-EXR';

export const ECB_SOURCE_STATEMENT = 'Source: ECB statistics.';
export const ECB_DERIVED_NOTE =
  'Derived by inverting the published ECB euro reference rate (1 / EUR->X); not identical to the published reference rate.';
export const ECB_INFORMATION_NOTE =
  'The ECB euro foreign exchange reference rates are published for information purposes only.';

export type FxDerivation = 'PUBLISHED' | 'DERIVED_INVERSE';

export interface FxAttribution {
  readonly statement: string;
  readonly derivation: FxDerivation;
  /** The published series orientation, `EUR` + X. */
  readonly publishedPair: string;
  /** ECB reference date `YYYY-MM-DD`, or `null` without an observation time. */
  readonly referenceDate: string | null;
  /** How the value used was obtained from the published one. */
  readonly method: 'AS_PUBLISHED' | 'DECIMAL_INVERSE';
  /** The precision of the derivation: the project Decimal configuration (FR-14). */
  readonly precision: { readonly significantDigits: 40; readonly rounding: 'ROUND_HALF_UP' };
  readonly notes: readonly string[];
}

const PAIR = /^[A-Z]{6}$/;
const PRECISION = Object.freeze({ significantDigits: 40, rounding: 'ROUND_HALF_UP' } as const);

/** Attribution for an ECB-sourced REAL rate with the requested pair; otherwise `undefined`. */
export function fxAttribution(rate: {
  readonly pair: string;
  readonly source: string;
  readonly sourceKind: string;
  readonly observedAt?: string | null;
}): FxAttribution | undefined {
  if (rate.source !== ECB_SOURCE_NAME || rate.sourceKind !== 'REAL' || !PAIR.test(rate.pair)) {
    return undefined;
  }
  const from = rate.pair.slice(0, 3);
  const to = rate.pair.slice(3);
  const referenceDate =
    typeof rate.observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(rate.observedAt)
      ? rate.observedAt.slice(0, 10)
      : null;
  if (from === 'EUR' && to !== 'EUR') {
    return Object.freeze({
      statement: ECB_SOURCE_STATEMENT,
      derivation: 'PUBLISHED',
      publishedPair: rate.pair,
      referenceDate,
      method: 'AS_PUBLISHED',
      precision: PRECISION,
      notes: Object.freeze([ECB_INFORMATION_NOTE]),
    });
  }
  if (to === 'EUR' && from !== 'EUR') {
    return Object.freeze({
      statement: ECB_SOURCE_STATEMENT,
      derivation: 'DERIVED_INVERSE',
      publishedPair: `EUR${from}`,
      referenceDate,
      method: 'DECIMAL_INVERSE',
      precision: PRECISION,
      notes: Object.freeze([ECB_DERIVED_NOTE, ECB_INFORMATION_NOTE]),
    });
  }
  // The ECB publishes no other orientation: nothing is attributed to it.
  return undefined;
}
