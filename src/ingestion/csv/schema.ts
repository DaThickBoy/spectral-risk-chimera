/**
 * CSV canonical fields, column mapping, and parser options (task 7.1; design:
 * CSV Parser; R1.2, R28.1, R28.4, R28.5, R28.8).
 */
import { z } from 'zod';

/** R28.1 canonical fields. */
export const CANONICAL_FIELDS = [
  'external_id',
  'trade_timestamp',
  'ticker',
  'type',
  'quantity',
  'price',
  'currency',
  'portfolio_id',
] as const;
export const CanonicalField = z.enum(CANONICAL_FIELDS);
export type CanonicalField = z.infer<typeof CanonicalField>;

/** Required canonical fields; their columns must be present in the header (R28.5). */
export const REQUIRED_CANONICAL_FIELDS: readonly CanonicalField[] = [
  'trade_timestamp',
  'ticker',
  'type',
  'quantity',
  'price',
  'currency',
];

/**
 * Canonical field -> source header (R1.2). Zod 4: an enum-keyed `z.record` requires
 * every key, so optional mappings use `z.partialRecord`; keys outside
 * `CanonicalField` are rejected by the key schema. An unmapped field uses the
 * header of the same name. Two fields may not map to the same header.
 */
export const CsvColumnMappingSchema = z
  .partialRecord(CanonicalField, z.string().min(1).max(256))
  .refine((mapping) => new Set(Object.values(mapping)).size === Object.values(mapping).length, {
    message: 'two canonical fields cannot map to the same column',
  });
export type CsvColumnMapping = z.infer<typeof CsvColumnMappingSchema>;

/** `import.maxFileBytes`, `import.maxRows`, `import.maxFieldLength` (class O, R28.4, R28.8). */
export interface CsvOptions {
  readonly maxFileBytes: number;
  readonly maxRows: number;
  readonly maxFieldLength: number;
}

/** The source header of every canonical field under `mapping`. */
export function headerFor(mapping: CsvColumnMapping, field: CanonicalField): string {
  return mapping[field] ?? field;
}
