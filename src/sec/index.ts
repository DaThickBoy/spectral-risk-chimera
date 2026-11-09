// Public API of src/sec/. Other modules import from this file only.
// sec/ imports only shared/ and config/ (never audit/ or persistence).
export { SEC_ALLOWED_HOSTS } from './ports.js';
export type {
  DnsFamilyAnswer,
  DnsQueryContext,
  SecAllowedHost,
  SecDnsResolver,
  SecUrlRejectionReason,
  SecUrlStage,
  SecurityEvent,
  SecurityEventDeliveryError,
  SecurityEventSink,
} from './ports.js';
export { ADDRESS_POLICY_VERSION } from './addressPolicy.js';
export { createSecUrlGuard } from './urlGuard.js';
export type {
  ResolvedSecHost,
  SecUrlGuard,
  SecUrlGuardDependencies,
  SecDnsTimeout,
  SecUrlRejected,
  SecurityEventDelivery,
  ValidatedAddress,
  ValidatedSecUrl,
} from './urlGuard.js';
export type { SecTransport, SecTransportOutcome, SecTransportRequest } from './transport.js';
export { createSecRateLimiter } from './rateLimiter.js';
export type { SecRateLimitOutcome, SecRateLimiter, SecRateLimiterOptions } from './rateLimiter.js';
export { createSecClient } from './client.js';
export type {
  SecClient,
  SecClientDependencies,
  SecClientLimits,
  SecError,
  SecErrorCode,
  SecGetTextOptions,
  SecResponse,
} from './client.js';
