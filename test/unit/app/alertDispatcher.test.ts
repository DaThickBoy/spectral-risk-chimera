// Task 16.3: alert outbox and dispatcher with injected publishers (no event-bus adapter).
// Tests: AT-ALR-05, AT-ALR-10, AT-ALR-11, AT-ALR-12, AT-ALR-17
// Validates: Requirements 19.1, 19.2, 19.3, 19.4, 19.5, 34.7, 34.8
import { describe, expect, it } from 'vitest';
import { alertRaisedEvent, createAlertDispatcher } from '../../../src/app/index.js';
import type { AlertPublisher } from '../../../src/app/index.js';
import { PersistenceError } from '../../../src/persistence/index.js';
import type { UnitOfWork } from '../../../src/persistence/index.js';
import { FakeSleeper, AlertRaisedSchema, sequentialIds } from '../../../src/shared/index.js';
import type { AlertRaised } from '../../../src/shared/index.js';
import { alertHarness, input } from '../../helpers/alerts.js';
import { advanceBy } from '../../helpers/resilience.js';

interface Recorder extends AlertPublisher {
  readonly received: AlertRaised[];
}

/** Fails the first `failures` calls (throws, rejects, or never settles), then accepts. */
function publisher(name: string, failures = 0, mode: 'throw' | 'reject' | 'hang' = 'throw'): Recorder {
  const received: AlertRaised[] = [];
  let calls = 0;
  return {
    name,
    received,
    publish: (event) => {
      calls += 1;
      if (calls <= failures) {
        if (mode === 'throw') throw new Error('bus down: test-api-key');
        if (mode === 'reject') return Promise.reject(new Error('bus down'));
        return new Promise<void>(() => undefined);
      }
      received.push(event);
      return undefined;
    },
  };
}

/** Fails the `failAt`-th (1-based) unit of work of the dispatcher with COMMIT_FAILED. */
function failingRun(inner: UnitOfWork, failAt: number): UnitOfWork {
  let calls = 0;
  return {
    run: (work) => {
      calls += 1;
      if (calls === failAt) {
        throw new PersistenceError('COMMIT_FAILED', 'The unit of work could not be committed.');
      }
      return inner.run(work);
    },
  };
}

function setup(publishers: readonly AlertPublisher[], maxRetries = 3, failAt?: number) {
  let raised: readonly string[] = [];
  const h = alertHarness({ onAlertsRaised: (ids) => (raised = ids) });
  const sleeper = new FakeSleeper(h.clock);
  const dispatcher = createAlertDispatcher({
    unitOfWork: failAt === undefined ? h.uow : failingRun(h.uow, failAt),
    clock: h.clock,
    sleeper,
    ids: sequentialIds('dispatch-audit'),
    logger: h.logger,
    publishers,
    maxRetries,
    initialBackoffMs: 1000,
    maxBackoffMs: 4000,
    attemptTimeoutMs: 5000,
  });
  const run = async () => {
    let done = false;
    const result = dispatcher.dispatchPending().finally(() => {
      done = true;
    });
    while (!done) {
      await advanceBy({ clock: h.clock, sleeper }, 500);
    }
    return result;
  };
  return { ...h, sleeper, dispatcher, run, raised: () => raised };
}

describe('AT-ALR-10 and AT-ALR-17: the alert event carries every R19.2 field and the triggering tickers', () => {
  it('publishes AlertRaised to every publisher after the commit', async () => {
    const bus = publisher('event-bus');
    const stream = publisher('stream');
    const s = setup([bus, stream]);
    const outcome = s.service.onRiskResult(input('16.5'));
    expect(outcome).toMatchObject({ status: 'FIRED' });
    expect(s.raised()).toEqual([outcome.status === 'FIRED' ? outcome.alertId : '']);
    expect(await s.run()).toEqual({ delivered: 1, failed: 0, deferred: 0 });
    const [event] = bus.received;
    expect(AlertRaisedSchema.parse(event)).toEqual({
      type: 'AlertRaised',
      alertId: 'alert-1',
      alertType: 'VAR',
      source: 'var-alert-evaluator',
      portfolioId: 'pf-1',
      severity: 'WARNING',
      metric: 'ADJUSTED_VAR_PCT_NAV',
      observedValue: '16.5',
      threshold: '15',
      at: '2026-11-08T12:00:00.000Z',
      description: expect.stringContaining('percentile-based loss estimate'),
      tickers: ['AAA', 'BBB'],
    });
    expect(stream.received).toEqual(bus.received);
    expect(s.uow.snapshot().alerts[0]).toMatchObject({ delivery: 'DELIVERED', deliveryAttempts: 1 });
  });
});

