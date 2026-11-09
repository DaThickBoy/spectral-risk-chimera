// Task 19.2: SecClient.getText with a scripted transport, fake public DNS, FakeClock, and
// FakeSleeper (no real time or network).
// Validates: Requirements 6.6, 6.7, 6.8, 25.2, 29.8, 29.9, 29.10, 29.14, 33.6
import { describe, expect, it } from 'vitest';
import type { SecError, SecResponse } from '../../../src/sec/index.js';
import type { Result } from '../../../src/shared/index.js';
import { drive } from '../../helpers/resilience.js';
import { LIMITS, TEST_USER_AGENT, ok200, redirect, secHarness } from '../../helpers/secClient.js';
import type { Reply, SecHarness } from '../../helpers/secClient.js';

const URL_A = 'https://www.sec.gov/Archives/edgar/data/PRIVATEPATH/a.htm?q=TOKEN123';

const get = (h: SecHarness, url = URL_A, opts?: Parameters<SecHarness['client']['getText']>[1]) =>
  drive(h.sleeper, h.client.getText(url, opts));

function errorOf(result: Result<SecResponse, SecError>): SecError {
  if (result.ok) {
    throw new Error('expected an error result');
  }
  return result.error;
}

/** Replies by index, the last one repeating. */
const sequence =
  (...replies: Reply[]) =>
  (_request: unknown, index: number): Reply =>
    replies[Math.min(index, replies.length - 1)] ?? ok200();

describe('getText: pinned request', () => {
  it('sends exactly the four headers to the pinned addresses and returns raw bytes', async () => {
    const h = secHarness({ reply: () => ({ status: 200, contentType: 'text/html', body: 'caf\u00e9' }) });
    const result = await get(h);
    expect(result).toEqual({
      ok: true,
      value: {
        status: 200,
        contentType: 'text/html',
        body: new TextEncoder().encode('caf\u00e9'),
        finalUrl: URL_A,
      },
    });
    expect(result.ok && result.value.body).toBeInstanceOf(Uint8Array);
    expect(h.transport.requests).toEqual([
      {
        at: 0,
        hostname: 'www.sec.gov',
        addresses: ['8.8.8.8', '8.8.4.4', '2001:4860:4860::8888'],
        path: '/Archives/edgar/data/PRIVATEPATH/a.htm?q=TOKEN123',
        headers: {
          Host: 'www.sec.gov',
          'User-Agent': TEST_USER_AGENT,
          'Accept-Encoding': 'identity',
          Connection: 'close',
        },
        maxBytes: LIMITS.maxResponseBytes,
      },
    ]);
    expect(h.sink.events).toEqual([]);
  });

  it('a guard rejection of the input sends nothing and reports the guard result', async () => {
    const h = secHarness();
    const error = errorOf(await get(h, 'http://www.sec.gov/x'));
    expect(error).toMatchObject({
      code: 'SEC_URL_REJECTED',
      reason: 'NOT_HTTPS',
      securityEvent: 'RECORDED',
      attempts: 0,
    });
    expect(h.resolver.calls).toEqual([]);
    expect(h.transport.requests).toEqual([]);
  });

  it('a prohibited resolved address sends nothing (no fallback to another address)', async () => {
    const h = secHarness({
      dns: {
        'www.sec.gov': [{ status: 'RECORDS', addresses: ['8.8.8.8', '10.0.0.1'] }, { status: 'NO_DATA' }],
      },
    });
    const error = errorOf(await get(h));
    expect(error).toMatchObject({ code: 'SEC_URL_REJECTED', reason: 'ADDRESS_PROHIBITED' });
    expect(h.transport.requests).toEqual([]);
  });
});

