/**
 * Production Node.js HTTPS `SecTransport` (task 19.2; R24.8, R29.9, R33.6; design:
 * URL Guard and Client, Production adapters).
 *
 * - One GET per call through `node:https` `request` with an explicit
 *   `NoReuseAgent` created for that request only (keep-alive off, one socket, no
 *   free sockets, no TLS session cache) and destroyed when it ends, so
 *   `https.globalAgent` is never used and no socket is reused across requests,
 *   retries, or redirect hops. The agent's `createConnection` returns the socket
 *   from the socket factory. `setHost: false` (the client's `Host` header is used).
 * - The default factory is verified TLS to port 443 of the pinned addresses:
 *   `host` and `servername` are the allowlisted hostname (SNI, certificate and
 *   hostname verification), `lookup` is the pinned lookup, and
 *   `rejectUnauthorized` is always true. There is no CA, identity-check, or
 *   verification option.
 * - The pinned lookup answers only for the pinned hostname with the guard's
 *   validated addresses (all of them for `all: true`, filtered by a requested
 *   family); any other name is refused. Nothing else is resolved or connected to.
 * - `socketFactory` is a TEST-ONLY seam (design: Testing seam). Production code
 *   never passes it.
 * - Responses: `Location` values come from the raw headers; the first
 *   `Retry-After` and `Content-Type` are kept. A non-2xx response is destroyed
 *   unread. For a 2xx, a `Content-Encoding` other than identity is
 *   INVALID_RESPONSE; a `Content-Length` or a streamed byte count above
 *   `maxBytes` is TOO_LARGE. Abort is TIMEOUT, a TLS verification error is TLS
 *   (no detail passed on), anything else is NETWORK. `request` never rejects.
 * - No proxy support, compression, cookies, or authorization.
 */
import type { IncomingMessage } from 'node:http';
import { Agent, request } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect } from 'node:tls';
import type { ConnectionOptions } from 'node:tls';
import type { ResolvedSecHost, SecAllowedHost, SecTransport, SecTransportOutcome } from '../../sec/index.js';

export interface SecSocketTarget {
  readonly hostname: SecAllowedHost;
  readonly addresses: ResolvedSecHost['addresses'];
  readonly port: 443;
  /** The pinned lookup for this target. */
  readonly lookup: LookupFunction;
}

/** TEST-ONLY seam. Production never passes one; the default is verified TLS to port 443. */
export type SecSocketFactory = (target: SecSocketTarget) => Duplex;

export interface NodeSecTransportOptions {
  /** TEST-ONLY seam; production never passes it. */
  readonly socketFactory?: SecSocketFactory;
  /** TEST-ONLY observer of the per-request agent (for reuse checks); production never passes it. */
  readonly onAgent?: (agent: NoReuseAgent) => void;
}

const TLS_ERROR_CODE = /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/;

function isTlsVerificationError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TLS_ERROR_CODE.test(code);
}

/** A lookup that returns only the pinned, validated addresses of the pinned hostname. */
export function pinnedLookup(host: ResolvedSecHost): LookupFunction {
  return (hostname, options, callback) => {
    const requested = options.family;
    const wanted =
      requested === 4 || requested === 'IPv4' ? 4 : requested === 6 || requested === 'IPv6' ? 6 : 0;
    const matches = host.addresses.filter((entry) => wanted === 0 || entry.family === wanted);
    const [first] = matches;
    queueMicrotask(() => {
      if (hostname !== host.hostname || first === undefined) {
        callback(Object.assign(new Error('Lookup refused.'), { code: 'ENOTFOUND' }), '', 0);
        return;
      }
      if (options.all === true) {
        callback(
          null,
          matches.map((entry) => ({ address: entry.address, family: entry.family })),
        );
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}

/** The exact TLS options of the default (production) socket factory. */
export function defaultTlsOptions(target: SecSocketTarget): ConnectionOptions & { autoSelectFamily: true } {
  return {
    host: target.hostname,
    port: 443,
    servername: target.hostname,
    lookup: target.lookup,
    autoSelectFamily: true,
    ALPNProtocols: ['http/1.1'],
    rejectUnauthorized: true,
  };
}

const verifiedTlsSocket: SecSocketFactory = (target) => connect(defaultTlsOptions(target));

/**
 * The exact options of every per-request agent: nothing is kept for reuse.
 * `maxFreeSockets` is 1 because Node treats 0 as unset (256); with keep-alive off,
 * Node destroys a socket as soon as it is freed, so the free pool stays empty.
 */
export const NO_REUSE_AGENT_OPTIONS = Object.freeze({
  keepAlive: false,
  maxSockets: 1,
  maxFreeSockets: 1,
  maxCachedSessions: 0,
});

/**
 * An `https.Agent` for exactly one request. Keep-alive is off, it holds at most
 * one socket and no free sockets, and it caches no TLS sessions. Its
 * `createConnection` returns the pinned socket from the factory (verified TLS by
 * default), so Node's own `tls.connect`, DNS lookup, and `https.globalAgent` are
 * never used. A new agent is created for every request (including every retry and
 * redirect hop) and destroyed when the request ends, so no socket can be reused.
 */
export class NoReuseAgent extends Agent {
  private connections = 0;

  constructor(private readonly open: () => Duplex) {
    super(NO_REUSE_AGENT_OPTIONS);
  }

  /** Sockets opened by this agent (never more than one). */
  get opened(): number {
    return this.connections;
  }

  override createConnection(): Duplex {
    this.connections += 1;
    if (this.connections > 1) {
      throw new Error('NoReuseAgent opens one connection only.');
    }
    return this.open();
  }
}

interface ResponseHeaders {
  readonly locations: string[];
  readonly retryAfter?: string;
  readonly contentType?: string;
  readonly contentLength?: string;
  readonly encodings: string[];
}

function readHeaders(raw: readonly string[]): ResponseHeaders {
  const locations: string[] = [];
  const encodings: string[] = [];
  let retryAfter: string | undefined;
  let contentType: string | undefined;
  let contentLength: string | undefined;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = (raw[i] ?? '').toLowerCase();
    const value = raw[i + 1] ?? '';
    if (name === 'location') {
      locations.push(value);
    } else if (name === 'retry-after') {
      retryAfter ??= value;
    } else if (name === 'content-type') {
      contentType ??= value;
    } else if (name === 'content-length') {
      contentLength ??= value;
    } else if (name === 'content-encoding') {
      encodings.push(value);
    }
  }
  return {
    locations,
    encodings,
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(contentLength === undefined ? {} : { contentLength }),
  };
}

const isIdentityEncoding = (value: string): boolean =>
  value
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .every((token) => token === '' || token === 'identity');

function readBody(response: IncomingMessage, maxBytes: number): Promise<Uint8Array | 'TOO_LARGE'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    response.on('data', (chunk: Buffer) => {
      if (finished) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        finished = true;
        response.destroy();
        resolve('TOO_LARGE');
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      if (!finished) {
        finished = true;
        resolve(new Uint8Array(Buffer.concat(chunks)));
      }
    });
    response.on('error', (error) => {
      if (!finished) {
        finished = true;
        reject(error);
      }
    });
    response.on('close', () => {
      if (!finished) {
        finished = true;
        reject(new Error('Response closed before the end of the body.'));
      }
    });
  });
}

