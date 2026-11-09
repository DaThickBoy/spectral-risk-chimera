/**
 * Filing NLP port and output schema (task 21.1; R7.1, R7.4, R8.1, R21.1, R21.3;
 * design: NLP port and FilingRiskScore).
 *
 * `nlp/` imports only `shared/` and `config/`. It owns the filing side only; the
 * sentiment-text port lives in `sentiment/`, and the two modules never import
 * each other (R8.6). A provider receives a `FilingText` and the attempt's
 * `AbortSignal`, and returns an unvalidated `AttemptOutcome<unknown>`; the
 * analyzer validates the value with `FilingAnalysisSchema` inside the attempt.
 */
import { z } from 'zod';
import { AnalysisMethodName, AnalysisMethodVersion, FilingRiskScoreSchema } from '../shared/index.js';
import type { AttemptOutcome, FilingText } from '../shared/index.js';

/** R7.4 risk categories. */
export const RISK_CATEGORIES = [
  'MARKET',
  'LIQUIDITY',
  'CREDIT',
  'OPERATIONAL',
  'REGULATORY',
  'LEGAL',
  'CYBERSECURITY',
  'BUSINESS',
] as const;

export type RiskCategory = (typeof RISK_CATEGORIES)[number];

/**
 * Provider output. Strict: unknown fields (for example a provider-supplied `mode`)
 * are rejected. The score is the branded `FilingRiskScore` in [0, 1], returned as
 * received; nothing is clamped, coerced, trimmed, or defaulted.
 */
export const FilingAnalysisSchema = z.strictObject({
  score: FilingRiskScoreSchema,
  categories: z
    .array(z.enum(RISK_CATEGORIES))
    .max(RISK_CATEGORIES.length)
    .refine((list) => new Set(list).size === list.length, { message: 'categories must be unique' }),
  method: AnalysisMethodName,
  methodVersion: AnalysisMethodVersion,
});

export type FilingAnalysis = z.infer<typeof FilingAnalysisSchema>;

export interface FilingNlpProvider {
  /** Lowercase identifier `[a-z0-9][a-z0-9._-]{0,63}`, used in the ResilientCall identity. */
  readonly name: string;
  /** One attempt. The value of a success is validated by the analyzer, never trusted. */
  analyzeFiling(text: FilingText, signal: AbortSignal): Promise<AttemptOutcome<unknown>>;
}
