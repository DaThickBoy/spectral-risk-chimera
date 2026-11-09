/**
 * Address policy `iana-special-purpose-2025-10-09` (task 19.1; design: URL Guard
 * and Client, address policy; R29.9).
 *
 * Only globally reachable unicast addresses are allowed. Sources, pinned:
 * - IANA IPv4 Special-Purpose Address Space, Last Updated 2025-10-09: every block
 *   is prohibited, whatever its "Globally Reachable" value (explicit exceptions:
 *   192.0.0.9/32 and 192.0.0.10/32 inside 192.0.0.0/24, AS112 192.31.196.0/24 and
 *   192.175.48.0/24, AMT 192.52.193.0/24).
 * - RFC 5771: IPv4 multicast 224.0.0.0/4.
 * - RFC 4291 section 2.4: IPv6 global unicast 2000::/3. Everything outside it is
 *   prohibited (loopback, unspecified, IPv4-mapped and -compatible, NAT64
 *   including the globally reachable 64:ff9b::/96, discard, SRv6, unique-local,
 *   link-local, site-local, multicast).
 * - IANA IPv6 Special-Purpose Address Space, Last Updated 2025-10-09: the blocks
 *   inside 2000::/3 are prohibited, including the globally reachable ones
 *   (anycast, AMT, AS112-v6, ORCHIDv2, DETs within 2001::/23, and
 *   2620:4f:8000::/48).
 *
 * The block list is fixed data; the unit tests compare it with the design table.
 * Changing it requires a new policy version and a reviewed change. Address text is
 * parsed strictly (no zone index, no leading zeros in IPv4 octets); text that is
 * not a valid address of the expected family is reported as invalid, never guessed.
 */
import { isIPv6 } from 'node:net';

export const ADDRESS_POLICY_VERSION = 'iana-special-purpose-2025-10-09';

export interface PolicyBlock {
  readonly cidr: string;
  readonly name: string;
}

/** Prohibited IPv4 blocks, in the design's table order. */
export const IPV4_PROHIBITED_BLOCKS: readonly PolicyBlock[] = [
  { cidr: '0.0.0.0/8', name: '"This network" (includes 0.0.0.0/32)' },
  { cidr: '10.0.0.0/8', name: 'Private-Use (RFC 1918)' },
  { cidr: '100.64.0.0/10', name: 'Shared Address Space (CGNAT)' },
  { cidr: '127.0.0.0/8', name: 'Loopback' },
  { cidr: '169.254.0.0/16', name: 'Link Local (includes 169.254.169.254)' },
  { cidr: '172.16.0.0/12', name: 'Private-Use (RFC 1918)' },
  {
    cidr: '192.0.0.0/24',
    name: 'IETF Protocol Assignments (includes globally reachable 192.0.0.9/32, 192.0.0.10/32)',
  },
  { cidr: '192.0.2.0/24', name: 'Documentation (TEST-NET-1)' },
  { cidr: '192.31.196.0/24', name: 'AS112-v4 (globally reachable, prohibited)' },
  { cidr: '192.52.193.0/24', name: 'AMT (globally reachable, prohibited)' },
  { cidr: '192.88.99.0/24', name: 'Deprecated (6to4 Relay Anycast), includes 192.88.99.2/32' },
  { cidr: '192.168.0.0/16', name: 'Private-Use (RFC 1918)' },
  { cidr: '192.175.48.0/24', name: 'Direct Delegation AS112 Service (globally reachable, prohibited)' },
  { cidr: '198.18.0.0/15', name: 'Benchmarking' },
  { cidr: '198.51.100.0/24', name: 'Documentation (TEST-NET-2)' },
  { cidr: '203.0.113.0/24', name: 'Documentation (TEST-NET-3)' },
  { cidr: '224.0.0.0/4', name: 'Multicast (RFC 5771)' },
  { cidr: '240.0.0.0/4', name: 'Reserved (includes 255.255.255.255/32)' },
];

/** The only IPv6 range in which an address may be allowed. */
export const IPV6_GLOBAL_UNICAST: PolicyBlock = {
  cidr: '2000::/3',
  name: 'Global Unicast (RFC 4291 section 2.4)',
};

/** Prohibited IPv6 blocks inside 2000::/3, in the design's table order. */
export const IPV6_PROHIBITED_BLOCKS: readonly PolicyBlock[] = [
  {
    cidr: '2001::/23',
    name: 'IETF Protocol Assignments (includes globally reachable anycast, AMT, AS112-v6, ORCHIDv2, DETs)',
  },
  { cidr: '2001:db8::/32', name: 'Documentation' },
  { cidr: '2002::/16', name: '6to4' },
  { cidr: '2620:4f:8000::/48', name: 'Direct Delegation AS112 Service (globally reachable, prohibited)' },
  { cidr: '3fff::/20', name: 'Documentation' },
];

export type AddressFamily = 4 | 6;

/** Classification of one address text. `INVALID` means the text is not a valid address of the family. */
export type AddressClass =
  | { readonly kind: 'ALLOWED'; readonly canonical: string }
  | { readonly kind: 'PROHIBITED'; readonly canonical: string }
  | { readonly kind: 'INVALID' };

