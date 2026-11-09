// Fakes and address helpers for the SEC URL guard tests (task 19.1).
import { BlockList } from 'node:net';
import { createSecUrlGuard } from '../../src/sec/index.js';
import type {
  DnsFamilyAnswer,
  SecAllowedHost,
  SecDnsResolver,
  SecUrlGuard,
  SecurityEvent,
  SecurityEventSink,
} from '../../src/sec/index.js';
import { FakeClock, appError, err, ok } from '../../src/shared/index.js';

export const NOW = '2026-11-07T12:00:00.000Z';

export type FamilyBehaviour = DnsFamilyAnswer | 'THROW' | 'REJECT' | 'MALFORMED_OBJECT';

export interface FakeResolver extends SecDnsResolver {
  readonly calls: { hostname: SecAllowedHost; family: 4 | 6 }[];
}

/** A resolver with a fixed behaviour per family. */
export function fakeResolver(v4: FamilyBehaviour, v6: FamilyBehaviour): FakeResolver {
  const calls: { hostname: SecAllowedHost; family: 4 | 6 }[] = [];
  return {
    calls,
    resolve: async (hostname, family) => {
      calls.push({ hostname, family });
      const behaviour = family === 4 ? v4 : v6;
      if (behaviour === 'THROW') {
        throw new Error('resolver crashed');
      }
      if (behaviour === 'REJECT') {
        return Promise.reject(new Error('resolver rejected'));
      }
      if (behaviour === 'MALFORMED_OBJECT') {
        return { status: 'SURPRISE' } as unknown as DnsFamilyAnswer;
      }
      return behaviour;
    },
  };
}

export const records = (...addresses: string[]): DnsFamilyAnswer => ({ status: 'RECORDS', addresses });
export const NO_DATA: DnsFamilyAnswer = { status: 'NO_DATA' };
export const NOT_FOUND: DnsFamilyAnswer = { status: 'NOT_FOUND' };
export const ERROR: DnsFamilyAnswer = { status: 'ERROR' };

export type SinkMode = 'OK' | 'ERROR_RESULT' | 'THROW' | 'UNDEFINED' | 'PROMISE_OK' | 'PROMISE_REJECT';

export interface RecordingSink extends SecurityEventSink {
  readonly events: SecurityEvent[];
}

/** A sink that records every event and then behaves according to `mode`. */
export function recordingSink(mode: SinkMode = 'OK'): RecordingSink {
  const events: SecurityEvent[] = [];
  return {
    events,
    record: (event) => {
      events.push(event);
      switch (mode) {
        case 'OK':
          return ok(undefined);
        case 'ERROR_RESULT':
          return err(appError('SECURITY_EVENT_NOT_RECORDED', 'audit write failed'));
        case 'THROW':
          throw new Error('sink crashed');
        case 'UNDEFINED':
          return undefined as unknown as ReturnType<SecurityEventSink['record']>;
        case 'PROMISE_OK':
          return Promise.resolve(ok(undefined)) as unknown as ReturnType<SecurityEventSink['record']>;
        case 'PROMISE_REJECT':
          return Promise.reject(new Error('async sink failed')) as unknown as ReturnType<
            SecurityEventSink['record']
          >;
      }
    },
  };
}

export function guardWith(
  resolver: SecDnsResolver = fakeResolver(records('8.8.8.8'), records('2001:4860:4860::8888')),
  sink: RecordingSink = recordingSink(),
): { guard: SecUrlGuard; sink: RecordingSink } {
  return { guard: createSecUrlGuard({ resolver, sink, clock: new FakeClock(NOW) }), sink };
}

// ---- Independent address arithmetic (BigInt text formatting and node:net BlockList membership) ----

export const ipv4Text = (value: bigint): string =>
  [24n, 16n, 8n, 0n].map((shift) => ((value >> shift) & 0xffn).toString()).join('.');

/** Full, uncompressed eight-group IPv6 text. */
export const ipv6FullText = (value: bigint): string =>
  Array.from({ length: 8 }, (_, i) => ((value >> BigInt((7 - i) * 16)) & 0xffffn).toString(16)).join(':');

export interface BlockRange {
  readonly cidr: string;
  readonly first: bigint;
  readonly last: bigint;
}

function parseFull(text: string, family: 4 | 6): bigint {
  if (family === 4) {
    return text.split('.').reduce((acc, part) => (acc << 8n) | BigInt(part), 0n);
  }
  const [head = '', tail = ''] = text.split('::');
  const h = head === '' ? [] : head.split(':');
  const t = tail === '' ? [] : tail.split(':');
  const groups = text.includes('::') ? [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t] : h;
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(`0x${group}`), 0n);
}

export function blockRange(cidr: string, family: 4 | 6): BlockRange {
  const [base = '', prefix = ''] = cidr.split('/');
  const bits = family === 4 ? 32n : 128n;
  const first = parseFull(base, family);
  const size = 1n << (bits - BigInt(prefix));
  return { cidr, first, last: first + size - 1n };
}

export function referenceBlockList(cidrs: readonly string[], family: 4 | 6): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [base = '', prefix = ''] = cidr.split('/');
    list.addSubnet(base, Number.parseInt(prefix, 10), family === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}
