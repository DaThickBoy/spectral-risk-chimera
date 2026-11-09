// Task 10.3: FX rate recording and the last valid rate for display (design: FX rate recording
// and last valid rate, rules 1 to 8).
// Tests: AT-FX-12, AT-PRV-01 (FX part), AT-PRV-02 (FX part), AT-PRV-03 (FX part),
// AT-AUD-03 (FX recording part).
// Validates: Requirements 22.3, 25.3, 25.4, 25.5, 30.5, 30.8, 30.12, 33.10
import { describe, expect, it } from 'vitest';
import { createRecordingFxService } from '../../../src/app/index.js';
import type { ObservedFxRate } from '../../../src/app/index.js';
import { FixtureFxProvider } from '../../../src/fx/index.js';
import type { FxError, FxRateUsed } from '../../../src/fx/index.js';
import { InMemoryUnitOfWork, PersistenceError } from '../../../src/persistence/index.js';
import type { UnitOfWork } from '../../../src/persistence/index.js';
import { FakeClock, LastValidStore, sequentialIds } from '../../../src/shared/index.js';
import type { Result } from '../../../src/shared/index.js';
import {
  AS_OF,
  AT,
  BASE,
  MAX_AGE_SECONDS,
  SUPPORTED,
  fakeProvider,
  minusMs,
  okResult,
  plusMs,
  providerFailure,
  quote,
} from '../../helpers/fx.js';
import { RECORDED_AT, recorderSetup } from '../../helpers/fxRecorder.js';
import { harness } from '../../helpers/resilience.js';

const CONVENTION = 'ECB-PUB-1600-FRANKFURT-v1';
const OBSERVED_AT = minusMs(AT, 3_600_000);
const STALE_AT = minusMs(AT, MAX_AGE_SECONDS * 1000 + 1);

function value(result: Result<FxRateUsed, FxError>): FxRateUsed {
  if (!result.ok) {
    throw new Error(`expected a rate, got ${result.error.code}`);
  }
  return result.value;
}

function errorOf(result: Result<FxRateUsed, FxError>): FxError {
  if (result.ok) {
    throw new Error('expected an FX error');
  }
  return result.error;
}

/** A provider whose next answer can be changed between calls. */
function switchable(initial: unknown, kind: 'REAL' | 'DEMO' = 'REAL') {
  const state = { answer: initial };
  const provider = fakeProvider(() => state.answer, { kind });
  return { provider, state };
}

