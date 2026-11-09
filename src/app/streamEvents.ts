/**
 * `/stream` event builders (task 15.1; design: API routes `WS /stream`; R10.5,
 * R16.7, R17.10, R25.1). They wrap results that other services already
 * computed into the shared `StreamEvent` contract; nothing is recalculated and
 * no value is converted. The hub validates every event again before sending.
 */
import type { SentimentView } from '../sentiment/index.js';
import { RiskResponseSchema } from '../shared/index.js';
import type { ProviderStatusItemDto, StreamEvent } from '../shared/index.js';
import type { RiskView } from './riskService.js';

/** One `SentimentUpdate` per changed ticker, in the emitter's order (13.6 `emit` callback). */
export function sentimentUpdateEvents(views: readonly SentimentView[]): StreamEvent[] {
  return views.map((view) => ({
    type: 'SentimentUpdate',
    ticker: view.ticker,
    index: view.index === null ? null : { ...view.index },
    latest: view.latest === null ? null : { ...view.latest },
  }));
}

/** The stored risk view of a portfolio, as `GET /portfolios/:id/risk` returns it. */
export function riskUpdateEvent(portfolioId: string, risk: RiskView): StreamEvent {
  return { type: 'RiskUpdate', portfolioId, risk: RiskResponseSchema.parse(risk) };
}

export function providerStatusEvent(providers: readonly ProviderStatusItemDto[]): StreamEvent {
  return { type: 'ProviderStatus', providers: [...providers] };
}
