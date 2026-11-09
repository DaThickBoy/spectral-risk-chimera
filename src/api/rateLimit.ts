/**
 * Per-client rate limiting (task 4.3; design: API gateway, rate limiting; R29.4,
 * AT-SEC-21).
 *
 * - A token bucket per client for `api.rateLimitPerMinute`, and a second one for
 *   upload routes with `api.uploadRateLimitPerMinute`. An upload is also a
 *   request, so an upload route takes one token from each bucket, and only when
 *   both have one (nothing is taken from either otherwise).
 * - The client key is the socket address (`request.ip`; `trustProxy` is off, so
 *   a forwarded header can never choose the key).
 * - Each bucket holds `limit` tokens and refills continuously at `limit` tokens
 *   per minute, measured on the injected Clock's monotonic time. Arithmetic is
 *   in integers (one token = 60,000 units, refill `limit` units per
 *   millisecond), so there is no floating-point drift. These are counts, not
 *   financial values.
 * - The check runs in `onRequest`, before the body is read or parsed. A denied
 *   request gets 429 `RATE_LIMITED` in the gateway error shape with
 *   `Retry-After` in whole seconds.
 * - Memory stays bounded: when more than `MAX_TRACKED_CLIENTS` buckets exist,
 *   full buckets are dropped (a full bucket is the same as a new one).
 */
import type { FastifyInstance } from 'fastify';
import type { Clock } from '../shared/index.js';
import { sendError } from './errors.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** `upload` routes also consume the upload bucket (task 4.3). */
    rateLimit?: 'upload';
  }
}

export interface RateLimits {
  /** `api.rateLimitPerMinute`: positive integer. */
  readonly perMinute: number;
  /** `api.uploadRateLimitPerMinute`: positive integer. */
  readonly uploadPerMinute: number;
}

const UNITS_PER_TOKEN = 60_000; // one token per minute = 1 unit per millisecond per token of limit
export const MAX_TRACKED_CLIENTS = 10_000;

interface Bucket {
  units: number;
  lastMs: number;
}

export interface TokenBuckets {
  /** Refills and reports whether a token is available, without taking it. */
  available(key: string): boolean;
  /** Takes one token; call only after `available` returned true for the same instant. */
  take(key: string): void;
  /** Whole seconds until the next token for `key` (at least 1). */
  retryAfterSeconds(key: string): number;
}

export function createTokenBuckets(limitPerMinute: number, clock: Clock): TokenBuckets {
  if (!Number.isSafeInteger(limitPerMinute) || limitPerMinute <= 0) {
    throw new TypeError('rate limit must be a positive integer.');
  }
  const capacity = limitPerMinute * UNITS_PER_TOKEN;
  if (!Number.isSafeInteger(capacity)) {
    throw new TypeError('rate limit is too large.');
  }
  const buckets = new Map<string, Bucket>();

  const refill = (key: string): Bucket => {
    const now = clock.monotonicMs();
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      if (buckets.size >= MAX_TRACKED_CLIENTS) {
        for (const [other, entry] of buckets) {
          const elapsed = Math.max(0, Math.floor(now - entry.lastMs));
          if (entry.units + elapsed * limitPerMinute >= capacity) {
            buckets.delete(other);
          }
        }
      }
      bucket = { units: capacity, lastMs: now };
      buckets.set(key, bucket);
      return bucket;
    }
    const elapsed = Math.max(0, Math.floor(now - bucket.lastMs));
    if (elapsed > 0) {
      bucket.units = Math.min(capacity, bucket.units + elapsed * limitPerMinute);
      bucket.lastMs += elapsed;
    }
    return bucket;
  };

  return {
    available: (key) => refill(key).units >= UNITS_PER_TOKEN,
    take: (key) => {
      const bucket = refill(key);
      if (bucket.units < UNITS_PER_TOKEN) {
        throw new Error('No token available.'); // programmer error: check available() first
      }
      bucket.units -= UNITS_PER_TOKEN;
    },
    retryAfterSeconds: (key) => {
      const missing = UNITS_PER_TOKEN - refill(key).units;
      return Math.max(1, Math.ceil(missing / limitPerMinute / 1000));
    },
  };
}

export function installRateLimiting(app: FastifyInstance, limits: RateLimits, clock: Clock): void {
  const general = createTokenBuckets(limits.perMinute, clock);
  const uploads = createTokenBuckets(limits.uploadPerMinute, clock);
  app.addHook('onRequest', async (request, reply) => {
    const key = request.ip;
    const isUpload = request.routeOptions.config.rateLimit === 'upload';
    const generalOk = general.available(key);
    const uploadOk = !isUpload || uploads.available(key);
    if (generalOk && uploadOk) {
      general.take(key);
      if (isUpload) {
        uploads.take(key);
      }
      return;
    }
    const wait = Math.max(
      generalOk ? 0 : general.retryAfterSeconds(key),
      uploadOk ? 0 : uploads.retryAfterSeconds(key),
    );
    reply.header('retry-after', String(wait));
    // Returning the reply ends the request here (async hook contract).
    return sendError(reply, request, 429, 'RATE_LIMITED', 'Too many requests.');
  });
}
