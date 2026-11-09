// Seeded violations: sentiment/ imports nlp/ and sec/ (R8.6).
import { nlpResult } from '../nlp/index.js';
import { filingScore } from '../sec/index.js';

export const sentimentFiling = `${nlpResult}${filingScore}`;
