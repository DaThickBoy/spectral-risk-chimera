// Task 21.1, AT-FIL-10: FilingText and SentimentText are distinct at run time and at type level.
// The @ts-expect-error lines are checked by `npm run typecheck`.
// Validates: Requirements 8.6
import { describe, expect, it } from 'vitest';
import { FilingText, SentimentText } from '../../../src/shared/index.js';

describe('FilingText and SentimentText', () => {
  it('hold the text unchanged (no trimming or normalization) and are frozen', () => {
    const text = '  Item 1A.\tRisk Factors \n';
    const filing = FilingText.of(text);
    expect(filing.text).toBe(text);
    expect(Object.isFrozen(filing)).toBe(true);
    expect(SentimentText.of(text).text).toBe(text);
  });

  it('are distinguishable at run time', () => {
    const filing = FilingText.of('x');
    const sentiment = SentimentText.of('x');
    expect(filing instanceof FilingText).toBe(true);
    expect(filing instanceof SentimentText).toBe(false);
    expect(sentiment instanceof SentimentText).toBe(true);
    expect(sentiment instanceof FilingText).toBe(false);
    // A look-alike object is neither.
    const fake = { text: 'x' };
    expect(fake instanceof FilingText).toBe(false);
    expect(fake instanceof SentimentText).toBe(false);
  });

  it('reject non-string input', () => {
    for (const value of [undefined, null, 1, {}, ['x']]) {
      expect(() => FilingText.of(value as never)).toThrow(TypeError);
      expect(() => SentimentText.of(value as never)).toThrow(TypeError);
    }
  });

  it('are not assignable to each other or to plain objects (type level)', () => {
    // @ts-expect-error SentimentText is not FilingText (R8.6).
    const filing: FilingText = SentimentText.of('x');
    // @ts-expect-error FilingText is not SentimentText (R8.6).
    const sentiment: SentimentText = FilingText.of('x');
    // @ts-expect-error A structurally similar object is not FilingText.
    const lookAlike: FilingText = { text: 'x' };
    // @ts-expect-error The constructor is private; only FilingText.of creates one.
    const direct = new FilingText('x');
    expect([filing, sentiment, lookAlike, direct]).toHaveLength(4);
  });
});
