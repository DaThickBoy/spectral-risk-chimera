/**
 * Service assembly for the composition root. Every component receives its ports
 * as parameters, exactly as in the module tests; nothing here adds behaviour.
 * A component whose configuration is missing is not built and is reported with
 * the missing keys; the rest of the application still starts (architecture.md
 * section 6). Decisions that are still open stay open:
 * - persistence (OD-12): the `UnitOfWork` is injected;
 * - providers (OD-5, OD-13, OD-16): market data, FX, and sentiment providers are injected;
 * - sentiment aggregation (OD-1): an aggregator is accepted only as an injected port.
 *   None exists in production, so the index is absent and Adjusted VaR stays unavailable.
 */
import {
  createImportUseCase,
  createLastValidPriceValuationService,
  createPortfolioQueryService,
  createPortfolioService,
  createPositionService,
  createPriceLastValidStore,
  createProviderStatusService,
  createRecordingFxService,
  createRiskInputBuilder,
  createRiskScheduler,
  createRiskService,
  createSentimentRejectionAuditor,
  createSeriesRetrievalService,
  createSeriesStore,
  createVarAlertService,
  marketDataCircuitKey,
  seriesStoreHistory,
} from '../app/index.js';
import type {
  ImportUseCase,
  ObservedFxRate,
  PortfolioQueryService,
  PortfolioService,
  PositionService,
  PositionValuationService,
  ProviderStatusService,
  RiskScheduler,
  RiskService,
  SeriesRetrievalService,
  SeriesStore,
  VarAlertService,
} from '../app/index.js';
import type { ConfigLoadResult } from '../config/index.js';
import { fxCircuitKey } from '../fx/index.js';
import type { FxProvider } from '../fx/index.js';
import { createCsvParser, createImportService } from '../ingestion/index.js';
import { createReturnsBuilder, createSeriesCleaner, weekendsOnlyCalendar } from '../marketdata/index.js';
import type { MarketDataProvider } from '../marketdata/index.js';
import type { UnitOfWork } from '../persistence/ports.js';
import { riskEngine } from '../risk/index.js';
import type { RiskInput, RiskResult } from '../risk/index.js';
import { createSentimentState } from '../sentiment/index.js';
import type { SentimentAggregator, SentimentProvider, SentimentState } from '../sentiment/index.js';
import { LastValidStore, createResilientCall } from '../shared/index.js';
import type { Clock, IdGenerator, Logger, ResilientCall, Sleeper } from '../shared/index.js';
import { optionalValue, requireKeys } from './configValues.js';

export interface CoreDependencies {
  readonly config: ConfigLoadResult;
  /** Exact secret values from the environment, for redaction (R24.7). */
  readonly secrets: readonly string[];
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly random: () => number;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly providers: {
    readonly marketData: MarketDataProvider;
    readonly fx: FxProvider;
    readonly sentiment?: SentimentProvider;
  };
  /** OD-1 is open: no production aggregator exists. Tests may inject the contract double. */
  readonly sentimentAggregator?: SentimentAggregator;
  /** Retained sentiment observations per ticker (operational; no configuration key). */
  readonly sentimentHistoryLimit: number;
  /** The risk calculation: the compiled worker client by default (see application.ts). */
  readonly compute: (input: RiskInput) => Promise<RiskResult>;
  /** Called after each stored recalculation result (stream update and alert evaluation). */
  readonly afterCalculation: (portfolioId: string) => void;
  /** Called after a commit that raised alerts (the outbox dispatcher). */
  readonly afterAlert: () => void;
}

export interface ComponentStatus {
  readonly available: boolean;
  readonly missingKeys: readonly string[];
}

export interface Components {
  readonly resilientCall: ResilientCall | undefined;
  readonly providerStatus: ProviderStatusService | undefined;
  readonly valuation: PositionValuationService | undefined;
  readonly portfolios: PortfolioService | undefined;
  readonly queries: PortfolioQueryService | undefined;
  readonly positions: PositionService;
  readonly imports: ImportUseCase | undefined;
  readonly seriesStore: SeriesStore;
  /** Explicit history retrieval into the series store (9.6 specified part); no trigger is wired. */
  readonly seriesRetrieval: SeriesRetrievalService | undefined;
  readonly sentiment: SentimentState | undefined;
  readonly risk: RiskService;
  readonly scheduler: RiskScheduler;
  readonly alerts: VarAlertService;
  /** Portfolios that have had a recalculation request, for draining at shutdown. */
  readonly requested: ReadonlySet<string>;
  readonly status: Readonly<Record<string, ComponentStatus>>;
  readonly onSentimentRejected: ReturnType<typeof createSentimentRejectionAuditor>;
}

