// Persistence test records. Financial fields are Canonical Decimal Strings, branded
// with the shared helper so no `as` cast or native number is needed.
import { brandDecimalString } from '../../src/shared/index.js';
import type {
  AuditRecord,
  ImportRecord,
  PositionRecord,
  QuarantineRecordRow,
  TransactionRecord,
} from '../../src/persistence/index.js';

const dec = brandDecimalString;
const AT = '2026-11-06T10:00:00.000Z';

export const transaction = (overrides: Partial<TransactionRecord> = {}): TransactionRecord => ({
  id: 'tx-1',
  portfolioId: 'pf-1',
  transactionKey: 'a'.repeat(64),
  source: 'CSV trades.csv',
  sourceId: `CSV:${'b'.repeat(64)}`,
  sourceSequence: 1,
  tradeTimestamp: AT,
  ticker: 'AAA',
  type: 'BUY',
  quantity: dec('10'),
  price: dec('12.5'),
  currency: 'USD',
  importId: 'imp-1',
  createdAt: AT,
  ...overrides,
});

export const importSummary = (overrides: Partial<ImportRecord> = {}): ImportRecord => ({
  id: 'imp-1',
  fileName: 'trades.csv',
  fileSha256: 'b'.repeat(64),
  importedAt: AT,
  totalRows: 3,
  accepted: 1,
  rejected: 1,
  duplicates: 0,
  skipped: 1,
  status: 'COMMITTED_WITH_REJECTIONS',
  ...overrides,
});

export const quarantined = (overrides: Partial<QuarantineRecordRow> = {}): QuarantineRecordRow => ({
  id: 'q-1',
  importId: 'imp-1',
  sourceKind: 'CSV',
  sequence: 2,
  reasonCode: 'MALFORMED_NUMBER',
  message: 'quantity is not a decimal',
  columnName: 'quantity',
  rawExcerpt: 'AAA,BUY,1e5',
  createdAt: AT,
  ...overrides,
});

export const position = (overrides: Partial<PositionRecord> = {}): PositionRecord => ({
  id: 'pos-1',
  portfolioId: 'pf-1',
  ticker: 'AAA',
  currency: 'USD',
  signedQuantity: dec('10'),
  averagePrice: dec('12.5'),
  isShort: false,
  source: 'ledger',
  updatedAt: AT,
  ...overrides,
});

export const auditEntry = (overrides: Partial<AuditRecord> = {}): AuditRecord => ({
  id: 'audit-1',
  at: AT,
  category: 'IMPORT',
  type: 'IMPORT_COMMITTED',
  subject: 'imp-1',
  details: { fileSha256: 'b'.repeat(64), withRejections: true },
  ...overrides,
});
