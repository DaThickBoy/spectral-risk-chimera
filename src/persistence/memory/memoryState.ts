/**
 * State and write application for the in-memory unit of work (task 5.1).
 *
 * Records are stored as frozen, detached copies, so state copies can share them
 * and callers can never change stored state through a record. `applyWrite`
 * enforces the table constraints from the design (unique ids, unique
 * `(portfolioId, transactionKey)`, one position per `(portfolioId, ticker)`) and
 * the Canonical Decimal String rule for financial fields (R4.3). Task 6.2 adds
 * the R28.18 ordering columns of transactions, the zero-quantity position
 * invariant (FR-13), and position deletion (R5.6). Task 9.4 adds series content
 * (immutable, at most once per hash) and series retrievals (append-only, `seq`
 * assigned in commit order); series prices are checked against the fixed decimal
 * grammar only, not for canonical form (decision C2). Task 10.3 adds append-only
 * FX rate records with a unique id and a unique `(pair, source, sourceKind,
 * observedAt)` key; their rate is a canonical decimal.
 */
import {
  checkAlert,
  checkAlertState,
  checkAlertUpdate,
  checkAudit,
  checkFxRate,
  checkImport,
  checkPortfolio,
  checkPosition,
  checkQuarantine,
  checkRiskResult,
  checkSeriesContent,
  checkSeriesRetrieval,
  checkSnapshot,
  checkTransaction,
  sameSeriesContent,
  violation,
} from '../constraints.js';
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
} from '../ports.js';

/** One write in a transaction's write log. */
export type WriteOperation =
  | { readonly repository: 'transactions'; readonly operation: 'insert'; readonly record: TransactionRecord }
  | { readonly repository: 'imports'; readonly operation: 'insert'; readonly record: ImportRecord }
  | { readonly repository: 'quarantine'; readonly operation: 'insert'; readonly record: QuarantineRecordRow }
  | { readonly repository: 'positions'; readonly operation: 'upsert'; readonly record: PositionRecord }
  | {
      readonly repository: 'positions';
      readonly operation: 'delete';
      readonly portfolioId: string;
      readonly ticker: string;
    }
  | { readonly repository: 'audit'; readonly operation: 'append'; readonly record: AuditRecord }
  | {
      readonly repository: 'series';
      readonly operation: 'insertContent';
      readonly record: SeriesContentRecord;
    }
  | {
      readonly repository: 'series';
      readonly operation: 'appendRetrieval';
      readonly record: SeriesRetrievalRecord;
    }
  | { readonly repository: 'fxRates'; readonly operation: 'append'; readonly record: FxRateRecord }
  | { readonly repository: 'portfolios'; readonly operation: 'insert'; readonly record: PortfolioRecord }
  | { readonly repository: 'riskResults'; readonly operation: 'append'; readonly record: RiskResultRecord }
  | { readonly repository: 'snapshots'; readonly operation: 'insert'; readonly record: SnapshotRecord }
  | { readonly repository: 'alertState'; readonly operation: 'upsert'; readonly record: AlertStateRecord }
  | { readonly repository: 'alerts'; readonly operation: 'insert'; readonly record: AlertRecord }
  | { readonly repository: 'alerts'; readonly operation: 'update'; readonly record: AlertRecord };

export interface WriteDescriptor {
  readonly repository: WriteOperation['repository'];
  readonly operation: WriteOperation['operation'];
}

export interface State {
  transactions: Map<string, TransactionRecord>;
  /** `(portfolioId, transactionKey)` â†’ transaction id. */
  transactionKeys: Map<string, string>;
  imports: Map<string, ImportRecord>;
  quarantine: Map<string, QuarantineRecordRow>;
  /** `(portfolioId, ticker)` â†’ position. */
  positions: Map<string, PositionRecord>;
  audit: Map<string, AuditRecord>;
  /** `contentHash` â†’ immutable series content. */
  seriesContent: Map<string, SeriesContentRecord>;
  /** `seq` â†’ retrieval, in `seq` order. */
  seriesRetrievals: Map<number, SeriesRetrievalRecord>;
  /** Unique `(contentHash, source, sourceKind, retrievedAt)` keys. */
  seriesRetrievalKeys: Set<string>;
  /** `id` â†’ FX rate record, in append order (task 10.3). */
  fxRates: Map<string, FxRateRecord>;
  /** `(pair, source, sourceKind, observedAt)` â†’ record id. */
  fxRateKeys: Map<string, string>;
  /** `id` â†’ portfolio (task 6.1). */
  portfolios: Map<string, PortfolioRecord>;
  /** `id` â†’ risk result, in append order (task 12.3). */
  riskResults: Map<string, RiskResultRecord>;
  /** `id` â†’ snapshot, in insertion order (task 12.5); the hash is not unique. */
  snapshots: Map<string, SnapshotRecord>;
  /** `(type, portfolioId, ticker)` â†’ alert state (task 16.2). */
  alertState: Map<string, AlertStateRecord>;
  /** `id` â†’ alert, in insertion order (task 16.3). */
  alerts: Map<string, AlertRecord>;
}

