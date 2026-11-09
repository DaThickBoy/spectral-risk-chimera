/**
 * SQLite schema and forward-only migrations (OD-12; design: Persisted tables).
 * The implemented repository ports are authoritative for the columns.
 *
 * - Every financial value, JSON body, and timestamp is `TEXT` (R4.3); counts are
 *   `INTEGER`. Prices of stored series keep their exact text (decision C2).
 * - Unique keys and references repeat the adapter's own checks as a second line.
 * - Append-only tables refuse `UPDATE` and `DELETE` through triggers, so even
 *   direct SQL cannot change history. Positions are a projection and may change;
 *   alert content never changes and alert status never moves backwards; alert
 *   state rows are never deleted.
 * - The schema version is SQLite's `user_version`. Migrations run in order in
 *   one transaction; a database with a newer version is refused.
 */

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

const APPEND_ONLY = [
  'portfolios',
  'imports',
  'transactions',
  'quarantine_records',
  'audit_log',
  'price_series',
  'series_retrievals',
  'fx_rates',
  'calc_snapshots',
  'risk_results',
] as const;

const appendOnlyTriggers = APPEND_ONLY.map(
  (table) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;`,
).join('\n');

const V1 = `
CREATE TABLE portfolios (
  id TEXT PRIMARY KEY NOT NULL,
  base_currency TEXT NOT NULL CHECK (length(base_currency) = 3),
  cash TEXT NOT NULL
);
CREATE TABLE imports (
  id TEXT PRIMARY KEY NOT NULL,
  file_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  total_rows INTEGER NOT NULL CHECK (total_rows >= 0),
  accepted INTEGER NOT NULL CHECK (accepted >= 0),
  rejected INTEGER NOT NULL CHECK (rejected >= 0),
  duplicates INTEGER NOT NULL CHECK (duplicates >= 0),
  skipped INTEGER NOT NULL CHECK (skipped >= 0),
  status TEXT NOT NULL CHECK (status IN ('COMMITTED', 'COMMITTED_WITH_REJECTIONS', 'FAILED')),
  failure_reason TEXT
);
CREATE TABLE transactions (
  id TEXT PRIMARY KEY NOT NULL,
  portfolio_id TEXT NOT NULL,
  transaction_key TEXT NOT NULL,
  external_id TEXT,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL CHECK (length(source_id) > 0),
  source_sequence INTEGER NOT NULL CHECK (source_sequence >= 1),
  trade_timestamp TEXT NOT NULL,
  ticker TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('BUY', 'SELL')),
  quantity TEXT NOT NULL,
  price TEXT NOT NULL,
  currency TEXT NOT NULL,
  import_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (portfolio_id, transaction_key)
);
CREATE INDEX transactions_by_portfolio ON transactions (portfolio_id);
CREATE TABLE quarantine_records (
  id TEXT PRIMARY KEY NOT NULL,
  import_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('CSV', 'FIX')),
  sequence INTEGER NOT NULL,
  reason_code TEXT NOT NULL,
  message TEXT NOT NULL,
  column_name TEXT,
  raw_excerpt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX quarantine_by_import ON quarantine_records (import_id);
