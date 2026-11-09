/**
 * Persistence ports (task 5.1; design: Persistence, Persisted tables, D-6, U-1).
 *
 * Domain modules (`ingestion/`, `audit/`, later `portfolio/` services) depend only
 * on this file. Implementations live elsewhere in `persistence/`: the in-memory
 * unit of work for tests (task 5.1) and the adapter approved in OD-12 (task 5.3,
 * blocked). No technology is chosen here.
 *
 * Scope: the repositories for the phase 2 aggregates — transactions, imports,
 * quarantine records, positions, and the audit log. The design's `Repositories`
 * also names repositories for market series, FX rates, sentiment, filings, risk
 * results, snapshots, alerts, alert state, configuration versions, and provider
 * status; their record shapes depend on later phases and are added by those
 * phases' tasks.
 *
 * Task 9.4 adds the series repository (`SeriesRepo`: immutable content in
 * `price_series`, append-only provenance in `series_retrievals`). Task 10.3 adds
 * the append-only FX rate repository (`FxRepo`, table `fx_rates`).
 *
 * Rules:
 * - Every financial field is a `DecimalString` holding a Canonical Decimal String
 *   (R4.3, financial-rules 6). A JavaScript `number` is a type error, and
 *   implementations reject non-canonical text at write time.
 *   One narrow exception (task 9.4, decision C2): the observation prices of a
 *   stored series (`SeriesContentRecord.observations[].adjustedClose`) keep the
 *   exact decimal text produced by the series cleaner (for example `"100.0"`),
 *   because the series content hash is computed over that text. They must match
 *   the fixed decimal grammar (R4.6) but need not be canonical. No other field
 *   is exempt.
 * - Counts (`totalRows`, `sequence`) are integers, not financial values (R4.7).
 * - Timestamps are canonical fixed-width UTC strings (`IsoUtc`), validated at write time.
 * - Records are plain data. Implementations store and return copies, so a caller
 *   can never change stored state by mutating a record.
 * - The audit repository is append-only: it has no update or delete operation.
 *   The transaction ledger has no delete either. Only positions (a projection)
 *   can be deleted (task 6.2, R5.6). Series content and series retrievals have
 *   no update or delete operation (task 9.4, D-10). FX rate records have no
 *   update or delete operation either (task 10.3).
 *
 * Validates: Requirements 4.3, 5.6, 12.6, 12.7, 22.3, 28.15, 28.16, 28.18, 30.5.
 */
import type { DecimalString } from '../shared/index.js';

/**
 * UTC ISO 8601 timestamp in the canonical fixed-width form
 * `YYYY-MM-DDTHH:mm:ss.sssZ`, for example `2026-11-06T10:00:00.000Z`. Every
 * implementation rejects any other text at write time, using the shared
 * `isIsoUtcMillis` (calendar and clock values are checked, not only the shape).
 * The fixed width makes ordinal order chronological (R28.18).
 */
export type IsoUtc = string;

/** Row and message rejection reasons (design: Core TypeScript models). */
export type RejectReason =
  | 'INVALID_ENCODING'
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_ROWS'
  | 'INVALID_HEADER'
  /** Task 7.1: structurally malformed CSV (quote error or field-count mismatch); file-level. */
  | 'MALFORMED_CSV'
  | 'MISSING_REQUIRED_FIELD'
  /** Task 7.2: a row's `portfolio_id` names another portfolio than the import. */
  | 'PORTFOLIO_MISMATCH'
  | 'MALFORMED_NUMBER'
  | 'INVALID_DATE'
  | 'INVALID_TICKER'
  | 'UNSUPPORTED_TRANSACTION_TYPE'
  | 'UNSUPPORTED_CURRENCY'
  | 'CURRENCY_MISMATCH'
  | 'OVERSELL'
  | 'FIELD_TOO_LONG'
  | 'FIX_MALFORMED'
  | 'FIX_UNSUPPORTED_MSG_TYPE'
  | 'FIX_MISSING_TAG'
  | 'FIX_INVALID_VALUE';

export type SourceKind = 'CSV' | 'FIX';

