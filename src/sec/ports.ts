/**
 * Ports of the SEC URL guard (task 19.1; design: URL Guard and Client; R29.9, R29.14).
 *
 * `sec/` imports only `shared/` and `config/`. It never imports `audit/` or
 * persistence: security events leave `sec/` through `SecurityEventSink`, which the
 * app layer implements with `recordAuditEvent` (category `SECURITY`). DNS answers
 * enter through `SecDnsResolver`; the production adapter is part of task 19.2.
 */
import type { AppError, Result } from '../shared/index.js';

/** The only hosts an SEC request may target (R29.8). */
export type SecAllowedHost = 'www.sec.gov' | 'data.sec.gov';

export const SEC_ALLOWED_HOSTS: readonly SecAllowedHost[] = ['www.sec.gov', 'data.sec.gov'];

/** Fixed set of rejection reasons (design). Validate-stage reasons are listed in check order. */
export type SecUrlRejectionReason =
  | 'MALFORMED_URL'
  | 'NOT_HTTPS'
  | 'CREDENTIALS_PRESENT'
  | 'IP_LITERAL'
  | 'HOST_NOT_ALLOWED'
  | 'PORT_NOT_ALLOWED'
  | 'FRAGMENT_PRESENT'
  | 'DNS_EMPTY'
  | 'DNS_FAILED'
  | 'ADDRESS_PROHIBITED';

export type SecUrlStage = 'VALIDATE' | 'RESOLVE';

/**
 * One DNS family's answer. `RECORDS` must be non-empty (an empty list is a
 * malformed answer). `TIMEOUT` means the lookup did not finish in time (the
 * resolver's own timeout, or cancellation at the caller's deadline); it is not a
 * DNS failure and never becomes `DNS_FAILED` (task 19.2). `ERROR` is any other
 * failure than no data or no such name; a resolver that throws or rejects counts
 * as `ERROR`.
 */
export type DnsFamilyAnswer =
  | { readonly status: 'RECORDS'; readonly addresses: readonly string[] }
  | { readonly status: 'NO_DATA' }
  | { readonly status: 'NOT_FOUND' }
  | { readonly status: 'TIMEOUT' }
  | { readonly status: 'ERROR' };

/** Deadline context of one lookup (task 19.2). */
export interface DnsQueryContext {
  /** Aborted when the caller's overall deadline is reached; the lookup should stop. */
  readonly signal: AbortSignal;
  /** Whole milliseconds left before that deadline (positive). */
  readonly timeoutMs: number;
}

export interface SecDnsResolver {
  /** Resolves the A (family 4) or AAAA (family 6) records of an allowlisted host. */
  resolve(hostname: SecAllowedHost, family: 4 | 6, context?: DnsQueryContext): Promise<DnsFamilyAnswer>;
}

/** A security event for one rejection. It never contains any part of the input URL. */
export interface SecurityEvent {
  readonly type: 'SEC_URL_REJECTED';
  readonly reason: SecUrlRejectionReason;
  readonly stage: SecUrlStage;
  /** Canonical UTC timestamp from the injected Clock. */
  readonly at: string;
  /** Resolve stage only: the allowlisted host that was resolved. */
  readonly hostname?: SecAllowedHost;
  /** `ADDRESS_PROHIBITED` only: the prohibited addresses, canonical text, sorted. */
  readonly prohibitedAddresses?: readonly string[];
}

export type SecurityEventDeliveryError = AppError<'SECURITY_EVENT_NOT_RECORDED'>;

/** Implemented by the app layer. Synchronous; an error result or a thrown error is a delivery failure. */
export interface SecurityEventSink {
  record(event: SecurityEvent): Result<void, SecurityEventDeliveryError>;
}
