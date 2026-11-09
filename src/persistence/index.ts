// Public API of src/persistence/ for composition and tests.
// Domain modules import `./ports.ts` directly (the boundary rules allow only that file);
// they never import this index or the implementations it exports.
export { FX_DERIVATION_PRECISION, PersistenceError } from './ports.js';
export type {
  AlertRecord,
  AlertRepo,
  AlertSeverityRecord,
  AlertStateRecord,
  AlertStateRepo,
  AlertTypeRecord,
  AuditCategory,
  AuditRecord,
  AuditRepo,
  ImportRecord,
  ImportRepo,
  IsoUtc,
  PersistenceErrorCode,
  PositionRecord,
  PositionRepo,
  QuarantineRecordRow,
  QuarantineRepo,
  FxRateRecord,
  FxPublishedQuote,
  FxRepo,
  PortfolioRecord,
  PortfolioRepo,
  NewSeriesRetrieval,
  RejectReason,
  Repositories,
  RiskResultRecord,
  RiskResultRepo,
  SnapshotRecord,
  SnapshotRepo,
  SeriesContentRecord,
  SeriesObservationRecord,
  SeriesRepo,
  SeriesRetrievalRecord,
  SeriesSourceKind,
  SourceKind,
  TransactionRecord,
  TransactionRepo,
  UnitOfWork,
} from './ports.js';
export { InMemoryUnitOfWork } from './memory/inMemoryUnitOfWork.js';
export { SqliteUnitOfWork } from './sqlite/sqliteUnitOfWork.js';
export type { SqliteOptions } from './sqlite/sqliteUnitOfWork.js';
export { LATEST_SCHEMA_VERSION } from './sqlite/schema.js';
export type {
  CommitAttempt,
  CommitFault,
  CommitOutcome,
  InMemorySnapshot,
  WriteDescriptor,
  WriteOperation,
} from './memory/inMemoryUnitOfWork.js';
