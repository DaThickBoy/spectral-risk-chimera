/**
 * Alert API contracts (task 16.3; design: API routes `GET /alerts`,
 * `POST /alerts/:id/dismiss`; R19.2, R19.4, R34.1, R34.7). Observed value and
 * threshold are Canonical Decimal Strings; `deliveryAttempts` is a count.
 */
import { z } from 'zod';
import { IsoUtcMillis } from '../timestamps.js';
import { CanonicalDecimalSchema, PortfolioIdSchema } from './portfolio.js';

export const AlertIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const AlertsQuerySchema = z.strictObject({ portfolioId: PortfolioIdSchema });
export const AlertIdParamsSchema = z.strictObject({ id: AlertIdSchema });
export const DismissBodySchema = z.strictObject({});

export const AlertItemSchema = z.strictObject({
  id: AlertIdSchema,
  type: z.enum(['VAR', 'FILING_RISK']),
  source: z.string().min(1),
  portfolioId: PortfolioIdSchema,
  ticker: z.string().min(1).nullable(),
  severity: z.enum(['WARNING', 'HIGH', 'CRITICAL']),
  metric: z.string().min(1),
  observed: CanonicalDecimalSchema,
  threshold: CanonicalDecimalSchema,
  triggeredTickers: z.array(z.string().min(1)),
  createdAt: IsoUtcMillis,
  description: z.string().min(1),
  state: z.enum(['OPEN', 'DISMISSED', 'RESOLVED']),
  stateChangedAt: IsoUtcMillis.nullable(),
  delivery: z.enum(['PENDING', 'DELIVERED', 'FAILED']),
  deliveryAttempts: z.int().nonnegative(),
  lastAttemptAt: IsoUtcMillis.nullable(),
});
export type AlertItemDto = z.infer<typeof AlertItemSchema>;

export const AlertsResponseSchema = z.strictObject({
  /** Newest first. */
  alerts: z.array(AlertItemSchema),
});
export type AlertsResponse = z.infer<typeof AlertsResponseSchema>;
