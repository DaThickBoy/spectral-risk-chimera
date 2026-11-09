// Validates: Requirements 19.5, 34.7, 34.8
// Property 33: Alert delivery isolation. Random publisher faults (throw, reject, hang, accept)
// and retry limits: the stored risk result and its VaR figures never change, the alert is never
// lost (it persists with its final delivery status), retries reuse the same id, and a
// de-duplicating dashboard shows it at most once.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createAlertDispatcher, varAlertInput } from '../../src/app/index.js';
import type { AlertPublisher } from '../../src/app/index.js';
import { FakeSleeper, sequentialIds } from '../../src/shared/index.js';
import { SETTINGS, alertHarness } from '../helpers/alerts.js';
import { completeTestConfig, withKey } from '../helpers/config.js';
import { advanceBy } from '../helpers/resilience.js';
import { PF, cleanSeries, riskHarness } from '../helpers/riskService.js';

type Fault = 'ok' | 'throw' | 'reject' | 'hang';
const faultArb = fc.constantFrom<Fault>('ok', 'throw', 'reject', 'hang');

function scripted(name: string, faults: readonly Fault[], seen: string[]): AlertPublisher {
  let call = 0;
  return {
    name,
    publish: (event) => {
      const fault = faults[call] ?? 'ok';
      call += 1;
      switch (fault) {
        case 'throw':
          throw new Error('publish failed');
        case 'reject':
          return Promise.reject(new Error('publish failed'));
        case 'hang':
          return new Promise<void>(() => undefined);
        case 'ok':
          seen.push(event.alertId);
          return undefined;
      }
    },
  };
}

const SMALL = withKey(withKey(completeTestConfig(), 'var.lookbackReturns', 3), 'var.minObservations', 2);

describe('Property 33: Alert delivery isolation', () => {
  it('publication faults never change the risk result and never lose or duplicate the alert', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(faultArb, { maxLength: 6 }),
        fc.array(faultArb, { maxLength: 6 }),
        fc.integer({ min: 0, max: 4 }),
        async (busFaults, streamFaults, maxRetries) => {
          const risk = riskHarness(
            { AAA: ['USD', '10'] },
            { values: SMALL, prices: { AAA: { price: '100' } } },
          );
          risk.putSeries(cleanSeries('AAA', ['100', '110', '99', '108.9'], { start: '2026-11-03' }));
          await risk.service.calculate(PF);
          const view = risk.service.view(PF);
          if (view === undefined) throw new Error('no risk view');

          const h = alertHarness({
            settings: { [PF]: { ...SETTINGS, metric: 'BASE', thresholdPct: '5', resetPct: '5' } },
            onAlertsRaised: () => {
              throw new Error('notification failed'); // must not reach the caller
            },
          });
          const outcome = h.service.onRiskResult(varAlertInput(view, []));
          expect(outcome).toMatchObject({ status: 'FIRED' });

          const busSeen: string[] = [];
          const dashboard: string[] = [];
          const sleeper = new FakeSleeper(h.clock);
          const dispatcher = createAlertDispatcher({
            unitOfWork: h.uow,
            clock: h.clock,
            sleeper,
            ids: sequentialIds('audit'),
            logger: h.logger,
            publishers: [
              scripted('event-bus', busFaults, busSeen),
              scripted('stream', streamFaults, dashboard),
            ],
            maxRetries,
            initialBackoffMs: 100,
            maxBackoffMs: 400,
            attemptTimeoutMs: 1000,
          });
          let done = false;
          const summary = dispatcher.dispatchPending().finally(() => {
            done = true;
          });
          while (!done) {
            await advanceBy({ clock: h.clock, sleeper }, 250);
          }
          await summary;

          // The risk result is untouched.
          expect(risk.service.view(PF)).toEqual(view);
          // The alert persists with a final status and a bounded number of attempts.
          const alerts = h.uow.snapshot().alerts;
          expect(alerts).toHaveLength(1);
          const [alert] = alerts;
          if (alert === undefined) return;
          expect(['DELIVERED', 'FAILED']).toContain(alert.delivery);
          expect(alert.deliveryAttempts).toBeGreaterThanOrEqual(1);
          expect(alert.deliveryAttempts).toBeLessThanOrEqual(maxRetries + 1);
          // Every receipt carries the same id; each publisher received it at most once.
          expect(new Set([...busSeen, ...dashboard])).toEqual(
            busSeen.length + dashboard.length === 0 ? new Set() : new Set([alert.id]),
          );
          expect(dashboard.length).toBeLessThanOrEqual(1);
          expect(busSeen.length).toBeLessThanOrEqual(1);
          expect(alert.delivery === 'DELIVERED').toBe(busSeen.length === 1 && dashboard.length === 1);
        },
      ),
      { numRuns: 150 },
    );
  });
});
