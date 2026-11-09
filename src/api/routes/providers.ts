/**
 * `GET /providers/status` (task 8.3; R25.1, R25.6). Each provider's status,
 * `since`, and last error code, validated against the shared contract before it
 * is sent. No credential, URL, message, or payload is ever included.
 */
import type { FastifyInstance } from 'fastify';
import type { ProviderStatusService } from '../../app/index.js';
import { ProviderStatusResponseSchema } from '../../shared/index.js';
import type { ApiRoutes } from '../server.js';
import { defineRoute } from '../validation.js';

export interface ProviderStatusRouteDependencies {
  readonly providerStatus: ProviderStatusService;
}

export function providerStatusRoutes(deps: ProviderStatusRouteDependencies): ApiRoutes {
  return (app: FastifyInstance) => {
    defineRoute(app, {
      method: 'GET',
      url: '/providers/status',
      handler: async (_input, _request, reply) =>
        reply.send(ProviderStatusResponseSchema.parse(deps.providerStatus.list())),
    });
  };
}
