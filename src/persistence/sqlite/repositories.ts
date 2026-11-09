/**
 * SQLite repositories (OD-12) for one open transaction. Same contracts as the
 * in-memory repositories (`persistence/ports.ts`):
 * - Writes run the shared record rules (`persistence/constraints.ts`) and the
 *   same uniqueness and reference checks, with the same messages, before any SQL;
 *   database constraints and triggers are a second line. A database error never
 *   reaches the caller as such: it becomes a `PersistenceError` with a fixed
 *   message (`CONSTRAINT_VIOLATION`, `COMMIT_FAILED`, or `INTEGRITY_ERROR`).
 * - Reads run inside the transaction, so they see its own writes. Every row is
 *   decoded strictly and checked with the same record rules; a row that fails is
 *   an `INTEGRITY_ERROR` and nothing of it is returned.
 * - Records are returned as frozen, detached objects, as in memory.
 * - List orders: insertion order (`rowid`; an upsert keeps its row), `seq` for
 *   series retrievals.
 */
import { canonicalJson } from '../../shared/index.js';
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
import { PersistenceError } from '../ports.js';
import type {
  AlertRecord,
  AlertStateRecord,
  AuditRecord,
  FxRateRecord,
  ImportRecord,
  PortfolioRecord,
  PositionRecord,
  QuarantineRecordRow,
  Repositories,
  RiskResultRecord,
  SeriesContentRecord,
  SeriesRetrievalRecord,
  SnapshotRecord,
  TransactionRecord,
} from '../ports.js';
import { sqlErrorKind } from './driver.js';
import type { SqlDriver, SqlRow, SqlValue } from './driver.js';

export interface WriteNote {
  readonly repository: keyof Repositories;
  readonly operation: string;
}

/** Maps a database error to a safe persistence error; anything else is rethrown. */
export function safeError(error: unknown, table: string): PersistenceError {
  if (error instanceof PersistenceError) {
    return error;
  }
  switch (sqlErrorKind(error)) {
    case 'CONSTRAINT':
      return violation(`${table} write violates a database constraint`);
    case 'CORRUPT':
      return new PersistenceError('INTEGRITY_ERROR', 'The database file is damaged or not a database.');
    case 'BUSY':
    case 'IO':
    case 'OTHER':
      return new PersistenceError('COMMIT_FAILED', 'The unit of work could not be committed.');
    case undefined:
      throw error;
  }
}

const integrity = (table: string): PersistenceError =>
  new PersistenceError('INTEGRITY_ERROR', `A stored ${table} record failed validation.`);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

/** Strict column readers: a wrong type is an integrity failure of `table`. */
function columns(row: SqlRow, table: string) {
  const fail = (): never => {
    throw integrity(table);
  };
  return {
    str: (name: string): string => {
      const value = row[name];
      return typeof value === 'string' ? value : fail();
    },
    optStr: (name: string): string | null => {
      const value = row[name];
      return value === null ? null : typeof value === 'string' ? value : fail();
    },
    int: (name: string): number => {
      const value = row[name];
      return typeof value === 'number' && Number.isSafeInteger(value) ? value : fail();
    },
    json: (name: string): unknown => {
      const value = row[name];
      if (typeof value !== 'string') {
        return fail();
      }
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return fail();
      }
    },
  };
}

/** Decodes with `decode`, validates with `check`; any failure is `INTEGRITY_ERROR` for `table`. */
function decoded<T>(
  row: SqlRow,
  table: string,
  decode: (c: ReturnType<typeof columns>) => T,
  check: (record: T) => void,
): T {
  let record: T;
  try {
    record = decode(columns(row, table));
    check(record);
  } catch {
    throw integrity(table);
  }
  return deepFreeze(record);
}

const optional = <K extends string, V>(key: K, value: V | null): { [P in K]?: V } =>
  (value === null ? {} : { [key]: value }) as { [P in K]?: V };

