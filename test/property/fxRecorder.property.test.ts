// Validates: Requirements 22.3, 25.3, 25.5, 30.12, 33.10
// Task 10.3, Property 36 (FX part): for any sequence of provider outcomes (fresh, stale, invalid,
// failed, and fresh with an injected commit fault), compared with an independent reference model:
// - the history holds exactly the recorded fresh and stale observations, in first-seen order;
// - the last valid rate is the newest fresh observation that was recorded (never a stale, invalid,
//   failed, or unrecorded one), and nothing is fabricated when there is none;
// - a provider failure carries exactly that last valid rate as a display-only STALE rate.
// Traceability: AT-FX-12, AT-PRV-01, AT-PRV-03
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AT,
  MAX_AGE_SECONDS,
  fakeProvider,
  minusMs,
  okResult,
  providerFailure,
  quote,
} from '../helpers/fx.js';
import { recorderSetup } from '../helpers/fxRecorder.js';

const MAX_MS = MAX_AGE_SECONDS * 1000;

type Step =
  | { readonly kind: 'fresh'; readonly ageMs: number }
  | { readonly kind: 'faultedFresh'; readonly ageMs: number }
  | { readonly kind: 'stale'; readonly ageMs: number }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'failure' };

// A small set of ages so that repeated (identical) observations occur often.
const freshAge = fc.constantFrom(0, 1_000, 60_000, 3_600_000, MAX_MS);
const staleAge = fc.constantFrom(MAX_MS + 1, MAX_MS + 60_000);

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  freshAge.map((ageMs) => ({ kind: 'fresh' as const, ageMs })),
  freshAge.map((ageMs) => ({ kind: 'faultedFresh' as const, ageMs })),
  staleAge.map((ageMs) => ({ kind: 'stale' as const, ageMs })),
  fc.constant({ kind: 'invalid' as const }),
  fc.constant({ kind: 'failure' as const }),
);

describe('Property 36 (FX part): recording and last valid rate', () => {
  it('matches the reference model for any sequence of provider outcomes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 12 }), async (steps) => {
        const state: { answer: unknown } = { answer: undefined };
        // A high circuit threshold keeps this property about recording; circuit behaviour is
        // covered by the 10.1 tests (an open circuit would turn later steps into CIRCUIT_OPEN).
        const { rate, uow, lastValid } = recorderSetup(
          fakeProvider(() => state.answer),
          {
            failureThreshold: 1_000,
          },
        );

        // Reference model.
        const recorded: string[] = [];
        let newestFresh: string | undefined;

        for (const step of steps) {
          switch (step.kind) {
            case 'fresh':
            case 'faultedFresh':
            case 'stale': {
              const observedAt = minusMs(AT, step.ageMs);
              state.answer = okResult(quote({ observedAt }));
              if (step.kind === 'faultedFresh') {
                // atWrite 0 fails the first write of a new record, or the publish step of a
                // unit of work with no writes (an identical re-receipt): both are RECORD_FAILED.
                uow.failNextCommit({ atWrite: 0 });
              }
              const result = await rate('EUR');
              if (step.kind === 'faultedFresh') {
                expect(result).toMatchObject({ ok: false, error: { cause: 'RECORD_FAILED' } });
                break;
              }
              if (!recorded.includes(observedAt)) {
                recorded.push(observedAt);
              }
              if (step.kind === 'fresh') {
                expect(result.ok).toBe(true);
                if (newestFresh === undefined || observedAt >= newestFresh) {
                  newestFresh = observedAt;
                }
              } else {
                expect(result).toMatchObject({ ok: false, error: { code: 'FX_STALE' } });
              }
              break;
            }
            case 'invalid':
            case 'failure': {
              state.answer =
                step.kind === 'invalid' ? okResult(quote({ rate: '1e0' })) : providerFailure('NETWORK_ERROR');
              const result = await rate('EUR');
              expect(result.ok).toBe(false);
              if (!result.ok && result.error.code === 'FX_UNAVAILABLE') {
                if (newestFresh === undefined) {
                  expect(result.error).not.toHaveProperty('lastValid');
                } else {
                  expect(result.error.lastValid).toMatchObject({
                    kind: 'STALE_DISPLAY',
                    status: 'STALE',
                    observedAt: newestFresh,
                  });
                }
              }
              break;
            }
          }
        }

        expect(uow.snapshot().fxRates.map((r) => r.observedAt)).toEqual(recorded);
        expect(lastValid.get('EURUSD:REAL')?.observedAt).toBe(newestFresh);
      }),
      { numRuns: 200 },
    );
  });
});
