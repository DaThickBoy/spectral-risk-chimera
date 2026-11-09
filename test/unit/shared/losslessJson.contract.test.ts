// Task 8.1: the LosslessJsonParser contract suite, run against the test double, and the
// LosslessJsonNumber type. Task 8.4 runs the same suite against the wrapped OD-16 library.
// Validates: Requirements 4.2, 4.6
import { describe, expect, it } from 'vitest';
import {
  JSON_NUMBER_PATTERN,
  LOSSLESS_JSON_MAX_DEPTH,
  LosslessJsonNumber,
  isLosslessJsonNumber,
} from '../../../src/shared/index.js';
import { runLosslessJsonContract } from '../../contracts/losslessJson.contract.js';
import { recursiveDescentDouble } from '../../helpers/losslessJsonDouble.js';

runLosslessJsonContract('recursive-descent test double', recursiveDescentDouble);

describe('LosslessJsonNumber', () => {
  it.each(['0', '-0', '0.1', '1.50', '1e-5', '2E+3', '123456789012345678901234567890'])(
    'holds the RFC 8259 token %s unchanged',
    (text) => {
      const number = new LosslessJsonNumber(text);
      expect(number.text).toBe(text);
      expect(Object.isFrozen(number)).toBe(true);
      expect(isLosslessJsonNumber(number)).toBe(true);
    },
  );

  it.each(['', ' 1', '01', '+1', '.5', '1.', 'NaN', 'Infinity', '0x10', '1,5', '1e'])(
    'rejects the non-number token %j as a programmer error',
    (text) => {
      expect(() => new LosslessJsonNumber(text)).toThrow(TypeError);
      expect(JSON_NUMBER_PATTERN.test(text)).toBe(false);
    },
  );

  it('rejects a non-string argument', () => {
    expect(() => new LosslessJsonNumber(1 as unknown as string)).toThrow(TypeError);
  });

  it('plain objects and strings are not numbers', () => {
    expect(isLosslessJsonNumber({ text: '1' })).toBe(false);
    expect(isLosslessJsonNumber('1')).toBe(false);
    expect(isLosslessJsonNumber(null)).toBe(false);
  });

  it('uses the approved depth limit of 64', () => {
    expect(LOSSLESS_JSON_MAX_DEPTH).toBe(64);
  });
});
