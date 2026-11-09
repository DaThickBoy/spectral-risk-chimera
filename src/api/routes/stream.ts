/**
 * `WS /stream` (task 15.1; design: API routes, Gateway rules 2, 3, 4 and 8;
 * R10.5, R16.7, R17.10, R25.1, R26.9, R29.4).
 *
 * Server-to-client push of `SentimentUpdate`, `RiskUpdate`, `ProviderStatus`
 * and (16.3) `AlertRaised` events through a `StreamHub`.
 *
 * - The route runs in its own encapsulated plugin with `@fastify/websocket`, so
 *   the upgrade request passes through the gateway hooks first: correlation id,
 *   rate limiting (each connection attempt takes a token, 429 before upgrade),
 *   and the `AuthGuard` pre-handler when one is supplied. The server stays
 *   loopback-only (`listenApiServer`).
 * - Origin: the `Origin` header must be one of the caller's `allowedOrigins`
 *   (exact match); a missing or other origin is 403 `ORIGIN_FORBIDDEN` before
 *   upgrade, which blocks cross-site WebSocket hijacking and DNS rebinding. The
 *   list is validated by the shared `origin.ts`, as for the HTTP request guard.
 * - Query and path parameters are strict empty Zod objects (400 otherwise).
 * - Inbound: clients may not send messages. Any message closes the connection
 *   with 1008; frames above `STREAM_MAX_INBOUND_BYTES` are refused by `ws`
 *   (1009). Compression is off.
 * - Capacity: at most `hub.maxClients` connections (503 `STREAM_CAPACITY`
 *   before upgrade, close 1013 if a race fills the hub during the upgrade).
 * - Any upgrade request that does not end in a WebSocket (rejected, not found,
 *   or another route) has its socket destroyed after the HTTP response.
 */
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Logger } from '../../shared/index.js';
import { sendError } from '../errors.js';
import { isAllowedOrigin, parseAllowedOrigins } from '../origin.js';
import type { ApiRoutes } from '../server.js';
import type { StreamHub } from '../streamHub.js';

/** Inbound frame limit: clients send nothing, so only control frames need room. */
export const STREAM_MAX_INBOUND_BYTES = 1024;

export interface StreamRouteDependencies {
  readonly hub: StreamHub;
  readonly logger: Logger;
  /** Exact origins (`scheme://host[:port]`) allowed to connect; at least one. */
  readonly allowedOrigins: readonly string[];
}

const EMPTY = z.strictObject({});

export function streamRoutes(deps: StreamRouteDependencies): ApiRoutes {
  // The same validation as the HTTP request guard (origin.ts, Gateway rule 9).
  const allowed = parseAllowedOrigins(deps.allowedOrigins);
  const { hub, logger } = deps;

  return (app: FastifyInstance) => {
    // An upgrade request that got an HTTP response never becomes a WebSocket: free its socket.
    app.addHook('onResponse', async (request) => {
      if (request.headers.upgrade !== undefined) {
        request.raw.socket.destroy();
      }
    });

    void app.register(async (scoped) => {
      await scoped.register(fastifyWebsocket, {
        options: {
          maxPayload: STREAM_MAX_INBOUND_BYTES,
          perMessageDeflate: false,
          clientTracking: true,
        },
        errorHandler: (error, socket) => {
          logger.warn('stream.socket_error', { errorName: error.name });
          socket.terminate();
        },
      });

      scoped.addHook('onRequest', async (request, reply) => {
        if (!isAllowedOrigin(request.headers.origin, allowed)) {
          return sendError(reply, request, 403, 'ORIGIN_FORBIDDEN', 'The origin is not allowed.');
        }
        if (hub.clientCount >= hub.maxClients) {
          return sendError(reply, request, 503, 'STREAM_CAPACITY', 'The stream is at capacity.');
        }
        return undefined;
      });

      scoped.route({
        method: 'GET',
        url: '/stream',
        websocket: true,
        schema: { params: EMPTY, querystring: EMPTY },
        handler: (socket) => {
          if (!hub.add(socket)) {
            socket.close(1013, 'At capacity.');
            return;
          }
          socket.on('message', () => {
            socket.close(1008, 'Client messages are not accepted.');
          });
          socket.on('close', () => {
            hub.remove(socket);
          });
        },
      });
    });
  };
}
