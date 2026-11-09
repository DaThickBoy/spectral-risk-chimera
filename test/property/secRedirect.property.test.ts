// Property 27: SSRF safety (redirect part, task 19.2)
// Validates: Requirements 29.8, 29.9, 29.10, 29.11
// For generated redirect chains and per-host DNS answers, SecClient sends a request only to a hop
// whose URL validates and whose resolved addresses are all allowed; any violation aborts with
// SEC_URL_REJECTED before anything is sent to the offending target; at most sec.maxRedirects
// redirects are followed. Expectations come from an independent model of the chain, not from the
// implementation.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { DnsFamilyAnswer, SecAllowedHost } from '../../src/sec/index.js';
import { drive } from '../helpers/resilience.js';
import { ok200, redirect, secHarness } from '../helpers/secClient.js';

type HostKey = 'www' | 'data';
const HOSTS: Record<HostKey, SecAllowedHost> = { www: 'www.sec.gov', data: 'data.sec.gov' };
const PUBLIC: Record<HostKey, string> = { www: '8.8.8.8', data: '1.1.1.1' };
const PROHIBITED: Record<HostKey, string> = { www: '10.0.0.1', data: '169.254.169.254' };
const MAX_REDIRECTS = 3;

/** One Location: its text, whether it validates, and its host (undefined: same host as the current hop). */
interface Hop {
  readonly text: (index: number) => string;
  readonly valid: boolean;
  readonly host?: HostKey;
}

const absolute = fc
  .tuple(
    fc.constantFrom(['https', true], ['HTTPS', true], ['http', false]),
    fc.constantFrom(['', true], ['u@', false], ['@', false], ['u:p@', false]),
    fc.constantFrom<readonly [string, HostKey | undefined]>(
      ['www.sec.gov', 'www'],
      ['data.sec.gov', 'data'],
      ['WWW.SEC.GOV', 'www'],
      ['www.sec.gov.', undefined],
      ['evil.example', undefined],
      ['127.0.0.1', undefined],
      ['[::1]', undefined],
    ),
    fc.constantFrom(['', true], [':443', true], [':8443', false]),
    fc.constantFrom(['', true], ['#', false], ['#x', false]),
  )
  .map(([[scheme, s], [user, u], [host, key], [port, p], [fragment, f]]): Hop => ({
    text: (index) => `${scheme}://${user}${host}${port}/hop/${index}${fragment}`,
    valid: (s as boolean) && (u as boolean) && key !== undefined && (p as boolean) && (f as boolean),
    ...(key === undefined ? {} : { host: key }),
  }));

const relative = fc.constantFrom<Hop>(
  { text: (index) => `/hop/${index}`, valid: true },
  { text: (index) => `hop-${index}?x=1`, valid: true },
  { text: (index) => `//evil.example/hop/${index}`, valid: false },
  { text: (index) => `//@www.sec.gov/hop/${index}`, valid: false },
  { text: (index) => `//data.sec.gov/hop/${index}`, valid: true, host: 'data' },
  { text: (index) => `/hop/${index}#`, valid: false },
);

const answer = (address: string): readonly [DnsFamilyAnswer, DnsFamilyAnswer] => [
  { status: 'RECORDS', addresses: [address] },
  { status: 'NO_DATA' },
];

type Expected =
  | { readonly code: 'OK'; readonly hosts: HostKey[] }
  | { readonly code: 'SEC_URL_REJECTED' | 'SEC_TOO_MANY_REDIRECTS'; readonly hosts: HostKey[] };

function model(chain: readonly Hop[], bad: Record<HostKey, boolean>): Expected {
  let current: HostKey = 'www';
  const hosts: HostKey[] = [];
  if (bad[current]) {
    return { code: 'SEC_URL_REJECTED', hosts };
  }
  hosts.push(current);
  for (let index = 0; ; index += 1) {
    const hop = chain[index];
    if (hop === undefined) {
      return { code: 'OK', hosts };
    }
    if (index >= MAX_REDIRECTS) {
      return { code: 'SEC_TOO_MANY_REDIRECTS', hosts };
    }
    if (!hop.valid) {
      return { code: 'SEC_URL_REJECTED', hosts };
    }
    current = hop.host ?? current;
    if (bad[current]) {
      return { code: 'SEC_URL_REJECTED', hosts };
    }
    hosts.push(current);
  }
}

describe('Property 27: SSRF safety across redirect chains', () => {
  it('requests reach only validated hops with allowed addresses; violations abort before sending', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(absolute, relative), { maxLength: 5 }),
        fc.record({ www: fc.boolean(), data: fc.boolean() }),
        async (chain, bad) => {
          const h = secHarness({
            limits: { maxRedirects: MAX_REDIRECTS },
            dns: {
              'www.sec.gov': answer(bad.www ? PROHIBITED.www : PUBLIC.www),
              'data.sec.gov': answer(bad.data ? PROHIBITED.data : PUBLIC.data),
            },
            reply: (_request, index) => {
              const hop = chain[index];
              return hop === undefined ? ok200() : redirect(hop.text(index));
            },
          });
          const result = await drive(h.sleeper, h.client.getText('https://www.sec.gov/start'));
          const expected = model(chain, bad);
          expect(result.ok ? 'OK' : result.error.code).toBe(expected.code);
          expect(h.transport.requests.map((r) => r.hostname)).toEqual(
            expected.hosts.map((key) => HOSTS[key]),
          );
          for (const request of h.transport.requests) {
            const key = request.hostname === 'www.sec.gov' ? 'www' : 'data';
            expect(request.addresses).toEqual([PUBLIC[key]]);
            expect(request.headers['Host']).toBe(request.hostname);
          }
          if (!result.ok && result.error.code === 'SEC_URL_REJECTED') {
            expect(result.error.securityEvent).toBe('RECORDED');
            expect(h.sink.events).toHaveLength(1);
          } else {
            expect(h.sink.events).toEqual([]);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});
