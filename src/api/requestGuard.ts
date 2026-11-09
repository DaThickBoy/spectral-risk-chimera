/**
 * Host and Origin request guard for the loopback API (pre-merge hardening of PR #2;
 * design: Gateway rules 2 and 9; OD-7 open).
 *
 * This guard does not replace authentication. The API still has no AuthGuard and
 * listens on 127.0.0.1 only until OD-7 (authentication and any network exposure)
 * is decided. The guard closes two browser-driven paths to that loopback API:
 *
 * - DNS rebinding. A request is accepted only when its `Host` header names the
 *   address the server is actually bound to: `127.0.0.1:<bound port>`, or
 *   `localhost:<bound port>` because the dashboard's development origin is
 *   `http://localhost:5173` or `http://127.0.0.1:5173` and both resolve to the
 *   loopback interface. The bound port is read from the listening socket, so
 *   ephemeral ports (`--port 0`, tests) work. Before the server listens there is
 *   no bound port and every request is refused (fail closed). `X-Forwarded-Host`
 *   and `X-Forwarded-For` are never read.
 * - Cross-site requests (CSRF). `POST`, `PUT`, `PATCH`, and `DELETE` require an
 *   `Origin` header that equals one of the explicitly allowed origins (the same
 *   `--allowed-origin` list as the stream route, validated by the shared
 *   `origin.ts`) exactly. A missing `Origin`, `null`, a malformed value, or any
 *   other origin is refused. There is no wildcard, prefix, or suffix matching, and
 *   no CORS response headers are sent, so no cross-origin read is enabled either.
 *   `GET`, `HEAD`, and `OPTIONS` need no Origin (no CORS headers are sent for
 *   them). Known limitation (Gateway rule 9): a cross-origin GET can still trigger
 *   valuation side effects (provider calls, FX observation records, rate-limit
 *   tokens), but never a portfolio, ledger, or alert change.
 *
 * Refusals use the shared error envelope: 421 `HOST_NOT_ALLOWED` for the Host
 * check and 403 `ORIGIN_FORBIDDEN` for the Origin check. Neither message echoes
 * the received header.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from './errors.js';
import { isAllowedOrigin, parseAllowedOrigins } from './origin.js';

/** The only listen address (see `listenApiServer`). */
const LOOPBACK_ADDRESS = '127.0.0.1';
/** Host names accepted with the bound port; both name the loopback interface. */
const LOOPBACK_HOST_NAMES = ['127.0.0.1', 'localhost'] as const;
/** State-changing methods that require an allowed Origin. */
const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** `host[:port]` with a host of letters, digits, dots, and hyphens, and a decimal port. */
const HOST_HEADER = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/;

export interface RequestGuardOptions {
  /** Exact origins (`scheme://host[:port]`) allowed to send state-changing requests. */
  readonly allowedOrigins: readonly string[];
}

/** The port the server is bound to, or `undefined` before it listens. */
function boundPort(app: FastifyInstance): number | undefined {
  const address = app.server.address();
  if (address === null || typeof address === 'string' || address.address !== LOOPBACK_ADDRESS) {
    return undefined;
  }
  return address.port;
}

/** True when `host` is exactly `127.0.0.1:<port>` or `localhost:<port>` (case-insensitive name). */
export function isAllowedHost(host: unknown, port: number): boolean {
  if (typeof host !== 'string') {
    return false;
  }
  const match = HOST_HEADER.exec(host);
  if (match === null) {
    return false;
  }
  const name = (match[1] ?? '').toLowerCase();
  const portText = match[2];
  // An explicit port is required: the API never listens on a scheme default port it could omit.
  if (portText === undefined || portText !== String(port)) {
    return false;
  }
  return (LOOPBACK_HOST_NAMES as readonly string[]).includes(name);
}

/**
 * Installs the guard as an `onRequest` hook. `createApiServer` calls it right after
 * the correlation-id hook (which only sets a response header), so it runs before
 * rate limiting, body parsing, and every route and plugin.
 * Throws `TypeError` for an invalid allowed-origin list (`origin.ts`).
 */
export function installRequestGuard(app: FastifyInstance, options: RequestGuardOptions): void {
  const allowed = parseAllowedOrigins(options.allowedOrigins);
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const port = boundPort(app);
    if (port === undefined || !isAllowedHost(request.headers.host, port)) {
      return sendError(reply, request, 421, 'HOST_NOT_ALLOWED', 'The request host is not allowed.');
    }
    if (STATE_CHANGING_METHODS.has(request.method) && !isAllowedOrigin(request.headers.origin, allowed)) {
      return sendError(reply, request, 403, 'ORIGIN_FORBIDDEN', 'The origin is not allowed.');
    }
    return undefined;
  });
}
