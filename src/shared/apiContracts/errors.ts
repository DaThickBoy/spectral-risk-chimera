/**
 * API error contract (task 4.2; design: Gateway rule 6; R29.13).
 *
 * Every error and not-found response has the body
 * `{ error: { code, message, correlationId } }`. Messages are generic and never
 * contain stack traces, paths, or request input.
 */
import { z } from 'zod';

/** Gateway-level codes. Routes may add their own domain codes in the same shape. */
export const GATEWAY_ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'INTERNAL_ERROR',
] as const;
export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

/** Upper-case snake case, for example `VALIDATION_FAILED` or `PORTFOLIO_EXISTS`. */
export const ApiErrorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

export const ApiErrorBodySchema = z.strictObject({
  error: z.strictObject({
    code: ApiErrorCodeSchema,
    message: z.string().min(1),
    correlationId: z.string().min(1),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
