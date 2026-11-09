// Task 4.3: per-client rate limiting (design: API gateway, rate limiting). Uses Fastify inject() and
// a FakeClock for monotonic time.
// Tests: AT-SEC-21
// Validates: Requirements 29.4
import { describe, expect, it } from 'vitest';
import {
  MAX_TRACKED_CLIENTS,
  createTokenBuckets,
  defineRoute,
  receiveUpload,
  sendUploadRejection,
} from '../../src/api/index.js';
import type { ApiRoutes } from '../../src/api/index.js';
import { FakeClock, sequentialIds } from '../../src/shared/index.js';
import { z } from 'zod';
import { testServer } from '../helpers/api.js';
import { multipart } from '../helpers/multipart.js';

const routes: ApiRoutes = (app) => {
  defineRoute(app, { method: 'GET', url: '/ping', handler: async () => ({ ok: true }) });
  defineRoute(app, {
    method: 'POST',
    url: '/echo',
    body: z.strictObject({ value: z.string() }),
    handler: async ({ body }) => body,
  });
  const ids = sequentialIds('up');
  defineRoute(app, {
    method: 'POST',
    url: '/upload',
    upload: true,
    handler: async (_input, request, reply) => {
      const result = await receiveUpload(request, ids);
      return result.ok
        ? { stored: result.upload.storedName }
        : sendUploadRejection(reply, request, result.reason);
    },
  });
};

const ping = { method: 'GET' as const, url: '/ping' };
const upload = () => ({
  method: 'POST' as const,
  url: '/upload',
  ...multipart([{ name: 'file', filename: 'a.csv', content: 'x' }]),
});

describe('AT-SEC-21: the request after the limit receives 429', () => {
  it('three per minute: the fourth request is 429 RATE_LIMITED with Retry-After and the gateway body', async () => {
    const { app } = testServer([routes], undefined, { rateLimits: { perMinute: 3, uploadPerMinute: 1 } });
    for (let i = 0; i < 3; i += 1) {
      expect((await app.inject(ping)).statusCode).toBe(200);
    }
    const limited = await app.inject(ping);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('20');
    expect(limited.json()).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests.',
        correlationId: limited.headers['x-correlation-id'],
      },
    });
  });

  it('capacity refills over time: one token per 60/limit seconds, never above the limit', async () => {
    const { app, clock } = testServer([routes], undefined, {
      rateLimits: { perMinute: 3, uploadPerMinute: 1 },
    });
    for (let i = 0; i < 3; i += 1) {
      await app.inject(ping);
    }
    clock.advance(19_999);
    expect((await app.inject(ping)).statusCode).toBe(429);
    clock.advance(1);
    expect((await app.inject(ping)).statusCode).toBe(200);
    expect((await app.inject(ping)).statusCode).toBe(429);
    clock.advance(10 * 60_000); // a long idle period refills to the limit only
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await app.inject(ping)).statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('a limited request is rejected before its body is parsed (429, not 400 or 413)', async () => {
    const { app } = testServer([routes], undefined, { rateLimits: { perMinute: 1, uploadPerMinute: 1 } });
    await app.inject(ping);
    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"value": broken',
    });
    expect(response.statusCode).toBe(429);
  });

  it('unknown routes count too; a forwarded header cannot choose another bucket', async () => {
    const { app } = testServer([routes], undefined, { rateLimits: { perMinute: 2, uploadPerMinute: 1 } });
    expect((await app.inject({ method: 'GET', url: '/nowhere' })).statusCode).toBe(404);
    expect((await app.inject(ping)).statusCode).toBe(200);
    const spoofed = await app.inject({ ...ping, headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(spoofed.statusCode).toBe(429);
  });
});

describe('Upload limit (api.uploadRateLimitPerMinute)', () => {
  it('uploads have their own, lower limit; other requests stay available', async () => {
    const { app } = testServer([routes], undefined, { rateLimits: { perMinute: 10, uploadPerMinute: 2 } });
    expect((await app.inject(upload())).statusCode).toBe(200);
    expect((await app.inject(upload())).statusCode).toBe(200);
    const limited = await app.inject(upload());
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('30');
    expect((await app.inject(ping)).statusCode).toBe(200);
  });

  it('an upload also counts as a request, and a denied upload consumes no general token', async () => {
    const { app } = testServer([routes], undefined, { rateLimits: { perMinute: 3, uploadPerMinute: 1 } });
    expect((await app.inject(upload())).statusCode).toBe(200); // general 2 left, upload 0 left
    expect((await app.inject(upload())).statusCode).toBe(429); // denied by the upload bucket only
    expect((await app.inject(ping)).statusCode).toBe(200);
    expect((await app.inject(ping)).statusCode).toBe(200);
    expect((await app.inject(ping)).statusCode).toBe(429);
  });
});

describe('createTokenBuckets', () => {
  it('rejects a non-positive or non-integer limit', () => {
    const clock = new FakeClock('2026-11-08T12:00:00.000Z');
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => createTokenBuckets(bad, clock)).toThrow(TypeError);
    }
  });

  it('memory stays bounded: full buckets are dropped beyond MAX_TRACKED_CLIENTS', () => {
    const clock = new FakeClock('2026-11-08T12:00:00.000Z');
    const buckets = createTokenBuckets(5, clock);
    for (let i = 0; i <= MAX_TRACKED_CLIENTS; i += 1) {
      expect(buckets.available(`client-${i}`)).toBe(true);
    }
    buckets.take('busy');
    expect(buckets.retryAfterSeconds('busy')).toBe(1);
    // A dropped full bucket behaves exactly like a new one.
    expect(buckets.available('client-0')).toBe(true);
  });
});