describe('Rule 1: what is recorded (AT-AUD-03 FX recording part)', () => {
  it('records a successful OBSERVED rate with every field, then returns the unchanged result', async () => {
    const { rate, uow } = recorderSetup(fakeProvider(() => okResult(quote())));
    const result = await rate('EUR');
    expect(value(result)).toMatchObject({ kind: 'OBSERVED', rate: '1.085', status: 'CURRENT' });
    expect(uow.snapshot().fxRates).toEqual([
      {
        id: 'fx-1',
        pair: 'EURUSD',
        rate: '1.085',
        observedAt: OBSERVED_AT,
        observedAtBasis: 'PROVIDER',
        source: 'fake-fx',
        sourceKind: 'REAL',
        recordedAt: RECORDED_AT,
        // OD-20: the provider's quote as received, beside the derived rate.
        published: {
          pair: 'EURUSD',
          rate: '1.085',
          method: 'AS_PUBLISHED',
          precision: 'SIGNIFICANT_DIGITS_40_ROUND_HALF_UP',
        },
      },
    ]);
  });

  it('records the requested pair and the inverted Rate(X/B), never the quote orientation', async () => {
    const { rate, uow } = recorderSetup(
      fakeProvider(() => okResult(quote({ from: 'USD', to: 'EUR', rate: '0.8' }))),
    );
    await rate('EUR');
    expect(uow.snapshot().fxRates[0]).toMatchObject({
      pair: 'EURUSD',
      rate: '1.25',
      // OD-20: the quote keeps its own orientation and value; the derived rate is 1 / 0.8.
      published: { pair: 'USDEUR', rate: '0.8', method: 'DECIMAL_INVERSE' },
    });
  });

  it('records a PUBLICATION_CONVENTION basis with its conventionId', async () => {
    const provider = fakeProvider(() =>
      okResult(quote({ observedAtBasis: 'PUBLICATION_CONVENTION', conventionId: CONVENTION })),
    );
    const { rate, uow } = recorderSetup(provider);
    await rate('EUR');
    expect(uow.snapshot().fxRates[0]).toMatchObject({
      observedAtBasis: 'PUBLICATION_CONVENTION',
      conventionId: CONVENTION,
    });
  });

  it('records the displayRate of FX_STALE before returning FX_STALE unchanged', async () => {
    const { rate, uow, lastValid } = recorderSetup(
      fakeProvider(() => okResult(quote({ observedAt: STALE_AT }))),
    );
    const error = errorOf(await rate('EUR'));
    expect(error).toMatchObject({
      code: 'FX_STALE',
      displayRate: { kind: 'STALE_DISPLAY', observedAt: STALE_AT },
    });
    expect(uow.snapshot().fxRates).toEqual([
      {
        id: 'fx-1',
        pair: 'EURUSD',
        rate: '1.085',
        observedAt: STALE_AT,
        observedAtBasis: 'PROVIDER',
        source: 'fake-fx',
        sourceKind: 'REAL',
        recordedAt: RECORDED_AT,
        // OD-20: the provider's quote as received, beside the derived rate.
        published: {
          pair: 'EURUSD',
          rate: '1.085',
          method: 'AS_PUBLISHED',
          precision: 'SIGNIFICANT_DIGITS_40_ROUND_HALF_UP',
        },
      },
    ]);
    // Stale rates never become last valid.
    expect(lastValid.get('EURUSD:REAL')).toBeUndefined();
  });

  it('never records the identity rate', async () => {
    const { rate, uow, lastValid } = recorderSetup(fakeProvider(() => okResult(quote())));
    expect(value(await rate(BASE)).kind).toBe('IDENTITY');
    expect(uow.snapshot().fxRates).toEqual([]);
    expect(lastValid.size).toBe(0);
    expect(uow.lastAttempt).toBeUndefined();
  });

  it.each([
    ['a provider error', providerFailure('HTTP_CLIENT_ERROR', 404)],
    ['invalid provider data', okResult(quote({ rate: '1e0' }))],
    ['an out-of-bound rate', okResult(quote({ observedAt: plusMs(AT, 1) }))],
    ['a provenance mismatch', okResult(quote({ source: 'other-fx' }))],
  ])('never records FX_UNAVAILABLE from %s', async (_name, answer) => {
    const { rate, uow, lastValid } = recorderSetup(fakeProvider(() => answer));
    expect(errorOf(await rate('EUR')).code).toBe('FX_UNAVAILABLE');
    expect(uow.snapshot().fxRates).toEqual([]);
    expect(uow.lastAttempt).toBeUndefined();
    expect(lastValid.size).toBe(0);
  });

  it('never records an unsupported currency', async () => {
    const { rate, uow } = recorderSetup(fakeProvider(() => okResult(quote())));
    expect(errorOf(await rate('CHF'))).toMatchObject({ cause: 'UNSUPPORTED_CURRENCY' });
    expect(uow.snapshot().fxRates).toEqual([]);
  });
});

