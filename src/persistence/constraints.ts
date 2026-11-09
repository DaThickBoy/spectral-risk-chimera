/**
 * Write-time record rules shared by every persistence adapter (task 5.1 rules,
 * moved here unchanged for task 5.3 / OD-12): the in-memory unit of work and the
 * SQLite adapter call the same functions, so both reject exactly the same
 * records with exactly the same messages. Messages name the field and never
 * echo the value (R4.3, R28.18, FR-13, D-10, task 10.3, 12.3, 12.5, 16.2, 16.3).
 *
 * These functions check one record on its own. Rules that depend on stored
 * state (uniqueness, references, the next retrieval `seq`, an alert's previous
 * version) stay with each adapter, which enforces them against its own state
 * (and, for SQLite, also with database constraints).
 */
import { IsoDate, canonicalJson, d, isDecimalText, isIsoUtcMillis, toCanonical } from '../shared/index.js';
import type {
  AlertRecord,
  AlertStateRecord,
  AuditRecord,
  FxRateRecord,
  ImportRecord,
  PortfolioRecord,
  PositionRecord,
  QuarantineRecordRow,
  RiskResultRecord,
  SeriesContentRecord,
  SeriesRetrievalRecord,
  SnapshotRecord,
  TransactionRecord,
} from './ports.js';
import { FX_DERIVATION_PRECISION, PersistenceError } from './ports.js';

export const violation = (message: string): PersistenceError =>
  new PersistenceError('CONSTRAINT_VIOLATION', message);

export const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

export const CONTENT_HASH = /^[0-9a-f]{64}$/;
export const CURRENCY_CODE = /^[A-Z]{3}$/;
const FX_PAIR = /^[A-Z]{3}[A-Z]{3}$/;

/** Financial columns hold Canonical Decimal Strings only (R4.3). The value is never echoed. */
export function assertCanonicalDecimal(repository: string, field: string, value: unknown): void {
  const canonical = typeof value === 'string' && isDecimalText(value) && toCanonical(d(value)) === value;
  if (!canonical) {
    throw violation(`${repository}.${field} must be a canonical decimal string`);
  }
}

/**
 * `IsoUtc` columns hold the canonical fixed-width UTC form
 * `YYYY-MM-DDTHH:mm:ss.sssZ` naming a real instant (shared `isIsoUtcMillis`).
 */
export function assertIsoUtc(repository: string, field: string, value: unknown): void {
  if (!isIsoUtcMillis(value)) {
    throw violation(`${repository}.${field} must be a UTC timestamp YYYY-MM-DDTHH:mm:ss.sssZ`);
  }
}

/**
 * Risk result and snapshot bodies are canonical JSON text: a JSON object whose
 * numbers are safe integers only, so no financial value can be a binary float.
 */
export function assertJsonText(repository: string, field: string, value: unknown): void {
  let canonical = false;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      canonical = typeof parsed === 'object' && parsed !== null && canonicalJson(parsed) === value;
    } catch {
      canonical = false;
    }
  }
  if (!canonical) {
    throw violation(`${repository}.${field} must be canonical JSON without non-integer numbers`);
  }
}

export function checkTransaction(record: TransactionRecord): void {
  assertCanonicalDecimal('transactions', 'quantity', record.quantity);
  assertCanonicalDecimal('transactions', 'price', record.price);
  // R28.18 ordering columns: a non-empty `sourceId` and a positive safe-integer `sourceSequence`.
  if (typeof record.sourceId !== 'string' || record.sourceId.length === 0) {
    throw violation('transactions.sourceId must be a non-empty string');
  }
  if (!Number.isSafeInteger(record.sourceSequence) || record.sourceSequence < 1) {
    throw violation('transactions.sourceSequence must be a positive integer');
  }
  assertIsoUtc('transactions', 'tradeTimestamp', record.tradeTimestamp);
  assertIsoUtc('transactions', 'createdAt', record.createdAt);
}

