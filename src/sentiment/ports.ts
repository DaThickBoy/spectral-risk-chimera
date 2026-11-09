/**
 * Sentiment-text NLP port and output schema (task 21.1 declares them; R8.2, R8.6,
 * R21.2; design: NLP port and FilingRiskScore).
 *
 * Declaration only: no implementation, fallback, or wiring until tasks 13.x.
 * `sentiment/` imports only `shared/` and `config/`; it never imports `nlp/` or
 * `sec/`, and accepts only `SentimentText`, so SEC filing text can never become
 * sentiment input (R8.6).
 */
import { z } from 'zod';
import { AnalysisMethodName, AnalysisMethodVersion, SentimentIndexSchema } from '../shared/index.js';
import type { AttemptOutcome, SentimentText } from '../shared/index.js';

/** Provider output. Strict; the value is the branded SentimentIndex in [-1, +1], unchanged. */
export const SentimentTextAnalysisSchema = z.strictObject({
  value: SentimentIndexSchema,
  method: AnalysisMethodName,
  methodVersion: AnalysisMethodVersion,
});

export type SentimentTextAnalysis = z.infer<typeof SentimentTextAnalysisSchema>;

export interface SentimentTextProvider {
  readonly name: string;
  /** One attempt; the success value is unvalidated and must be checked with the schema (13.x). */
  analyzeSentimentText(text: SentimentText, signal: AbortSignal): Promise<AttemptOutcome<unknown>>;
}
