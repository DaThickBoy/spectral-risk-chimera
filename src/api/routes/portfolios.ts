/**
 * Portfolio routes (task 6.1 `POST /portfolios`; task 11.4
 * `GET /portfolios/:id/positions` and `GET /portfolios/:id/allocation`; design:
 * API routes, Gateway rules; A-7, R5.2, R20.6, R20.8, R4.3, AT-ALC-10).
 *
 * - Requests are validated by the shared Zod contracts (`z.strictObject`): a
 *   portfolio without `cash` is 400 `VALIDATION_FAILED`; cash is never defaulted.
 * - Every response is validated against its shared contract before it is sent,
 *   so a response can never carry a JSON number for a financial value. A
 *   contract failure is a programmer error (500 `INTERNAL_ERROR`).
 */
import type { FastifyInstance } from 'fastify';
import type { PortfolioQueryService, PortfolioService } from '../../app/index.js';
import {
  AllocationResponseSchema,
  PortfolioCreateSchema,
  PortfolioParamsSchema,
  PortfolioSchema,
  PositionsResponseSchema,
} from '../../shared/index.js';
import type { ApiRoutes } from '../server.js';
import { sendError } from '../errors.js';
import { defineRoute } from '../validation.js';

export interface PortfolioRouteDependencies {
  readonly portfolios: PortfolioService;
  /** Task 11.4; omitted until the queries are wired. */
  readonly queries?: PortfolioQueryService;
}

export function portfolioRoutes(deps: PortfolioRouteDependencies): ApiRoutes {
  return (app: FastifyInstance) => {
    defineRoute(app, {
      method: 'POST',
      url: '/portfolios',
      body: PortfolioCreateSchema,
      handler: async ({ body }, request, reply) => {
        const result = deps.portfolios.create({
          id: body.id,
          baseCurrency: body.base_currency,
          cash: body.cash,
        });
        switch (result.status) {
          case 'CREATED': {
            const { id, baseCurrency, cash } = result.portfolio;
            return reply.code(201).send(PortfolioSchema.parse({ id, base_currency: baseCurrency, cash }));
          }
          case 'PORTFOLIO_EXISTS':
            return sendError(reply, request, 409, 'PORTFOLIO_EXISTS', 'The portfolio already exists.');
          case 'BASE_CURRENCY_NOT_SUPPORTED':
            return sendError(
              reply,
              request,
              422,
              'BASE_CURRENCY_NOT_SUPPORTED',
              'The base currency must be the configured base currency.',
            );
          case 'COMMIT_FAILED':
            throw new Error('Portfolio creation could not be committed.');
        }
      },
    });

    const queries = deps.queries;
    if (queries === undefined) {
      return;
    }
    defineRoute(app, {
      method: 'GET',
      url: '/portfolios/:id/positions',
      params: PortfolioParamsSchema,
      handler: async ({ params }, request, reply) => {
        const result = await queries.positions(params.id);
        if (!result.ok) {
          return sendError(reply, request, 404, 'NOT_FOUND', 'The resource was not found.');
        }
        return reply.send(PositionsResponseSchema.parse(result.value));
      },
    });
    defineRoute(app, {
      method: 'GET',
      url: '/portfolios/:id/allocation',
      params: PortfolioParamsSchema,
      handler: async ({ params }, request, reply) => {
        const result = await queries.allocation(params.id);
        if (!result.ok) {
          return sendError(reply, request, 404, 'NOT_FOUND', 'The resource was not found.');
        }
        return reply.send(AllocationResponseSchema.parse(result.value));
      },
    });
  };
}