const toTransaction = (row: SqlRow): TransactionRecord =>
  decoded(
    row,
    'transactions',
    (c) => {
      const type = c.str('type');
      if (type !== 'BUY' && type !== 'SELL') {
        throw integrity('transactions');
      }
      return {
        id: c.str('id'),
        portfolioId: c.str('portfolio_id'),
        transactionKey: c.str('transaction_key'),
        ...optional('externalId', c.optStr('external_id')),
        source: c.str('source'),
        sourceId: c.str('source_id'),
        sourceSequence: c.int('source_sequence'),
        tradeTimestamp: c.str('trade_timestamp'),
        ticker: c.str('ticker'),
        type,
        quantity: c.str('quantity'),
        price: c.str('price'),
        currency: c.str('currency'),
        importId: c.str('import_id'),
        createdAt: c.str('created_at'),
      } as TransactionRecord;
    },
    checkTransaction,
  );

const toImport = (row: SqlRow): ImportRecord =>
  decoded(
    row,
    'imports',
    (c) =>
      ({
        id: c.str('id'),
        fileName: c.str('file_name'),
        fileSha256: c.str('file_sha256'),
        importedAt: c.str('imported_at'),
        totalRows: c.int('total_rows'),
        accepted: c.int('accepted'),
        rejected: c.int('rejected'),
        duplicates: c.int('duplicates'),
        skipped: c.int('skipped'),
        status: c.str('status'),
        ...optional('failureReason', c.optStr('failure_reason')),
      }) as ImportRecord,
    checkImport,
  );

const toQuarantine = (row: SqlRow): QuarantineRecordRow =>
  decoded(
    row,
    'quarantine',
    (c) =>
      ({
        id: c.str('id'),
        importId: c.str('import_id'),
        sourceKind: c.str('source_kind'),
        sequence: c.int('sequence'),
        reasonCode: c.str('reason_code'),
        message: c.str('message'),
        ...optional('columnName', c.optStr('column_name')),
        rawExcerpt: c.str('raw_excerpt'),
        createdAt: c.str('created_at'),
      }) as QuarantineRecordRow,
    checkQuarantine,
  );

const toPosition = (row: SqlRow): PositionRecord =>
  decoded(
    row,
    'positions',
    (c) => {
      const isShort = c.int('is_short');
      if (isShort !== 0 && isShort !== 1) {
        throw integrity('positions');
      }
      return {
        id: c.str('id'),
        portfolioId: c.str('portfolio_id'),
        ticker: c.str('ticker'),
        currency: c.str('currency'),
        signedQuantity: c.str('signed_quantity'),
        averagePrice: c.optStr('average_price'),
        isShort: isShort === 1,
        source: c.str('source'),
        updatedAt: c.str('updated_at'),
      } as PositionRecord;
    },
    checkPosition,
  );

const toAudit = (row: SqlRow): AuditRecord =>
  decoded(
    row,
    'audit',
    (c) => {
      const details = c.json('details_json');
      if (typeof details !== 'object' || details === null || Array.isArray(details)) {
        throw integrity('audit');
      }
      return {
        id: c.str('id'),
        at: c.str('at'),
        category: c.str('category'),
        type: c.str('type'),
        ...optional('subject', c.optStr('subject')),
        ...optional('actor', c.optStr('actor')),
        details,
      } as AuditRecord;
    },
    checkAudit,
  );

const toSeriesContent = (row: SqlRow): SeriesContentRecord =>
  decoded(
    row,
    'series',
    (c) =>
      ({
        contentHash: c.str('content_hash'),
        ticker: c.str('ticker'),
        currency: c.str('currency'),
        observations: c.json('observations_json'),
      }) as SeriesContentRecord,
    checkSeriesContent,
  );

const toRetrieval = (row: SqlRow): SeriesRetrievalRecord =>
  decoded(
    row,
    'series',
    (c) =>
      ({
        seq: c.int('seq'),
        contentHash: c.str('content_hash'),
        ticker: c.str('ticker'),
        source: c.str('source'),
        sourceKind: c.str('source_kind'),
        retrievedAt: c.str('retrieved_at'),
      }) as SeriesRetrievalRecord,
    checkSeriesRetrieval,
  );