describe('AT-SEC-17: missing or unusable SEC_USER_AGENT blocks SEC retrieval', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['without a contact email', 'SpectralRiskChimera/1.0'],
    ['with a line break', 'Spectral\r\nX: y test-contact@example.invalid'],
    ['with non-ASCII text', 'Spectr\u00e4l test-contact@example.invalid'],
  ])('%s gives SEC_CONFIG_MISSING with no side effect', async (_label, userAgent) => {
    const h = secHarness({ userAgent });
    const error = errorOf(await get(h));
    expect(error).toEqual({
      code: 'SEC_CONFIG_MISSING',
      message: 'SEC request failed (SEC_CONFIG_MISSING).',
      attempts: 0,
    });
    expect(h.resolver.calls).toEqual([]);
    expect(h.sink.events).toEqual([]);
    expect(h.transport.requests).toEqual([]);
  });
});

describe('per-call options may only lower the configured limits', () => {
  it.each([
    ['a non-object', 'x'],
    ['null', null],
    ['an array', []],
    ['an unknown key', { maxBytes: 10, extra: 1 }],
    ['maxBytes 0', { maxBytes: 0 }],
    ['negative maxBytes', { maxBytes: -1 }],
    ['fractional timeoutMs', { timeoutMs: 1.5 }],
    ['string maxBytes', { maxBytes: '10' }],
    ['maxBytes above the configured limit', { maxBytes: LIMITS.maxResponseBytes + 1 }],
    ['timeoutMs above the configured limit', { timeoutMs: LIMITS.timeoutMs + 1 }],
  ])('%s throws TypeError before any side effect', async (_label, opts) => {
    const h = secHarness({ userAgent: undefined });
    await expect(h.client.getText(URL_A, opts as never)).rejects.toThrow(TypeError);
    expect(h.resolver.calls).toEqual([]);
    expect(h.sink.events).toEqual([]);
    expect(h.transport.requests).toEqual([]);
  });

  it('lower values apply: maxBytes reaches the transport and timeoutMs shortens the deadline', async () => {
    const h = secHarness({ reply: () => 'HANG' });
    const error = errorOf(await get(h, URL_A, { maxBytes: 10, timeoutMs: 5_000 }));
    expect(error).toMatchObject({ code: 'SEC_TIMEOUT', attempts: 1 });
    expect(h.transport.requests[0]?.maxBytes).toBe(10);
    expect(h.clock.monotonicMs()).toBe(5_000);
  });

  it('values equal to the configured limits are accepted', async () => {
    const h = secHarness();
    const result = await get(h, URL_A, { maxBytes: LIMITS.maxResponseBytes, timeoutMs: LIMITS.timeoutMs });
    expect(result.ok).toBe(true);
  });
});

