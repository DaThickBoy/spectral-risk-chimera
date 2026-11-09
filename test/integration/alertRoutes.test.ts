// Task 16.3: GET /alerts and POST /alerts/:id/dismiss through Fastify inject(), and an alert
// delivered to the /stream hub through the dispatcher's injected publisher.
// Tests: AT-ALR-11, AT-ALR-17
// Validates: Requirements 19.1, 19.2, 19.4, 34.8
import { describe, expect, it } from 'vitest';
import { alertRoutes, createStreamHub, streamAlertPublisher } from '../../src/api/index.js';
import type { StreamClient } from '../../src/api/index.js';
import { createAlertDispatcher } from '../../src/app/index.js';
import {
  AlertsResponseSchema,
  FakeSleeper,
  StreamEventSchema,
  sequentialIds,
} from '../../src/shared/index.js';
import { alertHarness, input } from '../helpers/alerts.js';
import { jsonNumbers, testServer } from '../helpers/api.js';

function setup() {
  const h = alertHarness();
  const { app } = testServer([alertRoutes({ alerts: h.service })]);
  return { ...h, app };
}

describe('GET /alerts', () => {
  it('lists the portfolio history newest first; financial values are strings', async () => {
    const s = setup();
    s.service.onRiskResult(input('16'));
    s.clock.advance(1000);
    s.service.onRiskResult(input('23'));
    const response = await s.app.inject({ method: 'GET', url: '/alerts?portfolioId=pf-1' });
    expect(response.statusCode).toBe(200);
    const body = AlertsResponseSchema.parse(response.json());
    expect(body.alerts.map((a) => [a.severity, a.observed, a.threshold, a.delivery])).toEqual([
      ['CRITICAL', '23', '15', 'PENDING'],
      ['WARNING', '16', '15', 'PENDING'],
    ]);
    expect(body.alerts[1]?.id).toBe('alert-1');
    expect(jsonNumbers(response.json()).every((path) => path.endsWith('.deliveryAttempts'))).toBe(true);
  });

  it.each(['/alerts', '/alerts?portfolioId=pf-1&all=1', '/alerts?portfolioId='])('%s is 400', async (url) => {
    const s = setup();
    expect((await s.app.inject({ method: 'GET', url })).statusCode).toBe(400);
  });
});

describe('POST /alerts/:id/dismiss (AT-ALR-11)', () => {
  it('dismisses an open alert and keeps it in the history', async () => {
    const s = setup();
    s.service.onRiskResult(input('16'));
    const dismiss = () =>
      s.app.inject({
        method: 'POST',
        url: '/alerts/alert-1/dismiss',
        payload: {},
        headers: { 'content-type': 'application/json' },
      });
    const response = await dismiss();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'alert-1', state: 'DISMISSED' });
    const list = AlertsResponseSchema.parse(
      (await s.app.inject({ method: 'GET', url: '/alerts?portfolioId=pf-1' })).json(),
    );
    expect(list.alerts).toEqual([expect.objectContaining({ id: 'alert-1', state: 'DISMISSED' })]);
    const again = await dismiss();
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'ALERT_NOT_OPEN' } });
  });

  it('an unknown id is 404; a body with fields is 400', async () => {
    const s = setup();
    expect(
      (
        await s.app.inject({
          method: 'POST',
          url: '/alerts/none/dismiss',
          payload: {},
          headers: { 'content-type': 'application/json' },
        })
      ).statusCode,
    ).toBe(404);
    s.service.onRiskResult(input('16'));
    expect(
      (
        await s.app.inject({
          method: 'POST',
          url: '/alerts/alert-1/dismiss',
          payload: { state: 'OPEN' },
          headers: { 'content-type': 'application/json' },
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('AT-ALR-17: an alert is published to the /stream hub', () => {
  it('the dashboard client receives one AlertRaised event with the alert id', async () => {
    const h = alertHarness();
    const hub = createStreamHub({ logger: h.logger, maxClients: 2, maxBufferedBytes: 65_536 });
    const sent: string[] = [];
    const client: StreamClient = {
      bufferedAmount: 0,
      send: (data) => sent.push(data),
      terminate: () => undefined,
    };
    hub.add(client);
    const dispatcher = createAlertDispatcher({
      unitOfWork: h.uow,
      clock: h.clock,
      sleeper: new FakeSleeper(h.clock),
      ids: sequentialIds('audit'),
      logger: h.logger,
      publishers: [streamAlertPublisher(hub)],
      maxRetries: 3,
      initialBackoffMs: 100,
      maxBackoffMs: 400,
      attemptTimeoutMs: 1000,
    });
    h.service.onRiskResult(input('16'));
    expect(await dispatcher.dispatchPending()).toEqual({ delivered: 1, failed: 0, deferred: 0 });
    expect(sent.map((text) => StreamEventSchema.parse(JSON.parse(text)))).toEqual([
      expect.objectContaining({
        type: 'AlertRaised',
        alertId: 'alert-1',
        alertType: 'VAR',
        tickers: ['AAA', 'BBB'],
      }),
    ]);
  });
});
