// Public API of src/nlp/ (filing side only; the sentiment-text port is in src/sentiment/).
// nlp/ imports only shared/ and config/; it never imports sentiment/ (R8.6).
export { FilingAnalysisSchema, RISK_CATEGORIES } from './ports.js';
export type { FilingAnalysis, FilingNlpProvider, RiskCategory } from './ports.js';
export { FALLBACK_METHOD, FALLBACK_METHOD_VERSION, FallbackNlpProvider } from './fallbackProvider.js';
export { createFilingAnalyzer } from './filingAnalyzer.js';
export type {
  FilingAnalysisResult,
  FilingAnalyzer,
  FilingAnalyzerDependencies,
  FilingAnalyzerSettings,
  NlpError,
  NlpFailureCause,
  NlpMode,
  NlpSourceKind,
} from './filingAnalyzer.js';