/** A committed transaction (table `transactions`). Unique per `(portfolioId, transactionKey)` (R28.12). */
export interface TransactionRecord {
  readonly id: string;
  readonly portfolioId: string;
  /** SHA-256 hex key defined in R28.11. */
  readonly transactionKey: string;
  readonly externalId?: string;
  /** Source label passed to the import (as used in R28.11). Display and audit only; never an ordering key. */
  readonly source: string;
  /**
   * Stable source identifier (R28.18): `"<sourceKind>:" + fileSha256`. The same
   * for the same file content; never changed after the commit. Non-empty.
   */
  readonly sourceId: string;
  /**
   * Position of the record within its source (R28.18): the CSV data row number or
   * FIX message sequence. A positive safe integer; an index, not a financial value.
   */
  readonly sourceSequence: number;
  readonly tradeTimestamp: IsoUtc;
  readonly ticker: string;
  readonly type: 'BUY' | 'SELL';
  readonly quantity: DecimalString;
  readonly price: DecimalString;
  readonly currency: string;
  readonly importId: string;
  readonly createdAt: IsoUtc;
}

/** An import summary (table `imports`, R28.9). */
export interface ImportRecord {
  readonly id: string;
  readonly fileName: string;
  readonly fileSha256: string;
  readonly importedAt: IsoUtc;
  readonly totalRows: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly duplicates: number;
  readonly skipped: number;
  readonly status: 'COMMITTED' | 'COMMITTED_WITH_REJECTIONS' | 'FAILED';
  readonly failureReason?: string;
}

/** A rejected row or message (table `quarantine_records`, R3.3, R28.10). */
export interface QuarantineRecordRow {
  readonly id: string;
  readonly importId: string;
  readonly sourceKind: SourceKind;
  /** Row number or message sequence. */
  readonly sequence: number;
  readonly reasonCode: RejectReason;
  readonly message: string;
  readonly columnName?: string;
  /** Truncated, redacted excerpt of the raw record. */
  readonly rawExcerpt: string;
  readonly createdAt: IsoUtc;
}

/**
 * A netted position (table `positions`, D-9). One per `(portfolioId, ticker)` (R5.3).
 * `averagePrice` is `null` exactly for a zero-quantity position, which then has
 * `isShort: false` (FR-13 rule 4); implementations reject any other combination
 * with `null`, and a non-null average price on a zero-quantity position.
 */
export interface PositionRecord {
  readonly id: string;
  readonly portfolioId: string;
  readonly ticker: string;
  readonly currency: string;
  readonly signedQuantity: DecimalString;
  readonly averagePrice: DecimalString | null;
  readonly isShort: boolean;
  readonly source: string;
  readonly updatedAt: IsoUtc;
}

export type AuditCategory =
  'IMPORT' | 'VALIDATION' | 'PROVIDER' | 'CALCULATION' | 'ALERT' | 'CONFIG' | 'SECURITY';

/** An audit entry (table `audit_log`). Details carry strings and booleans only, never native-number money. */
export interface AuditRecord {
  readonly id: string;
  readonly at: IsoUtc;
  readonly category: AuditCategory;
  readonly type: string;
  readonly subject?: string;
  readonly actor?: string;
  readonly details: Readonly<Record<string, string | boolean>>;
}

export interface TransactionRepo {
  /** Inserts a transaction. A duplicate `(portfolioId, transactionKey)` violates a constraint. */
  insert(record: TransactionRecord): void;
  findByKey(portfolioId: string, transactionKey: string): TransactionRecord | undefined;
  /** All transactions of a portfolio, in insertion order (callers sort for replay). */
  listByPortfolio(portfolioId: string): readonly TransactionRecord[];
}

export interface ImportRepo {
  /** Inserts an import summary. A duplicate id violates a constraint. */
  insert(record: ImportRecord): void;
  get(id: string): ImportRecord | undefined;
}

export interface QuarantineRepo {
  /** Inserts a quarantine record. A duplicate id violates a constraint. */
  insert(record: QuarantineRecordRow): void;
  /** Records of one import, in insertion order. */
  listByImport(importId: string): readonly QuarantineRecordRow[];
}

/**
 * Positions are a projection of the ledger (D-9), so unlike the ledger and the
 * audit log they can be deleted. Every write, including `delete`, belongs to the
 * unit of work and is committed or rolled back with its other writes (R5.6).
 */
export interface PositionRepo {
  /** Inserts or replaces the position for `(portfolioId, ticker)`. */
  upsert(record: PositionRecord): void;
  /**
   * Removes the position for `(portfolioId, ticker)`. Used only by the position
   * rebuild to remove an orphaned position. Deleting a position that does not
   * exist violates a constraint, so a mistaken delete is never silent.
   */
  delete(portfolioId: string, ticker: string): void;
  get(portfolioId: string, ticker: string): PositionRecord | undefined;
  /** Positions of a portfolio, in first-insertion order. */
  listByPortfolio(portfolioId: string): readonly PositionRecord[];
}