const IPV4_OCTET = /^(?:0|[1-9]\d{0,2})$/;

/** Strict dotted-quad IPv4 (four decimal octets 0-255, no leading zeros). */
export function parseIPv4(text: string): bigint | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) {
    return undefined;
  }
  let value = 0n;
  for (const part of parts) {
    if (!IPV4_OCTET.test(part)) {
      return undefined;
    }
    const octet = BigInt(part);
    if (octet > 255n) {
      return undefined;
    }
    value = (value << 8n) | octet;
  }
  return value;
}

/** Strict IPv6 text (no zone index); an embedded dotted IPv4 tail is accepted as the last 32 bits. */
export function parseIPv6(text: string): bigint | undefined {
  if (text.includes('%') || !isIPv6(text)) {
    return undefined;
  }
  let groupsText = text;
  const tail: bigint[] = [];
  if (text.includes('.')) {
    const cut = text.lastIndexOf(':');
    const v4 = parseIPv4(text.slice(cut + 1));
    if (v4 === undefined) {
      return undefined;
    }
    tail.push(v4 >> 16n, v4 & 0xffffn);
    groupsText = text.slice(0, cut + 1);
    if (groupsText.endsWith(':') && !groupsText.endsWith('::')) {
      groupsText = groupsText.slice(0, -1);
    }
  }
  const halves = groupsText.split('::');
  if (halves.length > 2) {
    return undefined;
  }
  const toGroups = (part: string | undefined): bigint[] =>
    part === undefined || part === '' ? [] : part.split(':').map((group) => BigInt(`0x${group}`));
  const head = toGroups(halves[0]);
  const rest = [...toGroups(halves[1]), ...tail];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) {
    return undefined;
  }
  const groups = [...head, ...Array.from({ length: halves.length === 1 ? 0 : missing }, () => 0n), ...rest];
  return groups.reduce((acc, group) => (acc << 16n) | group, 0n);
}

export function formatIPv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => ((value >> shift) & 0xffn).toString()).join('.');
}

/** RFC 5952 text: lowercase, no leading zeros, longest zero run (at least two groups) compressed; IPv4-mapped as ::ffff:a.b.c.d. */
export function formatIPv6(value: bigint): string {
  if (value >> 32n === 0xffffn) {
    return `::ffff:${formatIPv4(value & 0xffffffffn)}`;
  }
  const groups = Array.from({ length: 8 }, (_, index) => (value >> BigInt((7 - index) * 16)) & 0xffffn);
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < 8; start += 1) {
    let length = 0;
    while (start + length < 8 && groups[start + length] === 0n) {
      length += 1;
    }
    if (length > bestLength && length >= 2) {
      bestStart = start;
      bestLength = length;
    }
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestStart < 0) {
    return hex.join(':');
  }
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

interface ParsedBlock {
  readonly network: bigint;
  readonly mask: bigint;
}

function parseBlock(cidr: string, family: AddressFamily): ParsedBlock {
  const [base = '', prefixText = ''] = cidr.split('/');
  const bits = family === 4 ? 32n : 128n;
  const prefix = BigInt(prefixText);
  const network = family === 4 ? parseIPv4(base) : parseIPv6(base);
  if (network === undefined || prefix < 0n || prefix > bits) {
    throw new Error(`Invalid policy block ${cidr}.`);
  }
  const all = (1n << bits) - 1n;
  const mask = all ^ ((1n << (bits - prefix)) - 1n);
  if ((network & mask) !== network) {
    throw new Error(`Policy block ${cidr} has host bits set.`);
  }
  return { network, mask };
}

const V4_BLOCKS = IPV4_PROHIBITED_BLOCKS.map((block) => parseBlock(block.cidr, 4));
const V6_GLOBAL = parseBlock(IPV6_GLOBAL_UNICAST.cidr, 6);
const V6_BLOCKS = IPV6_PROHIBITED_BLOCKS.map((block) => parseBlock(block.cidr, 6));

const inBlock = (value: bigint, block: ParsedBlock): boolean => (value & block.mask) === block.network;

/** Classifies one resolved address text of the given family under the pinned policy. */
export function classifyAddress(text: string, family: AddressFamily): AddressClass {
  if (typeof text !== 'string') {
    return { kind: 'INVALID' };
  }
  if (family === 4) {
    const value = parseIPv4(text);
    if (value === undefined) {
      return { kind: 'INVALID' };
    }
    const canonical = formatIPv4(value);
    return V4_BLOCKS.some((block) => inBlock(value, block))
      ? { kind: 'PROHIBITED', canonical }
      : { kind: 'ALLOWED', canonical };
  }
  const value = parseIPv6(text);
  if (value === undefined) {
    return { kind: 'INVALID' };
  }
  const canonical = formatIPv6(value);
  const allowed = inBlock(value, V6_GLOBAL) && !V6_BLOCKS.some((block) => inBlock(value, block));
  return allowed ? { kind: 'ALLOWED', canonical } : { kind: 'PROHIBITED', canonical };
}
