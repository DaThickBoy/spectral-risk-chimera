// Public API of src/app/ (application layer, design D-16). Used by api/ and tests.
export type { PositionEventPublisher } from './ports.js';
export { POSITIONS_CHANGED_PUBLISH_FAILED, createPositionService } from './positionService.js';
export { createSeriesStore, labelFor } from './seriesStore.js';
export { createRecordingFxService } from './fxRateRecorder.js';
export type { ObservedFxRate, RecordingFxServiceDependencies } from './fxRateRecorder.js';
export {
  MARKET_DATA_PRICE_OPERATION,
  createPositionValuationService,
  marketDataCircuitKey,
} from './positionValuation.js';
export type {
  PortfolioValuation,
  PositionValuation,
  PositionValuationDependencies,
  PositionValuationService,
  PriceUnavailableCause,
  StalePriceDisplay,
} from './positionValuation.js';
export { createPortfolioService } from './portfolioService.js';
export type {
  PortfolioCreateInput,
  PortfolioCreateResult,
  PortfolioService,
  PortfolioServiceDependencies,
} from './portfolioService.js';
export { createPortfolioQueryService } from './portfolioQuery.js';
export type {
  PortfolioQueryDependencies,
  PortfolioQueryError,
  PortfolioQueryService,
} from './portfolioQuery.js';
export { createProviderStatusService } from './providerStatusService.js';
export type { ProviderStatusDependencies, ProviderStatusService } from './providerStatusService.js';
export { createLastValidPriceValuationService, createPriceLastValidStore } from './priceLastValid.js';
export type {
  LastValidPriceValuationDependencies,
  PriceLastValidStore,
  PriceOfferOutcome,
} from './priceLastValid.js';
export type {
  CachedLabel,
  CachedRetrieval,
  LatestSeries,
  PutOutcome,
  SeriesByHash,
  SeriesStore,
  SeriesStoreDependencies,
  SeriesStoreError,
  StoredSeries,
} from './seriesStore.js';
export { DEFAULT_IMPORT_SOURCE, createImportUseCase } from './importUseCase.js';
export type {
  ImportRequest,
  ImportUseCase,
  ImportUseCaseDependencies,
  ImportUseCaseResult,
} from './importUseCase.js';
export {
  cleanResultOf,
  createRiskInputBuilder,
  isMarketDataStale,
  seriesStoreHistory,
} from './riskInputBuilder.js';
export type {
  BuildOutcome,
  HistoryError,
  PriceIssue,
  RiskConfigView,
  RiskHistorySource,
  RiskInputBuilder,
  RiskInputBuilderDependencies,
  RiskPreconditionError,
  RiskSentimentSource,
} from './riskInputBuilder.js';
export {
  CalculationSnapshotSchema,
  SNAPSHOT_SCHEMA_VERSION,
  buildSnapshot,
  recomputeFromSnapshot,
} from './snapshotService.js';
export type {
  BuiltSnapshot,
  CalculationSnapshot,
  DisplayOnly,
  FilingScoreDisplay,
  RecomputeDependencies,
  RecomputeError,
  SnapshotBody,
  SnapshotPosition,
} from './snapshotService.js';
export { RiskResultSchema, createRiskService } from './riskService.js';
export { AGGREGATION_NOT_APPROVED_EXPLANATION, buildPortfolioRiskView } from './riskViewBuilder.js';
export { createDashboardService, currencyExposure, fxSummary } from './dashboardService.js';
export type { DashboardError, DashboardService, DashboardServiceDependencies } from './dashboardService.js';
export type { RiskViewParts } from './riskViewBuilder.js';
export type {
  AdjustmentDetail,
  CalculationOutcome,
  RiskService,
  RiskServiceDependencies,
  RiskView,
  VarEntry,
} from './riskService.js';
export { RiskWorkerError, createRiskWorkerClient } from './riskWorkerClient.js';
export type { RiskWorkerClient, RiskWorkerClientDependencies } from './riskWorkerClient.js';
export { createRiskScheduler } from './riskScheduler.js';
export { createSentimentRejectionAuditor } from './sentimentAudit.js';
export { providerStatusEvent, riskUpdateEvent, sentimentUpdateEvents } from './streamEvents.js';
export { createVarAlertService, varAlertInput } from './alertService.js';
export { MARKET_DATA_SERIES_OPERATION, createSeriesRetrievalService } from './seriesRetrieval.js';
export type {
  SeriesRejectionReason,
  SeriesRetrievalDependencies,
  SeriesRetrievalError,
  SeriesRetrievalService,
  SeriesRetrieved,
} from './seriesRetrieval.js';
export type {
  DismissOutcome,
  VarAlertOutcome,
  VarAlertService,
  VarAlertServiceDependencies,
} from './alertService.js';
export { alertRaisedEvent, createAlertDispatcher } from './alertDispatcher.js';
export type {
  AlertDispatcher,
  AlertDispatcherDependencies,
  AlertPublisher,
  DispatchSummary,
} from './alertDispatcher.js';
export type { SentimentRejectionAuditorDependencies } from './sentimentAudit.js';
export type { RecalcReason, RiskScheduler, RiskSchedulerDependencies } from './riskScheduler.js';
export type {
  PositionRebuildResult,
  PositionService,
  PositionServiceDependencies,
} from './positionService.js';