/** Append-only: there is deliberately no update or delete operation. */
export interface AuditRepo {
  /** Appends an entry. A duplicate id violates a constraint. */
  append(record: AuditRecord): void;
  /** All entries in append order. */
  list(): readonly AuditRecord[];
}

/** Whether a stored series retrieval came from a real provider or a demo source. */
export type SeriesSourceKind = 'REAL' | 'DEMO';

/** One stored observation: a trading date and its exact decimal price text (C2 exception). */
export interface SeriesObservationRecord {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** Exact text produced by the series cleaner; fixed decimal grammar, not necessarily canonical. */
  readonly adjustedClose: DecimalString;
}

/**
 * Immutable series content (table `price_series`, D-10, task 9.4). Keyed by
 * `contentHash`; written at most once and never updated or deleted. Carries no
 * provenance: one content may be referenced by several retrievals.
 */
export interface SeriesContentRecord {
  /** 64-character lowercase hex SHA-256 of `canonicalJson({ ticker, currency, observations })`. */
  readonly contentHash: string;
  readonly ticker: string;
  readonly currency: string;
  /** Strictly ascending by date. */
  readonly observations: readonly SeriesObservationRecord[];
}

/**
 * One successful retrieval of a series (table `series_retrievals`, append-only,
 * R12.6, R22.3). `seq` is assigned by the repository: 1, 2, 3, ... in commit order.
 */
export interface SeriesRetrievalRecord {
  readonly seq: number;
  readonly contentHash: string;
  readonly ticker: string;
  readonly source: string;
  readonly sourceKind: SeriesSourceKind;
  readonly retrievedAt: IsoUtc;
}

/** A retrieval to append; the repository assigns `seq`. */
export type NewSeriesRetrieval = Omit<SeriesRetrievalRecord, 'seq'>;

/**
 * Content-addressed series storage (task 9.4). There is deliberately no update
 * or delete operation. Hashes are not recomputed here; `SeriesStore` (app/) does that.
 */
export interface SeriesRepo {
  /**
   * Inserts content for a new hash and returns true. For an existing hash with
   * identical content it writes nothing and returns false; different content
   * under an existing hash violates a constraint.
   */
  insertContent(record: SeriesContentRecord): boolean;
  getContent(contentHash: string): SeriesContentRecord | undefined;
  /**
   * Appends a retrieval and returns it with its assigned `seq`. The content must
   * exist with the same ticker, and `(contentHash, source, sourceKind,
   * retrievedAt)` must be unique; otherwise a constraint is violated.
   */
  appendRetrieval(record: NewSeriesRetrieval): SeriesRetrievalRecord;
  /** Retrievals of one content hash, in `seq` order. */
  listRetrievalsByHash(contentHash: string): readonly SeriesRetrievalRecord[];
  /** Retrievals of one ticker and source kind, in `seq` order. */
  listRetrievalsByTicker(ticker: string, sourceKind: SeriesSourceKind): readonly SeriesRetrievalRecord[];
}

/**
 * One FX rate received from the configured provider (table `fx_rates`, task 10.3;
 * R22.3, R30.5, R30.13). Append-only. `pair` is the requested pair `X + B` and
 * `rate` the canonical `Rate(X/B)` (inverted for inverse quotes, never the
 * provider's quote orientation). The base-currency identity rate is never stored.
 */
export interface FxRateRecord {
  readonly id: string;
  /** Requested pair `X + B`, for example `EURUSD`. */
  readonly pair: string;
  /** Canonical `Rate(X/B)`, greater than 0. */
  readonly rate: DecimalString;
  readonly observedAt: IsoUtc;
  readonly observedAtBasis: 'PROVIDER' | 'PUBLICATION_CONVENTION';
  /** Present exactly for `PUBLICATION_CONVENTION` (task 10.4). */
  readonly conventionId?: string;
  readonly source: string;
  readonly sourceKind: 'REAL' | 'DEMO';
  readonly recordedAt: IsoUtc;
  /**
   * OD-20 (approved 2026-11-09, migration 2): the provider's quote as received, kept
   * beside the derived `rate`. Absent on rows written before migration 2 (all its
   * columns are then NULL); a row never has only part of it.
   */
  readonly published?: FxPublishedQuote;
}

/** Precision of the FX derivation: the project Decimal configuration (FR-14). */
export const FX_DERIVATION_PRECISION = 'SIGNIFICANT_DIGITS_40_ROUND_HALF_UP';

/**
 * The provider's quote behind one stored FX rate (OD-20). For the ECB this is the
 * published euro reference rate `EUR -> X`; it is never the derived application rate.
 */