export function checkImport(record: ImportRecord): void {
  assertIsoUtc('imports', 'importedAt', record.importedAt);
}

export function checkQuarantine(record: QuarantineRecordRow): void {
  assertIsoUtc('quarantine', 'createdAt', record.createdAt);
}

/**
 * Position invariants (FR-13 rule 4): `averagePrice` is `null` exactly when
 * `signedQuantity` is `"0"`, and a zero-quantity position has `isShort: false`.
 */
export function checkPosition(record: PositionRecord): void {
  assertCanonicalDecimal('positions', 'signedQuantity', record.signedQuantity);
  const flat = record.signedQuantity === '0';
  if (record.averagePrice === null) {
    if (!flat) {
      throw violation('positions.averagePrice may be null only for a zero-quantity position');
    }
    if (record.isShort !== false) {
      throw violation('positions.isShort must be false for a zero-quantity position');
    }
  } else {
    assertCanonicalDecimal('positions', 'averagePrice', record.averagePrice);
    if (flat) {
      throw violation('positions.averagePrice must be null for a zero-quantity position');
    }
  }
  assertIsoUtc('positions', 'updatedAt', record.updatedAt);
}

export function checkAudit(record: AuditRecord): void {
  assertIsoUtc('audit', 'at', record.at);
  for (const [field, item] of Object.entries(record.details)) {
    if (typeof item !== 'string' && typeof item !== 'boolean') {
      throw violation(`audit.details.${field} must be a string or boolean`);
    }
  }
}

/** True when two content records hold the same ticker, currency, and exact observations. */
export const sameSeriesContent = (a: SeriesContentRecord, b: SeriesContentRecord): boolean =>
  canonicalJson({ ticker: a.ticker, currency: a.currency, observations: a.observations }) ===
  canonicalJson({ ticker: b.ticker, currency: b.currency, observations: b.observations });

/**
 * Series content: prices match the fixed decimal grammar and keep their exact
 * text (decision C2), so canonical form is not required.
 */
export function checkSeriesContent(record: SeriesContentRecord): void {
  if (typeof record.contentHash !== 'string' || !CONTENT_HASH.test(record.contentHash)) {
    throw violation('series.contentHash must be a 64-character lowercase hex SHA-256');
  }
  if (!isNonEmptyString(record.ticker)) {
    throw violation('series.ticker must be a non-empty string');
  }
  if (typeof record.currency !== 'string' || !CURRENCY_CODE.test(record.currency)) {
    throw violation('series.currency must be a three-letter currency code');
  }
  if (!Array.isArray(record.observations)) {
    throw violation('series.observations must be a list');
  }
  let previous: string | undefined;
  for (const observation of record.observations as readonly unknown[]) {
    const { date, adjustedClose } = (observation ?? {}) as { date?: unknown; adjustedClose?: unknown };
    if (typeof date !== 'string' || !IsoDate.safeParse(date).success) {
      throw violation('series.observations.date must be a calendar date YYYY-MM-DD');
    }
    if (previous !== undefined && !(previous < date)) {
      throw violation('series.observations dates must be strictly ascending');
    }
    if (typeof adjustedClose !== 'string' || !isDecimalText(adjustedClose)) {
      throw violation('series.observations.adjustedClose must be a decimal string');
    }
    previous = date;
  }
}

/** The record fields of a retrieval; `seq`, the content reference, and uniqueness are adapter rules. */
export function checkSeriesRetrieval(record: Omit<SeriesRetrievalRecord, 'seq'>): void {
  if (!isNonEmptyString(record.source)) {
    throw violation('series.source must be a non-empty string');
  }
  if (record.sourceKind !== 'REAL' && record.sourceKind !== 'DEMO') {
    throw violation('series.sourceKind must be REAL or DEMO');
  }
  assertIsoUtc('series', 'retrievedAt', record.retrievedAt);
}

