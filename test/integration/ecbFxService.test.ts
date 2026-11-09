// AT-FX-19, AT-FX-15 (circuit part), AT-FX-14 (bound part), AT-FX-18 (view-model attribution
// part, H2): FxService over the ECB adapter with recorded ECB responses
// (test/fixtures/fx/ecb/, Source: ECB statistics.) and the real ResilientCall. No network access.
// fx.maxRateAgeSeconds values here are TEST values (the demo value is not approved, H3/OD-6).
// Validates: Requirements 30.3, 30.4, 30.7, 30.8, 30.13, 30.14, 25.8
import { describe, expect, it } from 'vitest';
import { ECB_CONVENTION_ID, createEcbFxProvider } from '../../src/adapters/index.js';
import type { EcbTransport } from '../../src/adapters/index.js';
import { ECB_SOURCE_NAME, createFxService, fxAttribution } from '../../src/fx/index.js';
import type { FxError, FxRateUsed } from '../../src/fx/index.js';
import type { Result } from '../../src/shared/index.js';
import { csvOk, recordedTransport, recordingTransport } from '../helpers/ecb.js';
import { roundSignificant } from '../helpers/positionReference.js';
import { equalFractions, fraction, parseDecimalText } from '../helpers/rational.js';
import { drive, harness } from '../helpers/resilience.js';

const DAY = 86_400;

function setup(transport: EcbTransport, maxRateAgeSeconds = DAY, failureThreshold = 5) {
  const h = harness({ maxRetries: 0 }, { failureThreshold });
  const provider = createEcbFxProvider({
    transport,
    supportedCurrencies: ['GBP', 'USD'],
    maxResponseBytes: 1_048_576,
    cacheMaxEntries: 16,
  });
  const service = createFxService({
    provider,
    resilientCall: h.rc,
    baseCurrency: 'EUR',
    supportedCurrencies: ['EUR', 'GBP', 'USD'],
    maxRateAgeSeconds,
    attemptTimeoutMs: 10_000,
  });
  return {
    h,
    rate: (currency: string, asOf: string, at: string): Promise<Result<FxRateUsed, FxError>> =>
      drive(h.sleeper, service.rateToBase(currency, asOf, at)),
  };
}

/** The exact 40-significant-digit ROUND_HALF_UP inverse of a published decimal (BigInt reference). */
const inverseOf = (published: string) => {
  const q = parseDecimalText(published);
  return roundSignificant(fraction(q.den, q.num));
};

describe('AT-FX-19: recorded ECB responses through FxService, including inverse conversion', () => {
  it.each([
    ['USD', '1.1165'],
    ['GBP', '0.83415'],
  ])('Rate(%s/EUR) is the exact inverse of the published EUR->%s value', async (currency, published) => {
    const { rate } = setup(recordedTransport().transport);
    const result = await rate(currency, '2026-11-06', '2026-11-06T16:00:00.000Z');
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== 'OBSERVED') return;
    expect(equalFractions(parseDecimalText(result.value.rate), inverseOf(published))).toBe(true);
    expect(result.value).toMatchObject({
      pair: `${currency}EUR`,
      observedAt: '2026-11-06T15:00:00.000Z',
      observedAtBasis: 'PUBLICATION_CONVENTION',
      conventionId: ECB_CONVENTION_ID,
      source: ECB_SOURCE_NAME,
      sourceKind: 'REAL',
      status: 'CURRENT',
    });
  });

  it('known answer: Rate(USD/EUR) = 1 / 1.1165 to 40 significant digits', async () => {
    const { rate } = setup(recordedTransport().transport);
    const result = await rate('USD', '2026-11-06', '2026-11-06T16:00:00.000Z');
    // 1 / 1.1165 = 2000 / 2233 = 0.89565606806986117330944917151813703537841...; computed by
    // BigInt long division, rounded half up to 40 significant digits (the 41st digit is 1).
    expect(result.ok && result.value.rate).toBe('0.8956560680698611733094491715181370353784');
  });

  it('EUR is the identity rate and makes no request', async () => {
    const t = recordedTransport();
    const { rate } = setup(t.transport);
    expect(await rate('EUR', '2026-11-06', '2026-11-06T16:00:00.000Z')).toMatchObject({
      ok: true,
      value: { kind: 'IDENTITY', rate: '1', sourceKind: 'IDENTITY' },
    });
    expect(t.calls).toHaveLength(0);
  });

  it('all currencies of one calculation share one HTTP request', async () => {
    const t = recordedTransport();
    const { rate } = setup(t.transport);
    await rate('USD', '2026-11-06', '2026-11-06T16:00:00.000Z');
    await rate('GBP', '2026-11-06', '2026-11-06T16:00:00.000Z');
    expect(t.calls).toHaveLength(1);
  });
});