describe('AT-SEC-10, AT-SEC-11, AT-SEC-12: every redirect hop is validated and resolved again', () => {
  it('follows 301, 302, 303, 307, and 308, validating and resolving each hop', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const h = secHarness({
        reply: sequence(redirect('https://data.sec.gov/submissions/x.json', status), ok200('final')),
      });
      const result = await get(h);
      expect(result.ok && result.value.finalUrl).toBe('https://data.sec.gov/submissions/x.json');
      expect(h.transport.requests.map((r) => [r.hostname, r.path, r.addresses])).toEqual([
        [
          'www.sec.gov',
          '/Archives/edgar/data/PRIVATEPATH/a.htm?q=TOKEN123',
          ['8.8.8.8', '8.8.4.4', '2001:4860:4860::8888'],
        ],
        ['data.sec.gov', '/submissions/x.json', ['1.1.1.1']],
      ]);
      expect(h.resolver.calls.map((c) => c.hostname)).toEqual([
        'www.sec.gov',
        'www.sec.gov',
        'data.sec.gov',
        'data.sec.gov',
      ]);
    }
  });

  it.each([
    ['a non-SEC host (AT-SEC-10)', 'https://evil.example/LEAKME', 'HOST_NOT_ALLOWED'],
    ['a look-alike host (AT-SEC-10)', 'https://www.sec.gov.example.com/LEAKME', 'HOST_NOT_ALLOWED'],
    ['HTTP (AT-SEC-12)', 'http://www.sec.gov/LEAKME', 'NOT_HTTPS'],
    ['credentials', 'https://user:pw@www.sec.gov/LEAKME', 'CREDENTIALS_PRESENT'],
    ['a scheme-relative empty userinfo', '//@www.sec.gov/LEAKME', 'CREDENTIALS_PRESENT'],
    ['a scheme-relative other host', '//evil.example/LEAKME', 'HOST_NOT_ALLOWED'],
    ['a backslash scheme-relative host', '\\\\evil.example/LEAKME', 'HOST_NOT_ALLOWED'],
    ['another port', 'https://www.sec.gov:8443/LEAKME', 'PORT_NOT_ALLOWED'],
    ['a relative reference with an empty fragment', '/LEAKME#', 'FRAGMENT_PRESENT'],
    ['an IP literal', 'https://127.0.0.1/LEAKME', 'IP_LITERAL'],
    ['an unparseable absolute URL', 'https://[::1/LEAKME', 'MALFORMED_URL'],
  ])('a redirect to %s is SEC_URL_REJECTED and nothing is sent to it', async (_label, location, reason) => {
    const h = secHarness({ reply: sequence(redirect(location), ok200()) });
    const error = errorOf(await get(h));
    expect(error).toMatchObject({ code: 'SEC_URL_REJECTED', reason, securityEvent: 'RECORDED', attempts: 1 });
    expect(h.transport.requests).toHaveLength(1);
    expect(h.sink.events).toHaveLength(1);
    expect(JSON.stringify([error, h.sink.events, h.logs])).not.toContain('LEAKME');
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['private', '10.1.2.3'],
    ['cloud metadata', '169.254.169.254'],
  ])(
    'AT-SEC-11: a redirect to a host resolving to a %s address is rejected before any request',
    async (_label, address) => {
      const h = secHarness({
        dns: { 'data.sec.gov': [{ status: 'RECORDS', addresses: [address] }, { status: 'NO_DATA' }] },
        reply: sequence(redirect('https://data.sec.gov/x'), ok200()),
      });
      const error = errorOf(await get(h));
      expect(error).toMatchObject({ code: 'SEC_URL_REJECTED', reason: 'ADDRESS_PROHIBITED', attempts: 1 });
      expect(h.transport.requests.map((r) => r.hostname)).toEqual(['www.sec.gov']);
      expect(h.sink.events[0]).toMatchObject({ prohibitedAddresses: [address], hostname: 'data.sec.gov' });
    },
  );

  it('resolves a relative Location against the current hop', async () => {
    const h = secHarness({ reply: sequence(redirect('../b.htm?x=1'), ok200()) });
    const result = await get(h);
    expect(result.ok && result.value.finalUrl).toBe('https://www.sec.gov/Archives/edgar/data/b.htm?x=1');
  });

  it('AT-SEC-12: follows exactly sec.maxRedirects redirects; the next one aborts without processing its Location', async () => {
    const chain =
      (n: number) =>
      (_r: unknown, index: number): Reply =>
        index < n ? redirect(`https://www.sec.gov/hop/${index}`) : ok200();
    const atLimit = secHarness({ reply: chain(3) });
    expect((await get(atLimit)).ok).toBe(true);
    expect(atLimit.transport.requests).toHaveLength(4);

    const above = secHarness({
      reply: (_r, index) =>
        redirect(index === 3 ? 'http://evil.example/LEAKME' : `https://www.sec.gov/hop/${index}`),
    });
    const error = errorOf(await get(above));
    expect(error).toEqual({
      code: 'SEC_TOO_MANY_REDIRECTS',
      message: 'SEC request failed (SEC_TOO_MANY_REDIRECTS).',
      attempts: 4,
      reason: 'REDIRECT_LIMIT',
    });
    expect(above.transport.requests).toHaveLength(4);
    // The fourth Location was never validated: no security event, no extra DNS query.
    expect(above.sink.events).toEqual([]);
    expect(above.resolver.calls).toHaveLength(8);
  });

  it.each([
    ['a self-redirect', [URL_A]],
    ['a two-hop loop', ['https://data.sec.gov/x', URL_A]],
    [
      'a loop through a normalized form',
      ['https://WWW.SEC.GOV:443/Archives/edgar/data/PRIVATEPATH/a.htm?q=TOKEN123'],
    ],
  ])('detects %s before any DNS query or request to the repeated URL', async (_label, locations) => {
    const h = secHarness({ reply: (_r, index) => redirect(locations[index] ?? 'https://www.sec.gov/never') });
    const error = errorOf(await get(h));
    expect(error).toMatchObject({ code: 'SEC_TOO_MANY_REDIRECTS', reason: 'REDIRECT_LOOP' });
    expect(h.transport.requests).toHaveLength(locations.length);
    expect(h.resolver.calls).toHaveLength(locations.length * 2);
    expect(h.sink.events).toEqual([]);
  });

  it.each([
    ['300', { status: 300, locations: ['https://www.sec.gov/x'] }],
    ['304', { status: 304, locations: ['https://www.sec.gov/x'] }],
    ['a 302 without Location', { status: 302 }],
    [
      'a 302 with two Location values',
      { status: 302, locations: ['https://www.sec.gov/x', 'https://www.sec.gov/y'] },
    ],
  ] as const)('%s is an invalid response, not retried', async (_label, reply) => {
    const h = secHarness({ reply: () => reply });
    const error = errorOf(await get(h));
    expect(error).toMatchObject({ code: 'SEC_UNAVAILABLE', cause: 'INVALID_RESPONSE', attempts: 1 });
    expect(h.transport.requests).toHaveLength(1);
  });
});

