/**
 * Audit of rejected sentiment messages (task 13.1; R10.7, R21.3, R22.6).
 *
 * `sentiment/` may not import `audit/`, so the poller reports rejections to a
 * callback and this app-layer adapter records each as `VALIDATION` /
 * `SENTIMENT_REJECTED` with the provider and the fixed reason code only: no
 * payload text, ticker, or value (R22.6). A failed audit write is reported to
 * `onAuditFailure` and never stops ingestion.
 */
import { recordAuditEvent } from '../audit/index.js';
import { PersistenceError } from '../persistence/ports.js';
import type { UnitOfWork } from '../persistence/ports.js';
import type { ObservationRejection } from '../sentiment/index.js';
import type { Clock, IdGenerator } from '../shared/index.js';

export interface SentimentRejectionAuditorDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly onAuditFailure: (error: PersistenceError) => void;
}

export function createSentimentRejectionAuditor(
  deps: SentimentRejectionAuditorDependencies,
): (rejection: ObservationRejection, context: { readonly provider: string }) => void {
  return (rejection, context) => {
    try {
      recordAuditEvent(deps.unitOfWork, {
        id: deps.ids.next(),
        at: deps.clock.nowUtc().toISOString(),
        category: 'VALIDATION',
        type: 'SENTIMENT_REJECTED',
        details: { provider: context.provider, reason: rejection.reason },
      });
    } catch (error) {
      if (error instanceof PersistenceError) {
        deps.onAuditFailure(error);
        return;
      }
      throw error;
    }
  };
}
