// Property 36: Provider failure keeps last valid data
// Validates: Requirements 25.3, 25.5, 33.9, 33.10
// Traceability: AT-PRV-01, AT-PRV-03, AT-PRV-08. "Unrelated risk calculations still complete" is
// checked with the 12.1 quantile stand-in and, since task 12.2, with the real Base VaR calculation.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeRisk, type7Quantile } from '../../src/risk/index.js';
import { LastValidStore, d, dataStatus, toCanonical } from '../../src/shared/index.js';
import type { AttemptOutcome } from '../../src/shared/index.js';
import { drive, harness, http } from '../helpers/resilience.js';
import { position, riskInput } from '../helpers/risk.js';

type Fetch =
  | { kind: 'OK'; close: string }
  | { kind: 'FAIL'; outcome: AttemptOutcome<never> }
  | { kind: 'HANG' }
  | { kind: 'THROW' };

const fetchArb: fc.Arbitrary<Fetch> = fc.oneof(
  fc.integer({ min: 1, max: 99_999 }).map((n) => ({ kind: 'OK' as const, close: `${n}.25` })),
  fc
    .constantFrom<AttemptOutcome<never>>(
      { ok: false, failure: 'NETWORK' },
      { ok: false, failure: 'TIMEOUT' },
      { ok: false, failure: 'INVALID_RESPONSE' },
      { ok: false, failure: 'TLS' },
      http(429),
      http(500),
      http(404),
    )
    .map((outcome) => ({ kind: 'FAIL' as const, outcome })),
  fc.constant({ kind: 'HANG' as const }),
  fc.constant({ kind: 'THROW' as const }),
);

const MAX_AGE_MS = 60_000;

describe('Property 36: provider failure keeps last valid data', () => {
  it('after any failure sequence the stored value is the last success, unchanged, labelled honestly, never fabricated', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fetchArb, fc.integer({ min: 0, max: 90_000 })), { maxLength: 25 }),
        async (steps) => {
          const h = harness({ maxRetries: 1, attemptTimeoutMs: 5_000 });
          h.randomValue = 0.5;
          const store = new LastValidStore<string, { close: string }>();
          let lastSuccess: { close: string; observedAt: string } | undefined;
          for (const [fetch, gapMs] of steps) {
            h.sleeper.advance(gapMs);
            const fn = (): Promise<AttemptOutcome<{ close: string }>> => {
              switch (fetch.kind) {
                case 'OK':
                  return Promise.resolve({ ok: true, value: { close: fetch.close } });
                case 'FAIL':
                  return Promise.resolve(fetch.outcome);
                case 'HANG':
                  return new Promise(() => undefined);
                case 'THROW':
                  throw new Error('provider bug');
              }
            };
            const result = await drive(h.sleeper, h.rc.run('md', 'getQuote', fn));
            const now = h.clock.nowUtc();
            if (result.ok) {
              const observedAt = now.toISOString();
              store.recordSuccess('AAA', result.value, observedAt);
              lastSuccess = { close: result.value.close, observedAt };
              expect(
                dataStatus({ sourceKind: 'REAL', observedAt, now, maxAgeMs: MAX_AGE_MS, fromCache: false }),
              ).toBe('CURRENT');
              continue;
            }
            // Failure: never a value; the store is exactly the last success (or empty).
            expect('value' in result).toBe(false);
            const stored = store.get('AAA');
            if (lastSuccess === undefined) {
              expect(stored).toBeUndefined();
              continue;
            }
            expect(stored).toEqual({
              value: { close: lastSuccess.close },
              observedAt: lastSuccess.observedAt,
            });
            const label = dataStatus({
              sourceKind: 'REAL',
              observedAt: stored?.observedAt,
              now,
              maxAgeMs: MAX_AGE_MS,
              fromCache: true,
            });
            expect(['STALE', 'CACHED']).toContain(label);
            expect(label).toBe(
              now.getTime() - Date.parse(lastSuccess.observedAt) > MAX_AGE_MS ? 'STALE' : 'CACHED',
            );
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it('AT-PRV-08: an unrelated calculation completes while a provider call hangs', async () => {
    const h = harness({ maxRetries: 3, attemptTimeoutMs: 10_000 });
    let providerSettled = false;
    const pending = h.rc.run('md', 'getSeries', () => new Promise<AttemptOutcome<never>>(() => undefined));
    void pending.then(() => (providerSettled = true));
    await new Promise((resolve) => setImmediate(resolve));

    // Stand-in risk calculation (12.1 quantile): 0.45 * 0.0213 + 0.55 * 0.0251 = 0.02339 at n = 250.
    const losses = Array.from({ length: 250 }, (_, i) =>
      d(i === 236 ? '0.0213' : i === 237 ? '0.0251' : i < 236 ? '-1' : '1'),
    );
    const quantile = type7Quantile(losses, d('0.95'));
    expect(quantile.ok && toCanonical(quantile.value)).toBe('0.02339');
    // Task 12.2: the real Base VaR calculation. One short unit at price 1 (E = -1), so each
    // scenario loss equals its return: the same 250 values give VaR 0.02339.
    const returns = losses.map((loss) => toCanonical(loss));
    const base = riskInput([position('AAA', '-1', '1')], { AAA: returns });
    const risk = computeRisk({
      ...base,
      params: { ...base.params, lookbackReturns: 250, minObservations: 200 },
    });
    expect(risk.status).toBe('OK');
    expect(risk.baseVaR?.absolute).toBe('0.02339');
    expect(providerSettled).toBe(false);

    const result = await drive(h.sleeper, pending);
    expect(!result.ok && result.error.code).toBe('TIMEOUT');
  });
});