export interface FxPublishedQuote {
  /** The quote's own orientation, `from + to` (for the ECB `EUR + X`). */
  readonly pair: string;
  /** The quoted value, canonical decimal text (numerically exact; FR-14 serialization). */
  readonly rate: DecimalString;
  /** The provider's reference date (`YYYY-MM-DD`), when it publishes one (the ECB does). */
  readonly referenceDate?: string;
  /** `AS_PUBLISHED`: `rate` is the quote (pair equals the stored pair); `DECIMAL_INVERSE`: `rate = 1 / quote`. */
  readonly method: 'AS_PUBLISHED' | 'DECIMAL_INVERSE';
  readonly precision: typeof FX_DERIVATION_PRECISION;
}

/** Append-only FX rate history: there is deliberately no update or delete operation. */
export interface FxRepo {
  /**
   * Appends a record. A duplicate `id`, or a duplicate key `(pair, source,
   * sourceKind, observedAt)`, violates a constraint.
   */
  append(record: FxRateRecord): void;
  findByKey(
    pair: string,
    source: string,
    sourceKind: 'REAL' | 'DEMO',
    observedAt: IsoUtc,
  ): FxRateRecord | undefined;
  /** Records of one pair, in append order. */
  listByPair(pair: string): readonly FxRateRecord[];
}

/**
 * A portfolio (table `portfolios`, task 6.1; A-7, FR-10, R30.1). `cash` is the
 * explicitly supplied cash balance in base currency, a Canonical Decimal String
 * that may be "0" or negative; it is required and never defaulted.
 */
export interface PortfolioRecord {
  readonly id: string;
  /** ISO 4217 code; equal to `fx.baseCurrency` (R30.1). */
  readonly baseCurrency: string;
  readonly cash: DecimalString;
}

export interface PortfolioRepo {
  /** Inserts a portfolio. A duplicate id violates a constraint. */
  insert(record: PortfolioRecord): void;
  get(id: string): PortfolioRecord | undefined;
}

/**
 * A stored risk calculation outcome (table `risk_results`, task 12.3; R13.5,
 * R14.12, R14.14). Append-only: earlier results are kept, so the last valid one
 * can be shown as `LAST_VALID`. `body` is the canonical JSON of the result (all
 * financial values Canonical Decimal Strings, TEXT); readers validate it.
 */
export interface RiskResultRecord {
  readonly id: string;
  readonly portfolioId: string;
  readonly calculatedAt: IsoUtc;
  /** A `CalcStatus`. */
  readonly status: string;
  readonly configVersionSeq: number;
  readonly configVersionHash: string;
  /** `null` when no calculation ran (a precondition failed). */
  readonly snapshotHash: string | null;
  readonly snapshotId: string | null;
  readonly body: string;
}

/** Append-only: there is deliberately no update or delete operation. */
export interface RiskResultRepo {
  /** Appends a result. A duplicate id violates a constraint. */
  append(record: RiskResultRecord): void;
  /** Results of one portfolio, in append order. */
  listByPortfolio(portfolioId: string): readonly RiskResultRecord[];
}

/**
 * A calculation snapshot (table `calc_snapshots`, task 12.5; R32.1, R32.4). The
 * hash index is not unique: identical inputs calculated twice give two rows with
 * one hash. `snapshot` is the canonical JSON of the full snapshot including
 * `displayOnly`; `inputsCanonical` excludes it and is what `hash` covers.
 */
export interface SnapshotRecord {
  readonly id: string;
  readonly portfolioId: string;
  readonly hash: string;
  readonly createdAt: IsoUtc;
  /** The calculation timestamp (not hashed, R32.4). */
  readonly evaluatedAt: IsoUtc;
  readonly snapshot: string;
  readonly inputsCanonical: string;
}

/** Append-only: there is deliberately no update or delete operation. */
export interface SnapshotRepo {
  insert(record: SnapshotRecord): void;
  get(id: string): SnapshotRecord | undefined;
  /** Snapshots with this hash, in insertion order. */
  listByHash(hash: string): readonly SnapshotRecord[];
}

export type AlertTypeRecord = 'VAR' | 'FILING_RISK';
export type AlertSeverityRecord = 'WARNING' | 'HIGH' | 'CRITICAL';

/**
 * Persisted alert state per key `(type, portfolioId, ticker)` (table
 * `alert_state`, task 16.2; R34.1, R34.5, R34.6). `ticker` is `null` for
 * portfolio-level keys (VaR). `lastSeverity`, `lastAlertAt`, and `lastAlertId`
 * are all `null` before the first alert, or all set.
 */
