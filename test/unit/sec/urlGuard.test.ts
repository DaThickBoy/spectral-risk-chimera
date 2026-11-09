// Task 19.1: the SEC URL guard. AT-SEC-01 to AT-SEC-09 and AT-SEC-28 to AT-SEC-31, with a stubbed
// DNS resolver and a recording SecurityEventSink.
// Validates: Requirements 29.8, 29.9, 29.11, 29.14
import { describe, expect, it } from 'vitest';
import { createSecUrlGuard } from '../../../src/sec/index.js';
import type { SecUrlRejected, ValidatedSecUrl } from '../../../src/sec/index.js';
import {
  ERROR,
  NOT_FOUND,
  NOW,
  NO_DATA,
  fakeResolver,
  guardWith,
  recordingSink,
  records,
} from '../../helpers/secGuard.js';
import type { SinkMode } from '../../helpers/secGuard.js';

function validated(url: string): ValidatedSecUrl {
  const result = guardWith().guard.validate(url);
  if (!result.ok) {
    throw new Error(`expected ${url} to validate, got ${result.error.reason}`);
  }
  return result.value;
}

function rejection(url: string): SecUrlRejected {
  const result = guardWith().guard.validate(url);
  if (result.ok) {
    throw new Error(`expected ${url} to be rejected`);
  }
  return result.error;
}

const reasonOf = (url: string) => rejection(url).reason;

describe('accepted URLs', () => {
  it.each([
    [
      'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany',
      'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany',
      'www.sec.gov',
    ],
    [
      'https://data.sec.gov/submissions/CIK0000320193.json',
      'https://data.sec.gov/submissions/CIK0000320193.json',
      'data.sec.gov',
    ],
    ['HTTPS://WWW.SEC.GOV/Archives/', 'https://www.sec.gov/Archives/', 'www.sec.gov'],
    ['https://www.sec.gov:443/x', 'https://www.sec.gov/x', 'www.sec.gov'],
    ['https://www.sec.gov:0443/x', 'https://www.sec.gov/x', 'www.sec.gov'],
    ['https://www.sec.gov', 'https://www.sec.gov/', 'www.sec.gov'],
    ['  https://www.sec.gov/a\tb\n  ', 'https://www.sec.gov/ab', 'www.sec.gov'],
    ['https:\\\\www.sec.gov\\Archives', 'https://www.sec.gov/Archives', 'www.sec.gov'],
  ])('%j validates to %s', (input, href, hostname) => {
    expect(validated(input)).toEqual({ href, hostname });
  });
});

describe('AT-SEC-01 and AT-SEC-02: non-SEC and look-alike hosts', () => {
  it.each([
    'https://example.com/',
    'https://sec.gov/',
    'https://www.sec.gov.example.com/',
    'https://www.sec.gov.evil/',
    'https://evilwww.sec.gov/',
    'https://wwwsec.gov/',
    'https://www-sec.gov/',
    'https://efts.sec.gov/',
    'https://www.sec.gov.example.com.www.sec.gov.evil/',
    'https://localhost/',
  ])('%s is HOST_NOT_ALLOWED', (url) => {
    expect(reasonOf(url)).toBe('HOST_NOT_ALLOWED');
  });
});

describe('AT-SEC-03: non-HTTPS schemes', () => {
  it.each([
    'http://www.sec.gov/',
    'HTTP://www.sec.gov/',
    'ftp://www.sec.gov/',
    'wss://www.sec.gov/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/plain,x',
  ])('%s is NOT_HTTPS', (url) => {
    expect(reasonOf(url)).toBe('NOT_HTTPS');
  });
});

describe('AT-SEC-04: embedded credentials', () => {
  it.each([
    'https://user:pass@www.sec.gov/',
    'https://user@www.sec.gov/',
    'https://:pass@www.sec.gov/',
    'https://@www.sec.gov/',
    'https://:@www.sec.gov/',
    'https:@www.sec.gov/',
    'https:\\\\@www.sec.gov/',
    'https://www.sec.gov@evil.example/',
    'https:/@www.sec.gov/',
    'https:////@www.sec.gov/',
    'https:/\\@www.sec.gov/',
    'https://\t@www.sec.gov/',
    'https://@\nwww.sec.gov/',
    ' \u0001https://@www.sec.gov/ ',
    'https://user%40x@www.sec.gov/',
    'https://a@b@www.sec.gov/',
  ])('%j is CREDENTIALS_PRESENT', (url) => {
    expect(reasonOf(url)).toBe('CREDENTIALS_PRESENT');
  });

  it.each([
    'https://www.sec.gov/a@b?c=@d',
    'https://www.sec.gov\\path@x',
    'https://www.sec.gov?q=user@example.com',
    'https://www.sec.gov/Archives/edgar/data/320193/a%40b.htm',
    'https:www.sec.gov/x@y',
  ])('an @ outside the authority is not userinfo: %j', (url) => {
    expect(validated(url).hostname).toBe('www.sec.gov');
  });
});

