// AT-FX-13, AT-FX-14, AT-FX-15 (counting part is in the FxService integration test), AT-FX-16:
// the ECB FX adapter over a recording fake transport and recorded ECB responses
// (test/fixtures/fx/ecb/, Source: ECB statistics.). No network access.
// Validates: Requirements 30.3, 30.7, 30.13, 24.8, 25.7
import { describe, expect, it } from 'vitest';
import {
  ECB_CONVENTION_ID,
  ECB_ENDPOINT,
  createEcbFxProvider,
  ecbQueryUrl,
} from '../../../../src/adapters/index.js';
import type { EcbTransport } from '../../../../src/adapters/index.js';
import { ECB_SOURCE_NAME } from '../../../../src/fx/index.js';
import type { AttemptOutcome } from '../../../../src/shared/index.js';
import { csvOk, recorded, recordedTransport, recordingTransport } from '../../../helpers/ecb.js';

const FRIDAY = '2026-11-06';
const AFTER = '2026-11-06T16:00:00.000Z';

function provider(
  transport: EcbTransport,
  overrides: { cacheMaxEntries?: number; supported?: string[] } = {},
) {
  return createEcbFxProvider({
    transport,
    supportedCurrencies: overrides.supported ?? ['USD', 'GBP'],
    maxResponseBytes: 1_048_576,
    cacheMaxEntries: overrides.cacheMaxEntries ?? 8,
  });
}

const live = (): AbortSignal => new AbortController().signal;

type Deferred = {
  readonly promise: Promise<AttemptOutcome<never>>;
  resolve: (value: unknown) => void;
};
function deferred(): Deferred {
  let resolve: (value: unknown) => void = () => undefined;
  const promise = new Promise<AttemptOutcome<never>>((r) => {
    resolve = r as (value: unknown) => void;
  });
  return { promise, resolve };
}

