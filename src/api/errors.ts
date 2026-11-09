/**
 * Generic error and not-found handling (task 4.2; design: Gateway rules 6 and 7;
 * R29.13, AT-SEC-26).
 *
 * Every error body is `{ error: { code, message, correlationId } }` with a fixed,
 * generic message: no stack trace, internal path, or request input ever reaches
 * the client. Unexpected errors are logged through the shared redacting logger
 * with the correlation id; client errors are not logged.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorBody, Logger } from '../shared/index.js';

interface Mapped {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

const MAPPED: Readonly<Record<number, Mapped>> = {
  400: { status: 400, code: 'VALIDATION_FAILED', message: 'The request is invalid.' },
  404: { status: 404, code: 'NOT_FOUND', message: 'The resource was not found.' },
  413: { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' },
  415: { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'The content type is not supported.' },
};
const INTERNAL: Mapped = { status: 500, code: 'INTERNAL_ERROR', message: 'An internal error occurred.' };

/** The error body for `code` with a generic `message`. */
export function errorBody(code: string, message: string, correlationId: string): ApiErrorBody {
  return { error: { code, message, correlationId } };
}

/** Sends an error reply in the gateway shape. */
export function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply
    .code(status)
    .type('application/json')
    .send(errorBody(code, message, request.id));
}

function classify(error: FastifyError): Mapped {
  if (error.validation !== undefined) {
    return MAPPED[400] ?? INTERNAL;
  }
  const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
  return MAPPED[status] ?? INTERNAL;
}

export function installErrorHandling(app: FastifyInstance, logger: Logger): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const mapped = classify(error);
    if (mapped === INTERNAL) {
      logger.child({ correlationId: request.id }).error('Unhandled API error', {
        route: request.routeOptions.url ?? 'unknown',
        method: request.method,
        errorName: error.name,
        errorCode: error.code ?? 'none',
        errorMessage: error.message,
        stack: error.stack ?? '',
      });
    }
    return sendError(reply, request, mapped.status, mapped.code, mapped.message);
  });
  app.setNotFoundHandler((request, reply) =>
    sendError(reply, request, 404, 'NOT_FOUND', 'The resource was not found.'),
  );
}
