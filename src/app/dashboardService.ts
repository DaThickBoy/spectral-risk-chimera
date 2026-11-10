/**
 * Read-only dashboard service (tasks 17.1 to 17.3; design: Dashboard route;
 * Kiroween decisions DR-KW-1 H2, H4, H6 to H8).
 *
 * `view(portfolioId)` assembles one `DashboardViewResponse` from the existing
 * services only:
 * - the stored risk result and its adjustment detail (`RiskService`), the
 *   positions and allocation responses (`PortfolioQueryService`), and the 13.3
 *   sentiment view, through the 17.1 `buildPortfolioRiskView` builder, unchanged;
 * - `fx`: per instrument currency, the FX rate the positions response used (or why
 *   none was used), with the ECB attribution already carried by the positions
 *   response;
 * - `currencyExposure`: the base-currency market value per instrument currency,
 *   the Decimal sum of the positions' `marketValueBase`. A currency with any
 *   position lacking a base value is `UNAVAILABLE` with `null`, never a partial
 *   sum and never `"0"`;
 * - `display`: FR-14 money text (ROUND_HALF_UP to the base currency's minor
 *   units), so the frontend renders without calculating;
 * - `adjustedVaRAvailability`: the explicit OD-1 reason when no aggregator is
 *   assembled (H7); the VarView status codes are unchanged;
 * - `filing`: `NOT_CONFIGURED` (H8), no score;
 * - `lossDistribution` (Kiroween A2): the 20-bucket histogram of the Base VaR scenario
 *   losses, recomputed from the latest verified snapshot (`buildLossDistribution`), or why
 *   it is unavailable.
 * No portfolio, ledger, or alert data is written. Valuation runs on request, as for the
 * positions route, so the recording FX service may append FX observation records and
 * providers may be called (design: Gateway rule 9, known limitation); no
 * retrieval is scheduled.
 *
 * Validates: Requirements 17.1, 17.10, 20.6, 30.14, 35.1, 35.6.
 */
import { LOSS_HISTOGRAM_BUCKETS } from '../risk/index.js';
import type { SentimentState, SentimentView } from '../sentiment/index.js';
import {
  DASHBOARD_SCHEMA_VERSION,
  DashboardIndexResponseSchema,
  DashboardViewResponseSchema,
  appError,
  currencyMinorUnits,
  d,
  err,
  formatMoneyDisplay,
  ok,
  toCanonical,
} from '../shared/index.js';
import type {
  AppError,
  Clock,
  CurrencyExposure,
  DashboardFx,
  DashboardIndexResponse,
  DashboardViewResponse,
  DecimalString,
  PositionItemDto,
  Result,
} from '../shared/index.js';
import type { PortfolioQueryService } from './portfolioQuery.js';
import type { PortfolioService } from './portfolioService.js';
import type { RiskService } from './riskService.js';
import { buildPortfolioRiskView } from './riskViewBuilder.js';
import { buildLossDistribution } from './lossDistribution.js';

export type DashboardError = AppError<'NOT_FOUND'>;

export interface DashboardService {
  index(): DashboardIndexResponse;
  view(portfolioId: string): Promise<Result<DashboardViewResponse, DashboardError>>;
}

export interface DashboardServiceDependencies {
  readonly risk: RiskService;
  readonly queries: PortfolioQueryService;
  readonly portfolios: PortfolioService;
  /** Absent when the sentiment settings are missing: every asset shows no sentiment. */
  readonly sentiment: SentimentState | undefined;
  /** `NOT_APPROVED` when no aggregator is assembled (OD-1 open). */
  readonly sentimentAggregation: 'NOT_APPROVED' | 'INJECTED';
  readonly clock: Clock;
  /** Portfolios listed by `index()`, in order (the composition root decides; no repository listing). */
  readonly portfolioIds: readonly string[];
  readonly runMode: 'DEMO_FIXTURES' | 'UNSPECIFIED';
}

const FILING_EXPLANATION =
  'SEC filing risk is not configured in this demonstration (Kiroween decision H8); no filing score exists.';

const noSentiment = (ticker: string): SentimentView => ({ ticker, index: null, latest: null });