describe('AT-FX-13: one fixed request over the TLS transport with the attempt signal', () => {
  it('builds the fixed query for all supported currencies, sorted', () => {
    expect(ecbQueryUrl(['USD', 'GBP'], FRIDAY)).toBe(
      'https://data-api.ecb.europa.eu/service/data/EXR/D.GBP+USD.EUR.SP00.A?endPeriod=2026-11-06&lastNObservations=2&detail=dataonly&format=csvdata',
    );
    expect(ECB_ENDPOINT).toBe('https://data-api.ecb.europa.eu/service/data/EXR/');
  });

  it('identity, URL, Accept header, size limit, and the caller signal reach the transport', async () => {
    const t = recordedTransport();
    const p = provider(t.transport);
    expect([p.name, p.kind]).toEqual([ECB_SOURCE_NAME, 'REAL']);
    const signal = live();
    const result = await p.getRate('USD', 'EUR', FRIDAY, AFTER, signal);
    expect(result.ok).toBe(true);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({
      url: ecbQueryUrl(['GBP', 'USD'], FRIDAY),
      headers: { Accept: 'text/csv' },
      maxBytes: 1_048_576,
    });
    // The shared request has its own controller, aborted only when every caller left (AT-FX-16).
    expect(t.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(t.calls[0]?.signal.aborted).toBe(false);
  });

  it('one request serves every currency of the same (asOf, at); another at is a new request', async () => {
    const t = recordedTransport();
    const p = provider(t.transport);
    await p.getRate('USD', 'EUR', FRIDAY, AFTER, live());
    await p.getRate('GBP', 'EUR', FRIDAY, AFTER, live());
    expect(t.calls).toHaveLength(1);
    await p.getRate('GBP', 'EUR', FRIDAY, '2026-11-06T16:00:00.001Z', live());
    expect(t.calls).toHaveLength(2);
  });
});

describe('AT-FX-14: convention instant, selection bound, and published quote', () => {
  it('returns the published EUR -> X quote with the convention basis and provenance', async () => {
    const p = provider(recordedTransport().transport);
    expect(await p.getRate('USD', 'EUR', FRIDAY, AFTER, live())).toEqual({
      ok: true,
      value: {
        from: 'EUR',
        to: 'USD',
        rate: '1.1165',
        observedAt: '2026-11-06T15:00:00.000Z',
        observedAtBasis: 'PUBLICATION_CONVENTION',
        conventionId: ECB_CONVENTION_ID,
        referenceDate: '2026-11-06', // OD-20: the ECB reference date of the published row
        source: ECB_SOURCE_NAME,
        sourceKind: 'REAL',
      },
    });
  });

  it('a rate is never used before its convention instant (CET: 15:00Z)', async () => {
    const p = provider(recordedTransport().transport);
    const before = await p.getRate('GBP', 'EUR', FRIDAY, '2026-11-06T14:59:59.999Z', live());
    expect(before.ok && [before.value.rate, before.value.observedAt]).toEqual([
      '0.83393',
      '2026-11-05T15:00:00.000Z',
    ]);
    const at = await p.getRate('GBP', 'EUR', FRIDAY, '2026-11-06T15:00:00.000Z', live());
    expect(at.ok && at.value.rate).toBe('0.83415');
  });

  it('across the end of summer time: Friday 23 October is 14:00Z (CEST), Monday 26 October 15:00Z (CET)', async () => {
    const p = provider(recordedTransport().transport);
    const early = await p.getRate('USD', 'EUR', '2026-10-26', '2026-10-26T14:59:59.999Z', live());
    expect(early.ok && [early.value.rate, early.value.observedAt]).toEqual([
      '1.1193',
      '2026-10-23T14:00:00.000Z',
    ]);
    const late = await p.getRate('USD', 'EUR', '2026-10-26', '2026-10-26T15:00:00.000Z', live());
    expect(late.ok && [late.value.rate, late.value.observedAt]).toEqual([
      '1.1188',
      '2026-10-26T15:00:00.000Z',
    ]);
  });

  it('a weekend asOf selects Friday; a holiday gap selects the last published day', async () => {
    const p = provider(recordedTransport().transport);
    const saturday = await p.getRate('USD', 'EUR', '2026-11-07', '2026-11-07T12:00:00.000Z', live());
    expect(saturday.ok && saturday.value.observedAt).toBe('2026-11-06T15:00:00.000Z');
    const christmas = await p.getRate('USD', 'EUR', '2025-12-29', '2025-12-29T09:00:00.000Z', live());
    expect(christmas.ok && [christmas.value.rate, christmas.value.observedAt]).toEqual([
      '1.1787',
      '2025-12-24T15:00:00.000Z',
    ]);
  });

  it('no row within the bound is HTTP_CLIENT_ERROR 404 (nothing older is invented)', async () => {
    const t = recordingTransport(() =>
      csvOk(
        'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\r\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-11-06,1.1165\r\n',
      ),
    );
    const p = provider(t.transport);
    const missingGbp = await p.getRate('GBP', 'EUR', FRIDAY, AFTER, live());
    expect(missingGbp).toMatchObject({ ok: false, error: { code: 'HTTP_CLIENT_ERROR', httpStatus: 404 } });
    const tooEarly = await p.getRate('USD', 'EUR', FRIDAY, '2026-11-06T14:00:00.000Z', live());
    expect(tooEarly).toMatchObject({ ok: false, error: { code: 'HTTP_CLIENT_ERROR', httpStatus: 404 } });
  });

  it('no triangulation and no unsupported currency: 404 without a request', async () => {
    const t = recordedTransport();
    const p = provider(t.transport);
    for (const [from, to] of [
      ['USD', 'GBP'],
      ['JPY', 'EUR'],
      ['EUR', 'EUR'],
    ] as const) {
      expect(await p.getRate(from, to, FRIDAY, AFTER, live())).toMatchObject({
        ok: false,
        error: {
          code: 'HTTP_CLIENT_ERROR',
          httpStatus: 404,
          provider: ECB_SOURCE_NAME,
          operation: 'getRate',
        },
      });
    }
    expect(t.calls).toHaveLength(0);
    const none = provider(t.transport, { supported: [] });
    expect((await none.getRate('USD', 'EUR', FRIDAY, AFTER, live())).ok).toBe(false);
    expect(t.calls).toHaveLength(0);
  });

  it('answers the (EUR, X) orientation with the same published quote', async () => {
    const p = provider(recordedTransport().transport);
    const result = await p.getRate('EUR', 'USD', FRIDAY, AFTER, live());
    expect(result.ok && [result.value.from, result.value.to, result.value.rate]).toEqual([
      'EUR',
      'USD',
      '1.1165',
    ]);
  });

  it('throws TypeError for programmer errors before any request', () => {
    const t = recordedTransport();
    const p = provider(t.transport);
    expect(() => p.getRate('usd', 'EUR', FRIDAY, AFTER, live())).toThrow(TypeError);
    expect(() => p.getRate('USD', 'EUR', '2026-11-31', AFTER, live())).toThrow(TypeError);
    expect(() => p.getRate('USD', 'EUR', FRIDAY, '2026-11-06T16:00:00Z', live())).toThrow(TypeError);
    expect(() => p.getRate('USD', 'EUR', FRIDAY, AFTER, undefined as never)).toThrow(TypeError);
    expect(() => provider(t.transport, { supported: ['USD', 'EUR'] })).toThrow(TypeError);
    expect(() => provider(t.transport, { supported: ['USD', 'USD'] })).toThrow(TypeError);
    expect(() => provider(t.transport, { cacheMaxEntries: 0 })).toThrow(TypeError);
    expect(t.calls).toHaveLength(0);
  });
});

describe('errors keep their classification; messages carry no URL or body', () => {
  it.each([
    [{ ok: false, failure: 'NETWORK' }, 'NETWORK_ERROR', undefined, true],
    [{ ok: false, failure: 'TIMEOUT' }, 'TIMEOUT', undefined, true],
    [{ ok: false, failure: 'TLS' }, 'TLS_ERROR', undefined, false],
    [{ ok: false, failure: 'INVALID_RESPONSE' }, 'INVALID_RESPONSE', undefined, false],
    [{ ok: false, failure: 'HTTP', status: 429, retryAfter: '5' }, 'RATE_LIMITED', 429, true],
    [{ ok: false, failure: 'HTTP', status: 404 }, 'HTTP_CLIENT_ERROR', 404, false],
    [{ ok: false, failure: 'HTTP', status: 504 }, 'HTTP_SERVER_ERROR', 504, true],
  ] as const)('%j -> %s', async (outcome, code, httpStatus, retryable) => {
    const p = provider(recordingTransport(() => outcome as AttemptOutcome<never>).transport);
    const result = await p.getRate('USD', 'EUR', FRIDAY, AFTER, live());
    expect(result).toMatchObject({ ok: false, error: { code, retryable, provider: ECB_SOURCE_NAME } });
    if (!result.ok) {
      expect(result.error.httpStatus).toBe(httpStatus);
      expect(result.error.message).not.toMatch(/https?:|data-api|EXR\.D/);
    }
  });

  it('a malformed body is INVALID_RESPONSE and is not cached', async () => {
    let calls = 0;
    const t = recordingTransport(() => {
      calls += 1;
      return calls === 1
        ? csvOk('not,a,valid,ecb,response\r\n')
        : csvOk(recorded('exr-gbp-usd-2026-11-06.csv'));
    });
    const p = provider(t.transport);
    expect(await p.getRate('USD', 'EUR', FRIDAY, AFTER, live())).toMatchObject({
      ok: false,
      error: { code: 'INVALID_RESPONSE' },
    });
    expect((await p.getRate('USD', 'EUR', FRIDAY, AFTER, live())).ok).toBe(true);
    expect(t.calls).toHaveLength(2);
  });

  it('a wrong Content-Type is INVALID_RESPONSE', async () => {
    const t = recordingTransport(() => csvOk(recorded('exr-gbp-usd-2026-11-06.csv'), 'text/html'));
    expect(await provider(t.transport).getRate('USD', 'EUR', FRIDAY, AFTER, live())).toMatchObject({
      ok: false,
      error: { code: 'INVALID_RESPONSE' },
    });
  });
});

describe('AT-FX-16: bounded cache and independent cancellation', () => {
  it('the cache holds at most cacheMaxEntries completed responses (least recently used evicted)', async () => {
    const t = recordedTransport();
    const p = provider(t.transport, { cacheMaxEntries: 2 });
    const at = (n: number) => `2026-11-06T16:00:00.00${n}Z`;
    await p.getRate('USD', 'EUR', FRIDAY, at(1), live());
    await p.getRate('USD', 'EUR', FRIDAY, at(2), live());
    await p.getRate('USD', 'EUR', FRIDAY, at(1), live()); // hit; at(1) becomes most recent
    expect(t.calls).toHaveLength(2);
    await p.getRate('USD', 'EUR', FRIDAY, at(3), live()); // evicts at(2)
    await p.getRate('USD', 'EUR', FRIDAY, at(1), live()); // still cached
    expect(t.calls).toHaveLength(3);
    await p.getRate('USD', 'EUR', FRIDAY, at(2), live()); // evicted: new request
    expect(t.calls).toHaveLength(4);
  });

  it('cached responses are frozen', async () => {
    const t = recordedTransport();
    const p = provider(t.transport);
    const first = await p.getRate('USD', 'EUR', FRIDAY, AFTER, live());
    expect(first.ok && Object.isFrozen(first.value)).toBe(true);
  });

  it('cancelling one of two callers does not cancel the other or the shared request', async () => {
    const gate = deferred();
    const t = recordingTransport(() => gate.promise);
    const p = provider(t.transport);
    const first = new AbortController();
    const a = p.getRate('USD', 'EUR', FRIDAY, AFTER, first.signal);
    const b = p.getRate('GBP', 'EUR', FRIDAY, AFTER, live());
    expect(t.calls).toHaveLength(1);
    first.abort();
    expect(await a).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    expect(t.calls[0]?.signal.aborted).toBe(false);
    gate.resolve(csvOk(recorded('exr-gbp-usd-2026-11-06.csv')));
    const resultB = await b;
    expect(resultB.ok && resultB.value.rate).toBe('0.83415');
  });

  it('when every caller abandons the request it is aborted, not cached, and the next call starts a new one', async () => {
    const gate = deferred();
    let calls = 0;
    const t = recordingTransport(() => {
      calls += 1;
      return calls === 1 ? gate.promise : csvOk(recorded('exr-gbp-usd-2026-11-06.csv'));
    });
    const p = provider(t.transport);
    const one = new AbortController();
    const two = new AbortController();
    const a = p.getRate('USD', 'EUR', FRIDAY, AFTER, one.signal);
    const b = p.getRate('GBP', 'EUR', FRIDAY, AFTER, two.signal);
    one.abort();
    expect(t.calls[0]?.signal.aborted).toBe(false);
    two.abort();
    expect(t.calls[0]?.signal.aborted).toBe(true);
    expect((await a).ok).toBe(false);
    expect((await b).ok).toBe(false);
    // The aborted request completes late: its body must not be cached.
    gate.resolve(csvOk(recorded('exr-gbp-usd-2026-11-06.csv')));
    await new Promise((resolve) => setImmediate(resolve));
    const again = await p.getRate('USD', 'EUR', FRIDAY, AFTER, live());
    expect(again.ok).toBe(true);
    expect(t.calls).toHaveLength(2);
  });

  it('an already aborted signal is TIMEOUT without a request', async () => {
    const t = recordedTransport();
    const controller = new AbortController();
    controller.abort();
    expect(await provider(t.transport).getRate('USD', 'EUR', FRIDAY, AFTER, controller.signal)).toMatchObject(
      {
        ok: false,
        error: { code: 'TIMEOUT' },
      },
    );
    expect(t.calls).toHaveLength(0);
  });

  it('failed responses are never cached', async () => {
    let calls = 0;
    const t = recordingTransport(() => {
      calls += 1;
      return calls === 1
        ? { ok: false, failure: 'HTTP', status: 504 }
        : csvOk(recorded('exr-gbp-usd-2026-11-06.csv'));
    });
    const p = provider(t.transport);
    expect((await p.getRate('USD', 'EUR', FRIDAY, AFTER, live())).ok).toBe(false);
    expect((await p.getRate('USD', 'EUR', FRIDAY, AFTER, live())).ok).toBe(true);
    expect(t.calls).toHaveLength(2);
  });
});
