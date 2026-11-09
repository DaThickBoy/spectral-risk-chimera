// Task 21.1: the sentiment-text port and schema (declared only; implementation in 13.x).
// The @ts-expect-error line is checked by `npm run typecheck`.
// Validates: Requirements 8.2, 8.6, 21.2, 21.3
import { describe, expect, it } from 'vitest';
import { SentimentTextAnalysisSchema } from '../../../src/sentiment/index.js';
import type { SentimentTextProvider } from '../../../src/sentiment/index.js';
import { FilingText, SentimentText } from '../../../src/shared/index.js';

const base = { value: '0.25', method: 'acme-sentiment', methodVersion: '1' };

describe('SentimentTextAnalysisSchema', () => {
  it.each(['-1', '1', '0', '-0.6001', '0.250'])('accepts %s unchanged', (value) => {
    expect(SentimentTextAnalysisSchema.parse({ ...base, value })).toEqual({ ...base, value });
  });

  it.each([
    ['above +1', { value: '1.0001' }],
    ['below -1', { value: '-1.01' }],
    ['a JSON number', { value: 0.5 }],
    ['exponent notation', { value: '5e-1' }],
    ['a whitespace-only method', { method: ' ' }],
    ['a version that is too long', { methodVersion: 'v'.repeat(33) }],
    ['an unknown field', { mode: 'REAL' }],
  ])('rejects %s', (_label, overrides) => {
    expect(SentimentTextAnalysisSchema.safeParse({ ...base, ...overrides }).success).toBe(false);
  });
});

describe('SentimentTextProvider accepts only SentimentText (type level, R8.6)', () => {
  it('rejects FilingText at compile time', () => {
    const p: SentimentTextProvider = {
      name: 'declared-only',
      analyzeSentimentText: () => Promise.resolve({ ok: false, failure: 'NETWORK' }),
    };
    const signal = new AbortController().signal;
    void p.analyzeSentimentText(SentimentText.of('market text'), signal);
    // @ts-expect-error SEC filing text is never sentiment input.
    void p.analyzeSentimentText(FilingText.of('filing text'), signal);
    expect(p.name).toBe('declared-only');
  });
});
