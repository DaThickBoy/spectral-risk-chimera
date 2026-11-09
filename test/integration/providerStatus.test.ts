// Task 8.3: GET /providers/status (design: Provider Resilience Layer). Uses Fastify inject() and the
// 8.2 ResilientCall harness.
// Validates: Requirements 25.1, 25.6
import { describe, expect, it } from 'vitest';
import { providerStatusRoutes } from '../../src/api/index.js';
import { createProviderStatusService } from '../../src/app/index.js';
import { ProviderStatusResponseSchema } from '../../src/shared/index.js';
import { SECRET, TIMEOUT, drive, harness } from '../helpers/resilience.js';
import { testServer } from '../helpers/api.js';

describe('Task 8.3: provider status route', () => {
  it('a failed provider shows its status and error code; no credential appears in the response', async () => {
    const h = harness({ maxRetries: 0 }, { failureThreshold: 1 });
    await drive(
      h.sleeper,
      h.rc.run('marketdata:fake-md', 'getLatestPrice', async () => {
        throw new Error(`upstream rejected key ${SECRET} at https://api.example.test/v1?key=${SECRET}`);
      }),
    );
    await drive(
      h.sleeper,
      h.rc.run('fx:fake-fx', 'getRate', async () => TIMEOUT),
    );
    const service = createProviderStatusService({
      resilientCall: h.rc,
      providers: ['marketdata:fake-md', 'fx:fake-fx', 'sentiment:idle'],
    });
    const { app } = testServer([providerStatusRoutes({ providerStatus: service })]);
    const response = await app.inject({ method: 'GET', url: '/providers/status' });
    expect(response.statusCode).toBe(200);
    const body = ProviderStatusResponseSchema.parse(response.json());
    expect(body.providers.map((entry) => entry.provider)).toEqual([
      'fx:fake-fx',
      'marketdata:fake-md',
      'sentiment:idle',
    ]);
    expect(body.providers[0]).toMatchObject({
      state: 'UNAVAILABLE',
      circuit: 'OPEN',
      lastErrorCode: 'TIMEOUT',
    });
    expect(body.providers[1]).toMatchObject({ lastErrorCode: 'UNEXPECTED_ERROR' });
    expect(body.providers[2]).toMatchObject({ state: 'AVAILABLE', circuit: 'CLOSED' });
    expect('lastErrorCode' in (body.providers[2] ?? {})).toBe(false);
    expect(response.payload).not.toContain(SECRET);
    expect(response.payload).not.toMatch(/https?:|example\.test|upstream/);
  });

  it('provider keys that are not circuit keys are refused at creation (no URL can enter a response)', () => {
    const h = harness();
    for (const bad of ['https://api.example.test', 'marketdata: x', 'MarketData:x', 'fx:', 'x']) {
      expect(() => createProviderStatusService({ resilientCall: h.rc, providers: [bad] })).toThrow(TypeError);
    }
  });

  it('the route accepts no query fields', async () => {
    const h = harness();
    const service = createProviderStatusService({ resilientCall: h.rc, providers: ['fx:a'] });
    const { app } = testServer([providerStatusRoutes({ providerStatus: service })]);
    expect((await app.inject({ method: 'GET', url: '/providers/status?verbose=1' })).statusCode).toBe(400);
  });
});