/** FX rate record (task 10.3); uniqueness of id and key is an adapter rule. */
export function checkFxRate(record: FxRateRecord): void {
  if (!isNonEmptyString(record.id)) {
    throw violation('fxRates.id must be a non-empty string');
  }
  if (typeof record.pair !== 'string' || !FX_PAIR.test(record.pair)) {
    throw violation('fxRates.pair must be two three-letter currency codes');
  }
  assertCanonicalDecimal('fxRates', 'rate', record.rate);
  if (!d(record.rate).greaterThan(0)) {
    throw violation('fxRates.rate must be greater than 0');
  }
  assertIsoUtc('fxRates', 'observedAt', record.observedAt);
  assertIsoUtc('fxRates', 'recordedAt', record.recordedAt);
  if (record.observedAtBasis === 'PROVIDER') {
    if (record.conventionId !== undefined) {
      throw violation('fxRates.conventionId must be absent for basis PROVIDER');
    }
  } else if (record.observedAtBasis === 'PUBLICATION_CONVENTION') {
    if (!isNonEmptyString(record.conventionId)) {
      throw violation('fxRates.conventionId must be a non-empty string for basis PUBLICATION_CONVENTION');
    }
  } else {
    throw violation('fxRates.observedAtBasis must be PROVIDER or PUBLICATION_CONVENTION');
  }
  if (!isNonEmptyString(record.source)) {
    throw violation('fxRates.source must be a non-empty string');
  }
  if (record.sourceKind !== 'REAL' && record.sourceKind !== 'DEMO') {
    throw violation('fxRates.sourceKind must be REAL or DEMO');
  }
  if (record.published !== undefined) {
    checkPublishedQuote(record.pair, record.published);
  }
}

/** OD-20: the provider's quote must be complete and consistent with the stored pair and method. */
function checkPublishedQuote(pair: string, published: NonNullable<FxRateRecord['published']>): void {
  if (typeof published !== 'object' || published === null) {
    throw violation('fxRates.published must be an object when present');
  }
  if (typeof published.pair !== 'string' || !FX_PAIR.test(published.pair)) {
    throw violation('fxRates.published.pair must be two three-letter currency codes');
  }
  assertCanonicalDecimal('fxRates', 'published.rate', published.rate);
  if (!d(published.rate).greaterThan(0)) {
    throw violation('fxRates.published.rate must be greater than 0');
  }
  if (published.referenceDate !== undefined && !IsoDate.safeParse(published.referenceDate).success) {
    throw violation('fxRates.published.referenceDate must be a YYYY-MM-DD date');
  }
  const inverse = `${pair.slice(3)}${pair.slice(0, 3)}`;
  if (published.method === 'AS_PUBLISHED') {
    if (published.pair !== pair) {
      throw violation('fxRates.published.pair must equal pair for method AS_PUBLISHED');
    }
  } else if (published.method === 'DECIMAL_INVERSE') {
    if (published.pair !== inverse) {
      throw violation('fxRates.published.pair must be the inverse of pair for method DECIMAL_INVERSE');
    }
  } else {
    throw violation('fxRates.published.method must be AS_PUBLISHED or DECIMAL_INVERSE');
  }
  if (published.precision !== FX_DERIVATION_PRECISION) {
    throw violation('fxRates.published.precision must be SIGNIFICANT_DIGITS_40_ROUND_HALF_UP');
  }
}

export function checkPortfolio(record: PortfolioRecord): void {
  if (!isNonEmptyString(record.id)) {
    throw violation('portfolios.id must be a non-empty string');
  }
  if (typeof record.baseCurrency !== 'string' || !CURRENCY_CODE.test(record.baseCurrency)) {
    throw violation('portfolios.baseCurrency must be a three-letter currency code');
  }
  // NOT NULL, no default (A-7): cash is a canonical decimal, "0" and negative allowed.
  assertCanonicalDecimal('portfolios', 'cash', record.cash);
}

