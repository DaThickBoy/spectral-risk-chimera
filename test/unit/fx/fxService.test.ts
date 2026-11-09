// Task 10.1: FxService (design: FX rules 1 to 12).
// Tests: AT-FX-01, AT-FX-02, AT-FX-03, AT-FX-04, AT-FX-06 (FX service part), AT-FX-08, AT-FX-09,
// AT-AUD-03 (in-memory FX part). Hand-calculated expected values are written out in the tests.
// Validates: Requirements 22.3, 30.1, 30.2, 30.3, 30.4, 30.5, 30.7, 30.8
import { describe, expect, it } from 'vitest';
import { FixtureFxProvider, createFxService, fxCircuitKey } from '../../../src/fx/index.js';
import type { FxError, FxProvider, FxRateUsed } from '../../../src/fx/index.js';
import { LosslessJsonNumber } from '../../../src/shared/index.js';
import type { ResilientCall, Result } from '../../../src/shared/index.js';
import {
  AS_OF,
  AT,
  BASE,
  MAX_AGE_SECONDS,
  SUPPORTED,
  fakeProvider,
  fxSetup,
  minusMs,
  okResult,
  plusMs,
  providerFailure,
  quote,
} from '../../helpers/fx.js';
import { harness } from '../../helpers/resilience.js';

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

const returning = (q: Record<string, unknown>) => fakeProvider(() => okResult(q));

const MAX_AGE_MS = MAX_AGE_SECONDS * 1000;

describe('AT-FX-01: the base currency is the identity rate', () => {
  it('returns exactly "1" with source BASE_CURRENCY, kind IDENTITY, no timestamp, and no provider call', async () => {
    const provider = returning(quote());
    const { rate } = fxSetup(provider);
    expect(value(await rate(BASE))).toEqual({
      kind: 'IDENTITY',
      pair: 'USDUSD',
      rate: '1',
      observedAt: null,
      source: 'BASE_CURRENCY',
      sourceKind: 'IDENTITY',
      status: 'CURRENT',
    });
    expect(provider.calls).toEqual([]);
  });

  it('is identical for any as-of date and calculation time (nothing time-dependent is fabricated)', async () => {
    const { rate } = fxSetup(returning(quote()));
    const a = value(await rate(BASE, '2020-01-01', '2020-01-01T00:00:00.000Z'));
    const b = value(await rate(BASE, AS_OF, AT));
    expect(a).toEqual(b);
  });
});

describe('AT-FX-02: direct and inverse quotes give Rate(X/B)', () => {
  it('canonicalizes a direct quote: EUR->USD "1.0850" is "1.085"', async () => {
    const { rate } = fxSetup(returning(quote({ rate: '1.0850' })));
    expect(value(await rate('EUR'))).toMatchObject({ pair: 'EURUSD', rate: '1.085' });
  });

  it.each([
    // Hand-calculated: 1 / 0.8 = 1.25 exactly.
    ['0.8', '1.25'],
    // 1 / 1 = 1.
    ['1', '1'],
    // 1 / 3 = 0.333..., 40 significant digits.
    ['3', `0.${'3'.repeat(40)}`],
    // 1 / 150 = 0.00666..., 40 significant digits, the last rounded half up.
    ['150', `0.00${'6'.repeat(39)}7`],
    // 1 / 1.25 = 0.8 exactly; non-canonical input text is accepted.
    ['1.2500', '0.8'],
  ])('converts an inverse USD->X quote %s into %s with one Decimal division', async (text, expected) => {
    const provider = returning(quote({ from: 'USD', to: 'EUR', rate: text }));
    const { rate } = fxSetup(provider);
    const used = value(await rate('EUR'));
    // The requested pair and the inverted rate, never the quote orientation.
    expect(used).toMatchObject({ kind: 'OBSERVED', pair: 'EURUSD', rate: expected });
  });

  it('asks the provider for (currency, base, asOf, at) exactly', async () => {
    const provider = returning(quote());
    const { rate } = fxSetup(provider);
    await rate('EUR');
    expect(provider.calls).toEqual([['EUR', 'USD', AS_OF, AT]]);
  });

  it('accepts a LosslessJsonNumber rate by its exact source text', async () => {
    const { rate } = fxSetup(returning(quote({ rate: new LosslessJsonNumber('1.0850') })));
    expect(value(await rate('EUR')).rate).toBe('1.085');
  });
});