async function handleResponse(response: IncomingMessage, maxBytes: number): Promise<SecTransportOutcome> {
  const status = response.statusCode ?? 0;
  const headers = readHeaders(response.rawHeaders);
  const base = {
    ok: true as const,
    status,
    locations: headers.locations,
    ...(headers.retryAfter === undefined ? {} : { retryAfter: headers.retryAfter }),
    ...(headers.contentType === undefined ? {} : { contentType: headers.contentType }),
  };
  if (status < 200 || status > 299) {
    response.destroy();
    return { ...base, body: new Uint8Array(0) };
  }
  if (!headers.encodings.every(isIdentityEncoding)) {
    response.destroy();
    return { ok: false, failure: 'INVALID_RESPONSE' };
  }
  const declared = headers.contentLength?.trim();
  if (declared !== undefined && /^\d+$/.test(declared) && BigInt(declared) > BigInt(maxBytes)) {
    response.destroy();
    return { ok: false, failure: 'TOO_LARGE' };
  }
  const body = await readBody(response, maxBytes);
  if (body === 'TOO_LARGE') {
    return { ok: false, failure: 'TOO_LARGE' };
  }
  return { ...base, body };
}

export function createNodeSecTransport(options: NodeSecTransportOptions = {}): SecTransport {
  const socketFactory = options.socketFactory ?? verifiedTlsSocket;
  const { onAgent } = options;
  return {
    request: (req) =>
      new Promise<SecTransportOutcome>((resolve) => {
        let settled = false;
        const done = (outcome: SecTransportOutcome): void => {
          if (!settled) {
            settled = true;
            resolve(outcome);
          }
        };
        const classify = (error: unknown): SecTransportOutcome =>
          req.signal.aborted
            ? { ok: false, failure: 'TIMEOUT' }
            : isTlsVerificationError(error)
              ? { ok: false, failure: 'TLS' }
              : { ok: false, failure: 'NETWORK' };
        if (req.signal.aborted) {
          done({ ok: false, failure: 'TIMEOUT' });
          return;
        }
        const target: SecSocketTarget = {
          hostname: req.host.hostname,
          addresses: req.host.addresses,
          port: 443,
          lookup: pinnedLookup(req.host),
        };
        const agent = new NoReuseAgent(() => socketFactory(target));
        onAgent?.(agent);
        const finish = (outcome: SecTransportOutcome): void => {
          // Destroying the agent closes its socket; nothing survives this request.
          agent.destroy();
          done(outcome);
        };
        try {
          const outgoing = request({
            method: 'GET',
            host: req.host.hostname,
            port: 443,
            path: req.path,
            headers: { ...req.headers },
            agent,
            setHost: false,
            signal: req.signal,
          });
          outgoing.on('error', (error) => finish(classify(error)));
          outgoing.on('response', (response) => {
            handleResponse(response, req.maxBytes).then(finish, (error: unknown) => finish(classify(error)));
          });
          outgoing.end();
        } catch (error) {
          finish(classify(error));
        }
      }),
  };
}
