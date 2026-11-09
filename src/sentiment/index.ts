// Public API of src/sentiment/. sentiment/ imports only shared/ and config/; it never imports nlp/ or
// sec/ (R8.6). Task 21.1 declared the sentiment-text port; tasks 13.1, 13.3, 13.4, and 13.6 add
// ingestion, state, the aggregator interface, and the emitter.
export { SentimentTextAnalysisSchema } from './ports.js';
export type { SentimentTextAnalysis, SentimentTextProvider } from './ports.js';
export { SentimentObservationSchema, normalizeObservation, normalizeObservedAt } from './observation.js';
export type { ObservationRejectReason, ObservationRejection, SentimentObservation } from './observation.js';
export { FixtureSentimentProvider } from './provider.js';
export type { FixtureSentimentProviderOptions, SentimentProvider } from './provider.js';
export { SENTIMENT_FETCH_OPERATION, createSentimentPoller } from './poller.js';
export type { PollSummary, SentimentPoller, SentimentPollerDependencies } from './poller.js';
export { sentimentFreshness } from './freshness.js';
export type { SentimentStatus } from './freshness.js';
export type { SentimentAggregator } from './aggregator.js';
export { createSentimentState } from './state.js';
export type {
  RecordOutcome,
  SentimentIndexView,
  SentimentRiskEntry,
  SentimentState,
  SentimentStateDependencies,
  SentimentView,
} from './state.js';
export { EMISSION_INTERVAL_MS, createSentimentEmitter } from './emitter.js';
export type { SentimentEmitter, SentimentEmitterDependencies } from './emitter.js';
export { createSentimentStream, reconnectDelayMs } from './stream.js';
export type {
  ConnectFailure,
  ReconnectPolicy,
  SentimentStream,
  SentimentStreamDependencies,
  StreamConnection,
  StreamHandlers,
  StreamStatus,
  StreamTransport,
} from './stream.js';
