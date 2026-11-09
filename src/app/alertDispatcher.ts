/**
 * Alert outbox dispatcher (task 16.3; design: Risk alert event flow; R19.1,
 * R19.2, R19.3, R19.5, R34.7, R34.8; Property 33).
 *
 * - The outbox is the `alerts` table: every `delivery = PENDING` alert, in
 *   insertion order, including alerts left pending by a restart.
 * - Each alert becomes one `AlertRaised` event (shared contract, validated) and
 *   is published to every injected `AlertPublisher` (for example the event bus
 *   port and the `/stream` hub). Nothing here implements an event bus.
 * - At-least-once: an attempt publishes to the publishers that have not yet
 *   accepted the alert. Each attempt is persisted (`deliveryAttempts`,
 *   `lastAttemptAt`) before the result is known, so a crash never loses one.
 *   The alert id never changes, so receivers de-duplicate by id (R34.8).
 * - Retries: up to `maxRetries` after the first attempt, waiting
 *   `min(maxBackoffMs, initialBackoffMs * 2^(retry - 1))` between attempts
 *   through the injected `Sleeper`. An attempt that does not settle within
 *   `attemptTimeoutMs` counts as failed.
 * - When every publisher accepted, the alert is `DELIVERED`; when the attempts
 *   are exhausted it is `FAILED`, kept in history, logged with its id and
 *   attempt count only, and audited as `ALERT_DELIVERY_FAILED`.
 * - Nothing here throws to the caller: publisher exceptions, timeouts, and
 *   persistence failures are contained, so risk calculations continue (R19.5).
 * - `kick()` starts a run unless one is active (then one more run follows),
 *   so a dispatch is single-flight.
 */
import { PersistenceError } from '../persistence/ports.js';
import type { AlertRecord, UnitOfWork } from '../persistence/ports.js';
import { AlertRaisedSchema } from '../shared/index.js';
import type { AlertRaised, Clock, IdGenerator, Logger, Sleeper } from '../shared/index.js';
import { createAuditLog } from '../audit/index.js';

/** An outbound alert channel (event bus port, `/stream` hub). Throws or rejects on failure. */
export interface AlertPublisher {
  readonly name: string;
  publish(event: AlertRaised): void | Promise<void>;
}

export interface AlertDispatcherDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly publishers: readonly AlertPublisher[];
  /** `alerts.delivery.maxRetries`: non-negative integer. */
  readonly maxRetries: number;
  /** Positive integers, milliseconds. */
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly attemptTimeoutMs: number;
}

export interface DispatchSummary {
  readonly delivered: number;
  readonly failed: number;
  /** Alerts left pending because persistence failed; retried by the next run. */
  readonly deferred: number;
}

export interface AlertDispatcher {
  /** Delivers every pending alert. Never rejects. */
  dispatchPending(signal?: AbortSignal): Promise<DispatchSummary>;
  /** Starts a run in the background (single-flight). */
  kick(): void;
  /** Resolves when no run is active or queued. */
  idle(): Promise<void>;
  /**
   * Shutdown: aborts the background run's waits, waits for it to end, and ignores later
   * `kick()` calls. Undelivered alerts stay `PENDING` and are delivered after the next start.
   */
  stop(): Promise<void>;
}

/** The R19.2 payload of a stored alert. */
export function alertRaisedEvent(alert: AlertRecord): AlertRaised {
  return AlertRaisedSchema.parse({
    type: 'AlertRaised',
    alertId: alert.id,
    alertType: alert.type,
    source: alert.source,
    portfolioId: alert.portfolioId,
    severity: alert.severity,
    metric: alert.metric,
    observedValue: alert.observed,
    threshold: alert.threshold,
    at: alert.createdAt,
    description: alert.description,
    tickers: alert.ticker === null ? [...alert.triggeredTickers] : [alert.ticker],
  });
}

const integerAtLeast = (value: number, min: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`${name} must be an integer of at least ${min}.`);
  }
};