export const emptyState = (): State => ({
  transactions: new Map(),
  transactionKeys: new Map(),
  imports: new Map(),
  quarantine: new Map(),
  positions: new Map(),
  audit: new Map(),
  seriesContent: new Map(),
  seriesRetrievals: new Map(),
  seriesRetrievalKeys: new Set(),
  fxRates: new Map(),
  fxRateKeys: new Map(),
  portfolios: new Map(),
  riskResults: new Map(),
  snapshots: new Map(),
  alertState: new Map(),
  alerts: new Map(),
});

/** Records are frozen, so a state copy can share them. */
export const copyState = (state: State): State => ({
  transactions: new Map(state.transactions),
  transactionKeys: new Map(state.transactionKeys),
  imports: new Map(state.imports),
  quarantine: new Map(state.quarantine),
  positions: new Map(state.positions),
  audit: new Map(state.audit),
  seriesContent: new Map(state.seriesContent),
  seriesRetrievals: new Map(state.seriesRetrievals),
  seriesRetrievalKeys: new Set(state.seriesRetrievalKeys),
  fxRates: new Map(state.fxRates),
  fxRateKeys: new Map(state.fxRateKeys),
  portfolios: new Map(state.portfolios),
  riskResults: new Map(state.riskResults),
  snapshots: new Map(state.snapshots),
  alertState: new Map(state.alertState),
  alerts: new Map(state.alerts),
});

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

/** A frozen, detached copy, so later caller mutations cannot reach stored state. */
export const store = <T>(record: T): T => deepFreeze(structuredClone(record));

export const compositeKey = (a: string, b: string): string => `${a}\u0000${b}`;

export const describeWrites = (writes: readonly WriteOperation[]): readonly WriteDescriptor[] =>
  writes.map(({ repository, operation }) => ({ repository, operation }));

/** Unique key of a retrieval: `(contentHash, source, sourceKind, retrievedAt)`. */
export const retrievalKey = (record: Omit<SeriesRetrievalRecord, 'seq'>): string =>
  [record.contentHash, record.source, record.sourceKind, record.retrievedAt].join('\u0000');

export { sameSeriesContent };

function assertSeriesRetrieval(state: State, record: SeriesRetrievalRecord): void {
  if (!Number.isSafeInteger(record.seq) || record.seq !== state.seriesRetrievals.size + 1) {
    throw violation('series.seq must be the next retrieval sequence number');
  }
  checkSeriesRetrieval(record);
  const content = state.seriesContent.get(record.contentHash);
  if (content === undefined) {
    throw violation('series retrieval must reference stored content');
  }
  if (content.ticker !== record.ticker) {
    throw violation('series retrieval ticker must equal the content ticker');
  }
  if (state.seriesRetrievalKeys.has(retrievalKey(record))) {
    throw violation('series (contentHash, source, sourceKind, retrievedAt) must be unique');
  }
}

/** Unique key of an FX rate record: `(pair, source, sourceKind, observedAt)`. */
export const fxRateKey = (pair: string, source: string, sourceKind: string, observedAt: string): string =>
  [pair, source, sourceKind, observedAt].join('\u0000');

export const alertStateKey = (type: string, portfolioId: string, ticker: string | null): string =>
  [type, portfolioId, ticker ?? ''].join('\u0000');

/**
 * Applies one write to `state`. Record rules come from the shared
 * `persistence/constraints.ts` (the same rules the SQLite adapter applies);
 * uniqueness and references are checked here against the state.
 */
