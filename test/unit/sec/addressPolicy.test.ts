// Task 19.1: the pinned address policy `iana-special-purpose-2025-10-09` (AT-SEC-07, AT-SEC-08,
// AT-SEC-09, AT-SEC-29). The expected tables below are copied from design.md (URL Guard and
// Client, address policy); membership is cross-checked with node:net BlockList, an independent
// mechanism.
// Validates: Requirements 29.9
import { describe, expect, it } from 'vitest';
import {
  ADDRESS_POLICY_VERSION,
  IPV4_PROHIBITED_BLOCKS,
  IPV6_GLOBAL_UNICAST,
  IPV6_PROHIBITED_BLOCKS,
  classifyAddress,
  formatIPv6,
  parseIPv6,
} from '../../../src/sec/addressPolicy.js';
import { blockRange, ipv4Text, ipv6FullText, referenceBlockList } from '../../helpers/secGuard.js';

// design.md, IPv4 table (IANA IPv4 Special-Purpose Address Space, Last Updated 2025-10-09, plus RFC 5771).
const DESIGN_IPV4 = [
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
// design.md, IPv6 table (inside 2000::/3; IANA IPv6 Special-Purpose Address Space, Last Updated 2025-10-09).
const DESIGN_IPV6 = ['2001::/23', '2001:db8::/32', '2002::/16', '2620:4f:8000::/48', '3fff::/20'];

const v4List = referenceBlockList(DESIGN_IPV4, 4);
const v6Prohibited = referenceBlockList(DESIGN_IPV6, 6);
const v6Global = referenceBlockList(['2000::/3'], 6);
const MAX_V4 = (1n << 32n) - 1n;
const MAX_V6 = (1n << 128n) - 1n;

const kind = (text: string, family: 4 | 6) => classifyAddress(text, family).kind;

describe('the implementation list equals the design table', () => {
  it('has the pinned version', () => {
    expect(ADDRESS_POLICY_VERSION).toBe('iana-special-purpose-2025-10-09');
  });

  it('IPv4 prohibited blocks, exactly and in order', () => {
    expect(IPV4_PROHIBITED_BLOCKS.map((block) => block.cidr)).toEqual(DESIGN_IPV4);
  });

  it('IPv6: only 2000::/3, minus exactly the listed blocks', () => {
    expect(IPV6_GLOBAL_UNICAST.cidr).toBe('2000::/3');
    expect(IPV6_PROHIBITED_BLOCKS.map((block) => block.cidr)).toEqual(DESIGN_IPV6);
  });
});

describe('AT-SEC-29: every block is rejected at its first and last address', () => {
  it.each(DESIGN_IPV4)('IPv4 %s', (cidr) => {
    const { first, last } = blockRange(cidr, 4);
    for (const value of [first, last]) {
      expect(kind(ipv4Text(value), 4)).toBe('PROHIBITED');
      expect(v4List.check(ipv4Text(value), 'ipv4')).toBe(true);
    }
  });

  it.each(DESIGN_IPV6)('IPv6 %s', (cidr) => {
    const { first, last } = blockRange(cidr, 6);
    for (const value of [first, last]) {
      expect(kind(ipv6FullText(value), 6)).toBe('PROHIBITED');
    }
  });

  it('IPv6 outside 2000::/3 is rejected at both edges', () => {
    const { first, last } = blockRange('2000::/3', 6);
    expect(kind(ipv6FullText(first - 1n), 6)).toBe('PROHIBITED');
    expect(kind(ipv6FullText(last + 1n), 6)).toBe('PROHIBITED');
    expect(kind(ipv6FullText(0n), 6)).toBe('PROHIBITED');
    expect(kind(ipv6FullText(MAX_V6), 6)).toBe('PROHIBITED');
  });
});

describe('AT-SEC-29: public unicast addresses just outside each block are accepted', () => {
  const v4Public = (value: bigint) =>
    value >= 0n && value <= MAX_V4 && !v4List.check(ipv4Text(value), 'ipv4');
  const v6Public = (value: bigint) =>
    value >= 0n &&
    value <= MAX_V6 &&
    v6Global.check(ipv6FullText(value), 'ipv6') &&
    !v6Prohibited.check(ipv6FullText(value), 'ipv6');

  it.each(DESIGN_IPV4)('IPv4 neighbours of %s', (cidr) => {
    const { first, last } = blockRange(cidr, 4);
    for (const value of [first - 1n, last + 1n].filter(v4Public)) {
      expect(kind(ipv4Text(value), 4)).toBe('ALLOWED');
    }
  });

  it.each([...DESIGN_IPV6, '2000::/3'])('IPv6 neighbours of %s', (cidr) => {
    const { first, last } = blockRange(cidr, 6);
    for (const value of [first - 1n, last + 1n, first, last].filter(v6Public)) {
      expect(kind(ipv6FullText(value), 6)).toBe('ALLOWED');
    }
  });

  it('agrees with the BlockList reference at every IPv4 block edge and neighbour', () => {
    for (const cidr of DESIGN_IPV4) {
      const { first, last } = blockRange(cidr, 4);
      for (const value of [first - 1n, first, last, last + 1n]) {
        if (value < 0n || value > MAX_V4) {
          continue;
        }
        const text = ipv4Text(value);
        expect(kind(text, 4)).toBe(v4List.check(text, 'ipv4') ? 'PROHIBITED' : 'ALLOWED');
      }
    }
  });
});

describe('AT-SEC-07, AT-SEC-08, AT-SEC-09 and the documented exceptions', () => {
  it.each([
    ['loopback', '127.0.0.1', 4],
    ['loopback (IPv6)', '::1', 6],
    ['RFC 1918 10/8', '10.1.2.3', 4],
    ['RFC 1918 172.16/12', '172.31.255.254', 4],
    ['RFC 1918 192.168/16', '192.168.1.1', 4],
    ['link-local', '169.254.10.20', 4],
    ['cloud metadata address', '169.254.169.254', 4],
    ['link-local (IPv6)', 'fe80::1', 6],
    ['CGNAT', '100.64.0.1', 4],
    ['unspecified', '0.0.0.0', 4],
    ['unspecified (IPv6)', '::', 6],
    ['multicast', '224.0.0.1', 4],
    ['multicast (IPv6)', 'ff02::1', 6],
    ['limited broadcast', '255.255.255.255', 4],
    ['unique-local', 'fd00::1', 6],
    ['deprecated site-local', 'fec0::1', 6],
    ['IPv4-mapped of a public address', '::ffff:8.8.8.8', 6],
    ['IPv4-mapped of loopback', '::ffff:127.0.0.1', 6],
    ['IPv4-compatible', '::8.8.8.8', 6],
    ['NAT64 (globally reachable, prohibited)', '64:ff9b::808:808', 6],
    ['local NAT64', '64:ff9b:1::1', 6],
    ['discard-only', '100::1', 6],
    ['SRv6 SIDs', '5f00::1', 6],
    ['PCP anycast (exception)', '192.0.0.9', 4],
    ['TURN anycast (exception)', '192.0.0.10', 4],
    ['AS112-v4 (exception)', '192.31.196.1', 4],
    ['AMT (exception)', '192.52.193.1', 4],
    ['Direct Delegation AS112 (exception)', '192.175.48.1', 4],
    ['6a44 relay', '192.88.99.2', 4],
    ['Teredo', '2001:0:4136:e378:8000:63bf:3fff:fdd2', 6],
    ['PCP anycast IPv6 (exception)', '2001:1::1', 6],
    ['DNS-SD SRP anycast (exception)', '2001:1::3', 6],
    ['AMT IPv6 (exception)', '2001:3::1', 6],
    ['AS112-v6 (exception)', '2001:4:112::1', 6],
    ['ORCHIDv2 (exception)', '2001:20::1', 6],
    ['Drone DETs (exception)', '2001:30::1', 6],
    ['IPv6 documentation', '2001:db8::1', 6],
    ['IPv6 documentation (3fff::/20)', '3fff:fff::1', 6],
    ['6to4', '2002:c000:204::1', 6],
    ['Direct Delegation AS112 IPv6 (exception)', '2620:4f:8000::1', 6],
  ] as const)('%s (%s) is prohibited', (_label, address, family) => {
    expect(kind(address, family)).toBe('PROHIBITED');
  });

  it.each([
    ['8.8.8.8', 4],
    ['1.1.1.1', 4],
    ['23.0.0.1', 4],
    ['2001:4860:4860::8888', 6],
    ['2606:4700:4700::1111', 6],
    ['2600:1406::1', 6],
  ] as const)('the public unicast address %s is allowed', (address, family) => {
    expect(kind(address, family)).toBe('ALLOWED');
  });
});

describe('strict address text', () => {
  it.each([
    ['01.2.3.4', 4],
    ['1.2.3', 4],
    ['256.1.1.1', 4],
    [' 8.8.8.8', 4],
    ['8.8.8.8 ', 4],
    ['0x8.8.8.8', 4],
    ['2001:4860:4860::8888', 4],
    ['8.8.8.8', 6],
    ['fe80::1%eth0', 6],
    ['2001:4860:4860::8888%1', 6],
    ['2001:4860:4860:::8888', 6],
    ['', 6],
  ] as const)('%j is not a valid family %i address', (text, family) => {
    expect(kind(text, family)).toBe('INVALID');
  });

  it.each([
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['2606:4700:4700:0:0:0:0:1111', '2606:4700:4700::1111'],
    ['2001:4860:0:0:1:0:0:1', '2001:4860::1:0:0:1'],
    ['2001:4860:4860:1:2:3:4:5', '2001:4860:4860:1:2:3:4:5'],
    ['2001:4860:4860:0:2:3:4:5', '2001:4860:4860:0:2:3:4:5'],
    ['::FFFF:8.8.8.8', '::ffff:8.8.8.8'],
    ['::', '::'],
  ])('formats %s canonically as %s (RFC 5952)', (text, canonical) => {
    const value = parseIPv6(text);
    expect(value).toBeDefined();
    expect(formatIPv6(value ?? 0n)).toBe(canonical);
  });
});
