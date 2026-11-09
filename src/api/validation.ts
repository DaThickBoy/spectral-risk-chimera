/**
 * Zod as the validation authority (task 4.2; design: Gateway rule 4; R29.5,
 * R24.6, AT-SEC-27).
 *
 * `zodValidatorCompiler` lets Fastify validate route `params`, `querystring`, and
 * `body` with project Zod schemas; there is no type-provider dependency. A
 * failure becomes a Fastify validation error, which the error handler turns into
 * 400 `VALIDATION_FAILED` without echoing any input.
 *
 * `defineRoute` makes validation complete: parameters and query default to an
 * empty `z.strictObject`, so unknown query or path fields are always rejected,
 * and the handler receives only parsed values.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifySchemaCompiler } from 'fastify';
import { z } from 'zod';

const EMPTY = z.strictObject({});

class SchemaValidationError extends Error {
  constructor() {
    super('Request validation failed.');
    this.name = 'SchemaValidationError';
  }
}

export const zodValidatorCompiler: FastifySchemaCompiler<unknown> = ({ schema }) => {
  if (!(schema instanceof z.ZodType)) {
    throw new TypeError('Every route schema must be a Zod schema.');
  }
  return (data: unknown) => {
    const parsed = schema.safeParse(data);
    // The error carries no issue details: nothing from the input is echoed.
    return parsed.success ? { value: parsed.data } : { error: new SchemaValidationError() };
  };
};

export interface RouteInput<P, Q, B> {
  readonly params: P;
  readonly query: Q;
  readonly body: B;
}

export interface RouteDefinition<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType> {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly params?: P;
  readonly querystring?: Q;
  /** Required for POST and PUT, except multipart upload routes. */
  readonly body?: B;
  /**
   * Task 4.4: a multipart upload route (POST). It has no JSON body schema, reads its
   * file with `receiveUpload`, and is rate limited as an upload (task 4.3).
   */
  readonly upload?: true;
  readonly handler: (
    input: RouteInput<z.infer<P>, z.infer<Q>, z.infer<B>>,
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<unknown>;
}

/** Registers a route whose parameters, query, and body are all validated by Zod. */
export function defineRoute<
  P extends z.ZodType = typeof EMPTY,
  Q extends z.ZodType = typeof EMPTY,
  B extends z.ZodType = typeof EMPTY,
>(app: FastifyInstance, definition: RouteDefinition<P, Q, B>): void {
  const upload = definition.upload === true;
  if (upload && (definition.method !== 'POST' || definition.body !== undefined)) {
    throw new TypeError(
      `${definition.method} ${definition.url}: an upload route is a POST without a body schema.`,
    );
  }
  const withBody = !upload && (definition.method === 'POST' || definition.method === 'PUT');
  if (withBody && definition.body === undefined) {
    throw new TypeError(`${definition.method} ${definition.url} needs a body schema.`);
  }
  app.route({
    method: definition.method,
    url: definition.url,
    ...(upload ? { config: { rateLimit: 'upload' as const } } : {}),
    schema: {
      params: definition.params ?? EMPTY,
      querystring: definition.querystring ?? EMPTY,
      ...(withBody ? { body: definition.body } : {}),
    },
    handler: (request, reply) =>
      definition.handler(
        {
          params: request.params as z.infer<P>,
          query: request.query as z.infer<Q>,
          body: (withBody ? request.body : undefined) as z.infer<B>,
        },
        request,
        reply,
      ),
  });
}