/** Risk result record (task 12.3); the snapshot reference and id uniqueness are adapter rules. */
export function checkRiskResult(record: RiskResultRecord): void {
  if (
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.portfolioId) ||
    !isNonEmptyString(record.status)
  ) {
    throw violation('riskResults.id, portfolioId, and status must be non-empty strings');
  }
  assertIsoUtc('riskResults', 'calculatedAt', record.calculatedAt);
  if (!Number.isSafeInteger(record.configVersionSeq) || record.configVersionSeq < 1) {
    throw violation('riskResults.configVersionSeq must be a positive integer');
  }
  if (!CONTENT_HASH.test(record.configVersionHash)) {
    throw violation('riskResults.configVersionHash must be a SHA-256 hex digest');
  }
  if ((record.snapshotHash === null) !== (record.snapshotId === null)) {
    throw violation('riskResults.snapshotHash and snapshotId must both be set or both be null');
  }
  if (record.snapshotHash !== null && !CONTENT_HASH.test(record.snapshotHash)) {
    throw violation('riskResults.snapshotHash must be a SHA-256 hex digest');
  }
  assertJsonText('riskResults', 'body', record.body);
}

/** Calculation snapshot record (task 12.5); id uniqueness is an adapter rule. */
export function checkSnapshot(record: SnapshotRecord): void {
  if (!isNonEmptyString(record.id) || !isNonEmptyString(record.portfolioId)) {
    throw violation('snapshots.id and portfolioId must be non-empty strings');
  }
  if (!CONTENT_HASH.test(record.hash)) {
    throw violation('snapshots.hash must be a SHA-256 hex digest');
  }
  assertIsoUtc('snapshots', 'createdAt', record.createdAt);
  assertIsoUtc('snapshots', 'evaluatedAt', record.evaluatedAt);
  assertJsonText('snapshots', 'snapshot', record.snapshot);
  assertJsonText('snapshots', 'inputsCanonical', record.inputsCanonical);
}

const ALERT_TYPES = new Set(['VAR', 'FILING_RISK']);
const SEVERITIES = new Set(['WARNING', 'HIGH', 'CRITICAL']);
const PHASES = new Set(['ARMED', 'BREACHED', 'REARMING']);
const ALERT_STATES = new Set(['OPEN', 'DISMISSED', 'RESOLVED']);
const DELIVERIES = new Set(['PENDING', 'DELIVERED', 'FAILED']);

/** Alert state (task 16.2). */
export function checkAlertState(record: AlertStateRecord): void {
  if (!ALERT_TYPES.has(record.type)) {
    throw violation('alertState.type must be VAR or FILING_RISK');
  }
  if (!isNonEmptyString(record.portfolioId)) {
    throw violation('alertState.portfolioId must be a non-empty string');
  }
  if (record.ticker !== null && !isNonEmptyString(record.ticker)) {
    throw violation('alertState.ticker must be null or a non-empty string');
  }
  if (!PHASES.has(record.phase)) {
    throw violation('alertState.phase must be ARMED, BREACHED, or REARMING');
  }
  const unset = [record.lastSeverity, record.lastAlertAt, record.lastAlertId].filter(
    (v) => v === null,
  ).length;
  if (unset !== 0 && unset !== 3) {
    throw violation('alertState.lastSeverity, lastAlertAt, and lastAlertId must all be set or all be null');
  }
  if (record.lastSeverity !== null && !SEVERITIES.has(record.lastSeverity)) {
    throw violation('alertState.lastSeverity must be WARNING, HIGH, or CRITICAL');
  }
  if (record.lastAlertAt !== null) {
    assertIsoUtc('alertState', 'lastAlertAt', record.lastAlertAt);
  }
  if (record.lastAlertId !== null && !isNonEmptyString(record.lastAlertId)) {
    throw violation('alertState.lastAlertId must be a non-empty string');
  }
  if (record.phase !== 'ARMED' && record.lastAlertAt === null) {
    throw violation('alertState.phase BREACHED or REARMING requires a last alert');
  }
  assertIsoUtc('alertState', 'updatedAt', record.updatedAt);
}