describe('Rule 2: append-only, idempotent, conflicts', () => {
  it('an identical re-receipt writes nothing and takes no new id', async () => {
    const { provider, state } = switchable(okResult(quote()));
    const { rate, uow } = recorderSetup(provider);
    await rate('EUR');
    const before = uow.snapshot();
    expect(value(await rate('EUR')).rate).toBe('1.085');
    expect(uow.snapshot()).toEqual(before);
    expect(uow.lastAttempt?.writes).toEqual([]);
    // The next appended record takes fx-2, so the duplicate consumed no id.
    state.answer = okResult(quote({ observedAt: minusMs(AT, 60_000) }));
    await rate('EUR');
    expect(uow.snapshot().fxRates.map((r) => r.id)).toEqual(['fx-1', 'fx-2']);
  });

  it('a different rate under the same key is RATE_CONFLICT: not used, nothing written, last valid unchanged', async () => {
    const { provider, state } = switchable(okResult(quote()));
    const { rate, uow, lastValid } = recorderSetup(provider);
    await rate('EUR');
    const stored = lastValid.get('EURUSD:REAL');
    const before = uow.snapshot();
    state.answer = okResult(quote({ rate: '1.09' }));
    expect(errorOf(await rate('EUR'))).toEqual({
      code: 'FX_UNAVAILABLE',
      message: 'FX rate EURUSD is unavailable (RATE_CONFLICT).',
      currency: 'EUR',
      cause: 'RATE_CONFLICT',
    });
    expect(uow.snapshot()).toEqual(before);
    expect(lastValid.get('EURUSD:REAL')).toEqual(stored);
  });

  it('a different basis under the same key is also a conflict', async () => {
    const { provider, state } = switchable(okResult(quote()));
    const { rate } = recorderSetup(provider);
    await rate('EUR');
    state.answer = okResult(quote({ observedAtBasis: 'PUBLICATION_CONVENTION', conventionId: CONVENTION }));
    expect(errorOf(await rate('EUR'))).toMatchObject({ cause: 'RATE_CONFLICT' });
  });

  it('the same basis with a different conventionId under the same key is also a conflict', async () => {
    const { provider, state } = switchable(
      okResult(quote({ observedAtBasis: 'PUBLICATION_CONVENTION', conventionId: CONVENTION })),
    );
    const { rate, uow } = recorderSetup(provider);
    await rate('EUR');
    const before = uow.snapshot();
    state.answer = okResult(
      quote({ observedAtBasis: 'PUBLICATION_CONVENTION', conventionId: 'ECB-PUB-1600-FRANKFURT-v2' }),
    );
    expect(errorOf(await rate('EUR'))).toMatchObject({ cause: 'RATE_CONFLICT' });
    expect(uow.snapshot()).toEqual(before);
  });

  it('a stale rate conflicting with a stored record is RATE_CONFLICT, not FX_STALE', async () => {
    const { provider, state } = switchable(okResult(quote({ observedAt: STALE_AT })));
    const { rate } = recorderSetup(provider);
    expect(errorOf(await rate('EUR')).code).toBe('FX_STALE');
    state.answer = okResult(quote({ observedAt: STALE_AT, rate: '1.2' }));
    expect(errorOf(await rate('EUR'))).toMatchObject({ code: 'FX_UNAVAILABLE', cause: 'RATE_CONFLICT' });
  });

  it('records are append-only: no update or delete operation exists', () => {
    const keys = new InMemoryUnitOfWork().run((tx) => Object.keys(tx.fxRates).sort());
    expect(keys).toEqual(['append', 'findByKey', 'listByPair']);
  });
});

