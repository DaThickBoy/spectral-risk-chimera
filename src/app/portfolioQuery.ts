/**
 * Positions and allocation queries (task 11.4; design: API routes, Valuation,
 * Exposure, Allocation, and Last valid price rules; R5.2, R20.6, R20.8, R4.3).
 *
 * One query:
 * 1. reads the portfolio, with its explicit cash (6.1), and its persisted
 *    positions in one unit of work;
 * 2. values them with the injected `PositionValuationService` (11.1, or the 11.5
 *    wrapper);
 * 3. computes exposure (11.2) and, only when exposure is available, the
 *    allocation (11.3), which fills `allocationPct`.
 *
 * It maps the domain results to the shared API contract DTOs. Every financial
 * value is a Canonical Decimal String; nothing is recomputed here, no missing
 * value becomes zero, and `lastValid` is passed through for display only.
 */
import { fxAttribution } from '../fx/index.js';
import type { FxRateUsed } from '../fx/index.js';
import type { PositionRecord, UnitOfWork } from '../persistence/ports.js';
import { allocate, computeExposure, withAllocation } from '../portfolio/index.js';
import type {
  AllocationLine,
  AllocationResult,
  ExposureResult,
  Position,
  PositionView,
} from '../portfolio/index.js';
import { brandDecimalString, err, ok } from '../shared/index.js';
import type {
  AllocationResponse,
  AppError,
  PositionItemDto,
  PositionsResponse,
  Result,
} from '../shared/index.js';
import type { PortfolioValuation, PositionValuation, PositionValuationService } from './positionValuation.js';

export type PortfolioQueryError = AppError<'PORTFOLIO_NOT_FOUND'>;

export interface PortfolioQueryService {
  positions(portfolioId: string): Promise<Result<PositionsResponse, PortfolioQueryError>>;
  allocation(portfolioId: string): Promise<Result<AllocationResponse, PortfolioQueryError>>;
}

export interface PortfolioQueryDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly valuation: PositionValuationService;
}

interface Evaluated {
  readonly portfolioId: string;
  readonly baseCurrency: string;
  readonly valuation: PortfolioValuation;
  readonly views: readonly PositionView[];
  readonly exposure: ExposureResult;
  readonly allocation: AllocationResult | null;
}

const toPosition = (record: PositionRecord): Position => ({
  id: record.id,
  portfolioId: record.portfolioId,
  ticker: record.ticker,
  currency: record.currency,
  signedQuantity: record.signedQuantity,
  averagePrice: record.averagePrice,
  isShort: record.isShort,
  updatedAt: record.updatedAt,
  source: record.source,
});

function fxRateDto(rate: FxRateUsed): NonNullable<PositionItemDto['fxRate']> {
  if (rate.kind === 'IDENTITY') {
    return {
      pair: rate.pair,
      rate: brandDecimalString(rate.rate),
      observedAt: null,
      source: rate.source,
      sourceKind: rate.sourceKind,
      status: rate.status,
    };
  }
  const attribution = fxAttribution(rate);
  return {
    pair: rate.pair,
    rate: rate.rate,
    observedAt: rate.observedAt,
    observedAtBasis: rate.observedAtBasis,
    ...(rate.conventionId === undefined ? {} : { conventionId: rate.conventionId }),
    source: rate.source,
    sourceKind: rate.sourceKind,
    status: rate.status,
    ...(attribution === undefined
      ? {}
      : {
          attribution: {
            statement: attribution.statement,
            derivation: attribution.derivation,
            publishedPair: attribution.publishedPair,
            referenceDate: attribution.referenceDate,
            method: attribution.method,
            precision: { ...attribution.precision },
            notes: [...attribution.notes],
          },
        }),
  };
}

