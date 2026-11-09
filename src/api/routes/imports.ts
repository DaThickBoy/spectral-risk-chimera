/**
 * Import routes (task 7.5; design: API routes, Quarantine and Audit Log;
 * R1.2, R1.4, R3.3, R28.9, R28.10, R29.4, R29.6).
 *
 * - `POST /portfolios/:id/imports`: one multipart CSV file (4.4 limits). The
 *   optional query names the source label and, per canonical field, its source
 *   column. 201 with the stored summary (also for a file-level rejection, which
 *   is stored as `FAILED`); 404 for an unknown portfolio; 400 for an invalid
 *   mapping; a commit failure (nothing stored) is a generic 500.
 * - `GET /imports/:id` and `GET /imports/:id/rejections`: the summary and its
 *   quarantine records (redacted excerpts), 404 for an unknown import.
 * Every response is validated against its shared contract before it is sent.
 */
import type { FastifyInstance } from 'fastify';
import type { ImportRequest, ImportUseCase } from '../../app/index.js';
import {
  IMPORT_MAPPING_FIELDS,
  ImportCreatedSchema,
  ImportIdParamsSchema,
  ImportQuerySchema,
  ImportRejectionsResponseSchema,
  ImportSummarySchema,
  PortfolioParamsSchema,
} from '../../shared/index.js';
import type { IdGenerator } from '../../shared/index.js';
import type { ApiRoutes } from '../server.js';
import { sendError } from '../errors.js';
import { receiveUpload, sendUploadRejection } from '../uploads.js';
import { defineRoute } from '../validation.js';

export interface ImportRouteDependencies {
  readonly imports: ImportUseCase;
  /** Generates upload stored names (4.4). */
  readonly ids: IdGenerator;
}

interface SummaryLike {
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
}

const summaryDto = (summary: SummaryLike) => ({
  importId: summary.importId,
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

export function importRoutes(deps: ImportRouteDependencies): ApiRoutes {
  return (app: FastifyInstance) => {
    defineRoute(app, {
      method: 'POST',
      url: '/portfolios/:id/imports',
      params: PortfolioParamsSchema,
      querystring: ImportQuerySchema,
      upload: true,
      handler: async ({ params, query }, request, reply) => {
        const received = await receiveUpload(request, deps.ids);
        if (!received.ok) {
          return sendUploadRejection(reply, request, received.reason);
        }
        const columns: Record<string, string> = {};
        for (const field of IMPORT_MAPPING_FIELDS) {
          const column = query[field];
          if (column !== undefined) {
            columns[field] = column;
          }
        }
        const input: ImportRequest = {
          portfolioId: params.id,
          fileName: received.upload.originalName,
          bytes: received.upload.bytes,
          columns,
          ...(query.source === undefined ? {} : { source: query.source }),
        };
        const result = await deps.imports.run(input);
        switch (result.status) {
          case 'PORTFOLIO_NOT_FOUND':
            return sendError(reply, request, 404, 'NOT_FOUND', 'The resource was not found.');
          case 'MAPPING_INVALID':
            return sendError(reply, request, 400, 'VALIDATION_FAILED', 'Request validation failed.');
          case 'DONE': {
            if (!result.summary.persisted) {
              throw new Error('The import could not be committed.'); // generic 500, nothing stored
            }
            return reply.code(201).send(
              ImportCreatedSchema.parse({
                ...summaryDto(result.summary),
                ...(result.positions === undefined ? {} : { positions: result.positions }),
              }),
            );
          }
        }
      },
    });
    defineRoute(app, {
      method: 'GET',
      url: '/imports/:id',
      params: ImportIdParamsSchema,
      handler: async ({ params }, request, reply) => {
        const summary = deps.imports.summary(params.id);
        if (summary === undefined) {
          return sendError(reply, request, 404, 'NOT_FOUND', 'The resource was not found.');
        }
        return reply.send(ImportSummarySchema.parse(summaryDto({ ...summary, importId: summary.id })));
      },
    });
    defineRoute(app, {
      method: 'GET',
      url: '/imports/:id/rejections',
      params: ImportIdParamsSchema,
      handler: async ({ params }, request, reply) => {
        const rows = deps.imports.rejections(params.id);
        if (rows === undefined) {
          return sendError(reply, request, 404, 'NOT_FOUND', 'The resource was not found.');
        }
        return reply.send(
          ImportRejectionsResponseSchema.parse({
            importId: params.id,
            rejections: rows.map((row) => ({
              sequence: row.sequence,
              reasonCode: row.reasonCode,
              message: row.message,
              ...(row.columnName === undefined ? {} : { column: row.columnName }),
              rawExcerpt: row.rawExcerpt,
              createdAt: row.createdAt,
            })),
          }),
        );
      },
    });
  };
}
