// Gateway rule 9 (pre-merge hardening of PR #2): the Host and Origin request guard on a real
// loopback socket with an ephemeral port. Requests are sent with node:http so that any Host
// header can be set. Not authentication: OD-7 stays open.
// Validates: Requirements 29.1, 29.13
import { request as httpRequest } from 'node:http';
import { fastify } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { z } from 'zod';
import {
  ListenRefusedError,
  canonicalOrigin,
  createApiServer,
  createStreamHub,
  defineRoute,
  isAllowedHost,
  isAllowedOrigin,
  listenApiServer,
  streamRoutes,
} from '../../src/api/index.js';
import type { ApiRoutes } from '../../src/api/index.js';
import { ApiErrorBodySchema, FakeClock } from '../../src/shared/index.js';
import { capturingLogger } from '../helpers/api.js';

const ORIGIN = 'http://127.0.0.1:5173';
const SECOND_ORIGIN = 'http://localhost:5173';

interface Reply {
  readonly status: number;
  readonly body: string;
}

/** One raw HTTP request to 127.0.0.1:port with exactly the given headers. */
function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body = '',
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        setHost: false,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const writes: string[] = [];
const routes: ApiRoutes = (app) => {
  defineRoute(app, {
    method: 'GET',
    url: '/things',
    handler: async () => ({ things: writes.length }),
  });
  // defineRoute validates a JSON body for POST and PUT only and has no PATCH; the guard is
  // global, so a plain Fastify PATCH route is guarded the same way.
  for (const method of ['POST', 'PUT', 'DELETE'] as const) {
    defineRoute(app, {
      method,
      url: '/things',
      body: z.strictObject({ name: z.string() }),
      handler: async (_input, _request, reply) => {
        writes.push(`${method}:x`);
        return reply.code(201).send({ ok: true });
      },
    });
  }
  app.route({
    method: 'PATCH',
    url: '/things',
    handler: async (_request, reply) => {
      writes.push('PATCH:x');
      return reply.code(201).send({ ok: true });
    },
  });
};

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  writes.splice(0);
});

async function guarded(allowedOrigins: readonly string[] = [ORIGIN, SECOND_ORIGIN]) {
  const { logger } = capturingLogger();
  const app = createApiServer({
    logger,
    clock: new FakeClock('2026-11-08T12:00:00.000Z'),
    rateLimits: { perMinute: 1000, uploadPerMinute: 1000 },
    uploads: { maxFileBytes: 1024 },
    routes: [routes],
    requestGuard: { allowedOrigins },
  });
  servers.push({ close: () => app.close() });
  const address = await listenApiServer(app, { host: '127.0.0.1', port: 0 });
  const port = Number(new URL(address).port);
  return { app, port };
}

const json = { 'content-type': 'application/json' };
const BODY = JSON.stringify({ name: 'x' });

function errorCode(reply: Reply): string {
  return ApiErrorBodySchema.parse(JSON.parse(reply.body)).error.code;
}

