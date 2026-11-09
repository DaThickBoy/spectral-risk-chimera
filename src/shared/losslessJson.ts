/**
 * Lossless JSON parsing for provider payloads: the interface and its contract
 * (task 8.1; design D-5, U-11; R4.2, R4.6; financial-rules rule 3).
 *
 * `JSON.parse` turns a numeric token such as `0.1` into a binary float before
 * any validation, so provider JSON must never be parsed with it. A lossless
 * parser keeps every numeric token as its exact source text instead. The parser
 * library is not chosen yet (OD-16, task 8.4); this module defines what any
 * implementation must do. The contract suite in
 * `test/contracts/losslessJson.contract.ts` checks it, and every implementation
 * (the test double now, the wrapped library in task 8.4) must pass that suite.
 *
 * Contract:
 * 1. Every numeric token becomes a `LosslessJsonNumber` holding its exact
 *    source text: `0.1` -> text `"0.1"`, `1.50` -> `"1.50"`, `-0` -> `"-0"`,
 *    integers of any size digit for digit. Nothing is rounded, canonicalized, or
 *    converted to a native number. JSON strings stay plain `string` values, so a
 *    numeric token and a string with the same characters are always
 *    distinguishable (`0.1` versus `"0.1"`).
 * 2. Exponent tokens (`1e-5`, `2E3`, `1e400`) are kept as `LosslessJsonNumber`
 *    with their unchanged text, so validating `.text` with the fixed decimal
 *    grammar (`DecimalStringSchema`) rejects them as `MALFORMED_NUMBER` (R4.6).
 *    The parser never resolves them to a value.
 * 3. `true`, `false`, and `null` keep their JSON meaning. Objects are plain
 *    objects whose prototype is `Object.prototype` or `null`; every key,
 *    including `"__proto__"`, `"constructor"`, and `"prototype"`, becomes an own
 *    data property and never changes a prototype.
 * 4. Duplicate object keys are `JSON_PARSE_ERROR` at every depth. Keys are
 *    compared after unescaping, so `{"a":1,"\u0061":2}` is a duplicate.
 * 5. A leading UTF-8 byte-order mark (U+FEFF as the first character) is
 *    `JSON_PARSE_ERROR`. U+FEFF inside a string is ordinary string content.
 * 6. Objects and arrays may nest up to `LOSSLESS_JSON_MAX_DEPTH` levels (the
 *    top-level container is depth 1). Deeper input is `JSON_PARSE_ERROR`; no input
 *    may overflow the call stack.
 * 7. Anything that is not strict JSON (RFC 8259) is `JSON_PARSE_ERROR`: empty
 *    input, trailing commas, comments, single quotes, `NaN`, `Infinity`, leading
 *    zeros, `+1`, `.5`, `1.`, unescaped control characters, trailing content.
 * 8. `parse` never throws for any string input; it returns a `Result`. Error
 *    messages never contain the input text (provider payloads may hold
 *    credentials or personal data).
 */
import type { AppError } from './errors.js';
import type { Result } from './result.js';

/** Maximum nesting depth of objects and arrays; the top-level container is depth 1. */
export const LOSSLESS_JSON_MAX_DEPTH = 64;

/** RFC 8259 number grammar, including exponents (which the decimal grammar later rejects). */
export const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * A JSON numeric token kept as its exact source text. It is never a native
 * number; domain code validates `text` with `DecimalStringSchema` (or a stricter
 * schema) before use. Instances are immutable. Parsed plain objects are never
 * `LosslessJsonNumber` instances, so `instanceof` reliably identifies numbers.
 */
export class LosslessJsonNumber {
  readonly text: string;

  /** Throws `TypeError` (programmer error) when `text` is not an RFC 8259 number token. */
  constructor(text: string) {
    if (typeof text !== 'string' || !JSON_NUMBER_PATTERN.test(text)) {
      throw new TypeError('LosslessJsonNumber requires an RFC 8259 number token.');
    }
    this.text = text;
    Object.freeze(this);
  }
}

/** True when `value` is a numeric token from a lossless parse. */
export function isLosslessJsonNumber(value: unknown): value is LosslessJsonNumber {
  return value instanceof LosslessJsonNumber;
}

/** A parsed JSON value: numeric tokens are `LosslessJsonNumber`, strings stay strings. */
export type LosslessJsonValue =
  | null
  | boolean
  | string
  | LosslessJsonNumber
  | readonly LosslessJsonValue[]
  | { readonly [key: string]: LosslessJsonValue };

export type LosslessJsonError = AppError<'JSON_PARSE_ERROR'>;

/** Implemented by the wrapper around the library approved in OD-16 (task 8.4). */
export interface LosslessJsonParser {
  parse(text: string): Result<LosslessJsonValue, LosslessJsonError>;
}
