// Public API of src/api/ (HTTP gateway, task 4.2). api/ imports only app/ and shared/.
export {
  BODY_LIMIT_BYTES,
  LOOPBACK_HOST,
  ListenRefusedError,
  createApiServer,
  listenApiServer,
} from './server.js';
export type { ApiRoutes, ApiServerOptions, ListenOptions, ListenRefusedReason } from './server.js';
export type { AuthGuard } from './auth.js';
export { ALLOWED_ORIGINS_INVALID, canonicalOrigin, isAllowedOrigin, parseAllowedOrigins } from './origin.js';
export { installRequestGuard, isAllowedHost } from './requestGuard.js';
export type { RequestGuardOptions } from './requestGuard.js';
export { defineRoute, zodValidatorCompiler } from './validation.js';
export type { RouteDefinition, RouteInput } from './validation.js';
export { errorBody, sendError } from './errors.js';
export { MAX_TRACKED_CLIENTS, createTokenBuckets, installRateLimiting } from './rateLimit.js';
export type { RateLimits, TokenBuckets } from './rateLimit.js';
export { multipartOptions, receiveUpload, sanitizeFilename, sendUploadRejection } from './uploads.js';
export type { ReceivedUpload, UploadLimits, UploadRejection, UploadResult } from './uploads.js';
export { providerStatusRoutes } from './routes/providers.js';
export type { ProviderStatusRouteDependencies } from './routes/providers.js';
export { portfolioRoutes } from './routes/portfolios.js';
export { importRoutes } from './routes/imports.js';
export { riskRoutes } from './routes/risk.js';
export { dashboardRoutes } from './routes/dashboard.js';
export type { DashboardRouteDependencies } from './routes/dashboard.js';
export type { RiskRouteDependencies } from './routes/risk.js';
export { STREAM_MAX_INBOUND_BYTES, streamRoutes } from './routes/stream.js';
export type { StreamRouteDependencies } from './routes/stream.js';
export { createStreamHub, streamAlertPublisher } from './streamHub.js';
export { alertRoutes } from './routes/alerts.js';
export type { AlertRouteDependencies } from './routes/alerts.js';
export type { StreamClient, StreamHub, StreamHubOptions, StreamPublishResult } from './streamHub.js';
export type { ImportRouteDependencies } from './routes/imports.js';
export type { PortfolioRouteDependencies } from './routes/portfolios.js';