describe('Rule 3: the last valid store is updated only after a committed OBSERVED record', () => {
  it('a recorded OBSERVED rate becomes last valid under pair:configured kind', async () => {
    const { rate, lastValid } = recorderSetup(fakeProvider(() => okResult(quote())));
    const used = value(await rate('EUR'));
    expect(lastValid.get('EURUSD:REAL')).toEqual({ value: used, observedAt: OBSERVED_AT });
  });

  it.each([0, 1])(
    'a commit failure (fault at write %i) is RECORD_FAILED: nothing stored, last valid unchanged',
    async (atWrite) => {
      const { rate, uow, lastValid } = recorderSetup(fakeProvider(() => okResult(quote())));
      uow.failNextCommit({ atWrite });
      expect(errorOf(await rate('EUR'))).toEqual({
        code: 'FX_UNAVAILABLE',
        message: 'FX rate EURUSD is unavailable (RECORD_FAILED).',
        currency: 'EUR',
        cause: 'RECORD_FAILED',
      });
      expect(uow.snapshot().fxRates).toEqual([]);
      expect(uow.lastAttempt?.outcome).toBe('COMMIT_FAILED');
      expect(lastValid.size).toBe(0);
    },
  );

  it('a stale rate whose record fails is RECORD_FAILED and never used', async () => {
    const { rate, uow } = recorderSetup(fakeProvider(() => okResult(quote({ observedAt: STALE_AT }))));
    uow.failNextCommit({ atWrite: 0 });
    expect(errorOf(await rate('EUR'))).toMatchObject({ code: 'FX_UNAVAILABLE', cause: 'RECORD_FAILED' });
    expect(uow.snapshot().fxRates).toEqual([]);
  });

  it('a constraint violation (PersistenceError) is RECORD_FAILED and rolls the unit of work back', async () => {
    const { rate, uow } = recorderSetup(
      fakeProvider(() => okResult(quote())),
      { ids: { next: () => '' } },
    );
    expect(errorOf(await rate('EUR'))).toMatchObject({ cause: 'RECORD_FAILED' });
    expect(uow.snapshot().fxRates).toEqual([]);
    expect(uow.lastAttempt?.outcome).toBe('ROLLED_BACK');
  });

  it('an older successful rate never replaces a newer last valid rate', async () => {
    const { provider, state } = switchable(okResult(quote({ observedAt: minusMs(AT, 1_000) })));
    const { rate, lastValid } = recorderSetup(provider);
    await rate('EUR');
    state.answer = okResult(quote({ observedAt: minusMs(AT, 5_000), rate: '1.07' }));
    await rate('EUR');
    expect(lastValid.get('EURUSD:REAL')?.observedAt).toBe(minusMs(AT, 1_000));
  });
});

describe('Rule 4: the last valid rate on provider failure is display only (AT-FX-12, AT-PRV-01/02/03)', () => {
  it.each([
    ['PROVIDER_ERROR', providerFailure('NETWORK_ERROR')],
    ['INVALID_RESPONSE', okResult(quote({ rate: '0' }))],
  ])('%s carries lastValid as a STALE display rate; no rate is fabricated', async (cause, failure) => {
    const { provider, state } = switchable(
      okResult(quote({ conventionId: CONVENTION, observedAtBasis: 'PUBLICATION_CONVENTION' })),
    );
    const { rate, uow, lastValid } = recorderSetup(provider);
    await rate('EUR');
    const recordsBefore = uow.snapshot().fxRates;
    const storedBefore = lastValid.get('EURUSD:REAL');
    state.answer = failure;
    const error = errorOf(await rate('EUR'));
    expect(error).toMatchObject({ code: 'FX_UNAVAILABLE', cause, currency: 'EUR' });
    if (error.code !== 'FX_UNAVAILABLE') {
      throw new Error('unreachable');
    }
    expect(error.lastValid).toEqual({
      kind: 'STALE_DISPLAY',
      pair: 'EURUSD',
      rate: '1.085',
      observedAt: OBSERVED_AT,
      observedAtBasis: 'PUBLICATION_CONVENTION',
      conventionId: CONVENTION,
      source: 'fake-fx',
      sourceKind: 'REAL',
      status: 'STALE',
    });
    // The failure leaves both the history and the last valid rate unchanged.
    expect(uow.snapshot().fxRates).toEqual(recordsBefore);
    expect(lastValid.get('EURUSD:REAL')).toEqual(storedBefore);
  });

  it('no lastValid when none was ever recorded (nothing is fabricated)', async () => {
    const { rate } = recorderSetup(fakeProvider(() => providerFailure('TIMEOUT')));
    expect(errorOf(await rate('EUR'))).not.toHaveProperty('lastValid');
  });

  it('UNSUPPORTED_CURRENCY never carries lastValid, even when one exists for that pair', async () => {
    const lastValid = new LastValidStore<string, ObservedFxRate>();
    const chfEntry = {
      kind: 'OBSERVED',
      pair: 'CHFUSD',
      rate: '1.1',
      observedAt: minusMs(AT, 1),
      observedAtBasis: 'PROVIDER',
      source: 'fake-fx',
      sourceKind: 'REAL',
      status: 'CURRENT',
    } as unknown as ObservedFxRate;
    lastValid.recordSuccess('CHFUSD:REAL', chfEntry, chfEntry.observedAt);
    const { rate } = recorderSetup(
      fakeProvider(() => okResult(quote())),
      { lastValid },
    );
    expect(errorOf(await rate('CHF'))).toEqual({
      code: 'FX_UNAVAILABLE',
      message: 'FX rate CHFUSD is unavailable (UNSUPPORTED_CURRENCY).',
      currency: 'CHF',
      cause: 'UNSUPPORTED_CURRENCY',
    });
  });

  it('RATE_CONFLICT and RECORD_FAILED never carry lastValid', async () => {
    const { provider, state } = switchable(okResult(quote()));
    const { rate, uow } = recorderSetup(provider);
    await rate('EUR');
    state.answer = okResult(quote({ rate: '1.09' }));
    expect(errorOf(await rate('EUR'))).not.toHaveProperty('lastValid');
    state.answer = okResult(quote({ observedAt: minusMs(AT, 1) }));
    uow.failNextCommit({ atWrite: 0 });
    expect(errorOf(await rate('EUR'))).not.toHaveProperty('lastValid');
  });

  it('a last valid rate is never returned as a rate used in a calculation', async () => {
    const { provider, state } = switchable(okResult(quote()));
    const { rate } = recorderSetup(provider);
    await rate('EUR');
    state.answer = providerFailure('NETWORK_ERROR');
    const result = await rate('EUR');
    expect(result.ok).toBe(false);
  });
});