export function applyWrite(state: State, write: WriteOperation): void {
  switch (write.repository) {
    case 'transactions': {
      const { record } = write;
      checkTransaction(record);
      const key = compositeKey(record.portfolioId, record.transactionKey);
      if (state.transactions.has(record.id)) {
        throw violation('transactions.id must be unique');
      }
      if (state.transactionKeys.has(key)) {
        throw violation('transactions (portfolioId, transactionKey) must be unique');
      }
      state.transactions.set(record.id, record);
      state.transactionKeys.set(key, record.id);
      return;
    }
    case 'imports':
      checkImport(write.record);
      if (state.imports.has(write.record.id)) {
        throw violation('imports.id must be unique');
      }
      state.imports.set(write.record.id, write.record);
      return;
    case 'quarantine':
      checkQuarantine(write.record);
      if (state.quarantine.has(write.record.id)) {
        throw violation('quarantine.id must be unique');
      }
      state.quarantine.set(write.record.id, write.record);
      return;
    case 'positions': {
      if (write.operation === 'delete') {
        const key = compositeKey(write.portfolioId, write.ticker);
        if (!state.positions.delete(key)) {
          throw violation('positions (portfolioId, ticker) to delete does not exist');
        }
        return;
      }
      checkPosition(write.record);
      state.positions.set(compositeKey(write.record.portfolioId, write.record.ticker), write.record);
      return;
    }
    case 'audit':
      checkAudit(write.record);
      if (state.audit.has(write.record.id)) {
        throw violation('audit.id must be unique');
      }
      state.audit.set(write.record.id, write.record);
      return;
    case 'series': {
      if (write.operation === 'insertContent') {
        checkSeriesContent(write.record);
        if (state.seriesContent.has(write.record.contentHash)) {
          throw violation('series.contentHash must be unique');
        }
        state.seriesContent.set(write.record.contentHash, write.record);
        return;
      }
      assertSeriesRetrieval(state, write.record);
      state.seriesRetrievals.set(write.record.seq, write.record);
      state.seriesRetrievalKeys.add(retrievalKey(write.record));
      return;
    }
    case 'portfolios': {
      const { record } = write;
      checkPortfolio(record);
      if (state.portfolios.has(record.id)) {
        throw violation('portfolios.id must be unique');
      }
      state.portfolios.set(record.id, record);
      return;
    }
    case 'riskResults': {
      const { record } = write;
      checkRiskResult(record);
      if (record.snapshotId !== null && !state.snapshots.has(record.snapshotId)) {
        throw violation('riskResults.snapshotId must reference a stored snapshot');
      }
      if (state.riskResults.has(record.id)) {
        throw violation('riskResults.id must be unique');
      }
      state.riskResults.set(record.id, record);
      return;
    }
    case 'snapshots': {
      const { record } = write;
      checkSnapshot(record);
      if (state.snapshots.has(record.id)) {
        throw violation('snapshots.id must be unique');
      }
      state.snapshots.set(record.id, record);
      return;
    }
    case 'alertState': {
      checkAlertState(write.record);
      const { type, portfolioId, ticker } = write.record;
      state.alertState.set(alertStateKey(type, portfolioId, ticker), write.record);
      return;
    }
    case 'alerts': {
      const { record } = write;
      checkAlert(record);
      const existing = state.alerts.get(record.id);
      if (write.operation === 'insert') {
        if (existing !== undefined) {
          throw violation('alerts.id must be unique');
        }
      } else if (existing === undefined) {
        throw violation('alerts.id to update does not exist');
      } else {
        checkAlertUpdate(existing, record);
      }
      state.alerts.set(record.id, record);
      return;
    }
    case 'fxRates': {
      const { record } = write;
      checkFxRate(record);
      if (state.fxRates.has(record.id)) {
        throw violation('fxRates.id must be unique');
      }
      if (state.fxRateKeys.has(fxRateKey(record.pair, record.source, record.sourceKind, record.observedAt))) {
        throw violation('fxRates (pair, source, sourceKind, observedAt) must be unique');
      }
      state.fxRates.set(record.id, record);
      state.fxRateKeys.set(
        fxRateKey(record.pair, record.source, record.sourceKind, record.observedAt),
        record.id,
      );
      return;
    }
  }
}