describe('AT-ALR-05: publish failure never stops calculations; retries, then FAILED', () => {
  it('a publisher that always fails: 1 + maxRetries attempts with backoff, then FAILED, logged and audited', async () => {
    const bus = publisher('event-bus', Number.MAX_SAFE_INTEGER);
    const s = setup([bus], 3);
    s.service.onRiskResult(input('16'));
    const start = s.clock.monotonicMs();
    expect(await s.run()).toEqual({ delivered: 0, failed: 1, deferred: 0 });
    // Waits 1000 + 2000 + 4000 ms between the four attempts (hand-calculated, capped at 4000).
    expect(s.clock.monotonicMs() - start).toBeGreaterThanOrEqual(7000);
    const [alert] = s.uow.snapshot().alerts;
    expect(alert).toMatchObject({ delivery: 'FAILED', deliveryAttempts: 4, state: 'OPEN' });
    expect(s.audit('ALERT_DELIVERY_FAILED')).toEqual([
      expect.objectContaining({ details: { alertType: 'VAR', alertId: 'alert-1', attempts: '4' } }),
    ]);
    const failure = s.lines.find((line) => line.msg === 'alert.delivery_failed');
    expect(failure).toMatchObject({ alertId: 'alert-1', attempts: 4 });
    expect(JSON.stringify(s.lines)).not.toContain('test-api-key');
    // Calculations continue: the next evaluation still works and keeps its own state.
    expect(s.service.onRiskResult(input('19'))).toMatchObject({ status: 'FIRED', severity: 'HIGH' });
  });

  it.each(['throw', 'reject', 'hang'] as const)(
    'a %s publisher counts as a failed attempt and is retried',
    async (mode) => {
      const bus = publisher('event-bus', 2, mode);
      const s = setup([bus], 3);
      s.service.onRiskResult(input('16'));
      expect(await s.run()).toEqual({ delivered: 1, failed: 0, deferred: 0 });
      expect(s.uow.snapshot().alerts[0]).toMatchObject({ delivery: 'DELIVERED', deliveryAttempts: 3 });
    },
  );

  it('maxRetries 0 makes exactly one attempt', async () => {
    const s = setup([publisher('event-bus', 1)], 0);
    s.service.onRiskResult(input('16'));
    expect(await s.run()).toEqual({ delivered: 0, failed: 1, deferred: 0 });
    expect(s.uow.snapshot().alerts[0]?.deliveryAttempts).toBe(1);
  });
});

describe('AT-ALR-12: retries never produce duplicate dashboard entries', () => {
  it('a publisher that already accepted is not published to again; ids never change', async () => {
    const stream = publisher('stream');
    const bus = publisher('event-bus', 2);
    const s = setup([stream, bus], 3);
    s.service.onRiskResult(input('16'));
    await s.run();
    expect(stream.received.map((e) => e.alertId)).toEqual(['alert-1']);
    expect(bus.received.map((e) => e.alertId)).toEqual(['alert-1']);
  });

  it('a restart resumes a pending alert with the same id and its attempt count', async () => {
    const s = setup([publisher('event-bus', 1)], 3, 2); // run 1 reads the outbox, run 2 records the attempt
    s.service.onRiskResult(input('16'));
    expect(await s.run()).toEqual({ delivered: 0, failed: 0, deferred: 1 });
    expect(s.lines.some((line) => line.msg === 'alert.delivery_persist_failed')).toBe(true);
    expect(s.uow.snapshot().alerts[0]).toMatchObject({ delivery: 'PENDING', deliveryAttempts: 0 });
    expect(await s.run()).toEqual({ delivered: 1, failed: 0, deferred: 0 });
    expect(s.uow.snapshot().alerts[0]).toMatchObject({
      id: 'alert-1',
      delivery: 'DELIVERED',
      deliveryAttempts: 2,
    });
  });
});