const toFxRate = (row: SqlRow): FxRateRecord =>
  decoded(
    row,
    'fxRates',
    (c) =>
      ({
        id: c.str('id'),
        pair: c.str('pair'),
        rate: c.str('rate'),
        observedAt: c.str('observed_at'),
        observedAtBasis: c.str('observed_at_basis'),
        ...optional('conventionId', c.optStr('convention_id')),
        source: c.str('source'),
        sourceKind: c.str('source_kind'),
        recordedAt: c.str('recorded_at'),
        ...publishedOf(c),
      }) as FxRateRecord,
    checkFxRate,
  );

/** OD-20 columns: all NULL (rows before migration 2, or no quote) or a complete quote. */
function publishedOf(c: { optStr(name: string): string | null }): { published?: unknown } {
  const pair = c.optStr('published_pair');
  const rate = c.optStr('published_rate');
  const referenceDate = c.optStr('published_reference_date');
  const method = c.optStr('derivation_method');
  const precision = c.optStr('derivation_precision');
  if (pair === null && rate === null && referenceDate === null && method === null && precision === null) {
    return {};
  }
  // A partial quote is passed on as it is, so checkFxRate rejects it (INTEGRITY_ERROR).
  return {
    published: {
      pair,
      rate,
      ...(referenceDate === null ? {} : { referenceDate }),
      method,
      precision,
    },
  };
}

const toPortfolio = (row: SqlRow): PortfolioRecord =>
  decoded(
    row,
    'portfolios',
    (c) =>
      ({ id: c.str('id'), baseCurrency: c.str('base_currency'), cash: c.str('cash') }) as PortfolioRecord,
    checkPortfolio,
  );

const toRiskResult = (row: SqlRow): RiskResultRecord =>
  decoded(
    row,
    'riskResults',
    (c) => ({
      id: c.str('id'),
      portfolioId: c.str('portfolio_id'),
      calculatedAt: c.str('calculated_at'),
      status: c.str('status'),
      configVersionSeq: c.int('config_version_seq'),
      configVersionHash: c.str('config_version_hash'),
      snapshotHash: c.optStr('snapshot_hash'),
      snapshotId: c.optStr('snapshot_id'),
      body: c.str('body'),
    }),
    checkRiskResult,
  );

const toSnapshot = (row: SqlRow): SnapshotRecord =>
  decoded(
    row,
    'snapshots',
    (c) => ({
      id: c.str('id'),
      portfolioId: c.str('portfolio_id'),
      hash: c.str('hash'),
      createdAt: c.str('created_at'),
      evaluatedAt: c.str('evaluated_at'),
      snapshot: c.str('snapshot'),
      inputsCanonical: c.str('inputs_canonical'),
    }),
    checkSnapshot,
  );

const toAlertState = (row: SqlRow): AlertStateRecord =>
  decoded(
    row,
    'alertState',
    (c) =>
      ({
        type: c.str('type'),
        portfolioId: c.str('portfolio_id'),
        ticker: c.optStr('ticker'),
        phase: c.str('phase'),
        lastSeverity: c.optStr('last_severity'),
        lastAlertAt: c.optStr('last_alert_at'),
        lastAlertId: c.optStr('last_alert_id'),
        updatedAt: c.str('updated_at'),
      }) as AlertStateRecord,
    checkAlertState,
  );

const toAlert = (row: SqlRow): AlertRecord =>
  decoded(
    row,
    'alerts',
    (c) =>
      ({
        id: c.str('id'),
        type: c.str('type'),
        source: c.str('source'),
        portfolioId: c.str('portfolio_id'),
        ticker: c.optStr('ticker'),
        severity: c.str('severity'),
        metric: c.str('metric'),
        observed: c.str('observed'),
        threshold: c.str('threshold'),
        triggeredTickers: c.json('triggered_tickers_json'),
        createdAt: c.str('created_at'),
        description: c.str('description'),
        state: c.str('state'),
        stateChangedAt: c.optStr('state_changed_at'),
        delivery: c.str('delivery'),
        deliveryAttempts: c.int('delivery_attempts'),
        lastAttemptAt: c.optStr('last_attempt_at'),
      }) as AlertRecord,
    checkAlert,
  );

