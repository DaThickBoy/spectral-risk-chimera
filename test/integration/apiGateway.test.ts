// Task 4.2: gateway skeleton with validation and safe errors (design: Gateway rules 1 to 8;
// OD-17 Resolved, Fastify 5.12.8). Uses Fastify inject(); one test binds a real loopback socket.
// Tests: AT-SEC-26, AT-SEC-27
// Validates: Requirements 24.5, 24.6, 26.9, 29.1, 29.5, 29.13
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BODY_LIMIT_BYTES,
  LOOPBACK_HOST,
  ListenRefusedError,
  defineRoute,
  listenApiServer,
} from '../../src/api/index.js';
import type { ApiRoutes, AuthGuard } from '../../src/api/index.js';
import { ApiErrorBodySchema, DecimalStringSchema } from '../../src/shared/index.js';
import { TEST_SECRET, testServer } from '../helpers/api.js';

const echoRoutes: ApiRoutes = (app) => {
  defineRoute(app, {
    method: 'POST',
    url: '/echo/:name',
    params: z.strictObject({ name: z.string().regex(/^[a-z]+$/) }),
    querystring: z.strictObject({ mode: z.enum(['a', 'b']).optional() }),
    body: z.strictObject({ amount: DecimalStringSchema }),
    handler: async ({ params, query, body }) => ({
      name: params.name,
      mode: query.mode ?? null,
      amount: body.amount,
    }),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/boom',
    handler: async () => {
      throw new Error(`database at C:\\secret\\path failed with ${TEST_SECRET}`);
    },
  });
};

const post = (body: unknown, url = '/echo/abc', headers: Record<string, string> = {}) => ({
  method: 'POST' as const,
  url,
  headers: { 'content-type': 'application/json', ...headers },
  payload: typeof body === 'string' ? body : JSON.stringify(body),
});

function errorOf(payload: string) {
  return ApiErrorBodySchema.parse(JSON.parse(payload)).error;
}

describe('AT-SEC-27: unknown fields and invalid input are rejected (Zod is the authority)', () => {
  it('a valid request passes with parsed values', async () => {
    const { app } = testServer([echoRoutes]);
    const response = await app.inject(post({ amount: '12.50' }, '/echo/abc?mode=a'));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ name: 'abc', mode: 'a', amount: '12.50' });
  });

  it.each([
    ['an unknown body field', post({ amount: '1', extra: 'x' })],
    ['an unknown query field', post({ amount: '1' }, '/echo/abc?other=1')],
    ['an invalid path parameter', post({ amount: '1' }, '/echo/ABC')],
    ['a JSON number for a financial field', post({ amount: 12.5 })],
    ['exponent notation', post({ amount: '1e5' })],
    ['a missing field', post({})],
    ['malformed JSON', post('{"amount": "1"')],
    ['a prototype-poisoning key', post('{"amount":"1","__proto__":{"x":1}}')],
    ['a constructor-poisoning key', post('{"amount":"1","constructor":{"prototype":{"x":1}}}')],
  ])('%s gives 400 VALIDATION_FAILED without echoing the input', async (_name, request) => {
    const { app } = testServer([echoRoutes]);
    const response = await app.inject(request);
    expect(response.statusCode).toBe(400);
    const error = errorOf(response.payload);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toBe('The request is invalid.');
    expect(response.payload).not.toMatch(/extra|other|ABC|12\.5|1e5|__proto__|constructor/);
  });

  it('a route without a body schema for POST cannot be defined', () => {
    const routes: ApiRoutes = (app) =>
      defineRoute(app, { method: 'POST', url: '/x', handler: async () => ({}) });
    expect(() => testServer([routes])).toThrow(TypeError);
  });

  it('a non-Zod schema is refused when routes are compiled', async () => {
    const { app } = testServer([
      (instance) =>
        instance.route({
          method: 'GET',
          url: '/raw',
          schema: { querystring: { type: 'object' } },
          handler: async () => ({}),
        }),
    ]);
    await expect(app.ready()).rejects.toThrow();
  });
});

describe('AT-SEC-26: internal errors return a generic body with a correlation id', () => {
  it('no stack trace, internal path, or secret reaches the client; the error is logged redacted', async () => {
    const { app, lines } = testServer([echoRoutes]);
    const response = await app.inject({ method: 'GET', url: '/boom' });
    expect(response.statusCode).toBe(500);
    const error = errorOf(response.payload);
    expect(error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred.',
      correlationId: response.headers['x-correlation-id'],
    });
    expect(response.payload).not.toMatch(/secret|path|at |\.ts|Error:/);
    expect(response.payload).not.toContain(TEST_SECRET);
    const logged = lines.find((line) => line.msg === 'Unhandled API error');
    expect(logged).toMatchObject({ level: 'error', correlationId: error.correlationId });
    expect(JSON.stringify(lines)).not.toContain(TEST_SECRET);
  });

  it('unknown routes are 404 NOT_FOUND in the same shape; client errors are not logged', async () => {
    const { app, lines } = testServer([echoRoutes]);
    const response = await app.inject({ method: 'GET', url: '/nowhere?x=1' });
    expect(response.statusCode).toBe(404);
    expect(errorOf(response.payload)).toMatchObject({
      code: 'NOT_FOUND',
      message: 'The resource was not found.',
    });
    expect(lines).toEqual([]);
  });

  it('every response carries a fresh server correlation id; a client-supplied id is ignored', async () => {
    const { app } = testServer([echoRoutes]);
    const first = await app.inject({
      method: 'GET',
      url: '/nowhere',
      headers: { 'request-id': 'client-id' },
    });
    const second = await app.inject({ method: 'GET', url: '/nowhere' });
    const id = first.headers['x-correlation-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(id).not.toBe('client-id');
    expect(errorOf(first.payload).correlationId).toBe(id);
    expect(second.headers['x-correlation-id']).not.toBe(id);
  });
});