describe('AT-FX-03: a missing rate is FX_UNAVAILABLE with no substitution', () => {
  it.each([
    ['HTTP_CLIENT_ERROR', 404, 'HTTP_CLIENT_ERROR'],
    ['NETWORK_ERROR', undefined, 'NETWORK_ERROR'],
    ['TIMEOUT', undefined, 'TIMEOUT'],
    ['TLS_ERROR', undefined, 'TLS_ERROR'],
    ['INVALID_RESPONSE', undefined, 'INVALID_RESPONSE'],
    ['RATE_LIMITED', undefined, 'RATE_LIMITED'],
    ['HTTP_SERVER_ERROR', 503, 'HTTP_SERVER_ERROR'],
    ['CANCELLED', undefined, 'UNEXPECTED_ERROR'],
    ['CIRCUIT_OPEN', undefined, 'UNEXPECTED_ERROR'],
    ['UNEXPECTED_ERROR', undefined, 'UNEXPECTED_ERROR'],
  ] as const)('provider %s gives PROVIDER_ERROR (%s) with code %s', async (code, status, expected) => {
    const { rate } = fxSetup(fakeProvider(() => providerFailure(code, status)));
    const error = errorOf(await rate('EUR'));
    expect(error).toEqual({
      code: 'FX_UNAVAILABLE',
      message: 'FX rate EURUSD is unavailable (PROVIDER_ERROR).',
      currency: 'EUR',
      cause: 'PROVIDER_ERROR',
      providerCode: expected,
    });
    expect(error).not.toHaveProperty('lastValid');
  });

  it('a throwing provider or a non-Result return is UNEXPECTED_ERROR', async () => {
    const throwing = fxSetup(
      fakeProvider(() => {
        throw new Error('boom');
      }),
    );
    expect(errorOf(await throwing.rate('EUR'))).toMatchObject({ providerCode: 'UNEXPECTED_ERROR' });
    const garbage = fxSetup(fakeProvider(() => 'not a result'));
    expect(errorOf(await garbage.rate('EUR'))).toMatchObject({ providerCode: 'UNEXPECTED_ERROR' });
    const noError = fxSetup(fakeProvider(() => ({ ok: false, error: null })));
    expect(errorOf(await noError.rate('EUR'))).toMatchObject({ providerCode: 'UNEXPECTED_ERROR' });
  });

  it('a real AbortSignal cancellation stays CANCELLED, without a provider call', async () => {
    // FxService takes no signal (design signature); a wrapper passes an aborted caller signal through.
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const cancelling: ResilientCall = {
      run: (providerKey, operation, fn, opts) =>
        h.rc.run(providerKey, operation, fn, { ...opts, signal: controller.signal }),
      status: (providerKey) => h.rc.status(providerKey),
    };
    const provider = returning(quote());
    const service = createFxService({
      provider,
      resilientCall: cancelling,
      baseCurrency: BASE,
      supportedCurrencies: SUPPORTED,
      maxRateAgeSeconds: MAX_AGE_SECONDS,
    });
    expect(errorOf(await service.rateToBase('EUR', AS_OF, AT))).toMatchObject({
      cause: 'PROVIDER_ERROR',
      providerCode: 'CANCELLED',
    });
    expect(provider.calls).toEqual([]);
  });

  it('provider-returned CANCELLED is unexpected and not retried; a real attempt timeout stays TIMEOUT', async () => {
    const cancelled = fakeProvider(() => providerFailure('CANCELLED'));
    const once = fxSetup(cancelled, { maxRetries: 3 });
    expect(errorOf(await once.rate('EUR'))).toMatchObject({ providerCode: 'UNEXPECTED_ERROR' });
    expect(cancelled.calls).toHaveLength(1);
    // A provider that never answers: ResilientCall aborts the attempt signal and classifies TIMEOUT.
    const hanging = fakeProvider(() => new Promise(() => undefined));
    const timed = fxSetup(hanging, { maxRetries: 0 });
    expect(errorOf(await timed.rate('EUR'))).toMatchObject({
      cause: 'PROVIDER_ERROR',
      providerCode: 'TIMEOUT',
    });
  });

  it('never triangulates: a missing EUR/USD is unavailable even when EUR/GBP and GBP/USD exist', async () => {
    const provider = new FixtureFxProvider({
      name: 'demo-fx',
      rates: [
        { from: 'EUR', to: 'GBP', rate: '0.85', observedAt: minusMs(AT, 60_000) },
        { from: 'GBP', to: 'USD', rate: '1.27', observedAt: minusMs(AT, 60_000) },
      ],
    });
    const { rate } = fxSetup(provider);
    expect(errorOf(await rate('EUR'))).toMatchObject({
      cause: 'PROVIDER_ERROR',
      providerCode: 'HTTP_CLIENT_ERROR',
    });
  });
});