describe('AT-FX-13 (signal part): the attempt signal and fx.ecb.timeoutMs reach the transport', () => {
  it('a hanging request is aborted at the ECB attempt timeout, not the shared provider timeout', async () => {
    const t = recordingTransport(() => new Promise(() => undefined));
    const h = harness({ maxRetries: 0, attemptTimeoutMs: 10_000 }, {});
    const service = createFxService({
      provider: createEcbFxProvider({
        transport: t.transport,
        supportedCurrencies: ['USD'],
        maxResponseBytes: 1_048_576,
        cacheMaxEntries: 4,
      }),
      resilientCall: h.rc,
      baseCurrency: 'EUR',
      supportedCurrencies: ['EUR', 'USD'],
      maxRateAgeSeconds: DAY,
      attemptTimeoutMs: 500,
    });
    const started = h.clock.monotonicMs();
    const result = await drive(
      h.sleeper,
      service.rateToBase('USD', '2026-11-06', '2026-11-06T16:00:00.000Z'),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'FX_UNAVAILABLE', cause: 'PROVIDER_ERROR', providerCode: 'TIMEOUT' },
    });
    expect(h.clock.monotonicMs() - started).toBe(500);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.signal.aborted).toBe(true);
  });
});

describe('AT-FX-18 (data part): attribution of ECB rates (H2)', () => {
  it('every ECB rate used for the EUR base is DERIVED_INVERSE from the published EUR->X rate', async () => {
    const { rate } = setup(recordedTransport().transport);
    const result = await rate('USD', '2026-11-06', '2026-11-06T16:00:00.000Z');
    expect(result.ok && fxAttribution(result.value)).toEqual({
      statement: 'Source: ECB statistics.',
      derivation: 'DERIVED_INVERSE',
      publishedPair: 'EURUSD',
      referenceDate: '2026-11-06',
      method: 'DECIMAL_INVERSE',
      precision: { significantDigits: 40, rounding: 'ROUND_HALF_UP' },
      notes: [
        'Derived by inverting the published ECB euro reference rate (1 / EUR->X); not identical to the published reference rate.',
        'The ECB euro foreign exchange reference rates are published for information purposes only.',
      ],
    });
  });
});

