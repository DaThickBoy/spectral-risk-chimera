// Property 27: SSRF safety
// Validates: Requirements 29.8, 29.9, 29.10, 29.11
// Task 19.1 covers the URL and address part with a stubbed DNS resolver; the redirect part is
// task 19.2. Address expectations use node:net BlockList over the design table, independently
// of the implementation's own parser.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatIPv4, formatIPv6, parseIPv4, parseIPv6 } from '../../src/sec/addressPolicy.js';
import {
  NO_DATA,
  blockRange,
  fakeResolver,
  guardWith,
  ipv4Text,
  ipv6FullText,
  records,
  referenceBlockList,
} from '../helpers/secGuard.js';

const RUNS = { numRuns: 500 };

const component = <T extends string>(...options: readonly (readonly [T, boolean])[]) =>
  fc.constantFrom(...options);

const composedUrl = fc
  .tuple(
    component(['https', true], ['HTTPS', true], ['http', false], ['ftp', false], ['wss', false]),
    component(['', true], ['user@', false], ['user:pw@', false], ['@', false], [':@', false]),
    component(
      ['www.sec.gov', true],
      ['data.sec.gov', true],
      ['WWW.SEC.GOV', true],
      ['www%2Esec.gov', true],
      ['www\uFF0Esec\uFF0Egov', true],
      ['www.sec.gov.', false],
      ['www.sec.gov.example.com', false],
      ['evilwww.sec.gov', false],
      ['sec.gov', false],
      ['evil.example', false],
      ['127.0.0.1', false],
      ['2130706433', false],
      ['[::1]', false],
      ['www.\u0455ec.gov', false],
    ),
    component(['', true], [':443', true], [':0443', true], [':8443', false], [':80', false]),
    fc.constantFrom('/', '/Archives/edgar/data', '/a@b', '/cgi-bin/browse-edgar'),
    fc.constantFrom('', '?action=getcompany', '?x=@&y=1'),
    component(['', true], ['#', false], ['#top', false]),
  )
  .map(([scheme, user, host, port, path, query, fragment]) => ({
    url: `${scheme[0]}://${user[0]}${host[0]}${port[0]}${path}${query}${fragment[0]}`,
    allowed: scheme[1] && user[1] && host[1] && port[1] && fragment[1],
  }));

const anyInput = fc.oneof(
  fc.string({ maxLength: 80 }),
  fc.webUrl({ withFragments: true, withQueryParameters: true }),
  composedUrl.map((c) => c.url),
);

describe('Property 27 (URL part): only allowlisted HTTPS URLs pass validate', () => {
  it('accepts a composed URL exactly when every component is allowed', () => {
    fc.assert(
      fc.property(composedUrl, ({ url, allowed }) => {
        const { guard, sink } = guardWith();
        const result = guard.validate(url);
        expect(result.ok).toBe(allowed);
        expect(sink.events).toHaveLength(allowed ? 0 : 1);
      }),
      RUNS,
    );
  });

  it('every accepted input is HTTPS on an allowlisted host, default port, with no credentials or fragment', () => {
    fc.assert(
      fc.property(anyInput, (input) => {
        const { guard, sink } = guardWith();
        const result = guard.validate(input);
        if (!result.ok) {
          expect(sink.events).toHaveLength(1);
          expect(sink.events[0]?.stage).toBe('VALIDATE');
          return;
        }
        const parsed = new URL(result.value.href);
        expect(parsed.protocol).toBe('https:');
        expect(['www.sec.gov', 'data.sec.gov']).toContain(parsed.hostname);
        expect(parsed.hostname).toBe(result.value.hostname);
        expect(parsed.port).toBe('');
        expect(parsed.username + parsed.password).toBe('');
        expect(input.includes('#')).toBe(false);
        expect(sink.events).toHaveLength(0);
      }),
      { numRuns: 1000 },
    );
  });
});

// ---- Address part ----

const V4_BLOCKS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.31.196.0/24',
  '192.52.193.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '192.175.48.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];
const V6_BLOCKS = ['2001::/23', '2001:db8::/32', '2002::/16', '2620:4f:8000::/48', '3fff::/20'];
const v4Prohibited = referenceBlockList(V4_BLOCKS, 4);
const v6Prohibited = referenceBlockList(V6_BLOCKS, 6);
const v6Global = referenceBlockList(['2000::/3'], 6);

const inside = (cidr: string, family: 4 | 6) => {
  const { first, last } = blockRange(cidr, family);
  return fc.bigInt({ min: first, max: last });
};

type Addr = { text: string; value: bigint; family: 4 | 6; prohibited: boolean };