describe('AT-SEC-05: ports', () => {
  it.each([
    'https://www.sec.gov:8443/',
    'https://www.sec.gov:80/',
    'https://www.sec.gov:1/',
    'https://data.sec.gov:65535/',
  ])('%s is PORT_NOT_ALLOWED', (url) => {
    expect(reasonOf(url)).toBe('PORT_NOT_ALLOWED');
  });
});

describe('AT-SEC-06: IP literals', () => {
  it.each([
    'https://127.0.0.1/',
    'https://127.1/',
    'https://0x7f.0.0.1/',
    'https://2130706433/',
    'https://8.8.8.8/',
    'https://[::1]/',
    'https://[2001:4860:4860::8888]/',
    'https://[::ffff:127.0.0.1]/',
  ])('%s is IP_LITERAL', (url) => {
    expect(reasonOf(url)).toBe('IP_LITERAL');
  });
});

describe('AT-SEC-28: MALFORMED_URL first, fragments, trailing dots, IDNA', () => {
  it.each([
    '',
    '   ',
    'not a url',
    'www.sec.gov/x',
    'https://',
    'http://',
    'https://[::1',
    'https://www.sec.gov:99999/',
    '//www.sec.gov/',
  ])('%j is MALFORMED_URL', (url) => {
    expect(reasonOf(url)).toBe('MALFORMED_URL');
  });

  it('treats a non-string input as MALFORMED_URL without throwing', () => {
    const { guard } = guardWith();
    const result = guard.validate(42 as unknown as string);
    expect(!result.ok && result.error.reason).toBe('MALFORMED_URL');
  });

  it.each([
    'https://www.sec.gov/#',
    'https://www.sec.gov/#section',
    'https://www.sec.gov/a?b=1#c',
    'https://www.sec.gov#x',
  ])('%s is FRAGMENT_PRESENT', (url) => {
    expect(reasonOf(url)).toBe('FRAGMENT_PRESENT');
  });

  it.each(['https://www.sec.gov./', 'https://data.sec.gov./x', 'https://www.sec.gov../'])(
    '%s (trailing dot) is HOST_NOT_ALLOWED',
    (url) => {
      expect(reasonOf(url)).toBe('HOST_NOT_ALLOWED');
    },
  );

  it.each([
    'https://www.\u0455\u0435\u0441.gov/',
    'https://www.s\u0435c.gov/',
    'https://www.sec.gov.xn--p1ai/',
    'https://www.sec.\u0261ov/',
    'https://www.sec.gov\u3002evil/',
  ])('look-alike %j is HOST_NOT_ALLOWED', (url) => {
    expect(reasonOf(url)).toBe('HOST_NOT_ALLOWED');
  });

  it.each([
    ['https://www%2Esec.gov/x', 'https://www.sec.gov/x'],
    ['https://www\uFF0Esec\uFF0Egov/x', 'https://www.sec.gov/x'],
    ['https://WwW.SeC.GoV/x', 'https://www.sec.gov/x'],
    ['https://data\u3002sec\u3002gov/x', 'https://data.sec.gov/x'],
  ])('IDNA input %j normalizes to the allowlisted ASCII name', (input, href) => {
    expect(validated(input).href).toBe(href);
  });

  it.each([
    ['http://user@127.0.0.1:8080/#x', 'NOT_HTTPS'],
    ['https://user@127.0.0.1:8080/#x', 'CREDENTIALS_PRESENT'],
    ['https://127.0.0.1:8080/#x', 'IP_LITERAL'],
    ['https://evil.example:8080/#x', 'HOST_NOT_ALLOWED'],
    ['https://www.sec.gov:8080/#x', 'PORT_NOT_ALLOWED'],
    ['https://www.sec.gov/#x', 'FRAGMENT_PRESENT'],
  ])('reports the first failure in the fixed order: %s -> %s', (url, reason) => {
    expect(reasonOf(url)).toBe(reason);
  });

  it('rejection messages never contain the input', () => {
    const secretUrl = 'https://user:secret-token-123@evil.example/secret-path#frag';
    const error = rejection(secretUrl);
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(error.message).toBe('SEC URL rejected (CREDENTIALS_PRESENT).');
    expect(error).toMatchObject({ code: 'SEC_URL_REJECTED', stage: 'VALIDATE', securityEvent: 'RECORDED' });
  });
});

