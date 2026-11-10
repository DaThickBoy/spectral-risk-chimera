/**
 * Read-only dashboard contracts (tasks 17.1 to 17.3; design: View models, Dashboard
 * route; Kiroween decisions DR-KW-1 H2, H4, H6 to H8).
 *
 * `GET /dashboard` lists the portfolios the dashboard shows; `GET /dashboard/portfolios/:id`
 * returns one portfolio's `DashboardViewResponse`. Both are GET-only and carry no write
 * capability. The same JSON bodies, stored verbatim, are the recorded responses of the
 * static replay (H4): the frontend reads them through one data-source interface.
 *
 * Every financial value is a Canonical Decimal String computed by the backend; display
 * strings (`display`) are the FR-14 money rounding done by the backend. The frontend
 * only renders them and never calculates.
 */
import { z } from 'zod';
import { Iso4217Code, IsoDate } from '../schemas.js';
import { IsoUtcMillis } from '../timestamps.js';
import { CanonicalDecimalSchema, PortfolioIdSchema, PositionItemSchema } from './portfolio.js';
import { LossDistributionSchema } from './lossDistribution.js';
import { PortfolioRiskViewSchema } from './views.js';

/**
 * Version of the dashboard contract family: the view, the index, and the replay manifest.
 * Every schema here is strict (unknown fields are rejected) and requires `schemaVersion` to equal
 * this literal, so any change to the required shape is incompatible in both directions. Such a
 * change increments the version; the reader then refuses responses and replays of another
 * version (`INVALID_RESPONSE`) instead of misreading them.
 * - 1: tasks 17.1 to 17.3 and the OD-21 replay.
 * - 2 (Kiroween A2, 2026-11-10): the view adds the required `lossDistribution`.
 */
export const DASHBOARD_SCHEMA_VERSION = 2;

const NullableDisplay = z.string().min(1).nullable();
const Code = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

/** One currency's FX rate for the base-currency valuation, as used by the positions response. */
export const DashboardFxSchema = z.strictObject({
  currency: Iso4217Code,
  /** IDENTITY (base currency), CURRENT, DEMO, or why no rate was used. */
  status: z.enum(['IDENTITY', 'CURRENT', 'DEMO', 'STALE', 'UNAVAILABLE']),
  rate: PositionItemSchema.shape.fxRate,
  unavailable: PositionItemSchema.shape.fxUnavailable,
  tickers: z.array(z.string().min(1)).min(1),
});

/** Base-currency market value per instrument currency (sum of the positions' marketValueBase). */
export const CurrencyExposureSchema = z.strictObject({
  currency: Iso4217Code,
  status: z.enum(['OK', 'UNAVAILABLE']),
  /** `null` when any position of the currency has no base-currency value; never `"0"`. */
  marketValueBase: CanonicalDecimalSchema.nullable(),
  tickers: z.array(z.string().min(1)).min(1),
});

export const DashboardViewResponseSchema = z.strictObject({
  schemaVersion: z.literal(DASHBOARD_SCHEMA_VERSION),
  portfolioId: PortfolioIdSchema,
  /** When the backend built this response. */
  generatedAt: IsoUtcMillis,
  /** How the application was started (`DEMO_FIXTURES` is the hackathon demo mode, H5). */
  runMode: z.enum(['DEMO_FIXTURES', 'UNSPECIFIED']),
  /** `DEMO` when any price, series, or FX rate used is DEMO, or the result is flagged DEMO_DATA. */
  dataMode: z.enum(['DEMO', 'REAL']),
  view: PortfolioRiskViewSchema,
  fx: z.array(DashboardFxSchema),
  currencyExposure: z.array(CurrencyExposureSchema),
  /** Why Adjusted VaR is unavailable when no aggregation method is approved (H7, OD-1 open). */
  adjustedVaRAvailability: z.strictObject({
    aggregation: z.enum(['NOT_APPROVED', 'INJECTED']),
    /** Machine-readable; the VarView status codes are unchanged. */
    reasonCode: z.enum(['AGGREGATION_NOT_APPROVED']).nullable(),
    openDecision: z.literal('OD-1').nullable(),
    explanation: z.string().min(1),
  }),
  /** SEC filing risk is not configured (H8); no filing score exists. */
  filing: z.strictObject({ status: z.literal('NOT_CONFIGURED'), explanation: z.string().min(1) }),
  /** Kiroween A2: histogram of the Base VaR scenario losses, or why it is unavailable. */
  lossDistribution: LossDistributionSchema,
  /** FR-14 display text (ROUND_HALF_UP to the base currency's minor units), computed by the backend. */
  display: z.strictObject({
    currency: Iso4217Code,
    minorUnits: z.int().min(0).max(4),
    exposure: z.strictObject({
      nav: NullableDisplay,
      long: NullableDisplay,
      short: NullableDisplay,
      gross: NullableDisplay,
      net: NullableDisplay,
      cash: z.string().min(1),
    }),
    baseVaR: NullableDisplay,
    baseVaRLastValid: NullableDisplay,
    adjustedVaR: NullableDisplay,
    varDifference: NullableDisplay,
    assets: z.array(z.strictObject({ ticker: z.string().min(1), marketValueBase: NullableDisplay })),
    currencyExposure: z.array(z.strictObject({ currency: Iso4217Code, marketValueBase: NullableDisplay })),
  }),
  /** Freshness summary for the top bar. */
  freshness: z.strictObject({
    calculatedAt: IsoUtcMillis.nullable(),
    asOfDate: IsoDate.nullable(),
    flags: z.array(Code),
    fxStatuses: z.array(z.enum(['IDENTITY', 'CURRENT', 'DEMO', 'STALE', 'UNAVAILABLE'])),
    /**
     * Backend summary for the top bar: `FX_UNAVAILABLE` when any rate is unavailable,
     * otherwise `STALE_INPUTS` when any rate is stale or the market data is flagged stale,
     * otherwise `CURRENT`.
     */
    summary: z.enum(['CURRENT', 'STALE_INPUTS', 'FX_UNAVAILABLE']),
  }),
});
export type DashboardViewResponse = z.infer<typeof DashboardViewResponseSchema>;
export type DashboardFx = z.infer<typeof DashboardFxSchema>;
export type CurrencyExposure = z.infer<typeof CurrencyExposureSchema>;

