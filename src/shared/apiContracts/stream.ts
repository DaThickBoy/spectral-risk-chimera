/**
 * `/stream` WebSocket event contract (task 15.1; design: API routes `WS /stream`;
 * R10.5, R16.7, R17.10, R19.1, R25.1, R26.9). Server-to-client only; every event
 * is validated with these schemas before it is sent. Financial values and
 * sentiment values are decimal strings; integers are counts.
 */
import { z } from 'zod';
import { IsoUtcMillis } from '../timestamps.js';
import { CanonicalDecimalSchema, PortfolioIdSchema } from './portfolio.js';
import { ProviderStatusItemSchema } from './providers.js';
import { RiskResponseSchema } from './risk.js';

const Status = z.enum(['CURRENT', 'STALE']);

/** One ticker's sentiment as emitted by the 13.6 emitter (index and display-only latest observation). */
export const SentimentUpdateSchema = z.strictObject({
  type: z.literal('SentimentUpdate'),
  ticker: z.string().min(1),
  index: z
    .strictObject({
      value: z.string().regex(/^-?(0|[1-9]\d*)(\.\d+)?$/),
      observedAt: IsoUtcMillis,
      source: z.string().min(1),
      status: Status,
      aggregatorVersion: z.string().min(1),
    })
    .nullable(),
  latest: z
    .strictObject({
      value: z.string().regex(/^-?(0|[1-9]\d*)(\.\d+)?$/),
      observedAt: IsoUtcMillis,
      receivedAt: IsoUtcMillis,
      provider: z.string().min(1),
      sourceKind: z.enum(['REAL', 'DEMO']),
      status: Status,
    })
    .nullable(),
});

export const RiskUpdateSchema = z.strictObject({
  type: z.literal('RiskUpdate'),
  portfolioId: PortfolioIdSchema,
  risk: RiskResponseSchema,
});

export const ProviderStatusEventSchema = z.strictObject({
  type: z.literal('ProviderStatus'),
  providers: z.array(ProviderStatusItemSchema),
});

/** Task 16.3: an alert as delivered to the dashboard; de-duplicated by `alertId`. */
export const AlertRaisedSchema = z.strictObject({
  type: z.literal('AlertRaised'),
  alertId: z.string().min(1),
  alertType: z.enum(['VAR', 'FILING_RISK']),
  source: z.string().min(1),
  portfolioId: PortfolioIdSchema,
  severity: z.enum(['WARNING', 'HIGH', 'CRITICAL']),
  metric: z.string().min(1),
  observedValue: CanonicalDecimalSchema,
  threshold: CanonicalDecimalSchema,
  at: IsoUtcMillis,
  description: z.string().min(1),
  tickers: z.array(z.string().min(1)),
});

export const StreamEventSchema = z.discriminatedUnion('type', [
  SentimentUpdateSchema,
  RiskUpdateSchema,
  ProviderStatusEventSchema,
  AlertRaisedSchema,
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;
export type AlertRaised = z.infer<typeof AlertRaisedSchema>;