describe('AT-SEC-07, AT-SEC-08, AT-SEC-09 and AT-SEC-29: resolved addresses', () => {
  const resolve = async (v4: Parameters<typeof fakeResolver>[0], v6: Parameters<typeof fakeResolver>[1]) => {
    const resolver = fakeResolver(v4, v6);
    const { guard, sink } = guardWith(resolver);
    const result = await guard.resolveAndCheck(validated('https://data.sec.gov/x'));
    return { result, sink, resolver };
  };

  it.each([
    ['loopback', records('127.0.0.1'), NO_DATA],
    ['IPv6 loopback', NO_DATA, records('::1')],
    ['RFC 1918', records('10.0.0.5'), NO_DATA],
    ['RFC 1918 192.168', records('192.168.0.10'), NO_DATA],
    ['link-local metadata', records('169.254.169.254'), NO_DATA],
    ['IPv6 link-local', NO_DATA, records('fe80::1')],
  ] as const)('a host resolving to %s is ADDRESS_PROHIBITED', async (_label, v4, v6) => {
    const { result, sink } = await resolve(v4, v6);
    expect(!result.ok && result.error.reason).toBe('ADDRESS_PROHIBITED');
    expect(!result.ok && result.error.stage).toBe('RESOLVE');
    expect(sink.events).toHaveLength(1);
  });

  it('rejects when any one of several A or AAAA records is prohibited', async () => {
    const { result, sink } = await resolve(
      records('8.8.8.8', '10.1.1.1', '1.1.1.1'),
      records('2001:4860:4860::8888', '::ffff:127.0.0.1'),
    );
    expect(!result.ok && result.error.reason).toBe('ADDRESS_PROHIBITED');
    expect(sink.events[0]?.prohibitedAddresses).toEqual(['10.1.1.1', '::ffff:127.0.0.1']);
    expect(sink.events[0]?.hostname).toBe('data.sec.gov');
  });

  it('returns every validated address, family 4 first, canonical and deduplicated', async () => {
    const { result, sink, resolver } = await resolve(
      records('8.8.8.8', '1.1.1.1', '8.8.8.8'),
      records('2001:4860:4860:0:0:0:0:8888', '2606:4700:4700::1111'),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        hostname: 'data.sec.gov',
        addresses: [
          { address: '8.8.8.8', family: 4 },
          { address: '1.1.1.1', family: 4 },
          { address: '2001:4860:4860::8888', family: 6 },
          { address: '2606:4700:4700::1111', family: 6 },
        ],
        policyVersion: 'iana-special-purpose-2025-10-09',
      },
    });
    expect(sink.events).toEqual([]);
    expect(resolver.calls).toEqual([
      { hostname: 'data.sec.gov', family: 4 },
      { hostname: 'data.sec.gov', family: 6 },
    ]);
  });

  it('a validated URL cannot be mutated after validation', () => {
    const url = validated('https://www.sec.gov/x');
    expect(Object.isFrozen(url)).toBe(true);
    expect(() => {
      (url as { href: string }).href = 'https://evil.example/';
    }).toThrow(TypeError);
    expect(() => {
      (url as { hostname: string }).hostname = 'data.sec.gov';
    }).toThrow(TypeError);
    expect(url).toEqual({ href: 'https://www.sec.gov/x', hostname: 'www.sec.gov' });
  });

  it('refuses a hand-built object even when its hostname is allowlisted', async () => {
    const resolver = fakeResolver(records('8.8.8.8'), NO_DATA);
    const { guard } = guardWith(resolver);
    const forged = { href: 'https://evil.example/', hostname: 'www.sec.gov' } as unknown as ValidatedSecUrl;
    await expect(guard.resolveAndCheck(forged)).rejects.toThrow(TypeError);
    const copied = { ...validated('https://www.sec.gov/') } as ValidatedSecUrl;
    await expect(guard.resolveAndCheck(copied)).rejects.toThrow(TypeError);
    await expect(guard.resolveAndCheck(null as unknown as ValidatedSecUrl)).rejects.toThrow(TypeError);
    expect(resolver.calls).toEqual([]);
  });

  it('resolves only the validated hostname, and the resolved result is frozen', async () => {
    const resolver = fakeResolver(records('8.8.8.8'), records('2001:4860:4860::8888'));
    const { guard } = guardWith(resolver);
    const result = await guard.resolveAndCheck(validated('https://WWW.SEC.GOV/x'));
    expect(resolver.calls.map((call) => call.hostname)).toEqual(['www.sec.gov', 'www.sec.gov']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.addresses)).toBe(true);
      expect(result.value.addresses.every((entry) => Object.isFrozen(entry))).toBe(true);
      expect(() => {
        (result.value.addresses as unknown as unknown[]).push({ address: '10.0.0.1', family: 4 });
      }).toThrow(TypeError);
    }
  });

  it('refuses a forged ValidatedSecUrl without resolving anything', async () => {
    const resolver = fakeResolver(records('8.8.8.8'), NO_DATA);
    const { guard } = guardWith(resolver);
    const forged = { href: 'https://evil.example/', hostname: 'evil.example' } as unknown as ValidatedSecUrl;
    await expect(guard.resolveAndCheck(forged)).rejects.toThrow(TypeError);
    expect(resolver.calls).toEqual([]);
  });
});

