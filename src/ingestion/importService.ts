/**
 * Import service (task 7.5; design: Import pipeline, Quarantine and Audit Log,
 * Import summary; R1.4, R3.2 to R3.5, R22.1, R28.9, R28.10, R28.15, R28.16,
 * R28.20, AT-CSV-05, AT-CSV-16, AT-AUD-01).
 *
 * `importFile` classifies every row (`prepareImport`) against the portfolio's
 * committed ledger and writes, in ONE unit of work, the accepted transactions,
 * the import summary, one quarantine record per rejected row, and one audit
 * entry per rejected row plus one for the import (R28.15). Then:
 * - a commit failure leaves nothing from the import, returns status `FAILED`
 *   (`COMMIT_FAILED`), and records `IMPORT_FAILED` in a separate audit write
 *   (R28.16);
 * - a file-level rejection (7.1) stores the `FAILED` summary and a
 *   `FILE_REJECTED` audit entry, and no rows;
 * - without `import.oversellPolicy` the import is refused before parsing
 *   (`FAILED`, `CONFIG_MISSING: import.oversellPolicy`, R28.20).
 *
 * Imports of the same portfolio run one at a time in this process, so the
 * ledger read for duplicate and oversell decisions cannot change before the
 * commit. `ingestion/` never writes positions or publishes events (D-16); the
 * app-layer use case rebuilds positions after a successful commit (R28.17).
 * Quarantine excerpts are redacted and at most 512 characters. Only a
 * `PersistenceError` becomes `FAILED`; any other exception propagates.
 */
import { createAuditLog, recordAuditEvent } from '../audit/index.js';
import type { AuditEvent } from '../audit/index.js';
import { PersistenceError } from '../persistence/ports.js';
import type { ImportRecord, TransactionRecord, UnitOfWork } from '../persistence/ports.js';
import { redactText, sha256Hex } from '../shared/index.js';
import type { Clock, IdGenerator } from '../shared/index.js';
import type { CsvParser } from './csv/csvParser.js';
import { RAW_EXCERPT_MAX } from './csv/csvParser.js';
import { prepareImport } from './prepareImport.js';
import type { ImportInput, ImportSettings, Prepared } from './prepareImport.js';

/** Design `ImportSummary`. Counts are integers (not financial values). */
export interface ImportSummary {
  readonly importId: string;
  readonly fileName: string;
  readonly fileSha256: string;
  readonly importedAt: string;
  readonly totalRows: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly duplicates: number;
  readonly skipped: number;
  readonly status: 'COMMITTED' | 'COMMITTED_WITH_REJECTIONS' | 'FAILED';
  readonly failureReason?: string;
  /** False only for `COMMIT_FAILED`: nothing was stored. */
  readonly persisted: boolean;
}

export interface ImportFileInput extends ImportInput {
  /** Sanitized display name (4.4). */
  readonly fileName: string;
}

export interface ImportService {
  importFile(input: ImportFileInput): Promise<ImportSummary>;
}

export interface ImportServiceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly parser: CsvParser;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly settings: ImportSettings;
  /** Exact secret values to redact from excerpts and audit details. */
  readonly secrets?: readonly string[];
}

const toRecord = (summary: ImportSummary): ImportRecord => ({
  id: summary.importId,
  fileName: summary.fileName,
  fileSha256: summary.fileSha256,
  importedAt: summary.importedAt,
  totalRows: summary.totalRows,
  accepted: summary.accepted,
  rejected: summary.rejected,
  duplicates: summary.duplicates,
  skipped: summary.skipped,
  status: summary.status,
  ...(summary.failureReason === undefined ? {} : { failureReason: summary.failureReason }),
});

const counts = (summary: ImportSummary): Record<string, string> => ({
  totalRows: String(summary.totalRows),
  accepted: String(summary.accepted),
  rejected: String(summary.rejected),
  duplicates: String(summary.duplicates),
  skipped: String(summary.skipped),
});

