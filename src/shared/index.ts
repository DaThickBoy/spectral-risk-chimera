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
  DecimalStringSchema,
  FilingRiskScoreSchema,
  Iso4217Code,
  IsoDate,
  IsoTimestamp,
  PositiveDecimalString,
  SentimentIndexSchema,
  SignedUnitDecimalString,
  UnitIntervalDecimalString,
  decimalInRange,
  isKnownCurrency,
} from './schemas.js';
export type { FilingRiskScore, SentimentIndex } from './schemas.js';