describe('AT-SEC-30: DNS family outcomes', () => {
  const outcome = async (v4: Parameters<typeof fakeResolver>[0], v6: Parameters<typeof fakeResolver>[1]) => {
    const { guard, sink } = guardWith(fakeResolver(v4, v6));
    const result = await guard.resolveAndCheck(validated('https://www.sec.gov/'));
    return { result, sink };
  };

  it.each([
    ['NO_DATA', 'NO_DATA', NO_DATA, NO_DATA],
    ['NO_DATA', 'NOT_FOUND', NO_DATA, NOT_FOUND],
    ['NOT_FOUND', 'NOT_FOUND', NOT_FOUND, NOT_FOUND],
    ['NOT_FOUND', 'NO_DATA', NOT_FOUND, NO_DATA],
  ] as const)('%s + %s is DNS_EMPTY', async (_a, _b, v4, v6) => {
    const { result, sink } = await outcome(v4, v6);
    expect(!result.ok && result.error.reason).toBe('DNS_EMPTY');
    expect(sink.events).toEqual([
      { type: 'SEC_URL_REJECTED', reason: 'DNS_EMPTY', stage: 'RESOLVE', at: NOW, hostname: 'www.sec.gov' },
    ]);
  });

  it.each([
    ['A records + AAAA NO_DATA', records('8.8.8.8'), NO_DATA, ['8.8.8.8']],
    ['A records + AAAA NOT_FOUND', records('8.8.8.8'), NOT_FOUND, ['8.8.8.8']],
    ['A NO_DATA + AAAA records', NO_DATA, records('2001:4860:4860::8888'), ['2001:4860:4860::8888']],
    ['A NOT_FOUND + AAAA records', NOT_FOUND, records('2001:4860:4860::8888'), ['2001:4860:4860::8888']],
  ] as const)('%s uses the available records', async (_label, v4, v6, expected) => {
    const { result } = await outcome(v4, v6);
    expect(result.ok && result.value.addresses.map((a) => a.address)).toEqual(expected);
  });

  it.each([
    ['A ERROR + AAAA records', ERROR, records('2001:4860:4860::8888')],
    ['A records + AAAA ERROR', records('8.8.8.8'), ERROR],
    ['A ERROR + AAAA ERROR', ERROR, ERROR],
    ['A ERROR + AAAA NO_DATA', ERROR, NO_DATA],
    ['A throws + AAAA records', 'THROW', records('2001:4860:4860::8888')],
    ['A records + AAAA rejects', records('8.8.8.8'), 'REJECT'],
    ['A unrecognized answer + AAAA records', 'MALFORMED_OBJECT', records('2001:4860:4860::8888')],
    ['A RECORDS with an empty list + AAAA NO_DATA', records(), NO_DATA],
    ['A RECORDS with an empty list + AAAA records', records(), records('2001:4860:4860::8888')],
    ['a malformed A record', records('8.8.8.8', 'not-an-ip'), NO_DATA],
    ['an IPv6 record in the A family', records('2001:4860:4860::8888'), NO_DATA],
    ['an IPv4 record in the AAAA family', NO_DATA, records('8.8.8.8')],
    ['an IPv6 record with a zone index', NO_DATA, records('fe80::1%eth0')],
    ['a malformed record next to a prohibited one', records('10.0.0.1', '1.2.3'), NO_DATA],
  ] as const)('%s is DNS_FAILED', async (_label, v4, v6) => {
    const { result, sink } = await outcome(v4, v6);
    expect(!result.ok && result.error.reason).toBe('DNS_FAILED');
    expect(sink.events.map((event) => event.reason)).toEqual(['DNS_FAILED']);
  });
});

