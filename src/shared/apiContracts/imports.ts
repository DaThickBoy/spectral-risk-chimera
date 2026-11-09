/**
 * Import API contracts (task 7.5; design: Import summary, Quarantine; R1.4,
 * R28.9, R28.10). Counts and row numbers are integers, not financial values.
 */
import { z } from 'zod';
import { IsoUtcMillis } from '../timestamps.js';

const CANONICAL = [
  'external_id',
  'trade_timestamp',
  'ticker',
  'type',
  'quantity',
  'price',
  'currency',
  'portfolio_id',
] as const;
const ColumnName = z.string().min(1).max(256);

/**
 * `POST /portfolios/:id/imports` query: an optional source label (R28.11) and an
 * optional column mapping, one query field per canonical field naming its
 * source column (R1.2). Unknown fields are rejected.
 */
export const ImportQuerySchema = z.strictObject({
  source: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
    .optional(),
  external_id: ColumnName.optional(),
  trade_timestamp: ColumnName.optional(),
  ticker: ColumnName.optional(),
  type: ColumnName.optional(),
  quantity: ColumnName.optional(),
  price: ColumnName.optional(),
  currency: ColumnName.optional(),
  portfolio_id: ColumnName.optional(),
});
export type ImportQuery = z.infer<typeof ImportQuerySchema>;
export const IMPORT_MAPPING_FIELDS = CANONICAL;

export const ImportIdParamsSchema = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) });

export const ImportSummarySchema = z.strictObject({
  importId: z.string().min(1),
  fileName: z.string().min(1),
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  importedAt: IsoUtcMillis,
  totalRows: z.int().nonnegative(),
  accepted: z.int().nonnegative(),
  rejected: z.int().nonnegative(),
  duplicates: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
  status: z.enum(['COMMITTED', 'COMMITTED_WITH_REJECTIONS', 'FAILED']),
  failureReason: z.string().min(1).optional(),
});
export type ImportSummaryDto = z.infer<typeof ImportSummarySchema>;

/**
 * `POST /portfolios/:id/imports` response (201): the stored summary plus, when
 * the import committed, the outcome of the position rebuild (R28.17).
 */
export const ImportCreatedSchema = z.strictObject({
  ...ImportSummarySchema.shape,
  positions: z.enum(['REBUILT', 'REBUILT_PUBLISH_FAILED', 'PROJECTION_FAILED', 'COMMIT_FAILED']).optional(),
});
export type ImportCreatedDto = z.infer<typeof ImportCreatedSchema>;

export const ImportRejectionSchema = z.strictObject({
  sequence: z.int().positive(),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  message: z.string().min(1),
  column: z.string().min(1).optional(),
  rawExcerpt: z.string().max(512),
  createdAt: IsoUtcMillis,
});

export const ImportRejectionsResponseSchema = z.strictObject({
  importId: z.string().min(1),
  rejections: z.array(ImportRejectionSchema),
});
export type ImportRejectionsResponse = z.infer<typeof ImportRejectionsResponseSchema>;
