// Test double for the LosslessJsonParser contract (task 8.1). It is not a production
// parser and not the OD-16 choice: it exists only so the contract suite can run before a
// library is approved (task 8.4).
//
// A small recursive-descent parser over strict RFC 8259 JSON. Numeric tokens become
// LosslessJsonNumber with their exact text; duplicate keys, a leading BOM, and nesting deeper
// than LOSSLESS_JSON_MAX_DEPTH are rejected. Recursion is bounded by the depth limit, which is
// checked before descending, so no input can overflow the stack. Failures never carry input text.
import { LOSSLESS_JSON_MAX_DEPTH, LosslessJsonNumber, appError, err, ok } from '../../src/shared/index.js';
import type { LosslessJsonParser, LosslessJsonValue } from '../../src/shared/index.js';

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
// eslint-disable-next-line no-control-regex
const STRING = /"(?:[^"\\\u0000-\u001F]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** Internal signal; never escapes `parse`. Carries no input text. */
class Failure extends Error {
  constructor() {
    super('Input is not valid JSON.');
    this.name = 'Failure';
  }
}

class DoubleParser {
  private pos = 0;

  constructor(private readonly text: string) {}

  parseDocument(): LosslessJsonValue {
    const value = this.value(0);
    this.whitespace();
    if (this.pos !== this.text.length) {
      throw new Failure();
    }
    return value;
  }

  private whitespace(): void {
    while (this.pos < this.text.length) {
      const char = this.text[this.pos];
      if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') {
        return;
      }
      this.pos += 1;
    }
  }

  private value(depth: number): LosslessJsonValue {
    this.whitespace();
    const char = this.text[this.pos];
    switch (char) {
      case '{':
        return this.object(depth + 1);
      case '[':
        return this.array(depth + 1);
      case '"':
        return this.string();
      case 't':
        return this.literal('true', true);
      case 'f':
        return this.literal('false', false);
      case 'n':
        return this.literal('null', null);
      default:
        return this.number();
    }
  }

  private literal<T extends LosslessJsonValue>(word: string, result: T): T {
    if (!this.text.startsWith(word, this.pos)) {
      throw new Failure();
    }
    this.pos += word.length;
    return result;
  }

  private number(): LosslessJsonNumber {
    NUMBER.lastIndex = this.pos;
    const match = NUMBER.exec(this.text);
    if (match === null) {
      throw new Failure();
    }
    this.pos += match[0].length;
    return new LosslessJsonNumber(match[0]);
  }

  private string(): string {
    STRING.lastIndex = this.pos;
    const match = STRING.exec(this.text);
    if (match === null) {
      throw new Failure();
    }
    this.pos += match[0].length;
    return match[0]
      .slice(1, -1)
      .replace(/\\(?:u([0-9a-fA-F]{4})|(.))/g, (_all, hex: string | undefined, escape: string | undefined) =>
        hex === undefined ? (ESCAPES[escape ?? ''] ?? '') : String.fromCharCode(Number.parseInt(hex, 16)),
      );
  }

  private enter(depth: number): void {
    if (depth > LOSSLESS_JSON_MAX_DEPTH) {
      throw new Failure();
    }
    this.pos += 1; // the opening bracket
  }

  private expect(char: string): void {
    this.whitespace();
    if (this.text[this.pos] !== char) {
      throw new Failure();
    }
    this.pos += 1;
  }

  private array(depth: number): LosslessJsonValue[] {
    this.enter(depth);
    const items: LosslessJsonValue[] = [];
    this.whitespace();
    if (this.text[this.pos] === ']') {
      this.pos += 1;
      return items;
    }
    for (;;) {
      items.push(this.value(depth));
      this.whitespace();
      if (this.text[this.pos] === ',') {
        this.pos += 1;
        continue;
      }
      this.expect(']');
      return items;
    }
  }

  private object(depth: number): Record<string, LosslessJsonValue> {
    this.enter(depth);
    const result: Record<string, LosslessJsonValue> = {};
    const seen = new Set<string>();
    this.whitespace();
    if (this.text[this.pos] === '}') {
      this.pos += 1;
      return result;
    }
    for (;;) {
      this.whitespace();
      if (this.text[this.pos] !== '"') {
        throw new Failure();
      }
      const key = this.string();
      if (seen.has(key)) {
        throw new Failure(); // duplicate key, compared after unescaping
      }
      seen.add(key);
      this.expect(':');
      const item = this.value(depth);
      // An own data property for every key, including "__proto__": no prototype change.
      Object.defineProperty(result, key, {
        value: item,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.whitespace();
      if (this.text[this.pos] === ',') {
        this.pos += 1;
        continue;
      }
      this.expect('}');
      return result;
    }
  }
}

const failure = () => err(appError('JSON_PARSE_ERROR', 'Input is not valid JSON.'));

export const recursiveDescentDouble: LosslessJsonParser = {
  parse(text) {
    // A leading byte-order mark is rejected (contract point 5).
    if (typeof text !== 'string' || text.startsWith('\uFEFF')) {
      return failure();
    }
    try {
      return ok(new DoubleParser(text).parseDocument());
    } catch (error) {
      if (error instanceof Failure) {
        return failure();
      }
      throw error;
    }
  },
};