describe('Gateway rule 9: Host validation (DNS rebinding)', () => {
  it('accepts 127.0.0.1:<bound port> and localhost:<bound port> on an ephemeral port', async () => {
    const { port } = await guarded();
    expect(port).toBeGreaterThan(0);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      const reply = await send(port, 'GET', '/things', { host });
      expect(reply.status, host).toBe(200);
    }
  });

  it.each([
    ['an attacker domain', 'evil.example'],
    ['an attacker domain with the bound port', 'evil.example:PORT'],
    ['a rebinding name resolving to loopback', 'rebind.evil.example:PORT'],
    ['an unexpected port', '127.0.0.1:1'],
    ['localhost with an unexpected port', 'localhost:1'],
    ['no port', '127.0.0.1'],
    ['localhost without a port', 'localhost'],
    ['another loopback address', '127.0.0.2:PORT'],
    ['IPv6 loopback', '[::1]:PORT'],
    ['a trailing dot', 'localhost.:PORT'],
    ['userinfo', 'user@127.0.0.1:PORT'],
    ['an empty value', ''],
    ['a malformed port', '127.0.0.1:PORTx'],
    ['two hosts', '127.0.0.1:PORT, evil.example'],
  ])('refuses %s with 421 HOST_NOT_ALLOWED, without echoing it', async (_name, template) => {
    const { port } = await guarded();
    const host = template.replaceAll('PORT', String(port));
    const reply = await send(port, 'GET', '/things', { host });
    expect(reply.status).toBe(421);
    expect(errorCode(reply)).toBe('HOST_NOT_ALLOWED');
    expect(reply.body).not.toContain('evil');
  });

  it('a missing Host header is refused (Node rejects HTTP/1.1 without Host with 400 first)', async () => {
    const { port } = await guarded();
    const read = await send(port, 'GET', '/things', {});
    expect(read.status).toBe(400);
    const write = await send(port, 'POST', '/things', { origin: ORIGIN, ...json }, BODY);
    expect(write.status).toBe(400);
    expect(writes).toEqual([]);
  });

  it('X-Forwarded-Host and X-Forwarded-For never make a foreign Host acceptable', async () => {
    const { port } = await guarded();
    const refused = await send(port, 'GET', '/things', {
      host: 'evil.example',
      'x-forwarded-host': `127.0.0.1:${port}`,
      'x-forwarded-for': '127.0.0.1',
    });
    expect(refused.status).toBe(421);
    const accepted = await send(port, 'GET', '/things', {
      host: `127.0.0.1:${port}`,
      'x-forwarded-host': 'evil.example',
    });
    expect(accepted.status).toBe(200);
  });

  it('a refused Host never reaches a write handler, even with an allowed Origin', async () => {
    const { port } = await guarded();
    const reply = await send(
      port,
      'POST',
      '/things',
      { host: 'evil.example', origin: ORIGIN, ...json },
      BODY,
    );
    expect(reply.status).toBe(421);
    expect(writes).toEqual([]);
  });

  it('an instance built without the guard cannot listen (REQUEST_GUARD_MISSING); inject() still works', async () => {
    const { logger } = capturingLogger();
    const app = createApiServer({
      logger,
      clock: new FakeClock('2026-11-08T12:00:00.000Z'),
      rateLimits: { perMinute: 1000, uploadPerMinute: 1000 },
      uploads: { maxFileBytes: 1024 },
      routes: [routes],
    });
    servers.push({ close: () => app.close() });
    await expect(listenApiServer(app, { host: '127.0.0.1', port: 0 })).rejects.toMatchObject({
      name: 'ListenRefusedError',
      reason: 'REQUEST_GUARD_MISSING',
      message: 'Listening requires a server built with the Host and Origin request guard (Gateway rule 9).',
    });
    await expect(listenApiServer(app, { host: '127.0.0.1', port: 0 })).rejects.toBeInstanceOf(
      ListenRefusedError,
    );
    expect(app.server.listening).toBe(false);
    // Isolated inject() tests keep working on the unguarded instance.
    const injected = await app.inject({ method: 'GET', url: '/things' });
    expect(injected.statusCode).toBe(200);
  });

  it('a plain Fastify instance (not built by createApiServer) cannot listen either', async () => {
    const app = fastify();
    servers.push({ close: () => app.close() });
    await expect(listenApiServer(app, { host: '127.0.0.1', port: 0 })).rejects.toMatchObject({
      reason: 'REQUEST_GUARD_MISSING',
    });
    expect(app.server.listening).toBe(false);
  });

  it('an instance whose guard configuration is invalid is never built', () => {
    const { logger } = capturingLogger();
    expect(() =>
      createApiServer({
        logger,
        clock: new FakeClock('2026-11-08T12:00:00.000Z'),
        rateLimits: { perMinute: 1, uploadPerMinute: 1 },
        uploads: { maxFileBytes: 1 },
        requestGuard: { allowedOrigins: ['*'] },
      }),
    ).toThrow(TypeError);
  });

  it('a guarded instance listens on an ephemeral port and serves with that port in Host', async () => {
    const first = await guarded();
    const second = await guarded();
    expect(first.app.server.listening).toBe(true);
    expect(first.port).not.toBe(second.port);
    expect((await send(first.port, 'GET', '/things', { host: `127.0.0.1:${first.port}` })).status).toBe(200);
    // Each instance accepts only its own bound port.
    expect((await send(first.port, 'GET', '/things', { host: `127.0.0.1:${second.port}` })).status).toBe(421);
  });

  it('before the server listens, every request is refused (fail closed)', async () => {
    const { logger } = capturingLogger();
    const app = createApiServer({
      logger,
      clock: new FakeClock('2026-11-08T12:00:00.000Z'),
      rateLimits: { perMinute: 1000, uploadPerMinute: 1000 },
      uploads: { maxFileBytes: 1024 },
      routes: [routes],
      requestGuard: { allowedOrigins: [ORIGIN] },
    });
    servers.push({ close: () => app.close() });
    const reply = await app.inject({ method: 'GET', url: '/things', headers: { host: '127.0.0.1:80' } });
    expect(reply.statusCode).toBe(421);
  });
});

