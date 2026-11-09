// Test helpers for task 10.1 (FX). Settings are TEST values: `fx.maxRateAgeSeconds` is still
// open (OD-6), so 86,400 here is a test choice only, never an approved value.
import { createFxService } from '../../src/fx/index.js';
import type { FxProvider, FxService } from '../../src/fx/index.js';
import { appError } from '../../src/shared/index.js';
import type { ProviderError, ProviderErrorCode } from '../../src/shared/index.js';
import { drive, harness } from './resilience.js';
import type { Harness } from './resilience.js';

export const BASE = 'USD';
export const SUPPORTED = ['USD', 'EUR', 'GBP', 'JPY'] as const;
/** TEST value (OD-6 open). */
export const MAX_AGE_SECONDS = 86_400;
export const AS_OF = '2026-11-06';
export const AT = '2026-11-06T16:00:00.000Z';

/** `at` minus `ms` milliseconds, as an IsoUtcMillis string. */
export const minusMs = (at: string, ms: number): string => new Date(Date.parse(at) - ms).toISOString();
export const plusMs = (at: string, ms: number): string => new Date(Date.parse(at) + ms).toISOString();

export type Responder = (from: string, to: string, asOf: string, at: string) => unknown;

export interface FakeFxProvider extends FxProvider {
  readonly calls: [string, string, string, string][];
}

/**
 * A provider whose `getRate` returns whatever `respond` returns (or throws). It
 * applies no selection bound itself, so tests can feed the service out-of-bound data.
 */
export function fakeProvider(
  respond: Responder,
  identity: { name?: string; kind?: 'REAL' | 'DEMO' } = {},
): FakeFxProvider {
  const calls: [string, string, string, string][] = [];
  return {
    name: identity.name ?? 'fake-fx',
    kind: identity.kind ?? 'REAL',
    calls,
    getRate: async (from, to, asOf, at) => {
      calls.push([from, to, asOf, at]);
      return respond(from, to, asOf, at) as never;
    },
  };
}

/** A provider-shaped rate for EUR -> USD from `fake-fx` (REAL), observed one hour before AT. */
export function quote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from: 'EUR',
    to: 'USD',
    rate: '1.0850',
    observedAt: minusMs(AT, 3_600_000),
    observedAtBasis: 'PROVIDER',
    source: 'fake-fx',
    sourceKind: 'REAL',
    ...overrides,
  };
}

export const okResult = (value: unknown): { ok: true; value: unknown } => ({ ok: true, value });

export function providerFailure(
  code: ProviderErrorCode,
  httpStatus?: number,
): { ok: false; error: ProviderError } {
  return {
    ok: false,
    error: {
      ...appError(code, `Provider call fake-fx getRate failed (${code}).`),
      provider: 'fake-fx',
      operation: 'getRate',
      attempts: 1,
      retryable: false,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    },
  };
}

export interface FxSetup {
  readonly h: Harness;
  readonly service: FxService;
  /** Runs `rateToBase` to completion under the fake clock. */
  readonly rate: (currency: string, asOf?: string, at?: string) => ReturnType<FxService['rateToBase']>;
}

export function fxSetup(
  provider: FxProvider,
  options: { maxRetries?: number; failureThreshold?: number; maxRateAgeSeconds?: number } = {},
): FxSetup {
  const h = harness(
    { maxRetries: options.maxRetries ?? 0 },
    { failureThreshold: options.failureThreshold ?? 5 },
  );
  const service = createFxService({
    provider,
    resilientCall: h.rc,
    baseCurrency: BASE,
    supportedCurrencies: SUPPORTED,
    maxRateAgeSeconds: options.maxRateAgeSeconds ?? MAX_AGE_SECONDS,
  });
  return {
    h,
    service,
    rate: (currency, asOf = AS_OF, at = AT) => drive(h.sleeper, service.rateToBase(currency, asOf, at)),
  };
}
