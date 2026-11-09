/**
 * Risk and snapshot routes (task 12.6; design: API routes, Gateway rules; R13.7,
 * R14.10, R14.12, R17.10, R22.5, R35.6).
 *
 * - `GET /portfolios/:id/risk`: the latest stored result with Base and Adjusted
 *   VaR as separate `VarEntry` objects. An unavailable figure is `null` with its
 *   validity, status, reason, and missing keys; an earlier figure appears only as
 *   `lastValid` with its calculation time. 404 when the portfolio has no result.
 * - `GET /portfolios/:id/snapshots/:hash`: the stored full snapshot (including
 *   `displayOnly`) with that hash, 404 when there is none.
 * Responses are validated against the shared contracts before they are sent, so
 * no financial value can be a JSON number.
 */
import type { FastifyInstance } from 'fastify';
import type { RiskService } from '../../app/index.js';
import {
  PortfolioParamsSchema,
  RiskResponseSchema,
  SnapshotParamsSchema,
  SnapshotResponseSchema,
} from '../../shared/index.js';
import type { ApiRoutes } from '../server.js';
import { sendError } from '../errors.js';
import { defineRoute } from '../validation.js';

export interface RiskRouteDependencies {
  readonly risk: RiskService;
}

export function riskRoutes(deps: RiskRouteDependencies): ApiRoutes {
  return (app: FastifyInstance) => {
    defineRoute(app, {
      method: 'GET',
      url: '/portfolios/:id/risk',
      params: PortfolioParamsSchema,
      handler: async ({ params }, request, reply) => {
        const view = deps.risk.view(params.id);
        if (view === undefined) {
          return sendError(reply, request, 404, 'NOT_FOUND', 'The resource was not found.');
        }
        return reply.send(RiskResponseSchema.parse(view));
      },
    });
    defineRoute(app, {
      method: 'GET',
      url: '/portfolios/:id/snapshots/:hash',
      params: SnapshotParamsSchema,
      handler: async ({ params }, request, reply) => {
        const stored = deps.risk.snapshot(params.id, params.hash);
        if (stored === undefined) {
          return sendError(reply, request, 404, 'NOT_FOUND', 'The resource was not found.');
        }
        return reply.send(
          SnapshotResponseSchema.parse({
            portfolioId: stored.portfolioId,
            hash: stored.hash,
            createdAt: stored.createdAt,
            evaluatedAt: stored.evaluatedAt,
            snapshot: JSON.parse(stored.snapshot) as unknown, // canonical JSON stored by the snapshot service
          }),
        );
      },
    });
  };
}
