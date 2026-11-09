// Contract suite for LosslessJsonParser (task 8.1; design D-5, U-11; R4.2, R4.6).
// Every implementation runs this suite unchanged: the test double now
// (test/unit/shared/losslessJson.contract.test.ts) and the wrapped OD-16 library in task 8.4,
// on Node.js 24.22.1 and 26. The numbered contract is documented in src/shared/losslessJson.ts.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DecimalStringSchema,
  LOSSLESS_JSON_MAX_DEPTH,
  LosslessJsonNumber,
  isLosslessJsonNumber,
} from '../../src/shared/index.js';
import type { LosslessJsonParser, LosslessJsonValue } from '../../src/shared/index.js';

const num = (text: string): LosslessJsonNumber => new LosslessJsonNumber(text);

/** The expected lossless form of a JSON value: every number becomes a LosslessJsonNumber of its JSON text. */
function expectedLossless(value: unknown): unknown {
  if (typeof value === 'number') {
    return num(JSON.stringify(value));
  }
  if (Array.isArray(value)) {
    return value.map(expectedLossless);
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(out, key, {
        value: expectedLossless(item),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/** True when no native number occurs anywhere in the parsed structure. */
function hasNoNativeNumber(value: unknown): boolean {
  if (typeof value === 'number') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.every(hasNoNativeNumber);
  }
  if (typeof value === 'object' && value !== null && !isLosslessJsonNumber(value)) {
    return Object.values(value).every(hasNoNativeNumber);
  }
  return true;
}

const nested = (depth: number, open: string, close: string, inner = '0'): string =>
  `${open.repeat(depth)}${inner}${close.repeat(depth)}`;

const nestedObjects = (depth: number): string => `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;

export function runLosslessJsonContract(name: string, parser: LosslessJsonParser): void {
  const value = (text: string): LosslessJsonValue => {
    const result = parser.parse(text);
    if (!result.ok) {
      throw new Error(`expected ${JSON.stringify(text)} to parse`);
    }
    return result.value;
  };
  const expectParseError = (text: string): void => {
    let result: ReturnType<LosslessJsonParser['parse']> | undefined;
    expect(() => {
      result = parser.parse(text);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    expect(result !== undefined && !result.ok && result.error.code).toBe('JSON_PARSE_ERROR');
  };

  describe(`LosslessJsonParser contract: ${name}`, () => {
    describe('1. numeric tokens become LosslessJsonNumber with their exact text', () => {
      it.each([
        '0.1',
        '1.50',
        '-0',
        '-0.0',
        '10',
        '0.30000000000000000001',
        '123456789012345678901234567890.123456789012345678901234567890',
        '9007199254740993',
        '-12.5',
      ])('the token %s keeps its exact text', (text) => {
        const parsed = value(text);
        expect(parsed).toBeInstanceOf(LosslessJsonNumber);
        expect(isLosslessJsonNumber(parsed) && parsed.text).toBe(text);
        expect(value(`[${text}]`)).toStrictEqual([num(text)]);
        expect(value(`{"close":${text}}`)).toStrictEqual({ close: num(text) });
      });

      it('distinguishes a numeric token from a string with the same characters', () => {
        const parsed = value('{"number":0.1,"string":"0.1","digits":"10","ten":10}');
        expect(parsed).toStrictEqual({ number: num('0.1'), string: '0.1', digits: '10', ten: num('10') });
        const record = parsed as Record<string, unknown>;
        expect(isLosslessJsonNumber(record['number'])).toBe(true);
        expect(isLosslessJsonNumber(record['string'])).toBe(false);
        expect(typeof record['string']).toBe('string');
      });

      it('never returns a native number anywhere in the structure', () => {
        const parsed = value('{"bars":[{"close":0.1,"volume":100},{"close":2.50,"volume":0}],"n":2}');
        expect(parsed).toStrictEqual({
          bars: [
            { close: num('0.1'), volume: num('100') },
            { close: num('2.50'), volume: num('0') },
          ],
          n: num('2'),
        });
        expect(hasNoNativeNumber(parsed)).toBe(true);
      });

      it('the number text is valid for DecimalStringSchema without change', () => {
        const parsed = value('{"price":0.1}') as { price: LosslessJsonNumber };
        expect(DecimalStringSchema.parse(parsed.price.text)).toBe('0.1');
      });

      it('numbers are immutable', () => {
        const parsed = value('1.5') as LosslessJsonNumber;
        expect(Object.isFrozen(parsed)).toBe(true);
      });

      it('allows JSON whitespace around tokens', () => {
        expect(value(' \n\t{ "a" : [ 1.0 , 2 ] }\r\n')).toStrictEqual({ a: [num('1.0'), num('2')] });
      });
    });

    describe('2. exponent tokens keep their text for rejection by the decimal grammar', () => {
      it.each(['1e-5', '2E3', '1.5e+10', '-0e0', '1e400', '-1E-400'])('the token %s', (text) => {
        expect(value(text)).toStrictEqual(num(text));
        expect(value(`{"price":${text}}`)).toStrictEqual({ price: num(text) });
        expect(DecimalStringSchema.safeParse(text).success).toBe(false);
      });
    });

    describe('3. strings, literals, and prototype-safe objects', () => {
      it('keeps strings, booleans, and null', () => {
        expect(value('{"s":"0.1","t":true,"f":false,"z":null,"e":""}')).toStrictEqual({
          s: '0.1',
          t: true,
          f: false,
          z: null,
          e: '',
        });
      });

      it('decodes escapes, including surrogate pairs', () => {
        expect(value('"a\\"b\\\\c\\/d\\n\\t\\u00e9\\ud83d\\ude00"')).toBe('a"b\\c/d\n\té😀');
      });

      it.each(['__proto__', 'constructor', 'prototype'])(
        'makes "%s" an own data property without changing any prototype',
        (key) => {
          const parsed = value(`{"${key}":{"polluted":"yes"},"inner":[{"${key}":1}]}`) as Record<
            string,
            unknown
          >;
          expect(Object.hasOwn(parsed, key)).toBe(true);
          expect(Object.getOwnPropertyDescriptor(parsed, key)?.value).toStrictEqual({ polluted: 'yes' });
          expect([Object.prototype, null]).toContain(Object.getPrototypeOf(parsed));
          expect((parsed as { polluted?: unknown }).polluted).toBeUndefined();
          const inner = (parsed['inner'] as Record<string, unknown>[])[0] ?? {};
          expect(Object.hasOwn(inner, key)).toBe(true);
          expect([Object.prototype, null]).toContain(Object.getPrototypeOf(inner));
          expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
        },
      );

      it('accepts top-level scalars and empty containers', () => {
        expect(value('"x"')).toBe('x');
        expect(value('null')).toBeNull();
        expect(value('true')).toBe(true);
        expect(value('[]')).toStrictEqual([]);
        expect(value('{}')).toStrictEqual({});
      });
    });

    describe('4. duplicate object keys are rejected at every depth', () => {
      it.each([
        ['at the top level', '{"a":1,"a":2}'],
        ['with equal values', '{"a":1,"a":1}'],
        ['with different value types', '{"a":"x","a":null}'],
        ['nested in an object', '{"outer":{"b":1,"b":2}}'],
        ['inside an array element', '[{"ok":1},{"c":1,"c":2}]'],
        ['deep in the structure', `${'{"x":'.repeat(30)}{"d":1,"d":2}${'}'.repeat(30)}`],
        ['after unescaping', '{"a":1,"\\u0061":2}'],
        ['for "__proto__"', '{"__proto__":1,"__proto__":2}'],
        ['for the empty key', '{"":1,"":2}'],
      ])('rejects a duplicate %s', (_label, text) => {
        expectParseError(text);
      });

      it('accepts the same key in sibling or nested objects, and keys differing in case', () => {
        expect(value('{"a":{"a":1},"b":[{"a":1},{"a":2}],"A":3}')).toStrictEqual({
          a: { a: num('1') },
          b: [{ a: num('1') }, { a: num('2') }],
          A: num('3'),
        });
      });
    });

    describe('5. a leading byte-order mark is rejected', () => {
      it.each(['\uFEFF{}', '\uFEFF1', '\uFEFF"x"', '\uFEFF\uFEFF[]'])('rejects %j', (text) => {
        expectParseError(text);
      });

      it('rejects U+FEFF used as whitespace elsewhere', () => {
        expectParseError(' \uFEFF{}');
        expectParseError('[1,\uFEFF2]');
      });

      it('keeps U+FEFF inside a string as content', () => {
        expect(value('"a\uFEFFb"')).toBe('a\uFEFFb');
      });
    });

    describe(`6. nesting up to ${LOSSLESS_JSON_MAX_DEPTH} levels`, () => {
      it(`parses arrays and objects nested exactly ${LOSSLESS_JSON_MAX_DEPTH} deep`, () => {
        let arrays: unknown = value(nested(LOSSLESS_JSON_MAX_DEPTH, '[', ']', '0.5'));
        for (let level = 0; level < LOSSLESS_JSON_MAX_DEPTH; level += 1) {
          expect(Array.isArray(arrays)).toBe(true);
          arrays = (arrays as unknown[])[0];
        }
        expect(arrays).toStrictEqual(num('0.5'));
        expect(parser.parse(nestedObjects(LOSSLESS_JSON_MAX_DEPTH)).ok).toBe(true);
        expect(parser.parse(`[${'{"a":['.repeat(31)}1${']}'.repeat(31)}]`).ok).toBe(true);
      });

      it.each([LOSSLESS_JSON_MAX_DEPTH + 1, 10_000, 200_000])(
        'rejects nesting %i deep with JSON_PARSE_ERROR, without throwing',
        (depth) => {
          expectParseError(nested(depth, '[', ']'));
          expectParseError(nestedObjects(depth));
        },
      );

      it('rejects mixed nesting one level too deep', () => {
        expectParseError(`[${'{"a":['.repeat(32)}1${']}'.repeat(32)}]`);
      });

      it('brackets inside strings do not count as nesting', () => {
        const text = `["${'['.repeat(LOSSLESS_JSON_MAX_DEPTH * 2)}"]`;
        expect(value(text)).toStrictEqual(['['.repeat(LOSSLESS_JSON_MAX_DEPTH * 2)]);
      });
    });

    describe('7. anything other than strict JSON is JSON_PARSE_ERROR', () => {
      it.each([
        ['empty input', ''],
        ['whitespace only', '  '],
        ['unclosed object', '{'],
        ['unclosed string', '"abc'],
        ['trailing comma in array', '[1,]'],
        ['trailing comma in object', '{"a":1,}'],
        ['missing colon', '{"a" 1}'],
        ['line comment', '// c\n1'],
        ['block comment', '/* c */ 1'],
        ['single quotes', "'a'"],
        ['unquoted key', '{a:1}'],
        ['number as key', '{1:1}'],
        ['NaN', 'NaN'],
        ['Infinity', 'Infinity'],
        ['negative Infinity', '-Infinity'],
        ['leading zero', '01'],
        ['plus sign', '+1'],
        ['leading dot', '.5'],
        ['trailing dot', '1.'],
        ['hexadecimal', '0x10'],
        ['bare exponent', '1e'],
        ['lone minus', '-'],
        ['unescaped control character', '"a\u0001b"'],
        ['invalid escape', '"\\x41"'],
        ['trailing content', '1 2'],
        ['two values', '{}{}'],
        ['undefined', 'undefined'],
        ['capitalized literal', 'True'],
      ])('rejects %s', (_label, text) => {
        expectParseError(text);
      });
    });

    describe('8. never throws; errors do not echo the input', () => {
      it('error messages contain none of the input text', () => {
        const secret = 'test-api-key-0000';
        for (const text of [
          `{"token":"${secret}",}`,
          secret,
          `["${secret}"`,
          `{"${secret}":1,"${secret}":2}`,
          `\uFEFF{"token":"${secret}"}`,
        ]) {
          const result = parser.parse(text);
          expect(result.ok).toBe(false);
          expect(JSON.stringify(result)).not.toContain(secret);
        }
      });

      it('returns a result for any string input', () => {
        fc.assert(
          fc.property(fc.string({ maxLength: 200 }), (text) => {
            let ok: boolean | undefined;
            expect(() => {
              ok = parser.parse(text).ok;
            }).not.toThrow();
            expect(typeof ok).toBe('boolean');
          }),
          { numRuns: 500 },
        );
      });

      it('round-trips any serialized JSON value, every number as a LosslessJsonNumber of its text', () => {
        fc.assert(
          fc.property(fc.jsonValue({ maxDepth: 6 }), (json) => {
            const text = JSON.stringify(json);
            const parsed = value(text);
            expect(parsed).toStrictEqual(expectedLossless(JSON.parse(text)));
            expect(hasNoNativeNumber(parsed)).toBe(true);
          }),
          { numRuns: 500 },
        );
      });
    });
  });
}
