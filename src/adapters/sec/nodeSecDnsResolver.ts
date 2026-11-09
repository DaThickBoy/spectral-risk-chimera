/**
 * Production `SecDnsResolver` (task 19.2; R29.9; design: URL Guard and Client,
 * Production adapters, DNS deadline classification).
 *
 * Each lookup uses a new `dns.promises.Resolver({ timeout, tries: 1 })` and
 * `resolve4` or `resolve6`, which query the DNS servers directly (not the hosts
 * file or `getaddrinfo`). The timeout is the caller's remaining deadline
 * (`context.timeoutMs`), capped by the configured `timeoutMs`; when the caller's
 * signal aborts, the lookup is cancelled with `Resolver.cancel()`.
 *
 * Mapping: records -> RECORDS (unchanged; the guard rejects an empty or malformed
 * list); `ENODATA` -> NO_DATA; `ENOTFOUND` -> NOT_FOUND; `ETIMEOUT` (the
 * resolver's own timeout) and `ECANCELLED` (cancelled at the deadline) ->
 * TIMEOUT, which is never a DNS failure or a security rejection; any other error
 * -> ERROR (a genuine DNS failure, reported by the guard as DNS_FAILED).
 */
import { promises as dns } from 'node:dns';
import type { DnsFamilyAnswer, DnsQueryContext, SecDnsResolver } from '../../sec/index.js';

export interface NodeSecDnsResolverOptions {
  /** Upper bound of each lookup in milliseconds (normally `sec.timeoutMs`). */
  readonly timeoutMs: number;
  /** DNS servers (`host` or `host:port`); the system servers when omitted. */
  readonly servers?: readonly string[];
}

const MAX_TIMEOUT_MS = 2_147_483_647;

/** Maps one family's lookup result to a `DnsFamilyAnswer`. Never rejects. */
export async function toDnsFamilyAnswer(lookup: Promise<readonly string[]>): Promise<DnsFamilyAnswer> {
  try {
    const addresses = await lookup;
    return { status: 'RECORDS', addresses: [...addresses] };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    switch (code) {
      case 'ENODATA':
        return { status: 'NO_DATA' };
      case 'ENOTFOUND':
        return { status: 'NOT_FOUND' };
      case 'ETIMEOUT':
      case 'ECANCELLED':
        return { status: 'TIMEOUT' };
      default:
        return { status: 'ERROR' };
    }
  }
}

export function createNodeSecDnsResolver(options: NodeSecDnsResolverOptions): SecDnsResolver {
  const { timeoutMs, servers } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError('timeoutMs must be a positive 32-bit integer.');
  }
  return {
    resolve: async (hostname, family, context?: DnsQueryContext) => {
      if (context?.signal.aborted === true) {
        return { status: 'TIMEOUT' };
      }
      const budget = context === undefined ? timeoutMs : Math.min(timeoutMs, Math.floor(context.timeoutMs));
      if (!Number.isSafeInteger(budget) || budget < 1) {
        return { status: 'TIMEOUT' };
      }
      const resolver = new dns.Resolver({ timeout: budget, tries: 1 });
      if (servers !== undefined) {
        resolver.setServers([...servers]);
      }
      const cancel = (): void => resolver.cancel();
      context?.signal.addEventListener('abort', cancel, { once: true });
      try {
        return await toDnsFamilyAnswer(
          family === 4 ? resolver.resolve4(hostname) : resolver.resolve6(hostname),
        );
      } finally {
        context?.signal.removeEventListener('abort', cancel);
      }
    },
  };
}