function itemDto(entry: PositionValuation, view: PositionView): PositionItemDto {
  const used = entry.status === 'VALUED' || entry.status === 'FX_UNAVAILABLE' || entry.status === 'FX_STALE';
  const item: PositionItemDto = {
    id: view.id,
    portfolioId: view.portfolioId,
    ticker: view.ticker,
    currency: view.currency,
    signedQuantity: view.signedQuantity,
    averagePrice: view.averagePrice,
    isShort: view.isShort,
    updatedAt: view.updatedAt,
    source: view.source,
    marketPrice: view.marketPrice,
    marketValueInstrument: view.marketValueInstrument,
    marketValueBase: view.marketValueBase,
    allocationPct: view.allocationPct,
    valuationStatus: view.valuationStatus,
    priceAsOf: entry.priceAsOf,
    priceProvenance:
      used && entry.price !== null
        ? {
            asOf: entry.price.asOf,
            source: entry.price.source,
            sourceKind: entry.price.sourceKind,
            retrievedAt: entry.price.retrievedAt,
          }
        : null,
    fxRate: entry.status === 'VALUED' ? fxRateDto(entry.fx) : null,
    priceUnavailable:
      entry.status === 'PRICE_UNAVAILABLE'
        ? {
            cause: entry.cause,
            ...(entry.providerCode === undefined ? {} : { providerCode: entry.providerCode }),
          }
        : null,
    fxUnavailable:
      entry.status === 'FX_UNAVAILABLE' || entry.status === 'FX_STALE'
        ? {
            code: entry.fxError.code,
            currency: entry.fxError.currency,
            ...(entry.fxError.code === 'FX_UNAVAILABLE'
              ? {
                  cause: entry.fxError.cause,
                  ...(entry.fxError.providerCode === undefined
                    ? {}
                    : { providerCode: entry.fxError.providerCode }),
                }
              : {}),
          }
        : null,
  };
  if (entry.status === 'PRICE_UNAVAILABLE' && entry.lastValid !== undefined) {
    return { ...item, lastValid: { ...entry.lastValid } };
  }
  return item;
}

/**
 * OD-20: adds the provider's quote behind each OBSERVED rate, read from the `fx_rates` record
 * the 10.3 recorder wrote for it (key: pair, source, source kind, observedAt). The stored
 * record is the provenance of record; nothing is recomputed. A record without a quote
 * (written before migration 2) gives `quote: null`.
 */
function withStoredQuotes(unitOfWork: UnitOfWork, items: PositionItemDto[]): PositionItemDto[] {
  const observed = items.filter((item) => item.fxRate !== null && item.fxRate.sourceKind !== 'IDENTITY');
  if (observed.length === 0) {
    return items;
  }
  return unitOfWork.run((tx) =>
    items.map((item) => {
      const rate = item.fxRate;
      if (rate === null || rate.sourceKind === 'IDENTITY' || rate.observedAt === null) {
        return item;
      }
      const stored = tx.fxRates.findByKey(rate.pair, rate.source, rate.sourceKind, rate.observedAt);
      const published = stored?.rate === rate.rate ? stored.published : undefined;
      return {
        ...item,
        fxRate: {
          ...rate,
          quote:
            published === undefined
              ? null
              : {
                  pair: published.pair,
                  rate: published.rate,
                  referenceDate: published.referenceDate ?? null,
                  method: published.method,
                  precision: published.precision,
                },
        },
      };
    }),
  );
}

function exposureDto(exposure: ExposureResult): AllocationResponse['exposure'] {
  if (exposure.status === 'EXPOSURE_UNAVAILABLE') {
    return {
      status: exposure.status,
      reason: exposure.reason,
      unvalued: exposure.unvalued.map((entry) => ({
        ticker: entry.ticker,
        valuationStatus: entry.valuationStatus,
      })),
      cash: exposure.cash,
    };
  }
  const { long, short, gross, net, cash, nav, allocationDenominator } = exposure;
  return {
    status: 'OK',
    navStatus: exposure.navStatus,
    measures: { long, short, gross, net, cash, nav, allocationDenominator },
  };
}

