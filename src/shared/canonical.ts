/**
 * Canonical JSON serialization and SHA-256 hashing (R32.3).
 *
 * Rules:
 * - UTF-8 JSON with no insignificant whitespace.
 * - Object keys sorted by Unicode code point (not UTF-16 code unit).
 * - Arrays keep the order given; callers sort arrays whose order is defined
 *   (for example positions by instrument identifier).
 * - Financial values must already be Canonical Decimal Strings. Native numbers
 *   are accepted only as safe integers (counts, R4.7); any other number, a
 *   Decimal instance, or a bigint is a programmer error and throws.
 * - Dates serialize as UTC ISO 8601 with milliseconds.
 * - Properties whose value is `undefined` are omitted.
 *
 * Validates: Requirements 32.3.
 */
import { createHash } from 'node:crypto';

/** Compares two strings by Unicode code point. */
export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const x = left[i]?.codePointAt(0) ?? 0;
    const y = right[i]?.codePointAt(0) ?? 0;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serialize(value: unknown, path: string): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(
          `canonicalJson: non-integer number at ${path}; financial values must be decimal strings.`,
        );
      }
      return Object.is(value, -0) ? '0' : String(value);
    case 'object':
      return serializeObject(value, path);
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}.`);
  }
}

function serializeObject(value: object, path: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError(`canonicalJson: invalid Date at ${path}.`);
    }
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    const items = value.map((item: unknown, index) => {
      if (item === undefined) {
        throw new TypeError(`canonicalJson: undefined array element at ${path}[${index}].`);
      }
      return serialize(item, `${path}[${index}]`);
    });
    return `[${items.join(',')}]`;
  }
  if (!isPlainObject(value)) {
    throw new TypeError(
      `canonicalJson: unsupported object at ${path}; convert Decimal values with toCanonical().`,
    );
  }
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => compareCodePoints(a, b))
    .map(([key, item]) => `${JSON.stringify(key)}:${serialize(item, `${path}.${key}`)}`);
  return `{${entries.join(',')}}`;
}

/** Serializes `value` in the canonical form defined in R32.3. */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

/** SHA-256 of a UTF-8 string or raw bytes, as lowercase hex. */
export function sha256Hex(bytes: string | Uint8Array): string {
  const hash = createHash('sha256');
  if (typeof bytes === 'string') {
    hash.update(bytes, 'utf8');
  } else {
    hash.update(bytes);
  }
  return hash.digest('hex');
}
