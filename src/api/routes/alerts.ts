/**
 * Alert routes (task 16.3; design: API routes; R19.4, R34.1, R34.7).
 *
 * - `GET /alerts?portfolioId=...`: the portfolio's alert history, newest first,
 *   with delivery and dismissal status. Dismissed alerts stay listed (R19.4).
 * - `POST /alerts/:id/dismiss` with an empty JSON body: marks an open alert
 *   `DISMISSED`; nothing is deleted. 404 for an unknown id, 409
 *   `ALERT_NOT_OPEN` for an alert that is no longer open.
 * Responses are validated against the shared contract before they are sent.
 */
import type { FastifyInstance } from 'fastify';
import type { VarAlertService } from '../../app/index.js';
import {
  AlertIdParamsSchema,
  AlertItemSchema,
  AlertsQuerySchema,
  AlertsResponseSchema,
  DismissBodySchema,
} from '../../shared/index.js';
import { sendError } from '../errors.js';
import type { ApiRoutes } from '../server.js';
import { defineRoute } from '../validation.js';

export interface AlertRouteDependencies {
  readonly alerts: Pick<VarAlertService, 'list' | 'dismiss'>;
}

export function alertRoutes(deps: AlertRouteDependencies): ApiRoutes {
  return (app: FastifyInstance) => {
    defineRoute(app, {
      method: 'GET',
      url: '/alerts',
      querystring: AlertsQuerySchema,
      handler: async ({ query }, _request, reply) =>
        reply.send(
          AlertsResponseSchema.parse({ alerts: [...deps.alerts.list(query.portfolioId)].reverse() }),
        ),
    });
    defineRoute(app, {
      method: 'POST',
      url: '/alerts/:id/dismiss',
      params: AlertIdParamsSchema,
      body: DismissBodySchema,
      handler: async ({ params }, request, reply) => {
        const outcome = deps.alerts.dismiss(params.id);
        switch (outcome.status) {
          case 'DISMISSED':
            return reply.send(AlertItemSchema.parse(outcome.alert));
          case 'NOT_FOUND':
            return sendError(reply, request, 404, 'NOT_FOUND', 'The resource was not found.');
          case 'NOT_OPEN':
            return sendError(reply, request, 409, 'ALERT_NOT_OPEN', 'The alert is not open.');
          case 'COMMIT_FAILED':
            return sendError(reply, request, 500, 'INTERNAL_ERROR', 'An internal error occurred.');
        }
      },
    });
  };
}
