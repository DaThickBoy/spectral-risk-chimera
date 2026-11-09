// Public API of src/shared/. Other modules import from this file only.
export {
  DEC,
  DECIMAL_PRECISION,
  DECIMAL_ROUNDING,
  DECIMAL_TEXT_PATTERN,
  DecimalInputError,
  brandDecimalString,
  d,
  isDecimal,
  isDecimalText,
  roundMoney,
  formatMoneyDisplay,
  currencyMinorUnits,
  toCanonical,
  toChartNumber,
} from './decimal.js';
export type { Decimal, DecimalErrorCode, DecimalString } from './decimal.js';
export { canonicalJson, compareCodePoints, sha256Hex } from './canonical.js';
export { FakeClock, systemClock } from './clock.js';
export type { Clock } from './clock.js';
export { appError, assertNever } from './errors.js';
export type { AppError } from './errors.js';
export { err, ok } from './result.js';
export type { Result } from './result.js';
export { newCorrelationId, randomIds, sequentialIds } from './ids.js';
export type { IdGenerator } from './ids.js';
export { BoundedQueue } from './boundedQueue.js';
export type { OfferOutcome } from './boundedQueue.js';
export { REDACTED, redact, redactText } from './redact.js';
export type { RedactionOptions } from './redact.js';
export { createLogger } from './logger.js';
export type { LogLevel, Logger, LoggerOptions } from './logger.js';
export {
  AnalysisMethodName,
  AnalysisMethodVersion,
  DecimalStringSchema,
  FilingRiskScoreSchema,
  Iso4217Code,
  IsoDate,
  IsoTimestamp,
  PositiveDecimalString,
  SentimentIndexSchema,
  SignedUnitDecimalString,
  TICKER_PATTERN,
  TickerSchema,
  UnitIntervalDecimalString,
  decimalInRange,
  isKnownCurrency,
  isTicker,
} from './schemas.js';
export type { FilingRiskScore, SentimentIndex } from './schemas.js';
export { ISO_UTC_MILLIS_PATTERN, IsoUtcMillis, isIsoUtcMillis } from './timestamps.js';
export { neutralizeCsvCell } from './csvCell.js';
export { FilingText, SentimentText } from './analysisText.js';
export { FakeSleeper, systemSleeper } from './sleeper.js';
export type { SleepOutcome, Sleeper } from './sleeper.js';
export { parseRetryAfterMs } from './retryAfter.js';
export { createResilientCall } from './resilience.js';
export type {
  AttemptOutcome,
  CircuitPolicy,
  CircuitState,
  ProviderError,
  ProviderErrorCode,
  ProviderState,
  ProviderStatus,
  ResilientCall,
  ResilientCallDependencies,
  ExceptionLogging,
  RetryPolicy,
  RunOptions,
} from './resilience.js';
export { LastValidStore, dataStatus } from './dataStatus.js';
export type { DataFreshness, DataSourceKind, DataStatusInput, StoredValue } from './dataStatus.js';
export {
  JSON_NUMBER_PATTERN,
  LOSSLESS_JSON_MAX_DEPTH,
  LosslessJsonNumber,
  isLosslessJsonNumber,
} from './losslessJson.js';
export type { LosslessJsonError, LosslessJsonParser, LosslessJsonValue } from './losslessJson.js';
// Shared API contracts (task 4.2): request, response, and error schemas for api/ and web/.
export * from './apiContracts/index.js';
