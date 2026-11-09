/**
 * Risk recalculation scheduler (task 12.4; design: Risk Worker and Scheduler,
 * recalculation triggers; R16.1, R16.6, R33.9).
 *
 * - Requests are coalesced per portfolio: at most one run in progress and one
 *   queued (R16.6). Any number of requests while a run is in progress collapse
 *   into the single queued run, which starts after the current one ends, so a
 *   burst gives at most two runs.
 * - `PositionsChanged` (task 6.2) requests a full recalculation (R16.1).
 * - A failed run is reported to `onError` and never stops later runs.
 *
 * Not implemented here: the `PriceUpdated` trigger with `recalc.minValueChangePct`
 * (R16.2, AT-DSH-08). Its exposure-change rule (reference price, NAV basis,
 * cumulative or per update) is not yet specified, and no `PriceUpdated` event
 * exists; it is a decision for approval. Filing score updates never trigger a
 * recalculation (R16.5).
 */
import type { PositionsChanged } from '../portfolio/index.js';

export type RecalcReason = 'POSITIONS_CHANGED' | 'MANUAL' | 'SCHEDULED';

export interface RiskScheduler {
  requestRecalculation(portfolioId: string, reason: RecalcReason): void;
  onPositionsChanged(event: PositionsChanged): void;
  /** Resolves when the portfolio has no run in progress or queued. */
  idle(portfolioId: string): Promise<void>;
}

export interface RiskSchedulerDependencies {
  readonly run: (portfolioId: string, reason: RecalcReason) => Promise<unknown>;
  readonly onError: (portfolioId: string, error: unknown) => void;
}

interface Slot {
  running: Promise<void>;
  queued: RecalcReason | undefined;
}

export function createRiskScheduler(deps: RiskSchedulerDependencies): RiskScheduler {
  const slots = new Map<string, Slot>();

  const execute = async (portfolioId: string, reason: RecalcReason): Promise<void> => {
    let next: RecalcReason | undefined = reason;
    while (next !== undefined) {
      try {
        await deps.run(portfolioId, next);
      } catch (error) {
        deps.onError(portfolioId, error);
      }
      const slot = slots.get(portfolioId);
      next = slot?.queued;
      if (slot !== undefined) {
        slot.queued = undefined;
      }
    }
    slots.delete(portfolioId);
  };

  const request = (portfolioId: string, reason: RecalcReason): void => {
    if (typeof portfolioId !== 'string' || portfolioId.length === 0) {
      throw new TypeError('portfolioId must be a non-empty string.');
    }
    const slot = slots.get(portfolioId);
    if (slot !== undefined) {
      slot.queued = slot.queued ?? reason;
      return;
    }
    const created: Slot = { running: Promise.resolve(), queued: undefined };
    slots.set(portfolioId, created);
    created.running = execute(portfolioId, reason);
  };

  return {
    requestRecalculation: request,
    onPositionsChanged: (event) => request(event.portfolioId, 'POSITIONS_CHANGED'),
    idle: async (portfolioId) => {
      let slot = slots.get(portfolioId);
      while (slot !== undefined) {
        await slot.running;
        slot = slots.get(portfolioId);
      }
    },
  };
}