describe('D4: last valid keys use the configured provider kind', () => {
  it('a DEMO provider reads and writes only pair:DEMO, never a REAL entry', async () => {
    const lastValid = new LastValidStore<string, ObservedFxRate>();
    const realEntry = {
      kind: 'OBSERVED',
      pair: 'EURUSD',
      rate: '1.5',
      observedAt: minusMs(AT, 1),
      observedAtBasis: 'PROVIDER',
      source: 'other',
      sourceKind: 'REAL',
      status: 'CURRENT',
    } as unknown as ObservedFxRate;
    lastValid.recordSuccess('EURUSD:REAL', realEntry, realEntry.observedAt);
    const { provider, state } = switchable(providerFailure('NETWORK_ERROR'), 'DEMO');
    const { rate } = recorderSetup(provider, { lastValid });
    expect(errorOf(await rate('EUR'))).not.toHaveProperty('lastValid');
    state.answer = okResult(quote({ sourceKind: 'DEMO' }));
    await rate('EUR');
    expect(lastValid.get('EURUSD:DEMO')?.value.sourceKind).toBe('DEMO');
    expect(lastValid.get('EURUSD:REAL')?.value).toEqual(realEntry);
  });

  it('the wrapped FxService is built from the same dependencies (invalid fx dependencies throw TypeError)', () => {
    const h = harness();
    const make = (fx: unknown) => () =>
      createRecordingFxService({
        fx: fx as never,
        unitOfWork: new InMemoryUnitOfWork(),
        lastValid: new LastValidStore(),
        clock: new FakeClock(RECORDED_AT),
        ids: sequentialIds('fx'),
      });
    expect(
      make({
        provider: { name: 'x', getRate: () => undefined },
        resilientCall: h.rc,
        baseCurrency: BASE,
        supportedCurrencies: SUPPORTED,
        maxRateAgeSeconds: 1,
      }),
    ).toThrow(TypeError);
  });

  it('throws TypeError for invalid recorder dependencies', () => {
    const h = harness();
    const fx = {
      provider: new FixtureFxProvider({ name: 'demo-fx', rates: [] }),
      resilientCall: h.rc,
      baseCurrency: BASE,
      supportedCurrencies: SUPPORTED,
      maxRateAgeSeconds: MAX_AGE_SECONDS,
    };
    const base = {
      fx,
      unitOfWork: new InMemoryUnitOfWork(),
      lastValid: new LastValidStore<string, ObservedFxRate>(),
      clock: new FakeClock(RECORDED_AT),
      ids: sequentialIds('fx'),
    };
    for (const override of [{ unitOfWork: {} }, { lastValid: new Map() }, { clock: {} }, { ids: {} }]) {
      expect(() => createRecordingFxService({ ...base, ...override } as never)).toThrow(TypeError);
    }
  });
});

