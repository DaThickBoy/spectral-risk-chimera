/**
 * Provider status API contract (task 8.3; design: Provider Resilience Layer;
 * R25.1, R25.6). Each entry is a provider's circuit key, its status, when the
 * status last changed, and the code of its last failed call. No URL, message,
 * credential, or payload is ever part of the contract.
 */
import { z } from 'zod';
import { IsoUtcMillis } from '../timestamps.js';

/** A circuit key such as `marketdata:fixture-md` or `fx:ECB-EXR`: no URL, no whitespace. */
export const ProviderKeySchema = z.string().regex(/^[a-z]+:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

export const PROVIDER_ERROR_CODES = [
  'NETWORK_ERROR',
  'TIMEOUT',
  'RATE_LIMITED',
  'HTTP_SERVER_ERROR',
  'HTTP_CLIENT_ERROR',
  'INVALID_RESPONSE',
  'CIRCUIT_OPEN',
  'CANCELLED',
  'TLS_ERROR',
  'UNEXPECTED_ERROR',
] as const;

export const ProviderStatusItemSchema = z.strictObject({
  provider: ProviderKeySchema,
  state: z.enum(['AVAILABLE', 'DEGRADED', 'UNAVAILABLE']),
  circuit: z.enum(['CLOSED', 'OPEN', 'HALF_OPEN']),
  since: IsoUtcMillis,
  lastErrorCode: z.enum(PROVIDER_ERROR_CODES).optional(),
});
export type ProviderStatusItemDto = z.infer<typeof ProviderStatusItemSchema>;

export const ProviderStatusResponseSchema = z.strictObject({
  /** Ascending provider key. */
  providers: z.array(ProviderStatusItemSchema),
});
export type ProviderStatusResponse = z.infer<typeof ProviderStatusResponseSchema>;