CREATE TABLE positions (
  id TEXT NOT NULL,
  portfolio_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  currency TEXT NOT NULL,
  signed_quantity TEXT NOT NULL,
  average_price TEXT,
  is_short INTEGER NOT NULL CHECK (is_short IN (0, 1)),
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (portfolio_id, ticker),
  CHECK ((average_price IS NULL) = (signed_quantity = '0'))
);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  at TEXT NOT NULL,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  subject TEXT,
  actor TEXT,
  details_json TEXT NOT NULL
);
CREATE TABLE price_series (
  content_hash TEXT PRIMARY KEY NOT NULL CHECK (length(content_hash) = 64),
  ticker TEXT NOT NULL,
  currency TEXT NOT NULL,
  observations_json TEXT NOT NULL
);
CREATE TABLE series_retrievals (
  seq INTEGER PRIMARY KEY NOT NULL CHECK (seq >= 1),
  content_hash TEXT NOT NULL REFERENCES price_series (content_hash),
  ticker TEXT NOT NULL,
  source TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('REAL', 'DEMO')),
  retrieved_at TEXT NOT NULL,
  UNIQUE (content_hash, source, source_kind, retrieved_at)
);
CREATE INDEX series_retrievals_by_ticker ON series_retrievals (ticker, source_kind);
CREATE TABLE fx_rates (
  id TEXT PRIMARY KEY NOT NULL,
  pair TEXT NOT NULL CHECK (length(pair) = 6),
  rate TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  observed_at_basis TEXT NOT NULL CHECK (observed_at_basis IN ('PROVIDER', 'PUBLICATION_CONVENTION')),
  convention_id TEXT,
  source TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('REAL', 'DEMO')),
  recorded_at TEXT NOT NULL,
  UNIQUE (pair, source, source_kind, observed_at),
  CHECK ((convention_id IS NOT NULL) = (observed_at_basis = 'PUBLICATION_CONVENTION'))
);
CREATE INDEX fx_rates_by_pair ON fx_rates (pair);
CREATE TABLE calc_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  portfolio_id TEXT NOT NULL,
  hash TEXT NOT NULL CHECK (length(hash) = 64),
  created_at TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  inputs_canonical TEXT NOT NULL
);
CREATE INDEX calc_snapshots_by_hash ON calc_snapshots (hash);
CREATE TABLE risk_results (
  id TEXT PRIMARY KEY NOT NULL,
  portfolio_id TEXT NOT NULL,
  calculated_at TEXT NOT NULL,
  status TEXT NOT NULL,
  config_version_seq INTEGER NOT NULL CHECK (config_version_seq >= 1),
  config_version_hash TEXT NOT NULL CHECK (length(config_version_hash) = 64),
  snapshot_hash TEXT,
  snapshot_id TEXT REFERENCES calc_snapshots (id),
  body TEXT NOT NULL,
  CHECK ((snapshot_hash IS NULL) = (snapshot_id IS NULL))
);
CREATE INDEX risk_results_by_portfolio ON risk_results (portfolio_id);
CREATE TABLE alert_state (
  type TEXT NOT NULL CHECK (type IN ('VAR', 'FILING_RISK')),
  portfolio_id TEXT NOT NULL,
  ticker TEXT,
  ticker_key TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('ARMED', 'BREACHED', 'REARMING')),
  last_severity TEXT,
  last_alert_at TEXT,
  last_alert_id TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (type, portfolio_id, ticker_key),
  CHECK (ticker_key = coalesce(ticker, ''))
);
CREATE TABLE alerts (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('VAR', 'FILING_RISK')),
  source TEXT NOT NULL,
  portfolio_id TEXT NOT NULL,
  ticker TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('WARNING', 'HIGH', 'CRITICAL')),
  metric TEXT NOT NULL,
  observed TEXT NOT NULL,
  threshold TEXT NOT NULL,
  triggered_tickers_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  description TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'DISMISSED', 'RESOLVED')),
  state_changed_at TEXT,
  delivery TEXT NOT NULL CHECK (delivery IN ('PENDING', 'DELIVERED', 'FAILED')),
  delivery_attempts INTEGER NOT NULL CHECK (delivery_attempts >= 0),
  last_attempt_at TEXT
);
CREATE INDEX alerts_by_portfolio ON alerts (portfolio_id);
CREATE INDEX alerts_by_delivery ON alerts (delivery);
${appendOnlyTriggers}
CREATE TRIGGER alert_state_no_delete BEFORE DELETE ON alert_state
BEGIN SELECT RAISE(ABORT, 'alert_state rows are never deleted'); END;
CREATE TRIGGER alerts_no_delete BEFORE DELETE ON alerts
BEGIN SELECT RAISE(ABORT, 'alerts are never deleted'); END;
CREATE TRIGGER alerts_content_fixed BEFORE UPDATE ON alerts
WHEN NEW.id IS NOT OLD.id OR NEW.type IS NOT OLD.type OR NEW.source IS NOT OLD.source
  OR NEW.portfolio_id IS NOT OLD.portfolio_id OR NEW.ticker IS NOT OLD.ticker
  OR NEW.severity IS NOT OLD.severity OR NEW.metric IS NOT OLD.metric
  OR NEW.observed IS NOT OLD.observed OR NEW.threshold IS NOT OLD.threshold
  OR NEW.triggered_tickers_json IS NOT OLD.triggered_tickers_json
  OR NEW.created_at IS NOT OLD.created_at OR NEW.description IS NOT OLD.description
BEGIN SELECT RAISE(ABORT, 'alert content cannot change'); END;
CREATE TRIGGER alerts_status_forward BEFORE UPDATE ON alerts
WHEN (OLD.state <> 'OPEN' AND (NEW.state IS NOT OLD.state OR NEW.state_changed_at IS NOT OLD.state_changed_at))
  OR (OLD.delivery <> 'PENDING' AND NEW.delivery IS NOT OLD.delivery)
  OR NEW.delivery_attempts < OLD.delivery_attempts
BEGIN SELECT RAISE(ABORT, 'alert status cannot move backwards'); END;
`;

/**
 * Migration 2 (OD-20, approved 2026-11-09): the provider's quote behind each FX rate,
 * added as nullable columns, so every existing row stays valid with NULLs. The quote is
 * all-or-nothing and consistent with the stored pair (a trigger repeats the adapter rule,
 * because SQLite cannot add a table-level CHECK). `fx_rates` stays append-only.
 */
const V2 = `
ALTER TABLE fx_rates ADD COLUMN published_pair TEXT CHECK (published_pair IS NULL OR length(published_pair) = 6);
ALTER TABLE fx_rates ADD COLUMN published_rate TEXT;
ALTER TABLE fx_rates ADD COLUMN published_reference_date TEXT
  CHECK (published_reference_date IS NULL OR length(published_reference_date) = 10);
ALTER TABLE fx_rates ADD COLUMN derivation_method TEXT
  CHECK (derivation_method IS NULL OR derivation_method IN ('AS_PUBLISHED', 'DECIMAL_INVERSE'));
ALTER TABLE fx_rates ADD COLUMN derivation_precision TEXT
  CHECK (derivation_precision IS NULL OR derivation_precision = 'SIGNIFICANT_DIGITS_40_ROUND_HALF_UP');
CREATE TRIGGER fx_rates_published_consistent BEFORE INSERT ON fx_rates
WHEN NOT (
  (NEW.published_pair IS NULL AND NEW.published_rate IS NULL AND NEW.published_reference_date IS NULL
    AND NEW.derivation_method IS NULL AND NEW.derivation_precision IS NULL)
  OR (NEW.published_pair IS NOT NULL AND NEW.published_rate IS NOT NULL
    AND NEW.derivation_method IS NOT NULL AND NEW.derivation_precision IS NOT NULL
    AND ((NEW.derivation_method = 'AS_PUBLISHED' AND NEW.published_pair = NEW.pair)
      OR (NEW.derivation_method = 'DECIMAL_INVERSE'
        AND NEW.published_pair = substr(NEW.pair, 4, 3) || substr(NEW.pair, 1, 3))))
)
BEGIN SELECT RAISE(ABORT, 'fx_rates published quote is incomplete or inconsistent'); END;
`;

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { version: 1, sql: V1 },
  { version: 2, sql: V2 },
]);

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => (m.version > max ? m.version : max), 0);
