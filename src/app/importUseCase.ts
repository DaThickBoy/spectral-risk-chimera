/**
 * Import use cases (task 7.5; design: Import pipeline, D-16; R1.2, R1.4, R28.9,
 * R28.10, R28.17, AT-POS-04).
 *
 * `run` checks that the portfolio exists and that the column mapping is valid,
 * runs the import (one unit of work in `ingestion/`) and, only after it has
 * committed (status `COMMITTED` or `COMMITTED_WITH_REJECTIONS`, `persisted`),
 * rebuilds the portfolio's positions with `PositionService.rebuild` (6.2) in a
 * second unit of work. A failed import never touches positions. A rebuild
 * failure does not change the committed import; it is reported in the result,
 * and a later rebuild repairs the projection because rebuild is a full replay.
 *
 * `summary` and `rejections` read a stored import and its quarantine records.
 */
import type { CanonicalField, ImportService, ImportSummary } from '../ingestion/index.js';
import { CsvColumnMappingSchema } from '../ingestion/index.js';
import type { ImportRecord, QuarantineRecordRow, UnitOfWork } from '../persistence/ports.js';
import type { PortfolioService } from './portfolioService.js';
import type { PositionRebuildResult, PositionService } from './positionService.js';

export interface ImportRequest {
  readonly portfolioId: string;
  /** Sanitized display name (4.4). */
  readonly fileName: string;
  readonly bytes: Uint8Array;
  /** Source label (R28.11); `CSV` when absent. */
  readonly source?: string;
  /** Canonical field -> source column (R1.2); unmapped fields use their own name. */
  readonly columns: Partial<Record<CanonicalField, string>>;
}

export type ImportUseCaseResult =
  | { readonly status: 'PORTFOLIO_NOT_FOUND' }
  | { readonly status: 'MAPPING_INVALID' }
  | {
      readonly status: 'DONE';
      readonly summary: ImportSummary;
      /** Absent when the import did not commit. */
      readonly positions?: PositionRebuildResult['status'];
    };

export interface ImportUseCase {
  run(request: ImportRequest): Promise<ImportUseCaseResult>;
  summary(importId: string): ImportRecord | undefined;
  /** `undefined` for an unknown import; otherwise its quarantine records in row order. */
  rejections(importId: string): readonly QuarantineRecordRow[] | undefined;
}

export interface ImportUseCaseDependencies {
  readonly imports: ImportService;
  readonly positions: PositionService;
  readonly portfolios: PortfolioService;
  readonly unitOfWork: UnitOfWork;
}

export const DEFAULT_IMPORT_SOURCE = 'CSV';

export function createImportUseCase(deps: ImportUseCaseDependencies): ImportUseCase {
  if (
    typeof deps.imports?.importFile !== 'function' ||
    typeof deps.positions?.rebuild !== 'function' ||
    typeof deps.portfolios?.get !== 'function' ||
    typeof deps.unitOfWork?.run !== 'function'
  ) {
    throw new TypeError('imports, positions, portfolios, and unitOfWork are required.');
  }
  return {
    run: async (request) => {
      if (deps.portfolios.get(request.portfolioId) === undefined) {
        return { status: 'PORTFOLIO_NOT_FOUND' };
      }
      const mapping = CsvColumnMappingSchema.safeParse(request.columns);
      if (!mapping.success) {
        return { status: 'MAPPING_INVALID' };
      }
      const summary = await deps.imports.importFile({
        portfolioId: request.portfolioId,
        fileName: request.fileName,
        bytes: request.bytes,
        source: request.source ?? DEFAULT_IMPORT_SOURCE,
        mapping: mapping.data,
      });
      if (summary.status === 'FAILED' || !summary.persisted) {
        return { status: 'DONE', summary };
      }
      return { status: 'DONE', summary, positions: deps.positions.rebuild(request.portfolioId).status };
    },
    summary: (importId) => deps.unitOfWork.run((tx) => tx.imports.get(importId)),
    rejections: (importId) =>
      deps.unitOfWork.run((tx) => {
        if (tx.imports.get(importId) === undefined) {
          return undefined;
        }
        // integer row order, not a financial value
        return [...tx.quarantine.listByImport(importId)].sort((a, b) => a.sequence - b.sequence);
      }),
  };
}