describe('ResilientCall integration (FX rule 4)', () => {
  it('retries a retryable failure and then uses the single successful rate', async () => {
    let calls = 0;
    const provider = fakeProvider(() => {
      calls += 1;
      return calls === 1 ? providerFailure('NETWORK_ERROR') : okResult(quote());
    });
    const { rate } = fxSetup(provider, { maxRetries: 1 });
    expect(value(await rate('EUR')).rate).toBe('1.085');
    expect(provider.calls).toHaveLength(2);
  });

  it('does not retry a 404, and reports the circuit under fx:<provider name>', async () => {
    const provider = fakeProvider(() => providerFailure('HTTP_CLIENT_ERROR', 404));
    const { rate, h } = fxSetup(provider, { maxRetries: 3 });
    await rate('EUR');
    expect(provider.calls).toHaveLength(1);
    expect(h.rc.status(fxCircuitKey('fake-fx'))).toMatchObject({
      provider: 'fx:fake-fx',
      lastErrorCode: 'HTTP_CLIENT_ERROR',
    });
  });

  it('an open circuit gives CIRCUIT_OPEN without calling the provider', async () => {
    const provider = fakeProvider(() => providerFailure('NETWORK_ERROR'));
    const { rate } = fxSetup(provider, { failureThreshold: 2 });
    await rate('EUR');
    await rate('EUR');
    const before = provider.calls.length;
    expect(errorOf(await rate('EUR'))).toMatchObject({ providerCode: 'CIRCUIT_OPEN' });
    expect(provider.calls).toHaveLength(before);
  });
});

describe('Circuit accounting for invalid provider data (FX rule 4a, task 8.2)', () => {
  const invalidPayloads: [string, Record<string, unknown> | string][] = [
    ['schema (exponent rate)', quote({ rate: '1e0' })],
    ['pair', quote({ from: 'EUR', to: 'GBP' })],
    ['provenance (source)', quote({ source: 'other-fx' })],
    ['provenance (source kind)', quote({ sourceKind: 'DEMO' })],
    ['selection bound (after `at`)', quote({ observedAt: plusMs(AT, 1) })],
    ['non-object value', 'garbage'],
  ];

  it.each(invalidPayloads)(
    'invalid %s is not retried and counts toward the circuit',
    async (_name, payload) => {
      const provider = fakeProvider(() => okResult(payload));
      const { rate, h } = fxSetup(provider, { maxRetries: 3, failureThreshold: 2 });
      expect(errorOf(await rate('EUR'))).toMatchObject({ cause: 'INVALID_RESPONSE' });
      expect(provider.calls).toHaveLength(1);
      expect(h.rc.status(fxCircuitKey('fake-fx'))).toMatchObject({
        circuit: 'CLOSED',
        lastErrorCode: 'INVALID_RESPONSE',
      });
      expect(errorOf(await rate('EUR'))).toMatchObject({ cause: 'INVALID_RESPONSE' });
      expect(h.rc.status(fxCircuitKey('fake-fx'))).toMatchObject({ circuit: 'OPEN', state: 'UNAVAILABLE' });
      expect(errorOf(await rate('EUR'))).toMatchObject({
        cause: 'PROVIDER_ERROR',
        providerCode: 'CIRCUIT_OPEN',
      });
      expect(provider.calls).toHaveLength(2);
    },
  );

  it('a stale but valid rate is not a provider failure: it does not count toward the circuit', async () => {
    const provider = returning(quote({ observedAt: minusMs(AT, MAX_AGE_MS + 1) }));
    const { rate, h } = fxSetup(provider, { failureThreshold: 1 });
    expect(errorOf(await rate('EUR')).code).toBe('FX_STALE');
    expect(errorOf(await rate('EUR')).code).toBe('FX_STALE');
    expect(h.rc.status(fxCircuitKey('fake-fx'))).toMatchObject({ circuit: 'CLOSED' });
  });

  it('a provider-reported INVALID_RESPONSE stays PROVIDER_ERROR (attributed to the provider)', async () => {
    const { rate } = fxSetup(fakeProvider(() => providerFailure('INVALID_RESPONSE')));
    expect(errorOf(await rate('EUR'))).toMatchObject({
      cause: 'PROVIDER_ERROR',
      providerCode: 'INVALID_RESPONSE',
    });
  });
});

