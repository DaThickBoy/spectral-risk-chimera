// Shared API contracts (task 4.2; design: Gateway rule 8). Imported by api/, app/, and later web/,
// through src/shared/index.ts.
export { ApiErrorBodySchema, ApiErrorCodeSchema, GATEWAY_ERROR_CODES } from './errors.js';
export type { ApiErrorBody, GatewayErrorCode } from './errors.js';
export {
  AllocationResponseSchema,
  AllocationSchema,
  CanonicalDecimalSchema,
  ExposureSchema,
  FxAttributionSchema,
  PortfolioCreateSchema,
  PortfolioIdSchema,
  PortfolioParamsSchema,
  PortfolioSchema,
  PositionItemSchema,
  PositionsResponseSchema,
  StalePriceDisplaySchema,
  VALUATION_STATUSES,
} from './portfolio.js';
export {
  IMPORT_MAPPING_FIELDS,
  ImportCreatedSchema,
  ImportIdParamsSchema,
  ImportQuerySchema,
  ImportRejectionSchema,
  ImportRejectionsResponseSchema,
  ImportSummarySchema,
} from './imports.js';
export type { ImportCreatedDto, ImportQuery, ImportRejectionsResponse, ImportSummaryDto } from './imports.js';
export {
  RiskResponseSchema,
  SnapshotParamsSchema,
  SnapshotResponseSchema,
  VarEntrySchema,
  VarFigureSchema,
} from './risk.js';
export type { RiskResponse, SnapshotResponse } from './risk.js';
export {
  PROVIDER_ERROR_CODES,
  ProviderKeySchema,
  ProviderStatusItemSchema,
  ProviderStatusResponseSchema,
} from './providers.js';
export type { ProviderStatusItemDto, ProviderStatusResponse } from './providers.js';
export {
  AssetFilingSchema,
  AssetRiskRowSchema,
  AssetSentimentSchema,
  PortfolioRiskViewSchema,
  VarViewSchema,
} from './views.js';
export type { AssetRiskRow, PortfolioRiskView, VarView } from './views.js';
export {
  CurrencyExposureSchema,
  DASHBOARD_SCHEMA_VERSION,
  DashboardFxSchema,
  DashboardIndexResponseSchema,
  DashboardReplayManifestSchema,
  DashboardViewResponseSchema,
} from './dashboard.js';
export type {
  CurrencyExposure,
  DashboardFx,
  DashboardIndexResponse,
  DashboardReplayManifest,
  DashboardViewResponse,
} from './dashboard.js';
export {
  LOSS_DISTRIBUTION_UNAVAILABLE_REASONS,
  LossBucketSchema,
  LossDistributionSchema,
} from './lossDistribution.js';
export type { LossBucket, LossDistribution } from './lossDistribution.js';
export {
  AlertIdParamsSchema,
  AlertIdSchema,
  AlertItemSchema,
  AlertsQuerySchema,
  AlertsResponseSchema,
  DismissBodySchema,
} from './alerts.js';
export type { AlertItemDto, AlertsResponse } from './alerts.js';
export {
  AlertRaisedSchema,
  ProviderStatusEventSchema,
  RiskUpdateSchema,
  SentimentUpdateSchema,
  StreamEventSchema,
} from './stream.js';
export type { AlertRaised, StreamEvent } from './stream.js';
export type {
  AllocationResponse,
  PortfolioCreateRequest,
  PortfolioDto,
  PositionItemDto,
  PositionsResponse,
  StalePriceDisplayDto,
} from './portfolio.js';
