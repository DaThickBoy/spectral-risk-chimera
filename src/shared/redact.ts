/**
 * Redaction for logs and error payloads (R24.7, R29.12, Property 35).
 *
 * Removes:
 * - values under sensitive keys: authorization and cookie headers, API keys,
 *   tokens, secrets, passwords, user-agent (the SEC contact), and account fields;
 * - configured secret values (for example API keys and the `SEC_USER_AGENT`
 *   contact) wherever they appear in strings or keys;
 * - `Bearer` and `Basic` credentials, `Authorization:` header lines, and
 *   credential query parameters in free text;
 * - FIX `Account` (tag 1) values in SOH- or pipe-delimited messages.
 *
 * Decimal values are serialized with `toCanonical`, Dates as ISO strings.
 */
import { isDecimal, toCanonical } from './decimal.js';

export const REDACTED = '[REDACTED]';

export interface RedactionOptions {
  /** Exact secret values to remove, for example API keys from the environment. */
  readonly secrets?: readonly string[];
}

const MAX_DEPTH = 20;

const SENSITIVE_KEY_PARTS = [
  'authorization',
  'cookie',
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'credential',
  'privatekey',
];
const SENSITIVE_KEYS_EXACT = new Set(['account', 'useragent', 'secuseragent']);

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    SENSITIVE_KEYS_EXACT.has(normalized) || SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part))
  );
}

type Replacer = (match: string, ...groups: string[]) => string;

const TEXT_PATTERNS: readonly (readonly [RegExp, Replacer])[] = [
  // Authorization header lines in free text.
  [/\b(?:proxy-)?authorization\s*[:=]\s*[^\r\n]*/gi, () => `authorization: ${REDACTED}`],
  // Bearer and Basic credentials.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/g, (_m, scheme = '') => `${scheme} ${REDACTED}`],
  // Credential query parameters.
  [
    /([?&](?:api[_-]?key|apikey|access[_-]?token|token|key|secret|password)=)[^&#\s]*/gi,
    (_m, prefix = '') => `${prefix}${REDACTED}`,
  ],
  // FIX Account (tag 1), SOH (U+0001) or pipe delimited.
  // eslint-disable-next-line no-control-regex
  [/(^|[\u0001|])1=[^\u0001|]*/g, (_m, delimiter = '') => `${delimiter}1=${REDACTED}`],
];

/** Removes configured secrets and known credential patterns from text. */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = text;
  const ordered = [...new Set(secrets.filter((s) => s.length > 0))].sort((a, b) => b.length - a.length);
  for (const secret of ordered) {
    out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Returns a redacted, JSON-safe copy of `value`. The input is not modified.
 */
export function redact(value: unknown, options: RedactionOptions = {}): unknown {
  const secrets = options.secrets ?? [];
  const seen = new WeakSet<object>();

  const walk = (item: unknown, depth: number): unknown => {
    if (item === null || item === undefined) {
      return item;
    }
    if (typeof item === 'string') {
      return redactText(item, secrets);
    }
    if (typeof item === 'number' || typeof item === 'boolean') {
      return item;
    }
    if (typeof item === 'bigint') {
      return item.toString();
    }
    if (typeof item === 'function' || typeof item === 'symbol') {
      return undefined;
    }
    if (depth >= MAX_DEPTH) {
      return '[MaxDepth]';
    }
    if (seen.has(item)) {
      return '[Circular]';
    }
    seen.add(item);
    try {
      if (isDecimal(item)) {
        return item.isFinite() ? toCanonical(item) : '[NonFiniteDecimal]';
      }
      if (item instanceof Date) {
        return Number.isNaN(item.getTime()) ? '[InvalidDate]' : item.toISOString();
      }
      if (item instanceof Error) {
        const out: Record<string, unknown> = {
          name: item.name,
          message: redactText(item.message, secrets),
        };
        if (item.stack !== undefined) {
          out['stack'] = redactText(item.stack, secrets);
        }
        if (item.cause !== undefined) {
          out['cause'] = walk(item.cause, depth + 1);
        }
        return out;
      }
      if (Array.isArray(item)) {
        return item.map((element: unknown) => walk(element, depth + 1));
      }
      if (item instanceof Map) {
        return walk(Object.fromEntries(item), depth + 1);
      }
      if (item instanceof Set) {
        return walk([...item], depth + 1);
      }
      const out: Record<string, unknown> = {};
      for (const [key, element] of Object.entries(item)) {
        const safeKey = redactText(key, secrets);
        out[safeKey] = isSensitiveKey(key) ? REDACTED : walk(element, depth + 1);
      }
      return out;
    } finally {
      seen.delete(item);
    }
  };

  return walk(value, 0);
}
