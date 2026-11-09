/**
 * Per-cell CSV formula-injection neutralization (task 24.1; R29.7; design: Shared utilities).
 *
 * Rules:
 * - A cell whose first character is `=`, `+`, `-`, `@`, TAB (U+0009), or CR (U+000D)
 *   is returned with one leading single quote (`'`).
 * - Decimal exception: a cell starting with `-` whose entire content matches the
 *   existing `DecimalStringSchema` grammar (R4.6, for example `-12.5`) is returned
 *   unchanged, so negative financial values stay numeric. No separate decimal grammar
 *   is defined here; the shared schema is reused as is.
 * - A cell that already starts with `'` (including one neutralized before) is returned
 *   unchanged, so `neutralizeCsvCell(neutralizeCsvCell(x)) === neutralizeCsvCell(x)`.
 * - Every other cell, including the empty string, is returned unchanged.
 *
 * Scope: one cell. No trimming, CSV quoting or escaping, or Unicode look-alike mapping;
 * those belong to an export feature, which is not specified yet.
 */
import { DecimalStringSchema } from './schemas.js';

const DANGEROUS_FIRST = new Set(['=', '+', '-', '@', '\t', '\r']);

/** True for a negative-signed cell that is entirely decimal text in the DecimalStringSchema grammar. */
function isDecimalException(cell: string): boolean {
  return cell.startsWith('-') && DecimalStringSchema.safeParse(cell).success;
}

/** Neutralizes one CSV cell against spreadsheet formula injection (R29.7). */
export function neutralizeCsvCell(cell: string): string {
  const first = cell.charAt(0);
  if (!DANGEROUS_FIRST.has(first) || isDecimalException(cell)) {
    return cell;
  }
  return `'${cell}`;
}