/** The FX status of one valued (or FX-failed) position; `undefined` when no rate was attempted. */
function fxStatusOf(item: PositionItemDto): DashboardFx['status'] | undefined {
  if (item.fxRate !== null) {
    if (item.fxRate.sourceKind === 'IDENTITY') {
      return 'IDENTITY';
    }
    return item.fxRate.status;
  }
  if (item.fxUnavailable !== null) {
    return item.fxUnavailable.code === 'FX_STALE' ? 'STALE' : 'UNAVAILABLE';
  }
  return undefined;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Per currency: the rate used, or why none was used. Sorted by currency. */
export function fxSummary(items: readonly PositionItemDto[]): DashboardFx[] {
  const groups = new Map<
    string,
    { item: PositionItemDto; status: DashboardFx['status']; tickers: string[] }
  >();
  for (const item of items) {
    const status = fxStatusOf(item);
    if (status === undefined) {
      continue;
    }
    const group = groups.get(item.currency);
    if (group === undefined) {
      groups.set(item.currency, { item, status, tickers: [item.ticker] });
    } else {
      group.tickers.push(item.ticker);
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => byText(a, b))
    .map(([currency, group]) => ({
      currency,
      status: group.status,
      rate: group.item.fxRate,
      unavailable: group.item.fxUnavailable,
      tickers: [...group.tickers].sort(byText),
    }));
}

/**
 * Base-currency market value per instrument currency: the Decimal sum of the
 * positions' `marketValueBase` (no rounding). Any missing value makes the whole
 * currency `UNAVAILABLE` with `null`. Sorted by currency; order-independent.
 */
export function currencyExposure(items: readonly PositionItemDto[]): CurrencyExposure[] {
  const groups = new Map<string, PositionItemDto[]>();
  for (const item of items) {
    groups.set(item.currency, [...(groups.get(item.currency) ?? []), item]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => byText(a, b))
    .map(([currency, group]) => {
      const tickers = group.map((item) => item.ticker).sort(byText);
      const values = group.map((item) => item.marketValueBase);
      if (values.some((value) => value === null)) {
        return { currency, status: 'UNAVAILABLE' as const, marketValueBase: null, tickers };
      }
      const [first, ...rest] = values as DecimalString[];
      const total = rest.reduce((sum, value) => sum.plus(d(value)), d(first as DecimalString));
      return { currency, status: 'OK' as const, marketValueBase: toCanonical(total), tickers };
    });
}

export function createDashboardService(deps: DashboardServiceDependencies): DashboardService {
  const runMode = deps.runMode;
  return {
    index: () =>
      DashboardIndexResponseSchema.parse({
        schemaVersion: DASHBOARD_SCHEMA_VERSION,
        generatedAt: deps.clock.nowUtc().toISOString(),
        runMode,
        portfolios: deps.portfolioIds
          .map((id) => deps.portfolios.get(id))
          .filter((record) => record !== undefined)
          .map((record) => ({ id: record.id, baseCurrency: record.baseCurrency })),
      }),

    view: async (portfolioId) => {
      const notFound = (): { ok: false; error: DashboardError } =>
        err(appError('NOT_FOUND', 'The resource was not found.'));
      const risk = deps.risk.view(portfolioId);
      const adjustment = deps.risk.adjustmentDetail(portfolioId);
      if (risk === undefined || adjustment === undefined) {
        return notFound();
      }
      const positions = await deps.queries.positions(portfolioId);
      const allocation = await deps.queries.allocation(portfolioId);
      if (!positions.ok || !allocation.ok) {
        return notFound();
      }
      const view = buildPortfolioRiskView({
        risk,
        adjustment,
        positions: positions.value,
        allocation: allocation.value,
        sentiment:
          deps.sentiment === undefined
            ? noSentiment
            : (ticker) => deps.sentiment?.view(ticker) ?? noSentiment(ticker),
        sentimentAggregation: deps.sentimentAggregation,
      });
      const items = positions.value.positions;
      const fx = fxSummary(items);
      const exposureByCurrency = currencyExposure(items);
      const minorUnits = currencyMinorUnits(view.baseCurrency);
      const money = (value: DecimalString | null | undefined): string | null =>
        value === null || value === undefined ? null : formatMoneyDisplay(value, minorUnits);
      const demo =
        view.calculation.flags.includes('DEMO_DATA') ||
        items.some(
          (item) => item.priceProvenance?.sourceKind === 'DEMO' || item.fxRate?.sourceKind === 'DEMO',
        );
      const notApproved = deps.sentimentAggregation === 'NOT_APPROVED';
      const adjustedUnavailable = view.sentimentAdjustedVaR.value === null;

      return ok(
        DashboardViewResponseSchema.parse({
          schemaVersion: DASHBOARD_SCHEMA_VERSION,
          portfolioId,
          generatedAt: deps.clock.nowUtc().toISOString(),
          runMode,
          dataMode: demo ? 'DEMO' : 'REAL',
          view,
          fx,
          currencyExposure: exposureByCurrency,
          adjustedVaRAvailability: {
            aggregation: deps.sentimentAggregation,
            reasonCode: notApproved && adjustedUnavailable ? 'AGGREGATION_NOT_APPROVED' : null,
            openDecision: notApproved ? 'OD-1' : null,
            explanation: view.adjustmentExplanation,
          },
          filing: { status: 'NOT_CONFIGURED', explanation: FILING_EXPLANATION },
          lossDistribution: buildLossDistribution({
            risk,
            scenarios: deps.risk.scenarioLosses(portfolioId),
            currency: view.baseCurrency,
            minorUnits,
            bucketCount: LOSS_HISTOGRAM_BUCKETS,
          }),
          display: {
            currency: view.baseCurrency,
            minorUnits,
            exposure: {
              nav: money(view.exposure.nav),
              long: money(view.exposure.long),
              short: money(view.exposure.short),
              gross: money(view.exposure.gross),
              net: money(view.exposure.net),
              cash: formatMoneyDisplay(view.exposure.cash, minorUnits),
            },
            baseVaR: money(view.baseVaR.value?.absolute),
            baseVaRLastValid: money(view.baseVaR.lastValid?.value.absolute),
            adjustedVaR: money(view.sentimentAdjustedVaR.value?.absolute),
            varDifference: money(view.varDifference),
            assets: view.assets.map((asset) => ({
              ticker: asset.ticker,
              marketValueBase: money(asset.marketValueBase),
            })),
            currencyExposure: exposureByCurrency.map((entry) => ({
              currency: entry.currency,
              marketValueBase: money(entry.marketValueBase),
            })),
          },
          freshness: {
            calculatedAt: view.calculation.calculatedAt,
            asOfDate: view.calculation.asOfDate,
            flags: view.calculation.flags,
            fxStatuses: [...new Set(fx.map((entry) => entry.status))].sort(byText),
            summary: fx.some((entry) => entry.status === 'UNAVAILABLE')
              ? 'FX_UNAVAILABLE'
              : fx.some((entry) => entry.status === 'STALE') ||
                  view.calculation.flags.includes('MARKET_DATA_STALE')
                ? 'STALE_INPUTS'
                : 'CURRENT',
          },
        }),
      );
    },
  };
}