describe('Gateway rule 9: Origin validation for state-changing methods (CSRF)', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    '%s with an allowed Origin reaches the handler',
    async (method) => {
      const { port } = await guarded();
      const reply = await send(
        port,
        method,
        '/things',
        { host: `127.0.0.1:${port}`, origin: ORIGIN, ...json },
        BODY,
      );
      expect(reply.status).toBe(201);
      expect(writes).toEqual([`${method}:x`]);
    },
  );

  it('each configured origin is accepted exactly (second origin, localhost Host)', async () => {
    const { port } = await guarded();
    const reply = await send(
      port,
      'POST',
      '/things',
      { host: `localhost:${port}`, origin: SECOND_ORIGIN, ...json },
      BODY,
    );
    expect(reply.status).toBe(201);
  });

  const refusedOrigins: [string, string | undefined][] = [
    ['a missing Origin', undefined],
    ['an attacker origin', 'https://evil.example'],
    ['the opaque origin null', 'null'],
    ['an empty Origin', ''],
    ['a malformed Origin', 'not a url'],
    ['another port', 'http://127.0.0.1:5174'],
    ['another scheme', 'https://127.0.0.1:5173'],
    ['a trailing slash', 'http://127.0.0.1:5173/'],
    ['upper case', 'HTTP://127.0.0.1:5173'],
    ['a suffix of an allowed origin', 'http://127.0.0.1:5173.evil.example'],
    ['an allowed origin as a prefix', 'http://127.0.0.1:51730'],
    ['a list of origins', `${ORIGIN} https://evil.example`],
  ];
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    it.each(refusedOrigins)(
      `${method} with %s is 403 ORIGIN_FORBIDDEN and writes nothing`,
      async (_name, origin) => {
        const { port } = await guarded();
        const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...json };
        if (origin !== undefined) headers['origin'] = origin;
        const reply = await send(port, method, '/things', headers, BODY);
        expect(reply.status).toBe(403);
        expect(errorCode(reply)).toBe('ORIGIN_FORBIDDEN');
        expect(reply.body).not.toContain('evil');
        expect(writes).toEqual([]);
      },
    );
  }

  it('read-only requests need no Origin, and a foreign Origin on GET is not a write', async () => {
    const { port } = await guarded();
    expect((await send(port, 'GET', '/things', { host: `127.0.0.1:${port}` })).status).toBe(200);
    expect((await send(port, 'HEAD', '/things', { host: `127.0.0.1:${port}` })).status).toBe(200);
    const foreign = await send(port, 'GET', '/things', {
      host: `127.0.0.1:${port}`,
      origin: 'https://evil.example',
    });
    expect(foreign.status).toBe(200);
  });

  it('no permissive CORS: no Access-Control-* header is ever sent', async () => {
    const { app } = await guarded();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/things',
      headers: {
        host: '127.0.0.1:1',
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
      },
    });
    expect(Object.keys(preflight.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
  });
});

