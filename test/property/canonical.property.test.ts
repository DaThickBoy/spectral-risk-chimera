// AT-REP-05: canonical serialization is deterministic regardless of key insertion order.
// Validates: Requirements 32.3
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/shared/index.js';

const jsonValue = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('value'), { maxLength: 4 }),
    tie('object'),
  ),
  object: fc.dictionary(fc.string({ maxLength: 6 }), tie('value'), { maxKeys: 6 }),
})).value;

/** Rebuilds every object with its keys inserted in a seeded, shuffled order. */
function reorder(value: unknown, seed: number): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => reorder(item, seed + index + 1));
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    let state = seed >>> 0;
    for (let i = entries.length - 1; i > 0; i -= 1) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const j = state % (i + 1);
      const a = entries[i];
      const b = entries[j];
      if (a !== undefined && b !== undefined) {
        entries[i] = b;
        entries[j] = a;
      }
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      Object.defineProperty(out, key, {
        value: reorder(item, state + key.length),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

describe('AT-REP-05: canonical JSON is insertion-order independent', () => {
  it('gives identical output for any key insertion order', () => {
    fc.assert(
      fc.property(jsonValue, fc.integer({ min: 0, max: 0x7fffffff }), (value, seed) => {
        expect(canonicalJson(reorder(value, seed))).toBe(canonicalJson(value));
      }),
      { numRuns: 1000 },
    );
  });

  it('produces valid JSON that parses back to an equal value', () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        const text = canonicalJson(value);
        expect(canonicalJson(JSON.parse(text))).toBe(text);
      }),
      { numRuns: 500 },
    );
  });
});