describe('AT-FX-04: staleness against the calculation timestamp (strict >)', () => {
  it('a rate exactly maxRateAgeSeconds old is fresh', async () => {
    const { rate } = fxSetup(returning(quote({ observedAt: minusMs(AT, MAX_AGE_MS) })));
    expect(value(await rate('EUR'))).toMatchObject({ status: 'CURRENT' });
  });

  it('one millisecond older is FX_STALE with a display-only StaleFxRate', async () => {
    const observedAt = minusMs(AT, MAX_AGE_MS + 1);
    const { rate } = fxSetup(returning(quote({ observedAt, from: 'USD', to: 'EUR', rate: '0.8' })));
    expect(errorOf(await rate('EUR'))).toEqual({
      code: 'FX_STALE',
      message: 'FX rate EURUSD is older than the maximum rate age.',
      currency: 'EUR',
      displayRate: {
        kind: 'STALE_DISPLAY',
        pair: 'EURUSD',
        rate: '1.25',
        observedAt,
        observedAtBasis: 'PROVIDER',
        source: 'fake-fx',
        sourceKind: 'REAL',
        status: 'STALE',
      },
    });
  });

  it('a stale DEMO rate is FX_STALE, not DEMO (freshness is checked for every source kind)', async () => {
    const provider = new FixtureFxProvider({
      name: 'demo-fx',
      rates: [{ from: 'EUR', to: 'USD', rate: '1.08', observedAt: minusMs(AT, MAX_AGE_MS + 1) }],
    });
    const { rate } = fxSetup(provider);
    expect(errorOf(await rate('EUR'))).toMatchObject({
      code: 'FX_STALE',
      displayRate: { sourceKind: 'DEMO', status: 'STALE' },
    });
  });

  it('staleness uses `at`, not the as-of date: Friday 16:00 is stale on Monday with 86,400 s (OD-6 note)', async () => {
    const friday = '2026-11-06T16:00:00.000Z';
    const { rate } = fxSetup(returning(quote({ observedAt: friday })));
    expect(errorOf(await rate('EUR', '2026-11-06', '2026-11-09T09:00:00.000Z')).code).toBe('FX_STALE');
  });
});

describe('Status of fresh rates (FX rule 8)', () => {
  it('a fresh REAL rate is CURRENT and a fresh DEMO rate is DEMO, with provenance recorded (AT-FX-09, AT-AUD-03)', async () => {
    const real = fxSetup(returning(quote()));
    expect(value(await real.rate('EUR'))).toEqual({
      kind: 'OBSERVED',
      pair: 'EURUSD',
      rate: '1.085',
      observedAt: minusMs(AT, 3_600_000),
      observedAtBasis: 'PROVIDER',
      source: 'fake-fx',
      sourceKind: 'REAL',
      status: 'CURRENT',
    });
    const demo = fxSetup(
      new FixtureFxProvider({
        name: 'demo-fx',
        rates: [{ from: 'EUR', to: 'USD', rate: '1.08', observedAt: minusMs(AT, 1) }],
      }),
    );
    expect(value(await demo.rate('EUR'))).toMatchObject({
      source: 'demo-fx',
      sourceKind: 'DEMO',
      status: 'DEMO',
    });
  });
});

describe('AT-FX-06 (FX service part): unsupported currencies', () => {
  it.each(['CHF', 'XYZ'])(
    '%s is FX_UNAVAILABLE (UNSUPPORTED_CURRENCY) without a provider call',
    async (currency) => {
      const provider = returning(quote());
      const { rate } = fxSetup(provider);
      expect(errorOf(await rate(currency))).toEqual({
        code: 'FX_UNAVAILABLE',
        message: `FX rate ${currency}USD is unavailable (UNSUPPORTED_CURRENCY).`,
        currency,
        cause: 'UNSUPPORTED_CURRENCY',
      });
      expect(provider.calls).toEqual([]);
    },
  );
});

