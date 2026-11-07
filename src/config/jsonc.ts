/**
 * Strict JSONC reader for the runtime configuration file only.
 *
 * Not for provider payloads: provider JSON uses the lossless parser selected
 * in OD-16 (design D-5, `src/shared/losslessJson.ts`, task 8.1/8.4).
 *
 * Behaviour:
 * - `//` and `/* *\/` comments are allowed; trailing commas are not.
 * - Duplicate object keys are a parse error, so a financial setting can never be
 *   silently overridden by a later duplicate.
 * - Numbers are never converted to binary floats. A numeric token becomes a JS
 *   number only when it is a safe integer written without fraction or exponent
 *   (counts and seconds, R4.7). Any other numeric token (for example `0.95`,
 *   `1e3`, or an unsafe integer) becomes an `UnsupportedNumber` marker that the
 *   schema rejects, because decimal values must be JSON strings (R4.3, R4.6).
 * - Objects and arrays may nest at most `MAX_CONFIG_NESTING_DEPTH` levels. Deeper
 *   input is a normal `CONFIG_PARSE_ERROR`, so the recursive parser can never
 *   overflow the call stack. The configuration schema nests at most 3 levels
 *   (for example `alerts.var.thresholdPct`), so the limit leaves ample room.
 */
import type { Result } from '../shared/index.js';
import { appError, err, ok } from '../shared/index.js';
import type { AppError } from '../shared/index.js';

export type UnsupportedNumberReason = 'EXPONENT' | 'NON_INTEGER' | 'UNSAFE_INTEGER';

/** Marker for a numeric token that is not accepted as a configuration value. */
export class UnsupportedNumber {
  constructor(
    readonly text: string,
    readonly reason: UnsupportedNumberReason,
  ) {}
}

export type JsoncParseError = AppError<'CONFIG_PARSE_ERROR'>;

/**
 * Maximum nesting depth of objects and arrays in a configuration file. The
 * top-level object is depth 1. Exceeding it is rejected as `CONFIG_PARSE_ERROR`.
 */
export const MAX_CONFIG_NESTING_DEPTH = 32;

const NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
// JSON forbids unescaped control characters (U+0000 to U+001F) inside strings.
// eslint-disable-next-line no-control-regex
const STRING_PATTERN = /"(?:[^"\\\u0000-\u001F]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const SAFE_INTEGER_TEXT = /^-?(?:0|[1-9]\d*)$/;

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly text: string) {}

  /** Enters an object or array; fails before recursing past the depth limit. */
  private enterContainer(): void {
    this.depth += 1;
    if (this.depth > MAX_CONFIG_NESTING_DEPTH) {
      this.fail(`nesting deeper than ${MAX_CONFIG_NESTING_DEPTH} levels is not allowed`);
    }
  }

  private leaveContainer(): void {
    this.depth -= 1;
  }

  parseDocument(): unknown {
    this.skipTrivia();
    const value = this.parseValue();
    this.skipTrivia();
    if (this.pos < this.text.length) {
      this.fail('unexpected content after the top-level value');
    }
    return value;
  }

  private fail(message: string): never {
    const before = this.text.slice(0, this.pos);
    const line = before.split('\n').length;
    const column = this.pos - before.lastIndexOf('\n');
    throw new JsoncSyntaxError(`${message} (line ${line}, column ${column})`);
  }

  private skipTrivia(): void {
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.pos += 1;
      } else if (ch === '/' && this.text[this.pos + 1] === '/') {
        const end = this.text.indexOf('\n', this.pos);
        this.pos = end === -1 ? this.text.length : end + 1;
      } else if (ch === '/' && this.text[this.pos + 1] === '*') {
        const end = this.text.indexOf('*/', this.pos + 2);
        if (end === -1) {
          this.fail('unterminated block comment');
        }
        this.pos = end + 2;
      } else {
        return;
      }
    }
  }

  private parseValue(): unknown {
    const ch = this.text[this.pos];
    if (ch === '{') {
      return this.parseObject();
    }
    if (ch === '[') {
      return this.parseArray();
    }
    if (ch === '"') {
      return this.parseString();
    }
    if (ch === '-' || (ch !== undefined && ch >= '0' && ch <= '9')) {
      return this.parseNumber();
    }
    for (const [word, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (this.text.startsWith(word, this.pos)) {
        this.pos += word.length;
        return value;
      }
    }
    return this.fail('unexpected token');
  }

  private parseObject(): Record<string, unknown> {
    this.enterContainer();
    const out = this.parseObjectBody();
    this.leaveContainer();
    return out;
  }

  private parseArray(): unknown[] {
    this.enterContainer();
    const out = this.parseArrayBody();
    this.leaveContainer();
    return out;
  }

  private parseObjectBody(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.pos += 1;
    this.skipTrivia();
    if (this.text[this.pos] === '}') {
      this.pos += 1;
      return out;
    }
    for (;;) {
      this.skipTrivia();
      if (this.text[this.pos] !== '"') {
        this.fail('expected a string key');
      }
      const key = this.parseString();
      if (keys.has(key)) {
        this.fail(`duplicate key "${key}"`);
      }
      keys.add(key);
      this.skipTrivia();
      if (this.text[this.pos] !== ':') {
        this.fail('expected ":"');
      }
      this.pos += 1;
      this.skipTrivia();
      // defineProperty keeps keys such as "__proto__" as ordinary own properties.
      Object.defineProperty(out, key, {
        value: this.parseValue(),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.skipTrivia();
      const next = this.text[this.pos];
      this.pos += 1;
      if (next === '}') {
        return out;
      }
      if (next !== ',') {
        this.pos -= 1;
        this.fail('expected "," or "}"');
      }
      this.skipTrivia();
      if (this.text[this.pos] === '}') {
        this.fail('trailing commas are not allowed');
      }
    }
  }

  private parseArrayBody(): unknown[] {
    const out: unknown[] = [];
    this.pos += 1;
    this.skipTrivia();
    if (this.text[this.pos] === ']') {
      this.pos += 1;
      return out;
    }
    for (;;) {
      this.skipTrivia();
      out.push(this.parseValue());
      this.skipTrivia();
      const next = this.text[this.pos];
      this.pos += 1;
      if (next === ']') {
        return out;
      }
      if (next !== ',') {
        this.pos -= 1;
        this.fail('expected "," or "]"');
      }
      this.skipTrivia();
      if (this.text[this.pos] === ']') {
        this.fail('trailing commas are not allowed');
      }
    }
  }

  private parseString(): string {
    STRING_PATTERN.lastIndex = this.pos;
    const match = STRING_PATTERN.exec(this.text);
    if (match === null) {
      this.fail('invalid string literal');
    }
    this.pos += match[0].length;
    // A validated JSON string literal; JSON.parse only decodes its escapes.
    return JSON.parse(match[0]) as string;
  }

  private parseNumber(): number | UnsupportedNumber {
    NUMBER_PATTERN.lastIndex = this.pos;
    const match = NUMBER_PATTERN.exec(this.text);
    if (match === null) {
      this.fail('invalid number');
    }
    const token = match[0];
    this.pos += token.length;
    if (/[eE]/.test(token)) {
      return new UnsupportedNumber(token, 'EXPONENT');
    }
    if (!SAFE_INTEGER_TEXT.test(token)) {
      return new UnsupportedNumber(token, 'NON_INTEGER');
    }
    const value = Number.parseInt(token, 10);
    if (!Number.isSafeInteger(value)) {
      return new UnsupportedNumber(token, 'UNSAFE_INTEGER');
    }
    return value;
  }
}

class JsoncSyntaxError extends Error {}

/** Parses configuration JSONC text. Never throws for malformed input. */
export function parseConfigJsonc(text: string): Result<unknown, JsoncParseError> {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  try {
    return ok(new Parser(source).parseDocument());
  } catch (error) {
    if (error instanceof JsoncSyntaxError) {
      return err(appError('CONFIG_PARSE_ERROR', error.message));
    }
    throw error;
  }
}