const PROVIDER_KEYS = [
  'provider.maxRetries',
  'provider.timeoutMs',
  'provider.backoff.baseMs',
  'provider.backoff.maxMs',
  'provider.circuit.failureThreshold',
  'provider.circuit.openMs',
  'provider.retryAfter.maxMs',
] as const;
const FX_KEYS = ['fx.baseCurrency', 'fx.supportedCurrencies', 'fx.maxRateAgeSeconds', 'fx.provider'] as const;
const IMPORT_KEYS = [
  'import.maxFileBytes',
  'import.maxRows',
  'import.maxFieldLength',
  'fx.supportedCurrencies',
] as const;
const SENTIMENT_KEYS = [
  'sentiment.maxAgeSeconds',
  'sentiment.windowSeconds',
  'sentiment.maxFutureSkewSeconds',
] as const;

const status = (available: boolean, missingKeys: readonly string[] = []): ComponentStatus => ({
  available,
  missingKeys,
});

/** Used only while Base VaR is unavailable: the input builder stops at CONFIG_MISSING first. */
const unreachableValuation: PositionValuationService = {
  value: () => {
    throw new TypeError('Valuation is not configured; Base VaR must be unavailable (CONFIG_MISSING).');
  },
};

export function buildComponents(deps: CoreDependencies): Components {
  const { config, unitOfWork, clock, ids, logger } = deps;
  const statusMap: Record<string, ComponentStatus> = {};

  // Provider resilience (8.2): one instance shared by every provider call and the status route.
  const providerKeys = requireKeys(config, PROVIDER_KEYS);
  let resilientCall: ResilientCall | undefined;
  if (providerKeys.ok) {
    const n = (key: (typeof PROVIDER_KEYS)[number]): number => providerKeys.get(key) as number;
    resilientCall = createResilientCall({
      clock,
      sleeper: deps.sleeper,
      random: deps.random,
      logger,
      retry: {
        maxRetries: n('provider.maxRetries'),
        attemptTimeoutMs: n('provider.timeoutMs'),
        baseDelayMs: n('provider.backoff.baseMs'),
        maxDelayMs: n('provider.backoff.maxMs'),
        maxRetryAfterMs: n('provider.retryAfter.maxMs'),
      },
      circuit: {
        failureThreshold: n('provider.circuit.failureThreshold'),
        openMs: n('provider.circuit.openMs'),
      },
    });
  }
  statusMap['providers'] = status(providerKeys.ok, providerKeys.ok ? [] : providerKeys.missingKeys);

  const { marketData, fx: fxProvider, sentiment: sentimentProvider } = deps.providers;
  const providerStatus =
    resilientCall === undefined
      ? undefined
      : createProviderStatusService({
          resilientCall,
          providers: [
            marketDataCircuitKey(marketData.name),
            fxCircuitKey(fxProvider.name),
            ...(sentimentProvider === undefined ? [] : [`sentiment:${sentimentProvider.name}`]),
          ].sort(),
        });

  // Valuation (11.1, 10.3, 11.5): needs the FX settings and provider resilience.
  const fxKeys = requireKeys(config, FX_KEYS);
  let valuation: PositionValuationService | undefined;
  if (fxKeys.ok && resilientCall !== undefined) {
    // R25.7: the ECB adapter has its own per-attempt timeout, fx.ecb.timeoutMs.
    const ecbTimeout =
      fxKeys.get('fx.provider') === 'ECB' ? optionalValue(config, 'fx.ecb.timeoutMs') : undefined;
    const fx = createRecordingFxService({
      fx: {
        provider: fxProvider,
        resilientCall,
        baseCurrency: fxKeys.get('fx.baseCurrency') as string,
        supportedCurrencies: fxKeys.get('fx.supportedCurrencies') as string[],
        maxRateAgeSeconds: fxKeys.get('fx.maxRateAgeSeconds') as number,
        ...(typeof ecbTimeout === 'number' ? { attemptTimeoutMs: ecbTimeout } : {}),
      },
      unitOfWork,
      lastValid: new LastValidStore<string, ObservedFxRate>(),
      clock,
      ids,
    });
    valuation = createLastValidPriceValuationService({
      valuation: { marketData, resilientCall, fx, clock },
      store: createPriceLastValidStore(),
    });
  }
  statusMap['valuation'] = status(valuation !== undefined, [
    ...(fxKeys.ok ? [] : fxKeys.missingKeys),
    ...(providerKeys.ok ? [] : providerKeys.missingKeys),
  ]);

  // Portfolios (6.1): `fx.baseCurrency` is financially significant and never defaulted.
  const baseCurrency = optionalValue(config, 'fx.baseCurrency');
  const portfolios =
    typeof baseCurrency === 'string' ? createPortfolioService({ unitOfWork, baseCurrency }) : undefined;
  statusMap['portfolios'] = status(
    portfolios !== undefined,
    portfolios === undefined ? ['fx.baseCurrency'] : [],
  );
  const queries =
    valuation === undefined ? undefined : createPortfolioQueryService({ unitOfWork, valuation });

  // Recalculation (12.4): PositionsChanged from the position service is delivered in-process,
  // synchronously, after the rebuild committed (D-7, D-16). No other event is wired.
  const requested = new Set<string>();
  const runRef: { run?: (portfolioId: string) => Promise<unknown> } = {};
  const scheduler = createRiskScheduler({
    run: (portfolioId) => {
      if (runRef.run === undefined) {
        throw new TypeError('The risk service is not assembled.');
      }
      return runRef.run(portfolioId);
    },
    onError: (portfolioId, error) =>
      logger.error('risk.run_failed', {
        portfolioId,
        errorName: error instanceof Error ? error.name : 'unknown',
      }),
  });
  const positions = createPositionService({
    unitOfWork,
    logger,
    publisher: {
      publish: (event) => {
        requested.add(event.portfolioId);
        scheduler.onPositionsChanged(event);
      },
    },
  });

  // Import (7.5): its own refusals (oversell policy, time zone) stay inside the import service.
  const importKeys = requireKeys(config, IMPORT_KEYS);
  let imports: ImportUseCase | undefined;
  if (importKeys.ok && portfolios !== undefined) {
    const oversellPolicy = optionalValue(config, 'import.oversellPolicy');
    const defaultTimezone = optionalValue(config, 'import.defaultTimezone');
    const service = createImportService({
      unitOfWork,
      parser: createCsvParser(),
      clock,
      ids,
      secrets: deps.secrets,
      settings: {
        csv: {
          maxFileBytes: importKeys.get('import.maxFileBytes') as number,
          maxRows: importKeys.get('import.maxRows') as number,
          maxFieldLength: importKeys.get('import.maxFieldLength') as number,
        },
        supportedCurrencies: importKeys.get('fx.supportedCurrencies') as string[],
        ...(oversellPolicy === 'REJECT' || oversellPolicy === 'ALLOW_SHORT' ? { oversellPolicy } : {}),
        ...(typeof defaultTimezone === 'string' ? { defaultTimezone } : {}),
      },
    });
    imports = createImportUseCase({ imports: service, positions, portfolios, unitOfWork });
  }
  statusMap['imports'] = status(imports !== undefined, [
    ...(importKeys.ok ? [] : importKeys.missingKeys),
    ...(portfolios === undefined ? ['fx.baseCurrency'] : []),
  ]);

  // Sentiment state (13.3): without its keys every position is ABSENT and Adjusted VaR unavailable.
  const sentimentKeys = requireKeys(config, SENTIMENT_KEYS);
  const sentiment = sentimentKeys.ok
    ? createSentimentState({
        clock,
        maxAgeSeconds: sentimentKeys.get('sentiment.maxAgeSeconds') as number,
        windowSeconds: sentimentKeys.get('sentiment.windowSeconds') as number,
        maxFutureSkewSeconds: sentimentKeys.get('sentiment.maxFutureSkewSeconds') as number,
        historyLimit: deps.sentimentHistoryLimit,
        ...(deps.sentimentAggregator === undefined ? {} : { aggregator: deps.sentimentAggregator }),
      })
    : undefined;
  statusMap['sentiment'] = status(sentiment !== undefined, sentimentKeys.ok ? [] : sentimentKeys.missingKeys);
  statusMap['sentimentAggregator'] = status(deps.sentimentAggregator !== undefined);

  // Risk (12.2 to 12.6, 14.x): the builder reports CONFIG_MISSING itself (R14.14).
  const seriesStore = createSeriesStore({ unitOfWork });
  // 9.6 (specified part): provider history into the store through the shared ResilientCall,
  // cleaned with the weekends-only calendar (A-14; holidays wait for OD-3).
  const seriesRetrieval =
    resilientCall === undefined
      ? undefined
      : createSeriesRetrievalService({
          marketData,
          resilientCall,
          cleaner: createSeriesCleaner(weekendsOnlyCalendar),
          store: seriesStore,
        });
  statusMap['seriesRetrieval'] = status(
    seriesRetrieval !== undefined,
    providerKeys.ok ? [] : providerKeys.missingKeys,
  );
  const returns = createReturnsBuilder();
  const gap = optionalValue(config, 'marketData.maxReturnGapDays');
  const risk = createRiskService({
    builder: createRiskInputBuilder({
      config,
      unitOfWork,
      valuation: valuation ?? unreachableValuation,
      history: seriesStoreHistory(seriesStore, marketData.kind),
      returns,
      ...(sentiment === undefined ? {} : { sentiment }),
    }),
    compute: deps.compute,
    engine: riskEngine,
    unitOfWork,
    clock,
    ids,
    configVersion: config.version,
    // Unreachable when absent: the key belongs to Base VaR, whose builder stops at CONFIG_MISSING.
    maxReturnGapDays: typeof gap === 'number' ? gap : Number.NaN,
    seriesStore,
    returns,
    // Filing scores are display-only and unavailable until the filing pipeline exists (phase 7).
    display: () => ({ filingScores: [] }),
  });
  runRef.run = async (portfolioId) => {
    const outcome = await risk.calculate(portfolioId);
    if (outcome.status === 'STORED') {
      deps.afterCalculation(portfolioId);
    } else {
      logger.warn('risk.not_stored', { portfolioId, status: outcome.status });
    }
    return outcome;
  };
  const scheduled: RiskScheduler = {
    ...scheduler,
    requestRecalculation: (portfolioId, reason) => {
      requested.add(portfolioId);
      scheduler.requestRecalculation(portfolioId, reason);
    },
  };

  // VaR alerts (16.1 to 16.3): the configured settings apply to every portfolio; there is no
  // per-portfolio source yet. Missing settings are evaluated as ALERT_CONFIG_MISSING and audited.
  const alertSetting = (key: string): unknown => optionalValue(config, key);
  const alerts = createVarAlertService({
    unitOfWork,
    clock,
    ids,
    logger,
    settings: () => ({
      thresholdPct: alertSetting('alerts.var.thresholdPct') as string | undefined,
      metric: alertSetting('alerts.var.metric') as string | undefined,
      resetPct: alertSetting('alerts.resetPct') as string | undefined,
      highRatio: alertSetting('alerts.severity.highRatio') as string | undefined,
      criticalRatio: alertSetting('alerts.severity.criticalRatio') as string | undefined,
      cooldownSeconds: alertSetting('alerts.cooldownSeconds') as number | undefined,
    }),
    onAlertsRaised: () => deps.afterAlert(),
  });

  return {
    resilientCall,
    providerStatus,
    valuation,
    portfolios,
    queries,
    positions,
    imports,
    seriesStore,
    seriesRetrieval,
    sentiment,
    risk,
    scheduler: scheduled,
    alerts,
    requested,
    status: statusMap,
    onSentimentRejected: createSentimentRejectionAuditor({
      unitOfWork,
      clock,
      ids,
      onAuditFailure: (error) => logger.error('sentiment.audit_failed', { code: error.code }),
    }),
  };
}