describe('AT-ALR-11: dismissal preserves history', () => {
  it('a dismissed alert stays listed with its delivery status; dismissing twice is NOT_OPEN', async () => {
    const s = setup([publisher('event-bus')]);
    s.service.onRiskResult(input('16'));
    await s.run();
    s.clock.advance(1000);
    const dismissedAt = s.clock.nowUtc().toISOString();
    const dismissed = s.service.dismiss('alert-1');
    expect(dismissed).toMatchObject({
      status: 'DISMISSED',
      alert: { state: 'DISMISSED', stateChangedAt: dismissedAt, delivery: 'DELIVERED', observed: '16' },
    });
    expect(s.service.list('pf-1')).toEqual([expect.objectContaining({ id: 'alert-1', state: 'DISMISSED' })]);
    expect(s.service.dismiss('alert-1')).toMatchObject({ status: 'NOT_OPEN' });
    expect(s.service.dismiss('nope')).toEqual({ status: 'NOT_FOUND' });
    expect(s.audit('ALERT_DISMISSED')).toHaveLength(1);
  });

  it('the store refuses to change alert content or move a status backwards', () => {
    const s = setup([publisher('event-bus')]);
    s.service.onRiskResult(input('16'));
    const [alert] = s.uow.snapshot().alerts;
    if (alert === undefined) throw new Error('no alert');
    expect(() =>
      s.uow.run((tx) => tx.alerts.update({ ...alert, observed: '99' as typeof alert.observed })),
    ).toThrow(/observed cannot change/);
    s.service.dismiss(alert.id);
    expect(() =>
      s.uow.run((tx) =>
        tx.alerts.update({ ...alert, state: 'OPEN', stateChangedAt: null, deliveryAttempts: 0 }),
      ),
    ).toThrow(/state cannot change/);
  });

  it('a final delivery status never changes back, and attempts never decrease', async () => {
    const s = setup([publisher('event-bus')]);
    s.service.onRiskResult(input('16'));
    await s.run();
    const [delivered] = s.uow.snapshot().alerts;
    if (delivered === undefined) throw new Error('no alert');
    expect(delivered).toMatchObject({ delivery: 'DELIVERED', deliveryAttempts: 1 });
    expect(() => s.uow.run((tx) => tx.alerts.update({ ...delivered, delivery: 'PENDING' }))).toThrow(
      /delivery cannot change/,
    );
    expect(() =>
      s.uow.run((tx) => tx.alerts.update({ ...delivered, deliveryAttempts: 0, lastAttemptAt: null })),
    ).toThrow(/deliveryAttempts cannot decrease/);
  });
});

describe('dispatcher configuration and the event shape', () => {
  it.each([
    ['maxRetries', -1],
    ['initialBackoffMs', 0],
    ['maxBackoffMs', 0],
    ['attemptTimeoutMs', 1.5],
  ])('rejects %s = %s', (key, value) => {
    const h = alertHarness();
    expect(() =>
      createAlertDispatcher({
        unitOfWork: h.uow,
        clock: h.clock,
        sleeper: new FakeSleeper(h.clock),
        ids: sequentialIds('x'),
        logger: h.logger,
        publishers: [],
        maxRetries: 3,
        initialBackoffMs: 1000,
        maxBackoffMs: 4000,
        attemptTimeoutMs: 5000,
        [key]: value,
      }),
    ).toThrow(TypeError);
  });

  it('a ticker-level alert lists its ticker', () => {
    const h = alertHarness();
    h.service.onRiskResult(input('16'));
    const [alert] = h.uow.snapshot().alerts;
    if (alert === undefined) throw new Error('no alert');
    expect(alertRaisedEvent({ ...alert, ticker: 'AAA', triggeredTickers: [] }).tickers).toEqual(['AAA']);
  });

  it('stop() aborts a retry wait, leaves the alert PENDING, and ignores later kicks', async () => {
    const bus = publisher('event-bus', Number.MAX_SAFE_INTEGER);
    const s = setup([bus], 3);
    s.service.onRiskResult(input('16'));
    s.dispatcher.kick();
    await new Promise((resolve) => setImmediate(resolve)); // first attempt fails; the run waits 1000 ms
    await s.dispatcher.stop(); // returns without advancing the fake clock
    expect(s.uow.snapshot().alerts[0]).toMatchObject({ delivery: 'PENDING', deliveryAttempts: 1 });
    s.dispatcher.kick();
    await s.dispatcher.idle();
    expect(s.uow.snapshot().alerts[0]?.deliveryAttempts).toBe(1);
  });

  it('kick() is single-flight and idle() waits for the queued run', async () => {
    const bus = publisher('event-bus');
    const s = setup([bus]);
    s.service.onRiskResult(input('16'));
    s.dispatcher.kick();
    s.dispatcher.kick();
    await s.dispatcher.idle();
    expect(bus.received).toHaveLength(1);
  });
});