type LineDto = Extract<
  NonNullable<AllocationResponse['allocation']>,
  { status: 'ELIGIBLE' }
>['lines'][number];

const lineDto = (line: AllocationLine): LineDto =>
  line.kind === 'CASH'
    ? { kind: 'CASH', valueBase: line.valueBase, pct: line.pct }
    : { kind: 'POSITION', ticker: line.ticker, valueBase: line.valueBase, pct: line.pct };

function allocationDto(result: AllocationResult): NonNullable<AllocationResponse['allocation']> {
  const measures = { ...result.measures };
  switch (result.status) {
    case 'ELIGIBLE':
      return { status: 'ELIGIBLE', measures, lines: result.lines.map(lineDto), total: result.total };
    case 'INELIGIBLE':
      return {
        status: 'INELIGIBLE',
        reasons: [...result.reasons],
        measures,
        lines: result.lines.map(lineDto),
        shortPositions: result.shortPositions.map((line) => ({
          ticker: line.ticker,
          valueBase: line.valueBase,
        })),
      };
    case 'ALLOCATION_UNAVAILABLE':
      return { status: 'ALLOCATION_UNAVAILABLE', reason: result.reason, measures };
  }
}

export function createPortfolioQueryService(deps: PortfolioQueryDependencies): PortfolioQueryService {
  if (typeof (deps.unitOfWork as Partial<UnitOfWork> | undefined)?.run !== 'function') {
    throw new TypeError('unitOfWork must be a UnitOfWork.');
  }
  if (typeof (deps.valuation as Partial<PositionValuationService> | undefined)?.value !== 'function') {
    throw new TypeError('valuation must be a PositionValuationService.');
  }
  const { unitOfWork, valuation } = deps;
  const notFound = (): { readonly ok: false; readonly error: PortfolioQueryError } =>
    err(Object.freeze({ code: 'PORTFOLIO_NOT_FOUND', message: 'The portfolio was not found.' }));

  const evaluate = async (portfolioId: string): Promise<Evaluated | undefined> => {
    const loaded = unitOfWork.run((tx) => {
      const portfolio = tx.portfolios.get(portfolioId);
      return portfolio === undefined
        ? undefined
        : { portfolio, positions: tx.positions.listByPortfolio(portfolioId).map(toPosition) };
    });
    if (loaded === undefined) {
      return undefined;
    }
    const valued = await valuation.value(portfolioId, loaded.positions);
    const views = valued.positions.map((entry) => entry.view);
    const exposure = computeExposure(views, loaded.portfolio.cash);
    const allocation =
      exposure.status === 'OK' ? allocate({ positions: exposure.lines, cash: loaded.portfolio.cash }) : null;
    return {
      portfolioId,
      baseCurrency: loaded.portfolio.baseCurrency,
      valuation: valued,
      views: allocation === null ? views : withAllocation(views, allocation),
      exposure,
      allocation,
    };
  };

  return {
    positions: async (portfolioId) => {
      const evaluated = await evaluate(portfolioId);
      if (evaluated === undefined) {
        return notFound();
      }
      const positions = withStoredQuotes(
        unitOfWork,
        evaluated.valuation.positions.map((entry, index) =>
          itemDto(entry, evaluated.views[index] ?? entry.view),
        ),
      );
      return ok({ portfolioId, baseCurrency: evaluated.baseCurrency, at: evaluated.valuation.at, positions });
    },
    allocation: async (portfolioId) => {
      const evaluated = await evaluate(portfolioId);
      if (evaluated === undefined) {
        return notFound();
      }
      return ok({
        portfolioId,
        baseCurrency: evaluated.baseCurrency,
        at: evaluated.valuation.at,
        exposure: exposureDto(evaluated.exposure),
        allocation: evaluated.allocation === null ? null : allocationDto(evaluated.allocation),
      });
    },
  };
}