export function createImportService(deps: ImportServiceDependencies): ImportService {
  const { unitOfWork, parser, clock, ids, settings } = deps;
  const secrets = deps.secrets ?? [];
  const queues = new Map<string, Promise<unknown>>();
  const now = (): string => clock.nowUtc().toISOString();

  const failedSummary = (
    base: Omit<ImportSummary, 'status' | 'failureReason' | 'persisted'>,
    failureReason: string,
    persisted: boolean,
  ): ImportSummary => Object.freeze({ ...base, status: 'FAILED', failureReason, persisted });

  /** Writes a FAILED summary with one IMPORT audit entry (file-level rejection or refusal). */
  const storeFailure = (
    summary: ImportSummary,
    type: string,
    details: Record<string, string>,
  ): ImportSummary => {
    try {
      unitOfWork.run((tx) => {
        tx.imports.insert(toRecord(summary));
        createAuditLog(tx.audit, { secrets }).append({
          id: ids.next(),
          at: now(),
          category: 'IMPORT',
          type,
          subject: summary.importId,
          details: { ...details, fileSha256: summary.fileSha256, ...counts(summary) },
        });
      });
      return summary;
    } catch (error) {
      if (error instanceof PersistenceError) {
        return Object.freeze({
          ...summary,
          failureReason: `${summary.failureReason ?? ''}; COMMIT_FAILED`,
          persisted: false,
        });
      }
      throw error;
    }
  };

  const run = async (input: ImportFileInput): Promise<ImportSummary> => {
    const importId = ids.next();
    const importedAt = now();
    const base = {
      importId,
      fileName: input.fileName,
      fileSha256: '',
      importedAt,
      totalRows: 0,
      accepted: 0,
      rejected: 0,
      duplicates: 0,
      skipped: 0,
    };
    const policy = settings.oversellPolicy;
    if (policy === undefined) {
      const summary = failedSummary(
        { ...base, fileSha256: sha256Hex(input.bytes) },
        'CONFIG_MISSING: import.oversellPolicy',
        true,
      );
      return storeFailure(summary, 'IMPORT_REFUSED', {
        reason: 'CONFIG_MISSING',
        key: 'import.oversellPolicy',
        source: input.source,
      });
    }
    const ledger = unitOfWork.run((tx) => tx.transactions.listByPortfolio(input.portfolioId));
    const prepared: Prepared = await prepareImport(
      input,
      { ...settings, oversellPolicy: policy },
      ledger,
      parser,
    );
    if (prepared.kind === 'FILE_REJECTED') {
      const summary = failedSummary({ ...base, fileSha256: prepared.fileSha256 }, prepared.reason, true);
      return storeFailure(summary, 'FILE_REJECTED', {
        reason: prepared.reason,
        message: prepared.message,
        source: input.source,
        ...(prepared.columns === undefined ? {} : { columns: prepared.columns.join(', ') }),
      });
    }
    const summary: ImportSummary = Object.freeze({
      ...base,
      fileSha256: prepared.fileSha256,
      totalRows: prepared.totalRows,
      accepted: prepared.accepted.length,
      rejected: prepared.rejected.length,
      duplicates: prepared.duplicates.length,
      skipped: prepared.skipped.length,
      status: prepared.rejected.length === 0 ? 'COMMITTED' : 'COMMITTED_WITH_REJECTIONS',
      persisted: true,
    });
    try {
      unitOfWork.run((tx) => {
        const createdAt = now();
        for (const candidate of prepared.accepted) {
          const { row } = candidate;
          const record: TransactionRecord = {
            id: ids.next(),
            portfolioId: input.portfolioId,
            transactionKey: candidate.transactionKey,
            ...(row.externalId === undefined ? {} : { externalId: row.externalId }),
            source: input.source,
            sourceId: candidate.sourceId,
            sourceSequence: candidate.sourceSequence,
            tradeTimestamp: row.tradeTimestamp,
            ticker: row.ticker,
            type: row.type,
            quantity: row.quantity,
            price: row.price,
            currency: row.currency,
            importId,
            createdAt,
          };
          tx.transactions.insert(record);
        }
        tx.imports.insert(toRecord(summary));
        const audit = createAuditLog(tx.audit, { secrets });
        for (const rejection of prepared.rejected) {
          const [primary, ...more] = rejection.errors;
          if (primary === undefined) {
            throw new Error('A rejected row has no error.'); // programmer error
          }
          tx.quarantine.insert({
            id: ids.next(),
            importId,
            sourceKind: 'CSV',
            sequence: rejection.sequence,
            reasonCode: primary.reason,
            message: [primary, ...more].map((error) => error.message).join(' '),
            ...(primary.column === undefined ? {} : { columnName: primary.column }),
            rawExcerpt: redactText(rejection.rawExcerpt, secrets).slice(0, RAW_EXCERPT_MAX),
            createdAt,
          });
          const event: AuditEvent = {
            id: ids.next(),
            at: createdAt,
            category: 'VALIDATION',
            type: 'ROW_REJECTED',
            subject: importId,
            details: {
              source: input.source,
              sourceKind: 'CSV',
              sequence: String(rejection.sequence),
              reason: primary.reason,
              reasons: rejection.errors.map((error) => error.reason).join(','),
              ...(primary.column === undefined ? {} : { column: primary.column }),
            },
          };
          audit.append(event);
        }
        audit.append({
          id: ids.next(),
          at: createdAt,
          category: 'IMPORT',
          type: 'IMPORT_COMMITTED',
          subject: importId,
          details: {
            status: summary.status,
            fileSha256: summary.fileSha256,
            source: input.source,
            ...counts(summary),
          },
        });
      });
      return summary;
    } catch (error) {
      if (!(error instanceof PersistenceError)) {
        throw error;
      }
      const failed = failedSummary(
        { ...base, fileSha256: prepared.fileSha256, totalRows: prepared.totalRows },
        'COMMIT_FAILED',
        false,
      );
      try {
        // R28.16: recorded afterwards, in its own unit of work.
        recordAuditEvent(
          unitOfWork,
          {
            id: ids.next(),
            at: now(),
            category: 'IMPORT',
            type: 'IMPORT_FAILED',
            subject: importId,
            details: {
              reason: 'COMMIT_FAILED',
              code: error.code,
              fileSha256: prepared.fileSha256,
              source: input.source,
            },
          },
          { secrets },
        );
      } catch (auditError) {
        if (!(auditError instanceof PersistenceError)) {
          throw auditError;
        }
      }
      return failed;
    }
  };

  return {
    importFile: (input) => {
      if (!(input.bytes instanceof Uint8Array)) {
        throw new TypeError('bytes must be a Uint8Array.');
      }
      for (const key of ['portfolioId', 'source', 'fileName'] as const) {
        if (typeof input[key] !== 'string' || input[key].length === 0) {
          throw new TypeError(`${key} must be a non-empty string.`);
        }
      }
      // One import at a time per portfolio (see header).
      const previous = queues.get(input.portfolioId) ?? Promise.resolve();
      const next = previous.then(
        () => run(input),
        () => run(input),
      );
      queues.set(
        input.portfolioId,
        next.catch(() => undefined),
      );
      return next;
    },
  };
}