export function createAlertDispatcher(deps: AlertDispatcherDependencies): AlertDispatcher {
  integerAtLeast(deps.maxRetries, 0, 'maxRetries');
  integerAtLeast(deps.initialBackoffMs, 1, 'initialBackoffMs');
  integerAtLeast(deps.maxBackoffMs, 1, 'maxBackoffMs');
  integerAtLeast(deps.attemptTimeoutMs, 1, 'attemptTimeoutMs');
  const maxAttempts = deps.maxRetries + 1;

  /** Publishes with a timeout; resolves true on success. */
  const publishOnce = async (publisher: AlertPublisher, event: AlertRaised): Promise<boolean> => {
    const timer = new AbortController();
    try {
      const published = Promise.resolve()
        .then(() => publisher.publish(event))
        .then(
          () => true,
          () => false,
        );
      const timedOut = deps.sleeper.sleep(deps.attemptTimeoutMs, timer.signal).then(() => false);
      return await Promise.race([published, timedOut]);
    } finally {
      timer.abort();
    }
  };

  /** Persists one change to an alert; false when persistence failed. */
  const save = (update: (current: AlertRecord) => AlertRecord, alertId: string): AlertRecord | undefined => {
    try {
      return deps.unitOfWork.run((tx) => {
        const current = tx.alerts.get(alertId);
        if (current === undefined || current.delivery !== 'PENDING') {
          return undefined;
        }
        const next = update(current);
        tx.alerts.update(next);
        if (next.delivery === 'FAILED') {
          createAuditLog(tx.audit).append({
            id: deps.ids.next(),
            at: deps.clock.nowUtc().toISOString(),
            category: 'ALERT',
            type: 'ALERT_DELIVERY_FAILED',
            subject: next.portfolioId,
            details: { alertType: next.type, alertId: next.id, attempts: String(next.deliveryAttempts) },
          });
        }
        return next;
      });
    } catch (error) {
      if (error instanceof PersistenceError) {
        deps.logger.error('alert.delivery_persist_failed', { alertId, code: error.code });
        return undefined;
      }
      throw error;
    }
  };

  const deliver = async (
    alert: AlertRecord,
    signal: AbortSignal | undefined,
  ): Promise<'DELIVERED' | 'FAILED' | 'DEFERRED'> => {
    const event = alertRaisedEvent(alert);
    const remaining = new Set(deps.publishers.map((p) => p.name));
    let current = alert;
    while (current.deliveryAttempts < maxAttempts) {
      if (current.deliveryAttempts > 0) {
        const retry = current.deliveryAttempts; // 1-based retry number, a count
        const wait = Math.min(deps.maxBackoffMs, deps.initialBackoffMs * 2 ** (retry - 1));
        if ((await deps.sleeper.sleep(wait, signal)) === 'ABORTED') {
          return 'DEFERRED';
        }
      }
      const attempted = save(
        (record) => ({
          ...record,
          deliveryAttempts: record.deliveryAttempts + 1,
          lastAttemptAt: deps.clock.nowUtc().toISOString(),
        }),
        current.id,
      );
      if (attempted === undefined) {
        return 'DEFERRED';
      }
      current = attempted;
      for (const publisher of deps.publishers) {
        if (remaining.has(publisher.name) && (await publishOnce(publisher, event))) {
          remaining.delete(publisher.name);
        }
      }
      if (remaining.size === 0) {
        return save((record) => ({ ...record, delivery: 'DELIVERED' }), current.id) === undefined
          ? 'DEFERRED'
          : 'DELIVERED';
      }
    }
    deps.logger.error('alert.delivery_failed', { alertId: current.id, attempts: current.deliveryAttempts });
    return save((record) => ({ ...record, delivery: 'FAILED' }), current.id) === undefined
      ? 'DEFERRED'
      : 'FAILED';
  };

  const dispatchPending = async (signal?: AbortSignal): Promise<DispatchSummary> => {
    let delivered = 0;
    let failed = 0;
    let deferred = 0;
    let pending: readonly AlertRecord[];
    try {
      pending = deps.unitOfWork.run((tx) => tx.alerts.listByDelivery('PENDING'));
    } catch (error) {
      deps.logger.error('alert.outbox_read_failed', {
        code: error instanceof PersistenceError ? error.code : 'UNEXPECTED',
      });
      return { delivered, failed, deferred };
    }
    for (const alert of pending) {
      if (signal?.aborted === true) {
        deferred += 1;
        continue;
      }
      try {
        const result = await deliver(alert, signal);
        if (result === 'DELIVERED') delivered += 1;
        else if (result === 'FAILED') failed += 1;
        else deferred += 1;
      } catch (error) {
        deps.logger.error('alert.dispatch_error', {
          alertId: alert.id,
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        deferred += 1;
      }
    }
    return { delivered, failed, deferred };
  };

  let running: Promise<void> | undefined;
  let again = false;
  const lifetime = new AbortController();
  const run = (): Promise<void> =>
    dispatchPending(lifetime.signal).then(() => {
      if (again && !lifetime.signal.aborted) {
        again = false;
        return run();
      }
      running = undefined;
      return undefined;
    });

  return {
    dispatchPending,
    kick: () => {
      if (lifetime.signal.aborted) {
        return;
      }
      if (running !== undefined) {
        again = true;
        return;
      }
      running = run();
    },
    stop: async () => {
      // Waits are aborted; an alert not yet delivered stays PENDING in the outbox for the next start.
      lifetime.abort();
      while (running !== undefined) {
        await running;
      }
    },
    idle: async () => {
      while (running !== undefined) {
        await running;
      }
    },
  };
}