describe('Gateway rule 5: body limit and media types', () => {
  it(`a body over ${BODY_LIMIT_BYTES} bytes is 413 PAYLOAD_TOO_LARGE`, async () => {
    const { app } = testServer([echoRoutes]);
    const response = await app.inject(post({ amount: '1', pad: 'x'.repeat(BODY_LIMIT_BYTES) }));
    expect(response.statusCode).toBe(413);
    expect(errorOf(response.payload).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('a non-JSON content type is 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const { app } = testServer([echoRoutes]);
    const response = await app.inject({
      method: 'POST',
      url: '/echo/abc',
      headers: { 'content-type': 'application/xml' },
      payload: '<amount>1</amount>',
    });
    expect(response.statusCode).toBe(415);
    expect(errorOf(response.payload).code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('Gateway rule 2: loopback only', () => {
  it.each(['0.0.0.0', 'localhost', '::1', '::', '192.168.1.10', '127.0.0.2', ' 127.0.0.1'])(
    'listening on %j is refused before binding',
    async (host) => {
      // An unguarded instance: HOST_NOT_LOOPBACK (not REQUEST_GUARD_MISSING) proves the host
      // check runs before the request-guard check (Gateway rules 2 and 9).
      const { app } = testServer();
      const refused = listenApiServer(app, { host, port: 0 });
      await expect(refused).rejects.toBeInstanceOf(ListenRefusedError);
      await expect(refused).rejects.toMatchObject({ reason: 'HOST_NOT_LOOPBACK' });
      expect(app.server.listening).toBe(false);
    },
  );

  it('a non-loopback host is refused even with an AuthGuard (OD-7 open)', async () => {
    const guard: AuthGuard = { name: 'test-guard', preHandler: async () => undefined };
    const { app } = testServer([], guard);
    await expect(listenApiServer(app, { host: '0.0.0.0', port: 0 })).rejects.toBeInstanceOf(
      ListenRefusedError,
    );
    expect(app.server.listening).toBe(false);
  });

  it('an invalid port is refused', async () => {
    const { app } = testServer();
    await expect(listenApiServer(app, { host: LOOPBACK_HOST, port: 70_000 })).rejects.toThrow(TypeError);
  });

  it('127.0.0.1 binds and serves (with the mandatory request guard, Gateway rule 9)', async () => {
    const { app } = testServer([echoRoutes], undefined, {
      requestGuard: { allowedOrigins: ['http://127.0.0.1:5173'] },
    });
    const address = await listenApiServer(app, { host: LOOPBACK_HOST, port: 0 });
    try {
      expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const response = await fetch(`${address}/nowhere`);
      expect(response.status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('a host refusal carries reason HOST_NOT_LOOPBACK', async () => {
    const { app } = testServer([], undefined, {
      requestGuard: { allowedOrigins: ['http://127.0.0.1:5173'] },
    });
    await expect(listenApiServer(app, { host: '0.0.0.0', port: 0 })).rejects.toMatchObject({
      name: 'ListenRefusedError',
      reason: 'HOST_NOT_LOOPBACK',
    });
    expect(app.server.listening).toBe(false);
  });
});

describe('Gateway rule 3: AuthGuard is a pre-handler hook', () => {
  it('a supplied guard runs before the handler and can deny', async () => {
    const guard: AuthGuard = {
      name: 'deny-all',
      preHandler: async (_request, reply) => {
        await reply.code(403).send({ denied: true });
      },
    };
    const { app } = testServer([echoRoutes], guard);
    const response = await app.inject(post({ amount: '1' }));
    expect(response.statusCode).toBe(403);
  });
});

describe('OD-17 conditions', () => {
  it('fastify is pinned exactly to 5.12.8', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies.fastify).toBe('5.12.8');
  });

  it('a text/plain body is not parsed (JSON only)', async () => {
    const { app } = testServer([echoRoutes]);
    const response = await app.inject({
      method: 'POST',
      url: '/echo/abc',
      headers: { 'content-type': 'text/plain' },
      payload: '{"amount":"1"}',
    });
    expect(response.statusCode).toBe(415);
  });
});
