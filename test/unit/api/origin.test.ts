// Shared allowed-origin validation (src/api/origin.ts; design: Gateway rule 9 and the WebSocket
// gateway): one canonical-origin rule for the HTTP request guard and the /stream route.
// Validates: Requirements 29.1, 29.4
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ORIGINS_INVALID,
  canonicalOrigin,
  createApiServer,
  createStreamHub,
  isAllowedOrigin,
  parseAllowedOrigins,
  streamRoutes,
} from '../../../src/api/index.js';
import { FakeClock } from '../../../src/shared/index.js';
import { capturingLogger } from '../../helpers/api.js';

const VALID = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1',
  'https://dashboard.example',
  'https://dashboard.example:8443',
  'http://[::1]:5173',
];

const INVALID: [string, unknown][] = [
  ['a path', 'http://127.0.0.1:5173/app'],
  ['a trailing slash', 'http://127.0.0.1:5173/'],
  ['credentials', 'http://user:pw@127.0.0.1:5173'],
  ['a user name only', 'http://user@127.0.0.1:5173'],
  ['a query', 'http://127.0.0.1:5173?x=1'],
  ['a fragment', 'http://127.0.0.1:5173#x'],
  ['an upper-case scheme', 'HTTP://127.0.0.1:5173'],
  ['an upper-case host', 'http://LOCALHOST:5173'],
  ['a default port written out (http)', 'http://127.0.0.1:80'],
  ['a default port written out (https)', 'https://dashboard.example:443'],
  ['the opaque origin null', 'null'],
  ['a wildcard', '*'],
  ['an empty string', ''],
  ['surrounding whitespace', ' http://127.0.0.1:5173'],
  ['no scheme', '127.0.0.1:5173'],
  ['a WebSocket scheme', 'ws://127.0.0.1:5173'],
  ['a file URL', 'file:///tmp'],
  ['a data URL', 'data:text/plain,x'],
  ['malformed', 'http://'],
  ['a number', 5173],
  ['undefined', undefined],
];

describe('canonicalOrigin: exact http(s) origins only', () => {
  it.each(VALID)('%s is accepted unchanged', (value) => {
    expect(canonicalOrigin(value)).toBe(value);
  });

  it.each(INVALID)('%s is rejected', (_name, value) => {
    expect(canonicalOrigin(value)).toBeUndefined();
  });
});

describe('parseAllowedOrigins and isAllowedOrigin: exact matching only', () => {
  it('returns the list as a set; an empty list or a non-array is refused', () => {
    expect([...parseAllowedOrigins(VALID)]).toEqual(VALID);
    expect(() => parseAllowedOrigins([])).toThrow(new TypeError(ALLOWED_ORIGINS_INVALID));
    expect(() => parseAllowedOrigins('http://127.0.0.1:5173')).toThrow(TypeError);
    expect(() => parseAllowedOrigins(undefined)).toThrow(TypeError);
  });

  it('one invalid entry refuses the whole list (nothing is dropped)', () => {
    expect(() => parseAllowedOrigins(['http://127.0.0.1:5173', 'http://127.0.0.1:5173/'])).toThrow(
      new TypeError(ALLOWED_ORIGINS_INVALID),
    );
  });

  it.each([
    ['the allowed origin', 'http://127.0.0.1:5173', true],
    ['another port', 'http://127.0.0.1:5174', false],
    ['a prefix of the allowed origin', 'http://127.0.0.1:517', false],
    ['the allowed origin as a prefix', 'http://127.0.0.1:51730', false],
    ['a suffix attack', 'http://127.0.0.1:5173.evil.example', false],
    ['another case', 'http://LOCALHOST:5173', false],
    ['a list of origins', 'http://127.0.0.1:5173, https://evil.example', false],
    ['null', 'null', false],
  ])('%s: %s -> %s', (_name, received, expected) => {
    const allowed = parseAllowedOrigins(['http://127.0.0.1:5173', 'http://localhost:5173']);
    expect(isAllowedOrigin(received, allowed)).toBe(expected);
  });

  it('a "*" inside a host is canonical text to the URL parser, but it is only ever compared literally', () => {
    // WHATWG URL accepts "*" in a host, so this value passes the canonical-origin rule (unchanged
    // behaviour). It has no wildcard meaning: matching is exact equality, so no real origin matches it.
    const allowed = parseAllowedOrigins(['https://*.example', 'https://*']);
    expect(isAllowedOrigin('https://a.example', allowed)).toBe(false);
    expect(isAllowedOrigin('https://example', allowed)).toBe(false);
    expect(isAllowedOrigin('https://evil.example', allowed)).toBe(false);
    expect(isAllowedOrigin('https://*.example', allowed)).toBe(true);
  });

  it('non-string header values never match', () => {
    const allowed = parseAllowedOrigins(['http://127.0.0.1:5173']);
    expect(isAllowedOrigin(undefined, allowed)).toBe(false);
    expect(isAllowedOrigin(['http://127.0.0.1:5173'], allowed)).toBe(false);
  });
});

describe('both consumers apply the same configuration rule', () => {
  const { logger } = capturingLogger();
  const hub = createStreamHub({ logger, maxClients: 1, maxBufferedBytes: 1024 });
  const guardOutcome = (origins: readonly string[]) => {
    try {
      createApiServer({
        logger,
        clock: new FakeClock('2026-11-08T12:00:00.000Z'),
        rateLimits: { perMinute: 1, uploadPerMinute: 1 },
        uploads: { maxFileBytes: 1 },
        requestGuard: { allowedOrigins: origins },
      });
      return 'accepted';
    } catch (error) {
      return error instanceof TypeError ? `TypeError: ${error.message}` : 'other';
    }
  };
  const streamOutcome = (origins: readonly string[]) => {
    try {
      streamRoutes({ hub, logger, allowedOrigins: origins });
      return 'accepted';
    } catch (error) {
      return error instanceof TypeError ? `TypeError: ${error.message}` : 'other';
    }
  };
  const lists: [string, readonly string[]][] = [
    ['an empty list', []],
    ...VALID.map((value): [string, readonly string[]] => [value, [value]]),
    ...INVALID.filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(
      ([name, value]): [string, readonly string[]] => [name, [value]],
    ),
    ['a valid and an invalid entry', ['http://127.0.0.1:5173', '*']],
  ];

  it.each(lists)('%s: the request guard and /stream agree', (_name, origins) => {
    const guard = guardOutcome(origins);
    expect(streamOutcome(origins)).toBe(guard);
    expect(guard).toBe(
      origins.length > 0 && origins.every((o) => canonicalOrigin(o) !== undefined)
        ? 'accepted'
        : `TypeError: ${ALLOWED_ORIGINS_INVALID}`,
    );
  });
});