const v4Address: fc.Arbitrary<Addr> = fc
  .oneof(
    fc.constantFrom(...V4_BLOCKS).chain((cidr) => inside(cidr, 4)),
    fc.bigInt({ min: 0n, max: (1n << 32n) - 1n }),
  )
  .map((value) => {
    const text = ipv4Text(value);
    return { text, value, family: 4 as const, prohibited: v4Prohibited.check(text, 'ipv4') };
  });

const v6Address: fc.Arbitrary<Addr> = fc
  .oneof(
    fc
      .constantFrom(...V6_BLOCKS, '2000::/3', 'fc00::/7', 'fe80::/10', '::ffff:0:0/96', '64:ff9b::/96')
      .chain((cidr) => inside(cidr, 6)),
    fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }),
  )
  .map((value) => {
    const text = ipv6FullText(value);
    const prohibited = !v6Global.check(text, 'ipv6') || v6Prohibited.check(text, 'ipv6');
    return { text, value, family: 6 as const, prohibited };
  });

describe('address text is parsed to its actual bytes (independent WHATWG cross-check)', () => {
  /** WHATWG URL's own IPv6 parser and serializer, used as an independent reference. */
  const whatwgIPv6 = (text: string): string | undefined => {
    try {
      return new URL(`http://[${text}]/`).hostname.slice(1, -1);
    } catch {
      return undefined;
    }
  };
  const isMapped = (value: bigint): boolean => value >> 32n === 0xffffn;

  it('round-trips every 128-bit value through full and WHATWG-compressed text', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }), (value) => {
        const full = ipv6FullText(value);
        expect(parseIPv6(full)).toBe(value);
        const compressed = whatwgIPv6(full);
        expect(compressed).toBeDefined();
        expect(parseIPv6(compressed ?? '')).toBe(value);
        if (!isMapped(value)) {
          expect(formatIPv6(value)).toBe(compressed);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('accepts IPv6 text only when WHATWG parses it to the same bytes', () => {
    const hexy = fc.string({
      unit: fc.constantFrom(...'0123456789abcdefABCDEF:.%'.split('')),
      maxLength: 45,
    });
    fc.assert(
      fc.property(hexy, (text) => {
        const value = parseIPv6(text);
        if (value === undefined) {
          return;
        }
        expect(parseIPv6(whatwgIPv6(text) ?? '')).toBe(value);
      }),
      { numRuns: 3000 },
    );
  });

  it('round-trips every 32-bit value and rejects non-canonical IPv4 text', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 32n) - 1n }), (value) => {
        expect(parseIPv4(ipv4Text(value))).toBe(value);
        expect(formatIPv4(value)).toBe(ipv4Text(value));
      }),
      { numRuns: 2000 },
    );
    for (const text of [
      '010.0.0.1',
      '1.2.3.04',
      '0x1.2.3.4',
      '1.2.3',
      '1.2.3.4.5',
      '1..2.3',
      '256.0.0.0',
      '+1.2.3.4',
    ]) {
      expect(parseIPv4(text)).toBeUndefined();
    }
  });
});

describe('Property 27 (address part): any prohibited record rejects the host', () => {
  it('resolveAndCheck succeeds exactly when every A and AAAA record is globally reachable unicast', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(v4Address, { maxLength: 4 }),
        fc.array(v6Address, { maxLength: 4 }),
        async (v4, v6) => {
          const resolver = fakeResolver(
            v4.length === 0 ? NO_DATA : records(...v4.map((a) => a.text)),
            v6.length === 0 ? NO_DATA : records(...v6.map((a) => a.text)),
          );
          const { guard, sink } = guardWith(resolver);
          const validated = guard.validate('https://www.sec.gov/Archives/');
          if (!validated.ok) {
            throw new Error('fixture URL must validate');
          }
          const result = await guard.resolveAndCheck(validated.value);
          const all = [...v4, ...v6];
          const anyProhibited = all.some((a) => a.prohibited);
          if (all.length === 0) {
            expect(!result.ok && result.error.reason).toBe('DNS_EMPTY');
          } else if (anyProhibited) {
            expect(!result.ok && result.error.reason).toBe('ADDRESS_PROHIBITED');
          } else {
            expect(result.ok).toBe(true);
            // Every distinct record is returned once.
            const distinct = new Set(all.map((a) => `${a.family}:${a.value}`)).size;
            expect(result.ok && result.value.addresses.length).toBe(distinct);
          }
          expect(sink.events).toHaveLength(result.ok ? 0 : 1);
          expect(resolver.calls.every((call) => call.hostname === 'www.sec.gov')).toBe(true);
        },
      ),
      RUNS,
    );
  });
});
