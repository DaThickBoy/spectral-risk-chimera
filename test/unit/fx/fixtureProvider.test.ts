// Task 10.1 (decision F14): in-code DEMO fixture FX provider.
// Validates: Requirements 30.3, 30.7, 22.3
import { describe, expect, it } from 'vitest';
import { FixtureFxProvider } from '../../../src/fx/index.js';
import type { ProviderFxRate } from '../../../src/fx/index.js';
import type { ProviderError, Result } from '../../../src/shared/index.js';

/** A calculation timestamp after the end of 2026-11-06, so the end of that day is the bound. */
const LATE = '2026-11-07T12:00:00.000Z';

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  from: 'EUR',
  to: 'USD',
  rate: '1.0850',
  observedAt: '2026-11-06T15:00:00.000Z',
  ...overrides,
});

const provider = (rates: readonly unknown[]): FixtureFxProvider =>
  new FixtureFxProvider({ name: 'demo-fx', rates });

function value(result: Result<ProviderFxRate, ProviderError>): ProviderFxRate {
  if (!result.ok) {
    throw new Error(`expected a rate, got ${result.error.code}`);
  }
  return result.value;
}

function errorOf(result: Result<ProviderFxRate, ProviderError>): ProviderError {
  if (result.ok) {
    throw new Error('expected an error');
  }
  return result.error;
}

describe('FixtureFxProvider', () => {
  it('is always DEMO and labels every rate with its own name and kind, keeping the exact rate text', async () => {
    const p = provider([entry()]);
    expect(p.kind).toBe('DEMO');
    expect(value(await p.getRate('EUR', 'USD', '2026-11-06', LATE))).toEqual({
      from: 'EUR',
      to: 'USD',
      rate: '1.0850',
      observedAt: '2026-11-06T15:00:00.000Z',
      observedAtBasis: 'PROVIDER',
      source: 'demo-fx',
      sourceKind: 'DEMO',
    });
  });

  it('returns the latest rate observed no later than the end of asOf (UTC) when `at` is later', async () => {
    const p = provider([
      entry({ rate: '1.01', observedAt: '2026-11-05T15:00:00.000Z' }),
      entry({ rate: '1.02', observedAt: '2026-11-06T23:59:59.999Z' }),
      entry({ rate: '1.03', observedAt: '2026-11-07T00:00:00.000Z' }),
    ]);
    expect(value(await p.getRate('EUR', 'USD', '2026-11-06', LATE)).rate).toBe('1.02');
    expect(value(await p.getRate('EUR', 'USD', '2026-11-05', LATE)).rate).toBe('1.01');
  });

  it('returns the latest rate observed no later than `at` when `at` is within the as-of date', async () => {
    const p = provider([
      entry({ rate: '1.01', observedAt: '2026-11-06T09:00:00.000Z' }),
      entry({ rate: '1.02', observedAt: '2026-11-06T12:00:00.000Z' }),
      entry({ rate: '1.03', observedAt: '2026-11-06T12:00:00.001Z' }),
    ]);
    expect(value(await p.getRate('EUR', 'USD', '2026-11-06', '2026-11-06T12:00:00.000Z')).rate).toBe('1.02');
    expect(value(await p.getRate('EUR', 'USD', '2026-11-06', '2026-11-06T11:59:59.999Z')).rate).toBe('1.01');
  });

  it('answers with a stored inverse orientation unchanged (the service inverts it)', async () => {
    const p = provider([entry({ from: 'USD', to: 'EUR', rate: '0.92' })]);
    expect(value(await p.getRate('EUR', 'USD', '2026-11-06', LATE))).toMatchObject({
      from: 'USD',
      to: 'EUR',
      rate: '0.92',
    });
  });

  it('two equally latest candidates are ambiguous: INVALID_RESPONSE, never an arbitrary pick', async () => {
    const p = provider([entry({ rate: '1.08' }), entry({ from: 'USD', to: 'EUR', rate: '0.92' })]);
    expect(errorOf(await p.getRate('EUR', 'USD', '2026-11-06', LATE))).toMatchObject({
      code: 'INVALID_RESPONSE',
      provider: 'demo-fx',
      operation: 'getRate',
      retryable: false,
    });
  });

  it('no candidate is HTTP_CLIENT_ERROR 404 (no other pair is substituted)', async () => {
    const p = provider([entry({ from: 'GBP' }), entry({ observedAt: '2026-11-08T00:00:00.000Z' })]);
    expect(errorOf(await p.getRate('EUR', 'USD', '2026-11-06', LATE))).toMatchObject({
      code: 'HTTP_CLIENT_ERROR',
      httpStatus: 404,
    });
    // Only rates after `at` exist: also 404.
    const later = provider([entry({ observedAt: '2026-11-06T15:00:00.000Z' })]);
    expect(
      errorOf(await later.getRate('EUR', 'USD', '2026-11-06', '2026-11-06T14:59:59.999Z')).httpStatus,
    ).toBe(404);
  });

  it.each([
    ['exponent notation', entry({ rate: '1e0' })],
    ['a JavaScript number', entry({ rate: 1.08 })],
    ['a zero rate', entry({ rate: '0' })],
    ['an unknown field', entry({ source: 'x' })],
    ['a timestamp without milliseconds', entry({ observedAt: '2026-11-06T15:00:00Z' })],
    ['a non-object', null],
  ])('any malformed entry (%s) makes the call INVALID_RESPONSE', async (_name, bad) => {
    const p = provider([entry(), bad]);
    expect(errorOf(await p.getRate('EUR', 'USD', '2026-11-06', LATE)).code).toBe('INVALID_RESPONSE');
  });

  it('throws TypeError for invalid arguments and options', () => {
    const p = provider([entry()]);
    expect(() => p.getRate('eur', 'USD', '2026-11-06', LATE)).toThrow(TypeError);
    expect(() => p.getRate('EUR', 'US', '2026-11-06', LATE)).toThrow(TypeError);
    expect(() => p.getRate('EUR', 'USD', '2026-02-30', LATE)).toThrow(TypeError);
    expect(() => p.getRate('EUR', 'USD', '2026-11-06', '2026-11-07T12:00:00Z')).toThrow(TypeError);
    expect(() => p.getRate('EUR', 'USD', '2026-11-06', '2026-11-07T12:00:00.000+00:00')).toThrow(TypeError);
    expect(() => new FixtureFxProvider({ name: '', rates: [] })).toThrow(TypeError);
    expect(() => new FixtureFxProvider({ name: 'x', rates: 'no' as never })).toThrow(TypeError);
  });

  it('later changes to the input array do not change its data', async () => {
    const rates: unknown[] = [entry()];
    const p = provider(rates);
    rates.push(entry({ rate: '9', observedAt: '2026-11-06T16:00:00.000Z' }));
    expect(value(await p.getRate('EUR', 'USD', '2026-11-06', LATE)).rate).toBe('1.0850');
  });
});