export interface AlertStateRecord {
  readonly type: AlertTypeRecord;
  readonly portfolioId: string;
  readonly ticker: string | null;
  readonly phase: 'ARMED' | 'BREACHED' | 'REARMING';
  readonly lastSeverity: AlertSeverityRecord | null;
  readonly lastAlertAt: IsoUtc | null;
  readonly lastAlertId: string | null;
  readonly updatedAt: IsoUtc;
}

export interface AlertStateRepo {
  /** Inserts or replaces the state of its key. */
  upsert(record: AlertStateRecord): void;
  get(type: AlertTypeRecord, portfolioId: string, ticker: string | null): AlertStateRecord | undefined;
}

/**
 * A raised alert (table `alerts`, task 16.3; R19.2, R19.4, R34.7, R34.8). The
 * table is also the delivery outbox: `delivery = PENDING` rows are waiting for
 * the dispatcher. Content fields never change after insertion; only the
 * delivery and dismissal fields do, and never backwards (OPEN to DISMISSED or
 * RESOLVED; PENDING to DELIVERED or FAILED). Alerts are never deleted, so
 * dismissal preserves history. `observed` and `threshold` are canonical decimals.
 */
export interface AlertRecord {
  readonly id: string;
  readonly type: AlertTypeRecord;
  readonly source: string;
  readonly portfolioId: string;
  readonly ticker: string | null;
  readonly severity: AlertSeverityRecord;
  readonly metric: string;
  readonly observed: DecimalString;
  readonly threshold: DecimalString;
  readonly triggeredTickers: readonly string[];
  readonly createdAt: IsoUtc;
  readonly description: string;
  readonly state: 'OPEN' | 'DISMISSED' | 'RESOLVED';
  readonly stateChangedAt: IsoUtc | null;
  readonly delivery: 'PENDING' | 'DELIVERED' | 'FAILED';
  /** Publish attempts made so far: a count, not a financial value. */
  readonly deliveryAttempts: number;
  readonly lastAttemptAt: IsoUtc | null;
}

/** No delete operation: alert history is preserved (R19.4). */
export interface AlertRepo {
  /** Inserts an alert. A duplicate id violates a constraint. */
  insert(record: AlertRecord): void;
  /** Replaces the delivery and dismissal fields of an existing alert; content must be unchanged. */
  update(record: AlertRecord): void;
  get(id: string): AlertRecord | undefined;
  /** Alerts of one portfolio, in insertion order. */
  listByPortfolio(portfolioId: string): readonly AlertRecord[];
  /** Alerts with this delivery status, in insertion order (the outbox for `PENDING`). */
  listByDelivery(delivery: AlertRecord['delivery']): readonly AlertRecord[];
}

/** The repositories available inside one unit of work. */
export interface Repositories {
  /** Task 16.2. */
  readonly alertState: AlertStateRepo;
  /** Task 16.3. */
  readonly alerts: AlertRepo;
  /** Task 12.3. */
  readonly riskResults: RiskResultRepo;
  /** Task 12.5. */
  readonly snapshots: SnapshotRepo;
  /** Task 6.1. */
  readonly portfolios: PortfolioRepo;
  readonly transactions: TransactionRepo;
  readonly imports: ImportRepo;
  readonly quarantine: QuarantineRepo;
  readonly positions: PositionRepo;
  readonly audit: AuditRepo;
  readonly series: SeriesRepo;
  readonly fxRates: FxRepo;
}

/**
 * Runs `work` in one transaction (design: `UnitOfWork.run`, R28.15, R28.16).
 *
 * - Every write made through `tx` is committed together when `work` returns, or
 *   none is: if `work` throws, or the commit fails, committed state is exactly as
 *   before and the error propagates.
 * - Reads through `tx` see the transaction's own writes; other units of work see
 *   only committed state.
 * - `work` is synchronous. The repositories passed to it must not be used after
 *   `run` returns.
 */
export interface UnitOfWork {
  run<T>(work: (tx: Repositories) => T): T;
}

/**
 * `INTEGRITY_ERROR` (OD-12): a stored record failed decoding, validation, or an
 * integrity check on read (or the database itself is unusable). No part of the
 * record is returned and no stored value appears in the message.
 */
export type PersistenceErrorCode = 'COMMIT_FAILED' | 'CONSTRAINT_VIOLATION' | 'INTEGRITY_ERROR';

/**
 * A persistence failure surfaced by `UnitOfWork.run`. The design's `run` returns
 * `T`, so persistence failures are thrown as this typed error rather than
 * returned as a `Result`; callers map it to their own status (for example
 * `IMPORT_COMMIT_FAILED`, R28.16).
 */
export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode, message: string) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
  }
}
