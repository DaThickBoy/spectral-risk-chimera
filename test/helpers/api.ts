// Test helpers for the API gateway (task 4.2): a capturing redacting logger and a server factory.
import { createApiServer } from '../../src/api/index.js';
import type { ApiRoutes, AuthGuard, RateLimits, UploadLimits } from '../../src/api/index.js';
import { FakeClock, createLogger } from '../../src/shared/index.js';
import type { Logger } from '../../src/shared/index.js';

export const TEST_SECRET = 'test-api-key-0000';

export interface CapturedLogger {
  readonly logger: Logger;
  readonly lines: Record<string, unknown>[];
}

export function capturingLogger(): CapturedLogger {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    clock: new FakeClock('2026-11-08T12:00:00.000Z'),
    secrets: [TEST_SECRET],
    level: 'debug',
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

export interface TestServerOptions {
  readonly rateLimits?: RateLimits;
  readonly uploads?: UploadLimits;
}

/** Documented class O defaults (60 / 10 per minute, 10 MiB), unless a test overrides them. */
export function testServer(
  routes: readonly ApiRoutes[] = [],
  authGuard?: AuthGuard,
  options: TestServerOptions = {},
) {
  const captured = capturingLogger();
  const clock = new FakeClock('2026-11-08T12:00:00.000Z');
  const app = createApiServer({
    logger: captured.logger,
    clock,
    rateLimits: options.rateLimits ?? { perMinute: 60, uploadPerMinute: 10 },
    uploads: options.uploads ?? { maxFileBytes: 10 * 1024 * 1024 },
    routes,
    ...(authGuard === undefined ? {} : { authGuard }),
  });
  return { app, clock, ...captured };
}

/** Every JSON number anywhere in `value`, with its path. */
export function jsonNumbers(value: unknown, path = '$'): string[] {
  if (typeof value === 'number') {
    return [path];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => jsonNumbers(item, `${path}[${index}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => jsonNumbers(item, `${path}.${key}`));
  }
  return [];
}
