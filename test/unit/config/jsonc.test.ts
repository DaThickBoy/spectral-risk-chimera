// Strict JSONC reader for the runtime configuration file (task 3.2).
// Validates: Requirements 4.3, 4.6
import { describe, expect, it } from 'vitest';
import {
  dropNulls,
  MAX_CONFIG_NESTING_DEPTH,
  parseConfigJsonc,
  UnsupportedNumber,
} from '../../../src/config/index.js';

const parse = (text: string): unknown => {
  const result = parseConfigJsonc(text);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
};

describe('parseConfigJsonc', () => {
  it('reads objects, arrays, strings, integers, booleans, and null with comments', () => {
    const text = `\uFEFF// header
    {
      /* block */ "a": "0.95", // decimal as string
      "b": 250, "c": [true, false, null], "d": { "e": "-0.60" }
    }`;
    expect(parse(text)).toEqual({ a: '0.95', b: 250, c: [true, false, null], d: { e: '-0.60' } });
  });

  it('never turns a fractional or exponent number into a float', () => {
    const value = parse('{"a": 0.95, "b": 1e3, "c": 2.5E-1, "d": 12345678901234567890}') as Record<
      string,
      unknown
    >;
    expect(value['a']).toEqual(new UnsupportedNumber('0.95', 'NON_INTEGER'));
    expect(value['b']).toEqual(new UnsupportedNumber('1e3', 'EXPONENT'));
    expect(value['c']).toEqual(new UnsupportedNumber('2.5E-1', 'EXPONENT'));
    expect(value['d']).toEqual(new UnsupportedNumber('12345678901234567890', 'UNSAFE_INTEGER'));
  });

  it(`accepts nesting up to ${MAX_CONFIG_NESTING_DEPTH} levels`, () => {
    const objects = `${'{"a":'.repeat(MAX_CONFIG_NESTING_DEPTH)}1${'}'.repeat(MAX_CONFIG_NESTING_DEPTH)}`;
    const arrays = `{"a":${'['.repeat(MAX_CONFIG_NESTING_DEPTH - 1)}${']'.repeat(MAX_CONFIG_NESTING_DEPTH - 1)}}`;
    expect(parseConfigJsonc(objects).ok).toBe(true);
    expect(parseConfigJsonc(arrays).ok).toBe(true);
  });

  it.each([
    [
      'nested objects',
      `${'{"a":'.repeat(MAX_CONFIG_NESTING_DEPTH + 1)}1${'}'.repeat(MAX_CONFIG_NESTING_DEPTH + 1)}`,
    ],
    [
      'nested arrays',
      `${'['.repeat(MAX_CONFIG_NESTING_DEPTH + 1)}${']'.repeat(MAX_CONFIG_NESTING_DEPTH + 1)}`,
    ],
    ['mixed objects and arrays', `${'{"a":['.repeat(20)}1${']}'.repeat(20)}`],
    ['500,000 unclosed arrays', '['.repeat(500_000)],
    ['500,000 nested objects', `${'{"a":'.repeat(500_000)}1${'}'.repeat(500_000)}`],
  ])('rejects excessive nesting (%s) as CONFIG_PARSE_ERROR without overflowing the stack', (_label, text) => {
    const result = parseConfigJsonc(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFIG_PARSE_ERROR');
      expect(result.error.message).toContain(`nesting deeper than ${MAX_CONFIG_NESTING_DEPTH} levels`);
    }
  });

  it('keeps "__proto__" as an ordinary key', () => {
    const value = parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it.each([
    ['duplicate keys', '{"a": "1", "a": "2"}', 'duplicate key'],
    ['trailing commas', '{"a": 1,}', 'trailing commas'],
    ['unterminated comments', '{"a": 1} /*', 'unterminated block comment'],
    ['single quotes', "{'a': 1}", 'expected a string key'],
    ['content after the value', '{"a": 1} {}', 'unexpected content'],
    ['NaN', '{"a": NaN}', 'unexpected token'],
    ['raw control characters in strings', '{"a": "x\u0001"}', 'invalid string literal'],
  ])('rejects %s', (_label, text, message) => {
    const result = parseConfigJsonc(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('CONFIG_PARSE_ERROR');
      expect(result.error.message).toContain(message);
    }
  });
});

describe('dropNulls', () => {
  it('removes null object properties at every depth and keeps null array elements', () => {
    expect(dropNulls({ a: null, b: { c: null, d: [null, { e: null, f: 1 }] }, g: '0' })).toEqual({
      b: { d: [null, { f: 1 }] },
      g: '0',
    });
    expect(dropNulls(null)).toBeNull();
    expect(dropNulls('x')).toBe('x');
  });

  it('copies "__proto__" keys as ordinary own properties', () => {
    const input = parseConfigJsonc('{"__proto__": {"x": null, "y": 1}}');
    expect(input.ok).toBe(true);
    const output = (input.ok ? dropNulls(input.value) : {}) as Record<string, unknown>;
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.keys(output)).toEqual(['__proto__']);
  });

  it('handles 200,000 levels of nesting without overflowing the stack', () => {
    const depth = 200_000;
    const root: Record<string, unknown> = {};
    let current = root;
    for (let i = 0; i < depth; i += 1) {
      const next: Record<string, unknown> = { gone: null };
      current['child'] = [next];
      current = next;
    }
    current['leaf'] = 'kept';

    let node = dropNulls(root) as Record<string, unknown>;
    let levels = 0;
    let nullsLeft = 0;
    while (Array.isArray(node['child'])) {
      node = (node['child'] as Record<string, unknown>[])[0] ?? {};
      levels += 1;
      if ('gone' in node) nullsLeft += 1;
    }
    expect(levels).toBe(depth);
    expect(nullsLeft).toBe(0);
    expect(node).toEqual({ leaf: 'kept' });
  });
});