describe('Gateway rule 9: configuration and matching helpers', () => {
  it('the guard refuses an empty or non-canonical allowed-origin list at construction', () => {
    const { logger } = capturingLogger();
    const build = (allowedOrigins: readonly string[]) => () =>
      createApiServer({
        logger,
        clock: new FakeClock('2026-11-08T12:00:00.000Z'),
        rateLimits: { perMinute: 1, uploadPerMinute: 1 },
        uploads: { maxFileBytes: 1 },
        requestGuard: { allowedOrigins },
      });
    expect(build([])).toThrow(TypeError);
    expect(build(['*'])).toThrow(TypeError);
    expect(build(['null'])).toThrow(TypeError);
    expect(build(['http://127.0.0.1:5173/'])).toThrow(TypeError);
    expect(build(['ftp://127.0.0.1'])).toThrow(TypeError);
    expect(build([ORIGIN])).not.toThrow();
  });

  it('canonicalOrigin, isAllowedHost, and isAllowedOrigin use exact comparison only', () => {
    expect(canonicalOrigin(ORIGIN)).toBe(ORIGIN);
    expect(canonicalOrigin('http://127.0.0.1:80')).toBeUndefined(); // canonical form omits :80
    expect(isAllowedHost('127.0.0.1:8080', 8080)).toBe(true);
    expect(isAllowedHost('127.0.0.1:08080', 8080)).toBe(false);
    expect(isAllowedHost(undefined, 8080)).toBe(false);
    expect(isAllowedHost(['127.0.0.1:8080'], 8080)).toBe(false);
    const allowed = new Set([ORIGIN]);
    expect(isAllowedOrigin(ORIGIN, allowed)).toBe(true);
    expect(isAllowedOrigin([ORIGIN], allowed)).toBe(false);
    expect(isAllowedOrigin(undefined, allowed)).toBe(false);
  });
});

describe('shared origin rule at runtime: HTTP writes and the /stream upgrade accept the same origins', () => {
  /** A guarded server with a POST route and /stream, both from the same --allowed-origin list. */
  async function combined(allowedOrigins: readonly string[]) {
    const { logger } = capturingLogger();
    const hub = createStreamHub({ logger, maxClients: 8, maxBufferedBytes: 65_536 });
    const app = createApiServer({
      logger,
      clock: new FakeClock('2026-11-08T12:00:00.000Z'),
      rateLimits: { perMinute: 1000, uploadPerMinute: 1000 },
      uploads: { maxFileBytes: 1024 },
      routes: [routes, streamRoutes({ hub, logger, allowedOrigins })],
      requestGuard: { allowedOrigins },
    });
    servers.push({ close: () => app.close() });
    const address = await listenApiServer(app, { host: '127.0.0.1', port: 0 });
    return { port: Number(new URL(address).port), base: address.replace(/^http/, 'ws') };
  }

  /** 101 when the upgrade succeeds, otherwise the HTTP status of the refusal. `host` overrides Host. */
  function upgradeStatus(url: string, origin: string | undefined, host?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        ...(origin === undefined ? {} : { origin }),
        ...(host === undefined ? {} : { headers: { host } }),
      });
      ws.on('open', () => {
        ws.terminate();
        resolve(101);
      });
      ws.on('unexpected-response', (_req, res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      ws.on('error', (error) => {
        if (ws.readyState === WebSocket.CLOSED) return; // after an unexpected response
        reject(error);
      });
    });
  }

  it.each([
    ['the first allowed origin', ORIGIN, true],
    ['the second allowed origin', SECOND_ORIGIN, true],
    ['an attacker origin', 'https://evil.example', false],
    ['null', 'null', false],
    ['another port', 'http://127.0.0.1:5174', false],
    ['a trailing slash', `${ORIGIN}/`, false],
    ['a suffix attack', 'http://127.0.0.1:5173.evil.example', false],
    ['no Origin', undefined, false],
  ])('%s: both accept, or both refuse with 403', async (_name, origin, accepted) => {
    const { port, base } = await combined([ORIGIN, SECOND_ORIGIN]);
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...json };
    if (origin !== undefined) headers['origin'] = origin;
    const write = await send(port, 'POST', '/things', headers, BODY);
    const upgrade = await upgradeStatus(`${base}/stream`, origin);
    expect(write.status).toBe(accepted ? 201 : 403);
    expect(upgrade).toBe(accepted ? 101 : 403);
  });

  it('a /stream upgrade with a disallowed Host is 421 even with an allowed Origin; allowed Hosts upgrade', async () => {
    const { port, base } = await combined([ORIGIN]);
    const url = `${base}/stream`;
    for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1:1', `[::1]:${port}`]) {
      expect(await upgradeStatus(url, ORIGIN, host), host).toBe(421);
    }
    expect(await upgradeStatus(url, ORIGIN, `127.0.0.1:${port}`)).toBe(101);
    expect(await upgradeStatus(url, ORIGIN, `localhost:${port}`)).toBe(101);
  });
});