export const DashboardIndexResponseSchema = z.strictObject({
  schemaVersion: z.literal(DASHBOARD_SCHEMA_VERSION),
  generatedAt: IsoUtcMillis,
  runMode: z.enum(['DEMO_FIXTURES', 'UNSPECIFIED']),
  portfolios: z.array(z.strictObject({ id: PortfolioIdSchema, baseCurrency: Iso4217Code })),
});
export type DashboardIndexResponse = z.infer<typeof DashboardIndexResponseSchema>;

const ReplayFileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(json|csv)$/);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Static-replay manifest (OD-21, approved 2026-11-09): `manifest.json` next to the built
 * dashboard. It holds the recorded `GET /dashboard` body verbatim and, per portfolio, the plain
 * file name (no directories) of its recorded `GET /dashboard/portfolios/:id` body, stored
 * byte for byte as the backend served it. Recorded by `src/main/replayExport.ts` from the
 * real application in the explicit demo mode, with deterministic fixture providers (no live
 * provider) and the fixed reference clock. The manifest also states what was recorded:
 * DEMO data, the reference clock and dates, each view's freshness, the SHA-256 of every
 * file, and the recorded ECB response used (attributed, unmodified).
 */
export const DashboardReplayManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(DASHBOARD_SCHEMA_VERSION),
    kind: z.literal('DASHBOARD_REPLAY'),
    /** The fixed reference clock at which the responses were recorded (OD-21). */
    recordedAt: IsoUtcMillis,
    /** Human-readable statement shown with the replay. */
    note: z.string().min(1),
    /** A recorded replay of DEMO data, never live data. */
    dataMode: z.literal('DEMO'),
    live: z.literal(false),
    reference: z.strictObject({
      /** The fixed reference clock (equal to `recordedAt`). */
      clock: IsoUtcMillis,
      /** Last trading day of the DEMO market-data fixtures. */
      marketDataAsOf: IsoDate,
      /** Reference date of the recorded ECB observations used. */
      fxReferenceDate: IsoDate,
    }),
    source: z.strictObject({
      runMode: z.literal('DEMO_FIXTURES'),
      configProfile: z.string().min(1),
      marketData: z.literal('DEMO_FIXTURES'),
      fx: z.strictObject({
        provider: z.literal('ECB-EXR'),
        /** The recorded ECB response served to the adapter, copied unmodified next to the manifest. */
        recordedResponse: ReplayFileName,
        sha256: Sha256,
        statement: z.literal('Source: ECB statistics.'),
      }),
    }),
    index: DashboardIndexResponseSchema,
    views: z.record(PortfolioIdSchema, ReplayFileName),
    portfolios: z.array(
      z.strictObject({
        id: PortfolioIdSchema,
        file: ReplayFileName,
        sha256: Sha256,
        dataMode: z.enum(['DEMO', 'REAL']),
        freshness: z.strictObject({
          summary: z.enum(['CURRENT', 'STALE_INPUTS', 'FX_UNAVAILABLE']),
          asOfDate: IsoDate.nullable(),
          calculatedAt: IsoUtcMillis.nullable(),
        }),
      }),
    ),
  })
  .superRefine((manifest, ctx) => {
    // Complete and internally consistent: index, views, and portfolios name the same portfolios.
    const indexIds = manifest.index.portfolios.map((p) => p.id);
    const viewIds = Object.keys(manifest.views);
    const listed = manifest.portfolios.map((p) => p.id);
    const same = (a: readonly string[], b: readonly string[]) =>
      a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);
    if (!same(indexIds, viewIds) || !same(indexIds, listed) || indexIds.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'index, views, and portfolios must list the same portfolios' });
    }
    if (manifest.portfolios.some((p) => manifest.views[p.id] !== p.file)) {
      ctx.addIssue({ code: 'custom', message: 'each portfolio file must match its views entry' });
    }
    if (manifest.reference.clock !== manifest.recordedAt) {
      ctx.addIssue({ code: 'custom', message: 'reference.clock must equal recordedAt' });
    }
  });
export type DashboardReplayManifest = z.infer<typeof DashboardReplayManifestSchema>;