const nul = <T>(value: T | undefined): T | null => (value === undefined ? null : value);

/** Repositories over `db` inside its open transaction. `note` records each write; `guard` checks ownership. */
export function sqliteRepositories(
  db: SqlDriver,
  note: (write: WriteNote) => void,
  guard: () => void,
): Repositories {
  const run = (table: string, sql: string, params: readonly SqlValue[]): number => {
    try {
      return db.prepare(sql).run(...params).changes;
    } catch (error) {
      throw safeError(error, table);
    }
  };
  const one = (table: string, sql: string, params: readonly SqlValue[]): SqlRow | undefined => {
    guard();
    try {
      return db.prepare(sql).get(...params);
    } catch (error) {
      throw safeError(error, table);
    }
  };
  const many = (table: string, sql: string, params: readonly SqlValue[]): readonly SqlRow[] => {
    guard();
    try {
      return db.prepare(sql).all(...params);
    } catch (error) {
      throw safeError(error, table);
    }
  };
  const exists = (table: string, sql: string, params: readonly SqlValue[]): boolean =>
    one(table, sql, params) !== undefined;

  const repositories: Repositories = {
    portfolios: {
      insert: (record) => {
        guard();
        checkPortfolio(record);
        if (exists('portfolios', 'SELECT 1 FROM portfolios WHERE id = ?', [record.id])) {
          throw violation('portfolios.id must be unique');
        }
        run('portfolios', 'INSERT INTO portfolios (id, base_currency, cash) VALUES (?, ?, ?)', [
          record.id,
          record.baseCurrency,
          record.cash,
        ]);
      },
      get: (id) => {
        const row = one('portfolios', 'SELECT * FROM portfolios WHERE id = ?', [id]);
        return row === undefined ? undefined : toPortfolio(row);
      },
    },
    transactions: {
      insert: (record) => {
        guard();
        checkTransaction(record);
        if (exists('transactions', 'SELECT 1 FROM transactions WHERE id = ?', [record.id])) {
          throw violation('transactions.id must be unique');
        }
        if (
          exists(
            'transactions',
            'SELECT 1 FROM transactions WHERE portfolio_id = ? AND transaction_key = ?',
            [record.portfolioId, record.transactionKey],
          )
        ) {
          throw violation('transactions (portfolioId, transactionKey) must be unique');
        }
        run(
          'transactions',
          `INSERT INTO transactions (id, portfolio_id, transaction_key, external_id, source, source_id,
             source_sequence, trade_timestamp, ticker, type, quantity, price, currency, import_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.portfolioId,
            record.transactionKey,
            nul(record.externalId),
            record.source,
            record.sourceId,
            record.sourceSequence,
            record.tradeTimestamp,
            record.ticker,
            record.type,
            record.quantity,
            record.price,
            record.currency,
            record.importId,
            record.createdAt,
          ],
        );
      },
      findByKey: (portfolioId, transactionKey) => {
        const row = one(
          'transactions',
          'SELECT * FROM transactions WHERE portfolio_id = ? AND transaction_key = ?',
          [portfolioId, transactionKey],
        );
        return row === undefined ? undefined : toTransaction(row);
      },
      listByPortfolio: (portfolioId) =>
        many('transactions', 'SELECT * FROM transactions WHERE portfolio_id = ? ORDER BY rowid', [
          portfolioId,
        ]).map(toTransaction),
    },
    imports: {
      insert: (record) => {
        guard();
        checkImport(record);
        if (exists('imports', 'SELECT 1 FROM imports WHERE id = ?', [record.id])) {
          throw violation('imports.id must be unique');
        }
        run(
          'imports',
          `INSERT INTO imports (id, file_name, file_sha256, imported_at, total_rows, accepted, rejected,
             duplicates, skipped, status, failure_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.fileName,
            record.fileSha256,
            record.importedAt,
            record.totalRows,
            record.accepted,
            record.rejected,
            record.duplicates,
            record.skipped,
            record.status,
            nul(record.failureReason),
          ],
        );
      },
      get: (id) => {
        const row = one('imports', 'SELECT * FROM imports WHERE id = ?', [id]);
        return row === undefined ? undefined : toImport(row);
      },
    },
    quarantine: {
      insert: (record) => {
        guard();
        checkQuarantine(record);
        if (exists('quarantine', 'SELECT 1 FROM quarantine_records WHERE id = ?', [record.id])) {
          throw violation('quarantine.id must be unique');
        }
        run(
          'quarantine',
          `INSERT INTO quarantine_records (id, import_id, source_kind, sequence, reason_code, message,
             column_name, raw_excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.importId,
            record.sourceKind,
            record.sequence,
            record.reasonCode,
            record.message,
            nul(record.columnName),
            record.rawExcerpt,
            record.createdAt,
          ],
        );
      },
      listByImport: (importId) =>
        many('quarantine', 'SELECT * FROM quarantine_records WHERE import_id = ? ORDER BY rowid', [
          importId,
        ]).map(toQuarantine),
    },
    positions: {
      upsert: (record) => {
        guard();
        checkPosition(record);
        run(
          'positions',
          `INSERT INTO positions (id, portfolio_id, ticker, currency, signed_quantity, average_price, is_short,
             source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (portfolio_id, ticker) DO UPDATE SET id = excluded.id, currency = excluded.currency,
             signed_quantity = excluded.signed_quantity, average_price = excluded.average_price,
             is_short = excluded.is_short, source = excluded.source, updated_at = excluded.updated_at`,
          [
            record.id,
            record.portfolioId,
            record.ticker,
            record.currency,
            record.signedQuantity,
            record.averagePrice,
            record.isShort ? 1 : 0,
            record.source,
            record.updatedAt,
          ],
        );
      },
      delete: (portfolioId, ticker) => {
        guard();
        if (
          run('positions', 'DELETE FROM positions WHERE portfolio_id = ? AND ticker = ?', [
            portfolioId,
            ticker,
          ]) === 0
        ) {
          throw violation('positions (portfolioId, ticker) to delete does not exist');
        }
      },
      get: (portfolioId, ticker) => {
        const row = one('positions', 'SELECT * FROM positions WHERE portfolio_id = ? AND ticker = ?', [
          portfolioId,
          ticker,
        ]);
        return row === undefined ? undefined : toPosition(row);
      },
      listByPortfolio: (portfolioId) =>
        many('positions', 'SELECT * FROM positions WHERE portfolio_id = ? ORDER BY rowid', [portfolioId]).map(
          toPosition,
        ),
    },
    audit: {
      append: (record) => {
        guard();
        checkAudit(record);
        if (exists('audit', 'SELECT 1 FROM audit_log WHERE id = ?', [record.id])) {
          throw violation('audit.id must be unique');
        }
        run(
          'audit',
          'INSERT INTO audit_log (id, at, category, type, subject, actor, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            record.id,
            record.at,
            record.category,
            record.type,
            nul(record.subject),
            nul(record.actor),
            JSON.stringify(record.details), // strings and booleans only (checked); key order kept
          ],
        );
      },
      list: () => many('audit', 'SELECT * FROM audit_log ORDER BY rowid', []).map(toAudit),
    },
    series: {
      insertContent: (record) => {
        guard();
        const stored = one('series', 'SELECT * FROM price_series WHERE content_hash = ?', [
          record.contentHash,
        ]);
        if (stored !== undefined) {
          let same: boolean;
          try {
            same = sameSeriesContent(toSeriesContent(stored), record);
          } catch (error) {
            if (error instanceof PersistenceError && error.code === 'INTEGRITY_ERROR') {
              throw error;
            }
            same = false;
          }
          if (same) {
            return false; // identical content is already stored: nothing is written
          }
        }
        guard();
        checkSeriesContent(record);
        if (stored !== undefined) {
          throw violation('series.contentHash must be unique');
        }
        run(
          'series',
          'INSERT INTO price_series (content_hash, ticker, currency, observations_json) VALUES (?, ?, ?, ?)',
          [
            record.contentHash,
            record.ticker,
            record.currency,
            canonicalJson(record.observations), // exact decimal text (C2)
          ],
        );
        return true;
      },
      getContent: (contentHash) => {
        const row = one('series', 'SELECT * FROM price_series WHERE content_hash = ?', [contentHash]);
        return row === undefined ? undefined : toSeriesContent(row);
      },
      appendRetrieval: (record) => {
        guard();
        checkSeriesRetrieval(record);
        const content = one('series', 'SELECT ticker FROM price_series WHERE content_hash = ?', [
          record.contentHash,
        ]);
        if (content === undefined) {
          throw violation('series retrieval must reference stored content');
        }
        if (content['ticker'] !== record.ticker) {
          throw violation('series retrieval ticker must equal the content ticker');
        }
        if (
          exists(
            'series',
            'SELECT 1 FROM series_retrievals WHERE content_hash = ? AND source = ? AND source_kind = ? AND retrieved_at = ?',
            [record.contentHash, record.source, record.sourceKind, record.retrievedAt],
          )
        ) {
          throw violation('series (contentHash, source, sourceKind, retrievedAt) must be unique');
        }
        const next = one('series', 'SELECT coalesce(max(seq), 0) + 1 AS seq FROM series_retrievals', []);
        const seq = next?.['seq'];
        if (typeof seq !== 'number') {
          throw integrity('series');
        }
        run(
          'series',
          `INSERT INTO series_retrievals (seq, content_hash, ticker, source, source_kind, retrieved_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [seq, record.contentHash, record.ticker, record.source, record.sourceKind, record.retrievedAt],
        );
        return deepFreeze({ ...record, seq });
      },
      listRetrievalsByHash: (contentHash) =>
        many('series', 'SELECT * FROM series_retrievals WHERE content_hash = ? ORDER BY seq', [
          contentHash,
        ]).map(toRetrieval),
      listRetrievalsByTicker: (ticker, sourceKind) =>
        many('series', 'SELECT * FROM series_retrievals WHERE ticker = ? AND source_kind = ? ORDER BY seq', [
          ticker,
          sourceKind,
        ]).map(toRetrieval),
    },
    fxRates: {
      append: (record) => {
        guard();
        checkFxRate(record);
        if (exists('fxRates', 'SELECT 1 FROM fx_rates WHERE id = ?', [record.id])) {
          throw violation('fxRates.id must be unique');
        }
        if (
          exists(
            'fxRates',
            'SELECT 1 FROM fx_rates WHERE pair = ? AND source = ? AND source_kind = ? AND observed_at = ?',
            [record.pair, record.source, record.sourceKind, record.observedAt],
          )
        ) {
          throw violation('fxRates (pair, source, sourceKind, observedAt) must be unique');
        }
        run(
          'fxRates',
          `INSERT INTO fx_rates (id, pair, rate, observed_at, observed_at_basis, convention_id, source, source_kind,
             recorded_at, published_pair, published_rate, published_reference_date, derivation_method,
             derivation_precision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.pair,
            record.rate,
            record.observedAt,
            record.observedAtBasis,
            nul(record.conventionId),
            record.source,
            record.sourceKind,
            record.recordedAt,
            nul(record.published?.pair),
            nul(record.published?.rate),
            nul(record.published?.referenceDate),
            nul(record.published?.method),
            nul(record.published?.precision),
          ],
        );
      },
      findByKey: (pair, source, sourceKind, observedAt) => {
        const row = one(
          'fxRates',
          'SELECT * FROM fx_rates WHERE pair = ? AND source = ? AND source_kind = ? AND observed_at = ?',
          [pair, source, sourceKind, observedAt],
        );
        return row === undefined ? undefined : toFxRate(row);
      },
      listByPair: (pair) =>
        many('fxRates', 'SELECT * FROM fx_rates WHERE pair = ? ORDER BY rowid', [pair]).map(toFxRate),
    },
    snapshots: {
      insert: (record) => {
        guard();
        checkSnapshot(record);
        if (exists('snapshots', 'SELECT 1 FROM calc_snapshots WHERE id = ?', [record.id])) {
          throw violation('snapshots.id must be unique');
        }
        run(
          'snapshots',
          `INSERT INTO calc_snapshots (id, portfolio_id, hash, created_at, evaluated_at, snapshot, inputs_canonical)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.portfolioId,
            record.hash,
            record.createdAt,
            record.evaluatedAt,
            record.snapshot,
            record.inputsCanonical,
          ],
        );
      },
      get: (id) => {
        const row = one('snapshots', 'SELECT * FROM calc_snapshots WHERE id = ?', [id]);
        return row === undefined ? undefined : toSnapshot(row);
      },
      listByHash: (hash) =>
        many('snapshots', 'SELECT * FROM calc_snapshots WHERE hash = ? ORDER BY rowid', [hash]).map(
          toSnapshot,
        ),
    },
    riskResults: {
      append: (record) => {
        guard();
        checkRiskResult(record);
        if (
          record.snapshotId !== null &&
          !exists('riskResults', 'SELECT 1 FROM calc_snapshots WHERE id = ?', [record.snapshotId])
        ) {
          throw violation('riskResults.snapshotId must reference a stored snapshot');
        }
        if (exists('riskResults', 'SELECT 1 FROM risk_results WHERE id = ?', [record.id])) {
          throw violation('riskResults.id must be unique');
        }
        run(
          'riskResults',
          `INSERT INTO risk_results (id, portfolio_id, calculated_at, status, config_version_seq, config_version_hash,
             snapshot_hash, snapshot_id, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.portfolioId,
            record.calculatedAt,
            record.status,
            record.configVersionSeq,
            record.configVersionHash,
            record.snapshotHash,
            record.snapshotId,
            record.body,
          ],
        );
      },
      listByPortfolio: (portfolioId) =>
        many('riskResults', 'SELECT * FROM risk_results WHERE portfolio_id = ? ORDER BY rowid', [
          portfolioId,
        ]).map(toRiskResult),
    },
    alertState: {
      upsert: (record) => {
        guard();
        checkAlertState(record);
        const key = record.ticker ?? '';
        const values = [
          record.phase,
          record.lastSeverity,
          record.lastAlertAt,
          record.lastAlertId,
          record.updatedAt,
        ] as const;
        const updated = run(
          'alertState',
          `UPDATE alert_state SET phase = ?, last_severity = ?, last_alert_at = ?, last_alert_id = ?, updated_at = ?
           WHERE type = ? AND portfolio_id = ? AND ticker_key = ?`,
          [...values, record.type, record.portfolioId, key],
        );
        if (updated === 0) {
          run(
            'alertState',
            `INSERT INTO alert_state (type, portfolio_id, ticker, ticker_key, phase, last_severity, last_alert_at,
               last_alert_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [record.type, record.portfolioId, record.ticker, key, ...values],
          );
        }
      },
      get: (type, portfolioId, ticker) => {
        const row = one(
          'alertState',
          'SELECT * FROM alert_state WHERE type = ? AND portfolio_id = ? AND ticker_key = ?',
          [type, portfolioId, ticker ?? ''],
        );
        return row === undefined ? undefined : toAlertState(row);
      },
    },
    alerts: {
      insert: (record) => {
        guard();
        checkAlert(record);
        if (exists('alerts', 'SELECT 1 FROM alerts WHERE id = ?', [record.id])) {
          throw violation('alerts.id must be unique');
        }
        run(
          'alerts',
          `INSERT INTO alerts (id, type, source, portfolio_id, ticker, severity, metric, observed, threshold,
             triggered_tickers_json, created_at, description, state, state_changed_at, delivery, delivery_attempts,
             last_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            record.type,
            record.source,
            record.portfolioId,
            record.ticker,
            record.severity,
            record.metric,
            record.observed,
            record.threshold,
            canonicalJson(record.triggeredTickers),
            record.createdAt,
            record.description,
            record.state,
            record.stateChangedAt,
            record.delivery,
            record.deliveryAttempts,
            record.lastAttemptAt,
          ],
        );
      },
      update: (record) => {
        guard();
        checkAlert(record);
        const row = one('alerts', 'SELECT * FROM alerts WHERE id = ?', [record.id]);
        if (row === undefined) {
          throw violation('alerts.id to update does not exist');
        }
        checkAlertUpdate(toAlert(row), record);
        run(
          'alerts',
          `UPDATE alerts SET state = ?, state_changed_at = ?, delivery = ?, delivery_attempts = ?, last_attempt_at = ?
           WHERE id = ?`,
          [
            record.state,
            record.stateChangedAt,
            record.delivery,
            record.deliveryAttempts,
            record.lastAttemptAt,
            record.id,
          ],
        );
      },
      get: (id) => {
        const row = one('alerts', 'SELECT * FROM alerts WHERE id = ?', [id]);
        return row === undefined ? undefined : toAlert(row);
      },
      listByPortfolio: (portfolioId) =>
        many('alerts', 'SELECT * FROM alerts WHERE portfolio_id = ? ORDER BY rowid', [portfolioId]).map(
          toAlert,
        ),
      listByDelivery: (delivery) =>
        many('alerts', 'SELECT * FROM alerts WHERE delivery = ? ORDER BY rowid', [delivery]).map(toAlert),
    },
  };
  // A write is recorded only after it succeeded, as in the in-memory write log.
  for (const [repository, operations] of Object.entries(WRITE_OPERATIONS) as [
    keyof Repositories,
    string[],
  ][]) {
    const target = repositories[repository] as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const operation of operations) {
      const original = target[operation];
      if (typeof original !== 'function') {
        continue;
      }
      target[operation] = (...args: unknown[]): unknown => {
        const result = original(...args);
        // `insertContent` that finds identical content writes nothing.
        if (!(repository === 'series' && operation === 'insertContent' && result === false)) {
          note({ repository, operation });
        }
        return result;
      };
    }
  }
  return repositories;
}

const WRITE_OPERATIONS: Readonly<Record<keyof Repositories, readonly string[]>> = {
  portfolios: ['insert'],
  transactions: ['insert'],
  imports: ['insert'],
  quarantine: ['insert'],
  positions: ['upsert', 'delete'],
  audit: ['append'],
  series: ['insertContent', 'appendRetrieval'],
  fxRates: ['append'],
  snapshots: ['insert'],
  riskResults: ['append'],
  alertState: ['upsert'],
  alerts: ['insert', 'update'],
};

/** Every table in insertion order (test inspection, the same shape as the in-memory snapshot). */
export function readAll(db: SqlDriver) {
  const all = (sql: string): readonly SqlRow[] => {
    try {
      return db.prepare(sql).all();
    } catch (error) {
      throw safeError(error, 'database');
    }
  };
  return {
    transactions: all('SELECT * FROM transactions ORDER BY rowid').map(toTransaction),
    imports: all('SELECT * FROM imports ORDER BY rowid').map(toImport),
    quarantine: all('SELECT * FROM quarantine_records ORDER BY rowid').map(toQuarantine),
    positions: all('SELECT * FROM positions ORDER BY rowid').map(toPosition),
    audit: all('SELECT * FROM audit_log ORDER BY rowid').map(toAudit),
    seriesContent: all('SELECT * FROM price_series ORDER BY rowid').map(toSeriesContent),
    seriesRetrievals: all('SELECT * FROM series_retrievals ORDER BY seq').map(toRetrieval),
    fxRates: all('SELECT * FROM fx_rates ORDER BY rowid').map(toFxRate),
    portfolios: all('SELECT * FROM portfolios ORDER BY rowid').map(toPortfolio),
    riskResults: all('SELECT * FROM risk_results ORDER BY rowid').map(toRiskResult),
    snapshots: all('SELECT * FROM calc_snapshots ORDER BY rowid').map(toSnapshot),
    alertState: all('SELECT * FROM alert_state ORDER BY rowid').map(toAlertState),
    alerts: all('SELECT * FROM alerts ORDER BY rowid').map(toAlert),
  };
}