describe('AT-SEC-13: oversized response', () => {
  it('TOO_LARGE is SEC_RESPONSE_TOO_LARGE and is not retried', async () => {
    const h = secHarness({ reply: () => ({ failure: 'TOO_LARGE' }) });
    const error = errorOf(await get(h));
    expect(error).toEqual({
      code: 'SEC_RESPONSE_TOO_LARGE',
      message: 'SEC request failed (SEC_RESPONSE_TOO_LARGE).',
      attempts: 1,
      cause: 'INVALID_RESPONSE',
    });
    expect(h.transport.requests).toHaveLength(1);
  });

  it('a plain invalid response stays SEC_UNAVAILABLE', async () => {
    const h = secHarness({ reply: () => ({ failure: 'INVALID_RESPONSE' }) });
    expect(errorOf(await get(h))).toMatchObject({ code: 'SEC_UNAVAILABLE', cause: 'INVALID_RESPONSE' });
  });
});

describe('AT-SEC-14: one overall deadline', () => {
  it('a hanging response ends with SEC_TIMEOUT exactly at sec.timeoutMs and is not retried', async () => {
    const h = secHarness({ reply: () => 'HANG' });
    const error = errorOf(await get(h));
    expect(error).toMatchObject({ code: 'SEC_TIMEOUT', cause: 'TIMEOUT', attempts: 1 });
    expect(h.clock.monotonicMs()).toBe(30_000);
    expect(h.sleeper.pending).toBe(0);
  });

  it('the budget is shared across redirect hops', async () => {
    const h = secHarness({
      reply: (_r, index) => {
        if (index === 0) {
          h.clock.advance(20_000);
          return redirect('https://data.sec.gov/x');
        }
        return 'HANG';
      },
    });
    const error = errorOf(await get(h));
    expect(error).toMatchObject({ code: 'SEC_TIMEOUT', attempts: 2 });
    expect(h.clock.monotonicMs()).toBe(30_000);
  });

  it('DNS that never settles is SEC_TIMEOUT at the deadline, with no request and no client security event', async () => {
    const h = secHarness({ dns: { 'www.sec.gov': 'HANG' } });
    const error = errorOf(await get(h));
    expect(error).toEqual({ code: 'SEC_TIMEOUT', message: 'SEC request failed (SEC_TIMEOUT).', attempts: 0 });
    expect(h.clock.monotonicMs()).toBe(30_000);
    expect(h.transport.requests).toEqual([]);
    expect(h.sink.events).toEqual([]);
  });

  /** Lets fake time run on after the call, so late resolver answers arrive. */
  const later = (h: SecHarness, ms: number) =>
    drive(h.sleeper, new Promise<void>((resolve) => void h.sleeper.sleep(ms).then(() => resolve())));

  it('a resolver failure that arrives after the deadline is SEC_TIMEOUT and never emits DNS_FAILED, now or later', async () => {
    const h = secHarness({ dns: { 'www.sec.gov': { afterMs: 40_000 } } });
    const error = errorOf(await get(h));
    expect(error).toEqual({ code: 'SEC_TIMEOUT', message: 'SEC request failed (SEC_TIMEOUT).', attempts: 0 });
    expect(h.clock.monotonicMs()).toBe(30_000);
    await later(h, 20_000);
    expect(h.sink.events).toEqual([]);
  });

  it('a late answer with a prohibited address after the deadline is still recorded as ADDRESS_PROHIBITED', async () => {
    const h = secHarness({
      dns: {
        'www.sec.gov': {
          afterMs: 40_000,
          answers: [{ status: 'RECORDS', addresses: ['8.8.8.8', '169.254.169.254'] }, { status: 'NO_DATA' }],
        },
      },
    });
    expect(errorOf(await get(h)).code).toBe('SEC_TIMEOUT');
    expect(h.sink.events).toEqual([]);
    await later(h, 20_000);
    expect(h.sink.events).toEqual([
      {
        type: 'SEC_URL_REJECTED',
        reason: 'ADDRESS_PROHIBITED',
        stage: 'RESOLVE',
        at: '2026-11-07T12:00:40.000Z',
        hostname: 'www.sec.gov',
        prohibitedAddresses: ['169.254.169.254'],
      },
    ]);
    expect(h.transport.requests).toEqual([]);
  });

  it.each([
    ['public records', [{ status: 'RECORDS', addresses: ['8.8.8.8'] }, { status: 'NO_DATA' }]],
    ['no records', [{ status: 'NO_DATA' }, { status: 'NOT_FOUND' }]],
    ['a malformed answer', [{ status: 'RECORDS', addresses: [] }, { status: 'NO_DATA' }]],
  ] as const)('late %s after the deadline record nothing', async (_label, answers) => {
    const h = secHarness({ dns: { 'www.sec.gov': { afterMs: 40_000, answers } } });
    expect(errorOf(await get(h)).code).toBe('SEC_TIMEOUT');
    await later(h, 20_000);
    expect(h.sink.events).toEqual([]);
    expect(h.transport.requests).toEqual([]);
  });

  it('a genuine DNS failure within the deadline is SEC_URL_REJECTED (DNS_FAILED) with its event', async () => {
    const h = secHarness({ dns: { 'www.sec.gov': { afterMs: 1_000 } } });
    expect(errorOf(await get(h))).toMatchObject({
      code: 'SEC_URL_REJECTED',
      reason: 'DNS_FAILED',
      securityEvent: 'RECORDED',
    });
    expect(h.sink.events.map((e) => e.reason)).toEqual(['DNS_FAILED']);
  });

  it.each([
    [
      'A TIMEOUT + AAAA records',
      [{ status: 'TIMEOUT' }, { status: 'RECORDS', addresses: ['2001:4860:4860::8888'] }],
    ],
    ['A NO_DATA + AAAA TIMEOUT', [{ status: 'NO_DATA' }, { status: 'TIMEOUT' }]],
    ['A TIMEOUT + AAAA TIMEOUT', [{ status: 'TIMEOUT' }, { status: 'TIMEOUT' }]],
  ] as const)(
    'a resolver TIMEOUT within the deadline (%s) is SEC_TIMEOUT with no event and no request',
    async (_label, answers) => {
      const h = secHarness({ dns: { 'www.sec.gov': answers } });
      expect(errorOf(await get(h))).toEqual({
        code: 'SEC_TIMEOUT',
        message: 'SEC request failed (SEC_TIMEOUT).',
        attempts: 0,
      });
      expect(h.sink.events).toEqual([]);
      expect(h.transport.requests).toEqual([]);
    },
  );

  it('a genuine DNS error beside a TIMEOUT is still DNS_FAILED', async () => {
    const h = secHarness({ dns: { 'www.sec.gov': [{ status: 'ERROR' }, { status: 'TIMEOUT' }] } });
    expect(errorOf(await get(h))).toMatchObject({ code: 'SEC_URL_REJECTED', reason: 'DNS_FAILED' });
    expect(h.sink.events.map((e) => e.reason)).toEqual(['DNS_FAILED']);
  });

  it('every lookup receives the deadline context; its signal aborts exactly at the deadline', async () => {
    const h = secHarness({ dns: { 'www.sec.gov': 'HANG' }, limits: { timeoutMs: 7_000 } });
    const pending = h.client.getText(URL_A);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.resolver.calls.map((c) => [c.family, c.context?.timeoutMs, c.context?.signal.aborted])).toEqual([
      [4, 7_000, false],
      [6, 7_000, false],
    ]);
    expect(errorOf(await drive(h.sleeper, pending)).code).toBe('SEC_TIMEOUT');
    expect(h.clock.monotonicMs()).toBe(7_000);
    expect(h.resolver.calls.every((c) => c.context?.signal.aborted === true)).toBe(true);
  });

  it('a redirect hop resolves with the remaining budget only', async () => {
    const h = secHarness({
      reply: (_r, index) => {
        h.clock.advance(4_000);
        return index === 0 ? redirect('https://data.sec.gov/x') : ok200();
      },
    });
    expect((await get(h)).ok).toBe(true);
    expect(h.resolver.calls.map((c) => c.context?.timeoutMs)).toEqual([30_000, 30_000, 26_000, 26_000]);
  });

  it('a limiter wait that would reach the deadline sends nothing and is SEC_TIMEOUT', async () => {
    const h = secHarness({ maxPerSecond: 1, limits: { timeoutMs: 1_000 } });
    expect((await get(h)).ok).toBe(true);
    const error = errorOf(await get(h));
    expect(error).toMatchObject({ code: 'SEC_TIMEOUT', attempts: 0 });
    expect(h.transport.requests).toHaveLength(1);
  });
});

