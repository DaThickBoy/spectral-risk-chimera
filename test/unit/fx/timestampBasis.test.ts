// Task 10.4: FX timestamp-basis metadata and its validation (design: FX rules 4a, 5, and 12).
// Tests: AT-FX-20.
// Validates: Requirements 30.5, 30.13, 25.8, 22.3
import { describe, expect, it } from 'vitest';
import { CONVENTION_ID_PATTERN, FixtureFxProvider, fxCircuitKey } from '../../../src/fx/index.js';
import type { FxError, FxRateUsed } from '../../../src/fx/index.js';
import type { Result } from '../../../src/shared/index.js';
import {
  AT,
  BASE,
  MAX_AGE_SECONDS,
  fakeProvider,
  fxSetup,
  minusMs,
  okResult,
  quote,
} from '../../helpers/fx.js';

const CONVENTION = 'ECB-PUB-1600-FRANKFURT-v1';

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

const withoutBasis = (): Record<string, unknown> => {
  const q = quote();
  delete q['observedAtBasis'];
  return q;
};

describe('AT-FX-20: valid timestamp-basis combinations are copied unchanged', () => {
  it('PROVIDER without conventionId passes through to a fresh rate, with no conventionId key', async () => {
    const used = value(await fxSetup(fakeProvider(() => okResult(quote()))).rate('EUR'));
    expect(used).toMatchObject({ kind: 'OBSERVED', observedAtBasis: 'PROVIDER' });
    expect(used).not.toHaveProperty('conventionId');
  });

  it('PUBLICATION_CONVENTION with a valid conventionId passes through to a fresh rate', async () => {
    const provider = fakeProvider(() =>
      okResult(quote({ observedAtBasis: 'PUBLICATION_CONVENTION', conventionId: CONVENTION })),
    );
    expect(value(await fxSetup(provider).rate('EUR'))).toEqual({
      kind: 'OBSERVED',
      pair: 'EURUSD',
      rate: '1.085',
      observedAt: minusMs(AT, 3_600_000),
      observedAtBasis: 'PUBLICATION_CONVENTION',
      conventionId: CONVENTION,
      source: 'fake-fx',
      sourceKind: 'REAL',
      status: 'CURRENT',
    });
  });

  it('the basis is copied unchanged into a stale display rate', async () => {
    const provider = fakeProvider(() =>
      okResult(
        quote({
          observedAt: minusMs(AT, MAX_AGE_SECONDS * 1000 + 1),
          observedAtBasis: 'PUBLICATION_CONVENTION',
          conventionId: CONVENTION,
        }),
      ),
    );
    expect(errorOf(await fxSetup(provider).rate('EUR'))).toMatchObject({
      code: 'FX_STALE',
      displayRate: {
        kind: 'STALE_DISPLAY',
        observedAtBasis: 'PUBLICATION_CONVENTION',
        conventionId: CONVENTION,
      },
    });
  });

  it('the fixture provider labels every rate PROVIDER', async () => {
    const provider = new FixtureFxProvider({
      name: 'demo-fx',
      rates: [{ from: 'EUR', to: 'USD', rate: '1.08', observedAt: minusMs(AT, 1) }],
    });
    const used = value(await fxSetup(provider).rate('EUR'));
    expect(used).toMatchObject({ observedAtBasis: 'PROVIDER', sourceKind: 'DEMO' });
    expect(used).not.toHaveProperty('conventionId');
  });

  it('the identity rate has no basis fields (nothing is observed)', async () => {
    const used = value(await fxSetup(fakeProvider(() => okResult(quote()))).rate(BASE));
    expect(used.kind).toBe('IDENTITY');
    expect(used).not.toHaveProperty('observedAtBasis');
    expect(used).not.toHaveProperty('conventionId');
  });
});

describe('AT-FX-20: invalid timestamp-basis combinations are INVALID_RESPONSE, counted by the circuit', () => {
  const invalid: [string, Record<string, unknown>][] = [
    ['a missing basis', withoutBasis()],
    ['an unknown basis', quote({ observedAtBasis: 'MEASURED' })],
    ['a lowercase basis', quote({ observedAtBasis: 'provider' })],
    ['PROVIDER with a conventionId', quote({ conventionId: CONVENTION })],
    ['PUBLICATION_CONVENTION without a conventionId', quote({ observedAtBasis: 'PUBLICATION_CONVENTION' })],
    [
      'PUBLICATION_CONVENTION with an empty conventionId',
      quote({ observedAtBasis: 'PUBLICATION_CONVENTION', conventionId: '' }),
    ],
    [
      'a conventionId starting with a separator',
      quote({ observedAtBasis: 'PUBLICATION_CONVENTION', conventionId: '-ECB' }),
    ],
    [
      'a conventionId with a space',
      quote({ observedAtBasis: 'PUBLICATION_CONVENTION', conventionId: 'ECB PUB' }),
    ],
    [
      'a conventionId longer than 64 characters',
      quote({ observedAtBasis: 'PUBLICATION_CONVENTION', conventionId: `E${'x'.repeat(64)}` }),
    ],
    ['a non-string conventionId', quote({ observedAtBasis: 'PUBLICATION_CONVENTION', conventionId: 1 })],
    ['a non-string basis', quote({ observedAtBasis: 1 })],
  ];

  it.each(invalid)(
    '%s is rejected inside the operation, not retried, and counted',
    async (_name, payload) => {
      const provider = fakeProvider(() => okResult(payload));
      const { rate, h } = fxSetup(provider, { maxRetries: 3, failureThreshold: 2 });
      expect(errorOf(await rate('EUR'))).toEqual({
        code: 'FX_UNAVAILABLE',
        message: 'FX rate EURUSD is unavailable (INVALID_RESPONSE).',
        currency: 'EUR',
        cause: 'INVALID_RESPONSE',
      });
      expect(provider.calls).toHaveLength(1);
      expect(h.rc.status(fxCircuitKey('fake-fx'))).toMatchObject({
        circuit: 'CLOSED',
        lastErrorCode: 'INVALID_RESPONSE',
      });
      await rate('EUR');
      expect(h.rc.status(fxCircuitKey('fake-fx'))).toMatchObject({ circuit: 'OPEN' });
      expect(errorOf(await rate('EUR'))).toMatchObject({
        cause: 'PROVIDER_ERROR',
        providerCode: 'CIRCUIT_OPEN',
      });
      expect(provider.calls).toHaveLength(2);
    },
  );

  it('the conventionId pattern boundaries: 64 characters accepted, 65 rejected; dots, dashes, underscores allowed', () => {
    expect(CONVENTION_ID_PATTERN.test(`E${'x'.repeat(63)}`)).toBe(true);
    expect(CONVENTION_ID_PATTERN.test(`E${'x'.repeat(64)}`)).toBe(false);
    expect(CONVENTION_ID_PATTERN.test('a.b-c_D9')).toBe(true);
    expect(CONVENTION_ID_PATTERN.test(CONVENTION)).toBe(true);
    expect(CONVENTION_ID_PATTERN.test('_x')).toBe(false);
    expect(CONVENTION_ID_PATTERN.test('x/y')).toBe(false);
  });
});
