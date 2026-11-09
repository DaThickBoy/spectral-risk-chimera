/**
 * Allowed-origin validation shared by the HTTP request guard (Gateway rule 9,
 * `requestGuard.ts`) and the `/stream` WebSocket route (`routes/stream.ts`), so
 * both read the `--allowed-origin` list with exactly the same rules.
 *
 * An allowed origin is an http(s) origin in its canonical serialization:
 * `new URL(value).origin` must equal `value` exactly. That rejects a path or a
 * trailing slash (`http://a.example/`), credentials (`http://user@a.example`), a
 * query or fragment, upper-case scheme or host, a default port written out
 * (`http://a.example:80`), the opaque origin `null`, wildcards, malformed values,
 * and any scheme other than `http:` and `https:`.
 *
 * Matching is exact string equality against the parsed set; there is no
 * wildcard, prefix, suffix, or case-insensitive matching.
 */

/** The canonical origin `value`, or `undefined` when it is not an exact http(s) origin. */
export function canonicalOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined;
  }
  return url.origin === value ? value : undefined;
}

/** Message of the TypeError thrown for an invalid allowed-origin list (both consumers). */
export const ALLOWED_ORIGINS_INVALID = 'allowedOrigins must list at least one exact http(s) origin.';

/**
 * Validates an allowed-origin list and returns it as a set for exact lookup.
 * Throws `TypeError(ALLOWED_ORIGINS_INVALID)` for an empty list, a non-array, or
 * any entry that is not an exact http(s) origin (programmer or configuration
 * error; nothing is dropped or normalized).
 */
export function parseAllowedOrigins(origins: unknown): ReadonlySet<string> {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new TypeError(ALLOWED_ORIGINS_INVALID);
  }
  const allowed = new Set<string>();
  for (const origin of origins as readonly unknown[]) {
    const canonical = canonicalOrigin(origin);
    if (canonical === undefined) {
      throw new TypeError(ALLOWED_ORIGINS_INVALID);
    }
    allowed.add(canonical);
  }
  return allowed;
}

/** True when the received `Origin` header value is exactly one of `allowed`. */
export function isAllowedOrigin(origin: unknown, allowed: ReadonlySet<string>): boolean {
  return typeof origin === 'string' && allowed.has(origin);
}
