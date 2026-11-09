/**
 * Seeded deterministic DEMO portfolios for the explicit demonstration mode
 * (Kiroween decision H6). Seeding goes through the ordinary use cases: the
 * portfolio service creates the portfolio with explicit cash, and the import use
 * case imports a fixed CSV, so positions, valuation, exposure, and risk are the
 * production code paths (no demo-only calculation). The recalculation that follows
 * is the normal `PositionsChanged` reaction; nothing is scheduled or refreshed.
 *
 * Portfolios (EUR base only; otherwise nothing is seeded and the reason is logged):
 * - `demo-eur-usd-gbp`: DEMO-EU (EUR), DEMO-US (USD), DEMO-UK (GBP) and EUR cash.
 *   Valuation converts USD and GBP into EUR through the configured FX provider
 *   (ECB: derived inverse rates; FIXTURE: one inverse and one direct DEMO rate).
 * - `demo-eur-only`: DEMO-EU and DEMO-A (both EUR) and EUR cash. It needs no FX
 *   rate, so it stays understandable when FX data is unavailable or stale.
 * Every price and series is DEMO, so every result carries `DEMO_DATA` and is
 * never evaluated for VaR alerts (R30.11).
 *
 * Idempotent: an existing portfolio is left untouched (`ALREADY_PRESENT`); the
 * trade timestamps are fixed, so a re-import would also be a duplicate. Quantities,
 * prices, and cash are fixed decimal text.
 */
import type { ImportUseCase, PortfolioService } from '../app/index.js';
import { brandDecimalString } from '../shared/index.js';
import type { DemoFixtures } from './demoFixtures.js';

/** Fixed trade time of every seeded transaction. */
export const DEMO_SEED_TRADE_TIMESTAMP = '2026-10-01T14:30:00Z';
export const DEMO_SEED_SOURCE = 'DEMO_SEED';

export interface DemoPortfolioDefinition {
  readonly id: string;
  readonly cash: string;
  readonly holdings: readonly { readonly ticker: string; readonly quantity: string }[];
}

export const DEMO_PORTFOLIOS: readonly DemoPortfolioDefinition[] = [
  {
    id: 'demo-eur-usd-gbp',
    cash: '1000',
    holdings: [
      { ticker: 'DEMO-EU', quantity: '100' },
      { ticker: 'DEMO-US', quantity: '50' },
      { ticker: 'DEMO-UK', quantity: '150' },
    ],
  },
  {
    id: 'demo-eur-only',
    cash: '1000',
    holdings: [
      { ticker: 'DEMO-EU', quantity: '100' },
      { ticker: 'DEMO-A', quantity: '40' },
    ],
  },
];

export type DemoSeedReason =
  | 'SEEDED'
  | 'ALREADY_PRESENT'
  | 'REQUIRES_EUR_BASE'
  | 'CURRENCY_NOT_SUPPORTED'
  | 'PORTFOLIOS_UNAVAILABLE'
  | 'IMPORT_UNAVAILABLE'
  | 'CREATE_FAILED'
  | 'IMPORT_FAILED';

export interface DemoSeedOutcome {
  readonly portfolioId: string;
  readonly seeded: boolean;
  readonly reason: DemoSeedReason;
  /** Accepted rows (a count) when the import ran. */
  readonly accepted?: number;
}

export interface DemoSeedDependencies {
  readonly portfolios: PortfolioService | undefined;
  readonly imports: ImportUseCase | undefined;
  /** `fx.baseCurrency` as loaded (may be absent). */
  readonly baseCurrency: unknown;
  /** `fx.supportedCurrencies` as loaded (may be absent). */
  readonly supportedCurrencies: unknown;
  readonly fixtures: DemoFixtures;
  /**
   * The configuration's `import` feature availability (R28.20: no import without
   * `import.oversellPolicy`). Checked before anything is created, so a refused
   * import never leaves an empty demo portfolio behind.
   */
  readonly importAvailable: boolean;
}

const csvFor = (definition: DemoPortfolioDefinition, fixtures: DemoFixtures): string =>
  [
    'trade_timestamp,ticker,type,quantity,price,currency',
    ...definition.holdings.map(
      (h) =>
        `${DEMO_SEED_TRADE_TIMESTAMP},${h.ticker},BUY,${h.quantity},${fixtures.firstCloses[h.ticker] ?? ''},${fixtures.currencies[h.ticker] ?? ''}`,
    ),
  ].join('\n') + '\n';

async function seedOne(
  definition: DemoPortfolioDefinition,
  deps: DemoSeedDependencies,
): Promise<DemoSeedOutcome> {
  const outcome = (reason: DemoSeedReason, accepted?: number): DemoSeedOutcome => ({
    portfolioId: definition.id,
    seeded: reason === 'SEEDED',
    reason,
    ...(accepted === undefined ? {} : { accepted }),
  });
  if (deps.baseCurrency !== 'EUR') {
    return outcome('REQUIRES_EUR_BASE');
  }
  const supported = Array.isArray(deps.supportedCurrencies) ? (deps.supportedCurrencies as unknown[]) : [];
  if (!definition.holdings.every((h) => supported.includes(deps.fixtures.currencies[h.ticker]))) {
    return outcome('CURRENCY_NOT_SUPPORTED');
  }
  if (deps.portfolios === undefined) {
    return outcome('PORTFOLIOS_UNAVAILABLE');
  }
  if (deps.imports === undefined || !deps.importAvailable) {
    return outcome('IMPORT_UNAVAILABLE');
  }
  const created = deps.portfolios.create({
    id: definition.id,
    baseCurrency: 'EUR',
    cash: brandDecimalString(definition.cash),
  });
  if (created.status === 'PORTFOLIO_EXISTS') {
    return outcome('ALREADY_PRESENT');
  }
  if (created.status !== 'CREATED') {
    return outcome('CREATE_FAILED');
  }
  const result = await deps.imports.run({
    portfolioId: definition.id,
    fileName: `${definition.id}.csv`,
    bytes: new TextEncoder().encode(csvFor(definition, deps.fixtures)),
    source: DEMO_SEED_SOURCE,
    columns: {},
  });
  if (result.status !== 'DONE' || result.summary.status !== 'COMMITTED') {
    return outcome('IMPORT_FAILED', result.status === 'DONE' ? result.summary.accepted : undefined);
  }
  return outcome('SEEDED', result.summary.accepted);
}

/** Seeds every demo portfolio in order; never throws for a refused or failed seed. */
export async function seedDemoPortfolios(deps: DemoSeedDependencies): Promise<readonly DemoSeedOutcome[]> {
  const outcomes: DemoSeedOutcome[] = [];
  for (const definition of DEMO_PORTFOLIOS) {
    outcomes.push(await seedOne(definition, deps));
  }
  return outcomes;
}
