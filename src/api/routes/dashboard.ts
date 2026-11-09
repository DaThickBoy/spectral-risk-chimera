/**
 * Read-only dashboard routes (tasks 17.1 to 17.3; design: Dashboard route;
 * Kiroween decision DR-KW-1 H4).
 *
 * - `GET /dashboard`: the portfolios the dashboard lists.
 * - `GET /dashboard/portfolios/:id`: one `DashboardViewResponse`; 404 when the
 *   portfolio is unknown or has no stored result yet.
 * Both are GET only and change nothing. Responses are validated against the shared
 * contracts before they are sent, so the same bodies can be stored verbatim as the
 * recorded responses of the static replay.
 */
import type { FastifyInstance } from 'fastify';
import type { DashboardService } from '../../app/index.js';
import {
  DashboardIndexResponseSchema,
  DashboardViewResponseSchema,
  PortfolioParamsSchema,
} from '../../shared/index.js';
import type { ApiRoutes } from '../server.js';
import { sendError } from '../errors.js';
import { defineRoute } from '../validation.js';

export interface DashboardRouteDependencies {
  readonly dashboard: DashboardService;
}

export function dashboardRoutes(deps: DashboardRouteDependencies): ApiRoutes {
  return (app: FastifyInstance) => {
    defineRoute(app, {
      method: 'GET',
      url: '/dashboard',
      handler: async (_input, _request, reply) =>
        reply.send(DashboardIndexResponseSchema.parse(deps.dashboard.index())),
    });
    defineRoute(app, {
      method: 'GET',
      url: '/dashboard/portfolios/:id',
      params: PortfolioParamsSchema,
      handler: async ({ params }, request, reply) => {
        const result = await deps.dashboard.view(params.id);
        if (!result.ok) {
          return sendError(reply, request, 404, 'NOT_FOUND', 'The resource was not found.');
        }
        return reply.send(DashboardViewResponseSchema.parse(result.value));
      },
    });
  };
}