describe('D2: only PersistenceError maps to RECORD_FAILED; other exceptions propagate unchanged', () => {
  const boom = new Error('boom');

  it('an exception from the unit of work propagates', async () => {
    const throwing: UnitOfWork = {
      run: () => {
        throw boom;
      },
    };
    const { service } = recorderSetup(
      fakeProvider(() => okResult(quote())),
      { unitOfWork: throwing },
    );
    // Called directly: with no retries nothing waits on fake time, and `drive` handles only resolution.
    await expect(service.rateToBase('EUR', AS_OF, AT)).rejects.toBe(boom);
  });

  it('an exception from the IdGenerator propagates and rolls back', async () => {
    const { service, uow } = recorderSetup(
      fakeProvider(() => okResult(quote())),
      {
        ids: {
          next: () => {
            throw boom;
          },
        },
      },
    );
    await expect(service.rateToBase('EUR', AS_OF, AT)).rejects.toBe(boom);
    expect(uow.snapshot().fxRates).toEqual([]);
  });

  it('an exception from the last valid update propagates (after the record committed)', async () => {
    class FailingStore extends LastValidStore<string, ObservedFxRate> {
      override recordSuccess(): boolean {
        throw boom;
      }
    }
    const { service, uow } = recorderSetup(
      fakeProvider(() => okResult(quote())),
      { lastValid: new FailingStore() },
    );
    await expect(service.rateToBase('EUR', AS_OF, AT)).rejects.toBe(boom);
    expect(uow.snapshot().fxRates).toHaveLength(1);
  });

  it('a PersistenceError thrown by a unit of work is RECORD_FAILED', async () => {
    const failing: UnitOfWork = {
      run: () => {
        throw new PersistenceError('COMMIT_FAILED', 'down');
      },
    };
    const { rate } = recorderSetup(
      fakeProvider(() => okResult(quote())),
      { unitOfWork: failing },
    );
    expect(errorOf(await rate('EUR'))).toMatchObject({ cause: 'RECORD_FAILED' });
  });

  it('a TypeError from the wrapped service (invalid arguments) propagates', async () => {
    const { service } = recorderSetup(fakeProvider(() => okResult(quote())));
    await expect(service.rateToBase('eur', '2026-11-06', AT)).rejects.toThrow(TypeError);
  });
});

describe('D3: injected IdGenerator and Clock', () => {
  it('ids are deterministic under sequentialIds and recordedAt comes from the Clock', async () => {
    const { provider, state } = switchable(okResult(quote({ observedAt: minusMs(AT, 2_000) })));
    const { rate, uow, clock } = recorderSetup(provider);
    await rate('EUR');
    clock.advance(1_000);
    state.answer = okResult(quote({ observedAt: minusMs(AT, 1_000) }));
    await rate('EUR');
    expect(uow.snapshot().fxRates.map((r) => [r.id, r.recordedAt])).toEqual([
      ['fx-1', RECORDED_AT],
      ['fx-2', '2026-11-06T16:00:06.000Z'],
    ]);
  });

  it('recordedAt never appears in FxRateUsed', async () => {
    const { rate } = recorderSetup(fakeProvider(() => okResult(quote())));
    expect(value(await rate('EUR'))).not.toHaveProperty('recordedAt');
  });
});