describe('AT-FX-15 (circuit part): malformed ECB CSV counts toward the circuit breaker', () => {
  it('after failureThreshold malformed responses the circuit opens and no request is made', async () => {
    const t = recordingTransport(() => csvOk('KEY,FREQ\r\nbroken\r\n'));
    const { rate, h } = setup(t.transport, DAY, 2);
    const at = (n: number) => `2026-11-06T16:00:00.00${n}Z`;
    // The adapter classifies the body as INVALID_RESPONSE; FxService reports the provider's code.
    const rejected = {
      ok: false,
      error: { code: 'FX_UNAVAILABLE', cause: 'PROVIDER_ERROR', providerCode: 'INVALID_RESPONSE' },
    };
    expect(await rate('USD', '2026-11-06', at(1))).toMatchObject(rejected);
    expect(await rate('USD', '2026-11-06', at(2))).toMatchObject(rejected);
    expect(h.rc.status(`fx:${ECB_SOURCE_NAME}`).circuit).toBe('OPEN');
    expect(await rate('USD', '2026-11-06', at(3))).toMatchObject({
      ok: false,
      error: { code: 'FX_UNAVAILABLE', cause: 'PROVIDER_ERROR', providerCode: 'CIRCUIT_OPEN' },
    });
    expect(t.calls).toHaveLength(2);
  });

  it('an HTTP 504 (observed live during recording) is FX_UNAVAILABLE with no rate', async () => {
    const t = recordingTransport(() => ({ ok: false, failure: 'HTTP', status: 504 }));
    const { rate } = setup(t.transport);
    expect(await rate('USD', '2026-11-06', '2026-11-06T16:00:00.000Z')).toMatchObject({
      ok: false,
      error: { code: 'FX_UNAVAILABLE', cause: 'PROVIDER_ERROR', providerCode: 'HTTP_SERVER_ERROR' },
    });
  });
});

describe('staleness boundaries with ECB publication times (FX rule 7, strict)', () => {
  // Friday 2026-11-06 rate: convention instant 15:00:00.000Z.
  it('exactly maxRateAgeSeconds old is CURRENT; one millisecond more is FX_STALE with a display-only rate', async () => {
    const { rate } = setup(recordedTransport().transport, DAY);
    expect(await rate('USD', '2026-11-07', '2026-11-07T15:00:00.000Z')).toMatchObject({
      ok: true,
      value: { status: 'CURRENT', observedAt: '2026-11-06T15:00:00.000Z' },
    });
    expect(await rate('USD', '2026-11-07', '2026-11-07T15:00:00.001Z')).toMatchObject({
      ok: false,
      error: { code: 'FX_STALE', displayRate: { status: 'STALE', kind: 'STALE_DISPLAY' } },
    });
  });

  it('weekend: with 86,400 s the Friday rate is stale from Saturday 15:00Z; with 259,200 s it is current until Monday 15:00Z', async () => {
    const short = setup(recordedTransport().transport, DAY);
    expect((await short.rate('USD', '2026-11-07', '2026-11-07T23:59:59.999Z')).ok).toBe(false);
    const threeDays = setup(recordedTransport().transport, 3 * DAY);
    expect((await threeDays.rate('USD', '2026-11-07', '2026-11-07T23:59:59.999Z')).ok).toBe(true);
  });

  it('holiday gap: on Monday 29 December 2025 before 15:00Z the latest rate is 24 December (age > 4 days)', async () => {
    const at = '2025-12-29T14:59:59.999Z';
    const fourDays = setup(recordedTransport().transport, 4 * DAY);
    expect(await fourDays.rate('USD', '2025-12-29', at)).toMatchObject({
      ok: false,
      error: { code: 'FX_STALE' },
    });
    const fiveDays = setup(recordedTransport().transport, 5 * DAY);
    expect(await fiveDays.rate('USD', '2025-12-29', at)).toMatchObject({
      ok: true,
      value: { observedAt: '2025-12-24T15:00:00.000Z' },
    });
  });

  it('Easter: on Tuesday 7 April 2026 before 14:00Z (CEST) the latest rate is 2 April', async () => {
    const at = '2026-04-07T13:59:59.999Z';
    const { rate } = setup(recordedTransport().transport, 5 * DAY);
    expect(await rate('GBP', '2026-04-07', at)).toMatchObject({
      ok: true,
      value: { observedAt: '2026-04-02T14:00:00.000Z' },
    });
    const short = setup(recordedTransport().transport, 4 * DAY);
    expect(await short.rate('GBP', '2026-04-07', at)).toMatchObject({
      ok: false,
      error: { code: 'FX_STALE' },
    });
  });
});
