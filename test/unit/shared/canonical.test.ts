// Canonical JSON and SHA-256 (task 2.3).
// Validates: Requirements 32.3
import { describe, expect, it } from 'vitest';
import { canonicalJson, compareCodePoints, d, sha256Hex, toCanonical } from '../../../src/shared/index.js';

describe('canonicalJson', () => {
  it('sorts keys, removes whitespace, and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 'x', c: null }], e: true })).toBe(
      '{"a":[2,{"c":null,"d":"x"}],"b":1,"e":true}',
    );
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it('sorts keys by Unicode code point, not UTF-16 code unit', () => {
    // U+1F600 is encoded as the surrogate pair D83D DE00, which sorts before U+FF61 by code unit.
    const value = { '\u{1F600}': 1, '\uFF61': 2 };
    expect(canonicalJson(value)).toBe('{"\uFF61":2,"\u{1F600}":1}');
    expect(compareCodePoints('\uFF61', '\u{1F600}')).toBe(-1);
    expect(compareCodePoints('a', 'ab')).toBe(-1);
    expect(compareCodePoints('b', 'b')).toBe(0);
  });

  it('serializes dates as UTC ISO 8601 with milliseconds', () => {
    expect(canonicalJson({ at: new Date('2026-11-06T12:00:00+02:00') })).toBe(
      '{"at":"2026-11-06T10:00:00.000Z"}',
    );
  });

  it('accepts decimal strings and safe integers, and omits undefined properties', () => {
    expect(canonicalJson({ nav: toCanonical(d('1000.50')), count: 250, skip: undefined })).toBe(
      '{"count":250,"nav":"1000.5"}',
    );
  });

  it.each([
    ['a non-integer number', { value: 0.1 }],
    ['a non-finite number', { value: Number.POSITIVE_INFINITY }],
    ['a Decimal instance', { value: d('1') }],
    ['a bigint', { value: 1n }],
    ['an invalid date', { value: new Date('invalid') }],
    ['an undefined array element', { value: [undefined] }],
    ['a Map', { value: new Map() }],
  ])('rejects %s', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});

describe('sha256Hex', () => {
  it('matches known SHA-256 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes UTF-8 bytes', () => {
    // SHA-256 of the UTF-8 encoding of "é" (C3 A9).
    expect(sha256Hex('\u00E9')).toBe(sha256Hex(new Uint8Array([0xc3, 0xa9])));
  });
});
