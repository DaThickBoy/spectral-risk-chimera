/**
 * API gateway skeleton (task 4.2; design: Gateway rules 1 to 8; OD-17 Resolved:
 * Fastify 5.12.8; A-15, R24.5, R24.6, R26.9, R29.1, R29.5, R29.13).
 *
 * - `createApiServer` builds a Fastify instance with the built-in logger
 *   disabled, a 1 MiB body limit, prototype and constructor poisoning rejected,
 *   Zod validation, generic error bodies, and one correlation id per request
 *   (also sent as `x-correlation-id`). Client-supplied request ids are ignored.
 * - `listenApiServer` accepts only the host `127.0.0.1` (Gateway rule 2). Any
 *   other host is refused before listening, with or without an `AuthGuard`,
 *   while OD-7 is open. Host and port come from the caller; there is no
 *   configuration key for them (Gateway rule 1).
 * - Routes are registered by the caller through `routes`; the composition root
 *   that wires real services is deferred.
 * - `requestGuard` (Gateway rule 9) installs the Host and Origin guard of
 *   `requestGuard.ts` right after the correlation-id hook, before rate limiting,
 *   body parsing, plugins, and routes. It is mandatory for listening:
 *   `listenApiServer` refuses an instance that was not built with a valid guard
 *   (`ListenRefusedError`, reason `REQUEST_GUARD_MISSING`). An unguarded
 *   instance can still be built for isolated `inject()` tests, which never
 *   listen. The guard does not replace authentication (OD-7).
 */
import fastifyMultipart from '@fastify/multipart';
import { fastify } from 'fastify';
import type { FastifyInstance } from 'fastify';
import { newCorrelationId } from '../shared/index.js';
import type { Clock, Logger } from '../shared/index.js';
import type { AuthGuard } from './auth.js';
import { installErrorHandling } from './errors.js';
import { installRateLimiting } from './rateLimit.js';
import type { RateLimits } from './rateLimit.js';
import { installRequestGuard } from './requestGuard.js';
import type { RequestGuardOptions } from './requestGuard.js';
import { multipartOptions } from './uploads.js';
import type { UploadLimits } from './uploads.js';
import { zodValidatorCompiler } from './validation.js';

/** The only permitted listening host (A-15, Gateway rule 2). */
export const LOOPBACK_HOST = '127.0.0.1';
/** Maximum request body (Gateway rule 5): 1 MiB. */
export const BODY_LIMIT_BYTES = 1_048_576;

export type ApiRoutes = (app: FastifyInstance) => void;

export interface ApiServerOptions {
  readonly logger: Logger;
  /** Monotonic time for rate limiting (task 4.3). */
  readonly clock: Clock;
  /** `api.rateLimitPerMinute` and `api.uploadRateLimitPerMinute` (task 4.3); required, never defaulted here. */
  readonly rateLimits: RateLimits;
  /** `import.maxFileBytes` (task 4.4). */
  readonly uploads: UploadLimits;
  readonly routes?: readonly ApiRoutes[];
  /** Type-only in version 1 (OD-7); never permits a non-loopback host. */
  readonly authGuard?: AuthGuard;
  /**
   * Host and Origin guard (Gateway rule 9). Required for `listenApiServer`; only
   * `inject()` tests may omit it. The composition root always supplies it.
   */
  readonly requestGuard?: RequestGuardOptions;
}

/** Instances built with a successfully installed request guard (Gateway rule 9). */
const guardedServers = new WeakSet<FastifyInstance>();

export interface ListenOptions {
  readonly host: string;
  /** Integer 0 to 65535; 0 picks a free port. */
  readonly port: number;
}

/** Why `listenApiServer` refused: a non-loopback host (rule 2) or no request guard (rule 9). */
export type ListenRefusedReason = 'HOST_NOT_LOOPBACK' | 'REQUEST_GUARD_MISSING';

export class ListenRefusedError extends Error {
  constructor(
    readonly reason: ListenRefusedReason,
    message: string,
  ) {
    super(message);
    this.name = 'ListenRefusedError';
  }
}

export function createApiServer(options: ApiServerOptions): FastifyInstance {
  if (typeof options.logger?.error !== 'function') {
    throw new TypeError('logger must be a Logger.');
  }
  if (typeof options.clock?.monotonicMs !== 'function') {
    throw new TypeError('clock must be a Clock.');
  }
  const app = fastify({
    logger: false,
    bodyLimit: BODY_LIMIT_BYTES,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    requestIdHeader: false,
    genReqId: () => newCorrelationId(),
  });
  // JSON only: Fastify 5 also parses text/plain by default; without it, any other
  // content type is 415 UNSUPPORTED_MEDIA_TYPE.
  app.removeContentTypeParser('text/plain');
  app.setValidatorCompiler(zodValidatorCompiler);
  installErrorHandling(app, options.logger);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
  });
  // Gateway rule 9: Host and Origin first, so a refused request takes no rate-limit token.
  if (options.requestGuard !== undefined) {
    installRequestGuard(app, options.requestGuard); // throws for an invalid origin list
    guardedServers.add(app);
  }
  // Task 4.3: before body parsing, so a limited request costs no parsing.
  installRateLimiting(app, options.rateLimits, options.clock);
  // Task 4.4: multipart parsing for upload routes only (one file, capped size).
  void app.register(fastifyMultipart, multipartOptions(options.uploads));
  const guard = options.authGuard;
  if (guard !== undefined) {
    app.addHook('preHandler', (request, reply) => guard.preHandler(request, reply));
  }
  for (const register of options.routes ?? []) {
    register(app);
  }
  return app;
}

/**
 * Listens on `127.0.0.1` only, and only for an instance built by `createApiServer`
 * with a request guard. Checks run in a fixed order before anything is bound:
 * host (rule 2), port, then the guard (rule 9). Returns the bound address.
 */
export async function listenApiServer(app: FastifyInstance, options: ListenOptions): Promise<string> {
  if (options.host !== LOOPBACK_HOST) {
    throw new ListenRefusedError(
      'HOST_NOT_LOOPBACK',
      `Listening is permitted only on ${LOOPBACK_HOST} until authentication is decided (OD-7).`,
    );
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new TypeError('port must be an integer from 0 to 65535.');
  }
  if (!guardedServers.has(app)) {
    throw new ListenRefusedError(
      'REQUEST_GUARD_MISSING',
      'Listening requires a server built with the Host and Origin request guard (Gateway rule 9).',
    );
  }
  return app.listen({ host: LOOPBACK_HOST, port: options.port });
}