/** Alert content and status (task 16.3). */
export function checkAlert(record: AlertRecord): void {
  if (
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.portfolioId) ||
    !isNonEmptyString(record.source)
  ) {
    throw violation('alerts.id, portfolioId, and source must be non-empty strings');
  }
  if (!ALERT_TYPES.has(record.type)) {
    throw violation('alerts.type must be VAR or FILING_RISK');
  }
  if (record.ticker !== null && !isNonEmptyString(record.ticker)) {
    throw violation('alerts.ticker must be null or a non-empty string');
  }
  if (!SEVERITIES.has(record.severity)) {
    throw violation('alerts.severity must be WARNING, HIGH, or CRITICAL');
  }
  if (!isNonEmptyString(record.metric) || !isNonEmptyString(record.description)) {
    throw violation('alerts.metric and description must be non-empty strings');
  }
  assertCanonicalDecimal('alerts', 'observed', record.observed);
  assertCanonicalDecimal('alerts', 'threshold', record.threshold);
  if (!Array.isArray(record.triggeredTickers) || !record.triggeredTickers.every(isNonEmptyString)) {
    throw violation('alerts.triggeredTickers must be a list of non-empty strings');
  }
  assertIsoUtc('alerts', 'createdAt', record.createdAt);
  if (!ALERT_STATES.has(record.state)) {
    throw violation('alerts.state must be OPEN, DISMISSED, or RESOLVED');
  }
  if ((record.state === 'OPEN') !== (record.stateChangedAt === null)) {
    throw violation('alerts.stateChangedAt must be set exactly when the state is not OPEN');
  }
  if (record.stateChangedAt !== null) {
    assertIsoUtc('alerts', 'stateChangedAt', record.stateChangedAt);
  }
  if (!DELIVERIES.has(record.delivery)) {
    throw violation('alerts.delivery must be PENDING, DELIVERED, or FAILED');
  }
  if (!Number.isSafeInteger(record.deliveryAttempts) || record.deliveryAttempts < 0) {
    throw violation('alerts.deliveryAttempts must be a non-negative integer');
  }
  if ((record.deliveryAttempts === 0) !== (record.lastAttemptAt === null)) {
    throw violation('alerts.lastAttemptAt must be set exactly when an attempt was made');
  }
  if (record.lastAttemptAt !== null) {
    assertIsoUtc('alerts', 'lastAttemptAt', record.lastAttemptAt);
  }
}

const ALERT_CONTENT_FIELDS = [
  'type',
  'source',
  'portfolioId',
  'ticker',
  'severity',
  'metric',
  'observed',
  'threshold',
  'triggeredTickers',
  'createdAt',
  'description',
] as const;

/** An update may change delivery and dismissal fields only, and never backwards. */
export function checkAlertUpdate(existing: AlertRecord, next: AlertRecord): void {
  for (const field of ALERT_CONTENT_FIELDS) {
    if (canonicalJson(existing[field]) !== canonicalJson(next[field])) {
      throw violation(`alerts.${field} cannot change after insertion`);
    }
  }
  if (
    existing.state !== 'OPEN' &&
    (next.state !== existing.state || next.stateChangedAt !== existing.stateChangedAt)
  ) {
    throw violation('alerts.state cannot change after DISMISSED or RESOLVED');
  }
  if (existing.delivery !== 'PENDING' && next.delivery !== existing.delivery) {
    throw violation('alerts.delivery cannot change after DELIVERED or FAILED');
  }
  if (next.deliveryAttempts < existing.deliveryAttempts) {
    throw violation('alerts.deliveryAttempts cannot decrease');
  }
}