describe('AT-FX-08: selection bound observedAt <= min(end of asOf UTC, at)', () => {
  it('accepts a rate observed exactly at `at`, rejects one a millisecond later', async () => {
    expect(value(await fxSetup(returning(quote({ observedAt: AT }))).rate('EUR')).observedAt).toBe(AT);
    const late = fxSetup(returning(quote({ observedAt: plusMs(AT, 1) })));
    expect(errorOf(await late.rate('EUR'))).toMatchObject({ cause: 'INVALID_RESPONSE' });
  });

  it('accepts 23:59:59.999Z of the as-of date and rejects 00:00:00.000Z of the next day', async () => {
    const at = '2026-11-07T08:00:00.000Z';
    const endOfDay = fxSetup(returning(quote({ observedAt: '2026-11-06T23:59:59.999Z' })));
    expect(value(await endOfDay.rate('EUR', '2026-11-06', at)).observedAt).toBe('2026-11-06T23:59:59.999Z');
    const nextDay = fxSetup(returning(quote({ observedAt: '2026-11-07T00:00:00.000Z' })));
    expect(errorOf(await nextDay.rate('EUR', '2026-11-06', at))).toMatchObject({ cause: 'INVALID_RESPONSE' });
  });

  it('is deterministic: identical inputs give identical, frozen results', async () => {
    const provider = new FixtureFxProvider({
      name: 'demo-fx',
      rates: [
        { from: 'EUR', to: 'USD', rate: '1.07', observedAt: minusMs(AT, 7_200_000) },
        { from: 'EUR', to: 'USD', rate: '1.08', observedAt: minusMs(AT, 3_600_000) },
        // After the end of the as-of date: the provider never returns it.
        { from: 'EUR', to: 'USD', rate: '1.09', observedAt: '2026-11-07T09:00:00.000Z' },
      ],
    });
    const { rate } = fxSetup(provider);
    const first = value(await rate('EUR'));
    const second = value(await rate('EUR'));
    expect(first).toEqual(second);
    expect(first.rate).toBe('1.08');
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('an intraday `at` reaches the provider: the latest rate not after `at` is used', async () => {
    const provider = new FixtureFxProvider({
      name: 'demo-fx',
      rates: [
        { from: 'EUR', to: 'USD', rate: '1.08', observedAt: minusMs(AT, 3_600_000) },
        { from: 'EUR', to: 'USD', rate: '1.09', observedAt: plusMs(AT, 3_600_000) },
      ],
    });
    const { rate } = fxSetup(provider);
    expect(value(await rate('EUR'))).toMatchObject({ rate: '1.08', observedAt: minusMs(AT, 3_600_000) });
  });

  it('the service validates the bound itself: a provider that ignores `at` is rejected, not corrected', async () => {
    // fakeProvider applies no bound; FX rule 6 rejects the later rate and rule 10 forbids substitution.
    const provider = returning(quote({ observedAt: plusMs(AT, 3_600_000) }));
    const { rate } = fxSetup(provider);
    expect(errorOf(await rate('EUR'))).toEqual({
      code: 'FX_UNAVAILABLE',
      message: 'FX rate EURUSD is unavailable (INVALID_RESPONSE).',
      currency: 'EUR',
      cause: 'INVALID_RESPONSE',
    });
    expect(provider.calls).toHaveLength(1);
  });
});

describe('Validation and provenance (FX rule 5): FX_UNAVAILABLE (INVALID_RESPONSE)', () => {
  const cases: [string, Record<string, unknown> | unknown][] = [
    ['a pair that is neither direct nor inverse', quote({ from: 'EUR', to: 'GBP' })],
    ['exponent notation', quote({ rate: '1e0' })],
    ['a zero rate', quote({ rate: '0' })],
    ['a negative rate', quote({ rate: '-1.08' })],
    ['a JavaScript number', quote({ rate: 1.08 })],
    ['a thousands separator', quote({ rate: '1,080' })],
    ['NaN text', quote({ rate: 'NaN' })],
    ['an unknown field', quote({ extra: 'x' })],
    ['a timestamp without milliseconds', quote({ observedAt: '2026-11-06T15:00:00Z' })],
    ['a timestamp with an offset', quote({ observedAt: '2026-11-06T15:00:00.000+01:00' })],
    ['an unknown currency code', quote({ from: 'XYZ' })],
    ['a source other than the provider name', quote({ source: 'other-fx' })],
    ['a source kind other than the provider kind', quote({ sourceKind: 'DEMO' })],
    [
      'a missing source',
      (() => {
        const q = quote();
        delete q['source'];
        return q;
      })(),
    ],
    ['a non-object', 'garbage'],
  ];

  it.each(cases)('%s', async (_name, payload) => {
    const { rate } = fxSetup(fakeProvider(() => okResult(payload)));
    expect(errorOf(await rate('EUR'))).toEqual({
      code: 'FX_UNAVAILABLE',
      message: 'FX rate EURUSD is unavailable (INVALID_RESPONSE).',
      currency: 'EUR',
      cause: 'INVALID_RESPONSE',
    });
  });

  it('a REAL provider returning DEMO provenance is rejected, and the reverse', async () => {
    const demoProvider = fakeProvider(() => okResult(quote({ sourceKind: 'REAL' })), { kind: 'DEMO' });
    expect(errorOf(await fxSetup(demoProvider).rate('EUR'))).toMatchObject({ cause: 'INVALID_RESPONSE' });
  });
});

describe('Arguments and construction (FX rule 3)', () => {
  it.each([
    ['a lowercase currency', 'eur', AS_OF, AT],
    ['a four-letter currency', 'EURO', AS_OF, AT],
    ['an impossible as-of date', 'EUR', '2026-02-30', AT],
    ['a timestamp as-of date', 'EUR', '2026-11-06T00:00:00.000Z', AT],
    ['`at` without milliseconds', 'EUR', AS_OF, '2026-11-06T16:00:00Z'],
    ['`at` with an offset', 'EUR', AS_OF, '2026-11-06T16:00:00.000+00:00'],
  ])('throws TypeError for %s, before any provider call', async (_name, currency, asOf, at) => {
    const provider = returning(quote());
    const { service } = fxSetup(provider);
    await expect(service.rateToBase(currency, asOf, at)).rejects.toThrow(TypeError);
    expect(provider.calls).toEqual([]);
  });

  const valid = {
    provider: returning(quote()) as FxProvider,
    resilientCall: harness().rc,
    baseCurrency: BASE,
    supportedCurrencies: SUPPORTED,
    maxRateAgeSeconds: MAX_AGE_SECONDS,
  };

  it.each([
    ['a base currency outside the supported list', { baseCurrency: 'CHF' }],
    ['an unknown base currency', { baseCurrency: 'XYZ' }],
    ['duplicate supported currencies', { supportedCurrencies: ['USD', 'USD'] }],
    ['maxRateAgeSeconds 0', { maxRateAgeSeconds: 0 }],
    ['fractional maxRateAgeSeconds', { maxRateAgeSeconds: 1.5 }],
    ['a provider without a kind', { provider: { name: 'x', getRate: (): undefined => undefined } }],
    [
      'a provider with an empty name',
      { provider: { name: '', kind: 'REAL', getRate: (): undefined => undefined } },
    ],
    ['no ResilientCall', { resilientCall: {} }],
  ])('createFxService throws TypeError for %s', (_name, override) => {
    expect(() => createFxService({ ...valid, ...override } as never)).toThrow(TypeError);
  });
});

describe('Display-only stale rates never become FxRateUsed (FX rule 7)', () => {
  it('a StaleFxRate is not assignable to FxRateUsed', () => {
    const stale = {
      kind: 'STALE_DISPLAY',
      pair: 'EURUSD',
      rate: '1.08',
      observedAt: AT,
      observedAtBasis: 'PROVIDER',
      source: 'fake-fx',
      sourceKind: 'REAL',
      status: 'STALE',
    } as const;
    // @ts-expect-error A display-only stale rate must never type-check as a rate used in a calculation.
    const used: FxRateUsed = stale;
    expect(used.kind).toBe('STALE_DISPLAY');
  });
});