describe('AT-SEC-15: 429, 5xx, and other statuses through ResilientCall', () => {
  it('retries 429 after its Retry-After, waiting for the limiter too', async () => {
    const h = secHarness({ reply: sequence({ status: 429, retryAfter: '2' }, ok200()) });
    const result = await get(h);
    expect(result.ok).toBe(true);
    expect(h.transport.requests.map((r) => r.at)).toEqual([0, 2_000]);
  });

  it('a Retry-After above provider.retryAfter.maxMs stops at once with SEC_RATE_LIMITED', async () => {
    const h = secHarness({
      reply: () => ({ status: 429, retryAfter: '601' }),
      limits: { timeoutMs: 30_000 },
    });
    const error = errorOf(await get(h));
    expect(error).toMatchObject({
      code: 'SEC_RATE_LIMITED',
      httpStatus: 429,
      cause: 'RATE_LIMITED',
      attempts: 1,
    });
    expect(h.clock.monotonicMs()).toBe(0);
  });

  it('a 503 Retry-After above the limit stays HTTP_SERVER_ERROR (SEC_UNAVAILABLE)', async () => {
    const h = secHarness({ reply: () => ({ status: 503, retryAfter: '86400' }) });
    expect(errorOf(await get(h))).toMatchObject({
      code: 'SEC_UNAVAILABLE',
      cause: 'HTTP_SERVER_ERROR',
      httpStatus: 503,
      attempts: 1,
    });
  });

  it('a 429 wait that would reach the overall deadline returns SEC_RATE_LIMITED without waiting', async () => {
    const h = secHarness({ reply: () => ({ status: 429, retryAfter: '60' }) });
    expect(errorOf(await get(h))).toMatchObject({ code: 'SEC_RATE_LIMITED', attempts: 1 });
    expect(h.clock.monotonicMs()).toBe(0);
  });

  it('5xx is retried up to provider.maxRetries, then SEC_UNAVAILABLE', async () => {
    const h = secHarness({ reply: () => ({ status: 502 }) });
    expect(errorOf(await get(h))).toMatchObject({
      code: 'SEC_UNAVAILABLE',
      cause: 'HTTP_SERVER_ERROR',
      httpStatus: 502,
      attempts: 4,
    });
  });

  it('other 4xx are SEC_HTTP_ERROR and not retried', async () => {
    const h = secHarness({ reply: () => ({ status: 404 }) });
    expect(errorOf(await get(h))).toMatchObject({ code: 'SEC_HTTP_ERROR', httpStatus: 404, attempts: 1 });
  });

  it('a TLS failure is SEC_UNAVAILABLE (TLS_ERROR) and not retried', async () => {
    const h = secHarness({ reply: () => ({ failure: 'TLS' }) });
    expect(errorOf(await get(h))).toMatchObject({ code: 'SEC_UNAVAILABLE', cause: 'TLS_ERROR', attempts: 1 });
  });

  it('network errors are retried within the budget', async () => {
    const h = secHarness({ reply: sequence({ failure: 'NETWORK' }, ok200()) });
    expect((await get(h)).ok).toBe(true);
    expect(h.transport.requests).toHaveLength(2);
  });

  it('both hosts share the sec-edgar circuit; an open circuit sends nothing', async () => {
    const h = secHarness({ reply: () => ({ status: 503 }), retry: { maxRetries: 0 } });
    for (let i = 0; i < 5; i += 1) {
      await get(h);
    }
    expect(h.resilience.status('sec-edgar').circuit).toBe('OPEN');
    const error = errorOf(await get(h, 'https://data.sec.gov/x'));
    expect(error).toMatchObject({ code: 'SEC_UNAVAILABLE', cause: 'CIRCUIT_OPEN', attempts: 0 });
    expect(h.transport.requests).toHaveLength(5);
  });

  it('guard rejections never count toward the circuit', async () => {
    const h = secHarness();
    for (let i = 0; i < 10; i += 1) {
      await get(h, 'https://evil.example/');
    }
    expect(h.resilience.status('sec-edgar').circuit).toBe('CLOSED');
  });
});