describe('AT-SEC-31: security events and delivery outcomes', () => {
  const secretUrl = 'https://user:secret-token-123@evil.example/secret-path?q=secret-query#secret-fragment';

  it('emits exactly one event per rejection, with no part of the input URL', () => {
    const { guard, sink } = guardWith();
    guard.validate(secretUrl);
    expect(sink.events).toEqual([
      { type: 'SEC_URL_REJECTED', reason: 'CREDENTIALS_PRESENT', stage: 'VALIDATE', at: NOW },
    ]);
    expect(JSON.stringify(sink.events)).not.toMatch(/secret|evil|user/);
  });

  it('emits no event for an accepted URL or a successful resolution', async () => {
    const { guard, sink } = guardWith();
    const result = guard.validate('https://www.sec.gov/x');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((await guard.resolveAndCheck(result.value)).ok).toBe(true);
    }
    expect(sink.events).toEqual([]);
  });

  it('reports RECORDED only when the sink returns success', () => {
    const { guard } = guardWith(undefined, recordingSink('OK'));
    const result = guard.validate('http://www.sec.gov/');
    expect(!result.ok && result.error.securityEvent).toBe('RECORDED');
  });

  it.each(['ERROR_RESULT', 'THROW', 'UNDEFINED', 'PROMISE_OK', 'PROMISE_REJECT'] as const)(
    'a sink that %s still rejects and reports DELIVERY_FAILED',
    async (mode: SinkMode) => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const sink = recordingSink(mode);
        const { guard } = guardWith(fakeResolver(records('10.0.0.1'), NO_DATA), sink);
        const validateResult = guard.validate('https://evil.example/');
        expect(validateResult.ok).toBe(false);
        expect(!validateResult.ok && validateResult.error).toMatchObject({
          reason: 'HOST_NOT_ALLOWED',
          securityEvent: 'DELIVERY_FAILED',
        });
        const resolveResult = await guard.resolveAndCheck(validated('https://www.sec.gov/'));
        expect(!resolveResult.ok && resolveResult.error).toMatchObject({
          reason: 'ADDRESS_PROHIBITED',
          securityEvent: 'DELIVERY_FAILED',
        });
        expect(sink.events).toHaveLength(2);
        // Node.js reports unhandled rejections before the next macrotask, so one setImmediate
        // turn is a deterministic check (no arbitrary delay).
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    },
  );

  it('a failing clock still rejects and reports DELIVERY_FAILED', async () => {
    const sink = recordingSink('OK');
    const guard = createSecUrlGuard({
      resolver: fakeResolver(NO_DATA, NO_DATA),
      sink,
      clock: {
        nowUtc: () => {
          throw new Error('clock unavailable');
        },
        monotonicMs: () => 0,
      },
    });
    const result = guard.validate('http://www.sec.gov/');
    expect(!result.ok && result.error).toMatchObject({
      reason: 'NOT_HTTPS',
      securityEvent: 'DELIVERY_FAILED',
    });
    const resolved = await guard.resolveAndCheck(validated('https://www.sec.gov/'));
    expect(!resolved.ok && resolved.error).toMatchObject({
      reason: 'DNS_EMPTY',
      securityEvent: 'DELIVERY_FAILED',
    });
    expect(sink.events).toEqual([]);
  });
});