describe('AT-SEC-16: the shared limiter holds across concurrent calls, retries, and redirects', () => {
  it('never starts more than sec.maxRequestsPerSecond requests in any 1-second window', async () => {
    const h = secHarness({
      maxPerSecond: 3,
      reply: (request) => (request.path === '/start' ? redirect('https://data.sec.gov/next') : ok200()),
    });
    const calls = Array.from({ length: 7 }, () => h.client.getText('https://www.sec.gov/start'));
    const results = await drive(h.sleeper, Promise.all(calls));
    expect(results.every((r) => r.ok)).toBe(true);
    const times = h.transport.requests.map((r) => r.at);
    expect(times).toHaveLength(14);
    for (const start of times) {
      expect(times.filter((t) => t >= start && t < start + 1_000).length).toBeLessThanOrEqual(3);
    }
    expect(times).toEqual([
      0, 0, 0, 1_000, 1_000, 1_000, 2_000, 2_000, 2_000, 3_000, 3_000, 3_000, 4_000, 4_000,
    ]);
  });
});

describe('limiter expiry stays outside provider accounting', () => {
  const statusOf = (h: SecHarness) => h.resilience.status('sec-edgar');

  it('a first attempt that cannot get a slot is SEC_TIMEOUT and never reaches ResilientCall', async () => {
    const h = secHarness({ maxPerSecond: 1, limits: { timeoutMs: 1_000 } });
    expect((await get(h)).ok).toBe(true);
    expect(h.runCalls.count).toBe(1);
    const before = statusOf(h);
    for (let i = 0; i < 10; i += 1) {
      expect(errorOf(await get(h))).toEqual({
        code: 'SEC_TIMEOUT',
        message: 'SEC request failed (SEC_TIMEOUT).',
        attempts: 0,
      });
    }
    expect(h.runCalls.count).toBe(1);
    expect(statusOf(h)).toEqual(before);
    expect(statusOf(h)).toMatchObject({ state: 'AVAILABLE', circuit: 'CLOSED' });
    expect(statusOf(h).lastErrorCode).toBeUndefined();
    expect(h.transport.requests).toHaveLength(1);
    expect(h.clock.monotonicMs()).toBe(0);
    expect(h.logs).toEqual([]);
  });

  it('a retry that cannot get a slot is SEC_TIMEOUT, is not retried, and is never counted toward the circuit', async () => {
    const h = secHarness({ maxPerSecond: 1, limits: { timeoutMs: 1_000 }, reply: () => ({ status: 503 }) });
    for (let call = 0; call < 6; call += 1) {
      h.sleeper.advance(1_000);
      const startedAt = h.clock.monotonicMs();
      const error = errorOf(await get(h));
      // One real request (503); the retry's slot would start at the deadline, so nothing more is sent.
      expect(error).toEqual({
        code: 'SEC_TIMEOUT',
        message: 'SEC request failed (SEC_TIMEOUT).',
        attempts: 1,
      });
      expect(h.clock.monotonicMs() - startedAt).toBeLessThan(1_000);
    }
    expect(h.transport.requests).toHaveLength(6);
    expect(h.runCalls.count).toBe(6);
    // Six calls whose only provider contact was a 503 would open a five-failure circuit if counted.
    expect(statusOf(h)).toMatchObject({ state: 'AVAILABLE', circuit: 'CLOSED' });
    expect(statusOf(h).lastErrorCode).toBeUndefined();
  });

  it('with retries disabled the same 503s do count (control for the test above)', async () => {
    const h = secHarness({
      maxPerSecond: 1,
      limits: { timeoutMs: 1_000 },
      retry: { maxRetries: 0 },
      reply: () => ({ status: 503 }),
    });
    for (let call = 0; call < 5; call += 1) {
      h.sleeper.advance(1_000);
      expect(errorOf(await get(h)).code).toBe('SEC_UNAVAILABLE');
    }
    expect(statusOf(h)).toMatchObject({ circuit: 'OPEN', lastErrorCode: 'HTTP_SERVER_ERROR' });
  });

  it('limiter expiry after the cooldown neither uses nor reopens the half-open probe', async () => {
    const h = secHarness({
      retry: { maxRetries: 0 },
      limits: { timeoutMs: 1_000 },
      reply: (_r, index) => (index < 5 ? { status: 503 } : ok200()),
    });
    for (let call = 0; call < 5; call += 1) {
      await get(h);
    }
    expect(statusOf(h).circuit).toBe('OPEN');
    h.sleeper.advance(60_000);
    // Fill the shared window so the next call's first slot is at its deadline.
    for (let i = 0; i < 5; i += 1) {
      expect(await h.limiter.acquire(Number.POSITIVE_INFINITY, new AbortController().signal)).toBe('GRANTED');
    }
    const runsBefore = h.runCalls.count;
    expect(errorOf(await get(h))).toMatchObject({ code: 'SEC_TIMEOUT', attempts: 0 });
    expect(h.runCalls.count).toBe(runsBefore);
    // No fresh cooldown was started: one window later the probe is admitted and closes the circuit.
    h.sleeper.advance(1_000);
    expect((await get(h)).ok).toBe(true);
    expect(statusOf(h)).toMatchObject({ state: 'AVAILABLE', circuit: 'CLOSED' });
  });
});

describe('errors and events never contain URLs or details', () => {
  it('no URL, path, query, or Location appears in any error, event, or log', async () => {
    const replies: Reply[] = [
      { status: 404 },
      { status: 503, retryAfter: 'TOKEN123' },
      { failure: 'TLS' },
      redirect('https://evil.example/LEAKME'),
      { status: 302, locations: ['https://www.sec.gov/LEAKME', 'https://www.sec.gov/LEAKME2'] },
    ];
    for (const reply of replies) {
      const h = secHarness({ reply: () => reply, retry: { maxRetries: 0 } });
      const result = await get(h);
      const text = JSON.stringify([result, h.sink.events, h.logs]);
      for (const marker of ['PRIVATEPATH', 'TOKEN123', 'LEAKME', 'Archives', 'evil.example']) {
        expect(text).not.toContain(marker);
      }
    }
  });
});
