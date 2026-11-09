/**
 * Import preparation: parsing, mapping, validation, normalization, and
 * chronological decisions, without persistence (tasks 7.1 to 7.4; NFR-PERF-1
 * timed scope; R3.1, R3.2, R28.4 to R28.22).
 *
 * Every data row is classified exactly once (R3.5, R28.9):
 * - `skipped`: an entirely empty row (7.1);
 * - `rejected`: `FIELD_TOO_LONG` (7.1), one or more field errors (7.2, all kept),
 *   `UNSUPPORTED_CURRENCY` (7.3), or `CURRENCY_MISMATCH` / `OVERSELL` (7.4);
 * - `duplicate`: its `transactionKey` belongs to a ledger transaction or to a row of
 *   this file that is accepted (7.3); a row rejected by 7.4 never makes another row
 *   a duplicate (R28.12), so those decisions are repeated without its key;
 * - `accepted`: everything else, in R28.18 order.
 * A file-level problem (7.1) classifies no row. Pure apart from reading `bytes`.
 */
import type { LedgerEntry } from '../portfolio/index.js';
import type { RejectReason } from '../persistence/ports.js';
import { sha256Hex } from '../shared/index.js';
import { applyChronology } from './chronology.js';
import type { ChronologyRejection, ChronologyResult, OversellPolicy } from './chronology.js';
import type { CsvParser, FileRejectReason } from './csv/csvParser.js';
import { validateRow } from './csv/rowValidation.js';
import type { RowError, ValidRow } from './csv/rowValidation.js';
import { headerFor } from './csv/schema.js';
import type { CsvColumnMapping, CsvOptions } from './csv/schema.js';
import { normalizeRows } from './normalize.js';
import type { Candidate } from './normalize.js';

export interface ImportInput {
  readonly bytes: Uint8Array;
  readonly portfolioId: string;
  /** Source label (R28.11). */
  readonly source: string;
  readonly mapping: CsvColumnMapping;
}

export interface ImportSettings {
  /** `import.maxFileBytes`, `import.maxRows`, `import.maxFieldLength`. */
  readonly csv: CsvOptions;
  /** `import.defaultTimezone` (class F, no default); date-only timestamps need it. */
  readonly defaultTimezone?: string;
  /** `fx.supportedCurrencies`. */
  readonly supportedCurrencies: readonly string[];
  /** `import.oversellPolicy` (class F, no default); the import is refused without it. */
  readonly oversellPolicy?: OversellPolicy;
}

/** One rejected row: all its errors, the first one being the primary reason. */
export interface RowRejection {
  readonly sequence: number;
  readonly errors: readonly {
    readonly reason: RejectReason;
    readonly column?: string;
    readonly message: string;
  }[];
  readonly rawExcerpt: string;
}

export type Prepared =
  | {
      readonly kind: 'FILE_REJECTED';
      readonly fileSha256: string;
      readonly reason: FileRejectReason;
      readonly message: string;
      readonly columns?: readonly string[];
    }
  | {
      readonly kind: 'CLASSIFIED';
      readonly fileSha256: string;
      readonly totalRows: number;
      /** R28.18 order. */
      readonly accepted: readonly Candidate[];
      readonly duplicates: readonly number[];
      readonly skipped: readonly number[];
      /** Ascending sequence. */
      readonly rejected: readonly RowRejection[];
    };

const single = (reason: RejectReason, message: string, column?: string): RowRejection['errors'] => [
  { reason, message, ...(column === undefined ? {} : { column }) },
];

/** Classifies every row of `input` against the committed `ledger`. Requires an oversell policy. */
export async function prepareImport(
  input: ImportInput,
  settings: ImportSettings & { readonly oversellPolicy: OversellPolicy },
  ledger: readonly LedgerEntry[],
  parser: CsvParser,
): Promise<Prepared> {
  const fileSha256 = sha256Hex(input.bytes);
  const valid: ValidRow[] = [];
  const skipped: number[] = [];
  const rejected: RowRejection[] = [];
  let totalRows = 0;
  for await (const event of parser.parse(input.bytes, input.mapping, settings.csv)) {
    switch (event.kind) {
      case 'FILE_REJECTED':
        return {
          kind: 'FILE_REJECTED',
          fileSha256,
          reason: event.reason,
          message: event.message,
          ...(event.columns === undefined ? {} : { columns: event.columns }),
        };
      case 'SKIPPED':
        totalRows += 1;
        skipped.push(event.sequence);
        break;
      case 'ROW_REJECTED':
        totalRows += 1;
        rejected.push({
          sequence: event.sequence,
          errors: single('FIELD_TOO_LONG', `${event.column} is longer than the field limit.`, event.column),
          rawExcerpt: event.rawExcerpt,
        });
        break;
      case 'RECORD': {
        totalRows += 1;
        const result = validateRow(event.record, {
          mapping: input.mapping,
          portfolioId: input.portfolioId,
          ...(settings.defaultTimezone === undefined ? {} : { defaultTimezone: settings.defaultTimezone }),
        });
        if (result.ok) {
          valid.push(result.row);
        } else {
          rejected.push({
            sequence: event.record.sequence,
            errors: result.errors.map((error: RowError) => ({
              reason: error.reason,
              column: error.column,
              message: error.message,
            })),
            rawExcerpt: result.rawExcerpt,
          });
        }
        break;
      }
    }
  }

  const ledgerKeys = new Set(ledger.map((entry) => entry.transactionKey));
  const supportedCurrencies = new Set(settings.supportedCurrencies);
  const currencyColumn = headerFor(input.mapping, 'currency');
  // Rows rejected by 7.4 whose key was also used by a later row of this file. Such a later
  // row is not a duplicate (no transaction with the key exists, R28.12), so the 7.3 and 7.4
  // decisions are repeated without the rejected row's key. The set grows on every repeat and
  // is bounded by the number of rows, so the loop ends; usually it runs once.
  const excluded = new Map<number, ChronologyRejection>();
  let candidates: Candidate[];
  let duplicates: number[];
  let unsupported: ValidRow[];
  let chronology: ChronologyResult;
  for (;;) {
    const normalized = normalizeRows(valid, {
      portfolioId: input.portfolioId,
      source: input.source,
      fileSha256,
      supportedCurrencies,
      ledgerKeys,
      excluded: new Set(excluded.keys()),
    });
    candidates = [];
    duplicates = [];
    unsupported = [];
    const batchDuplicateKeys = new Set<string>();
    for (const outcome of normalized) {
      switch (outcome.kind) {
        case 'CANDIDATE':
          candidates.push(outcome.candidate);
          break;
        case 'DUPLICATE':
          duplicates.push(outcome.sequence);
          if (!ledgerKeys.has(outcome.transactionKey)) {
            batchDuplicateKeys.add(outcome.transactionKey);
          }
          break;
        case 'UNSUPPORTED_CURRENCY':
          unsupported.push(outcome.row);
          break;
        case 'EXCLUDED':
          break;
      }
    }
    chronology = applyChronology(candidates, ledger, settings.oversellPolicy);
    const hiding = chronology.rejected.filter((r) => batchDuplicateKeys.has(r.candidate.transactionKey));
    if (hiding.length === 0) {
      break;
    }
    for (const rejection of hiding) {
      excluded.set(rejection.candidate.sourceSequence, rejection);
    }
  }
  for (const row of unsupported) {
    rejected.push({
      sequence: row.sequence,
      errors: single(
        'UNSUPPORTED_CURRENCY',
        `${currencyColumn} is not a supported currency.`,
        currencyColumn,
      ),
      rawExcerpt: row.rawExcerpt,
    });
  }
  for (const { candidate, reason } of [...excluded.values(), ...chronology.rejected]) {
    const column = reason === 'CURRENCY_MISMATCH' ? currencyColumn : headerFor(input.mapping, 'quantity');
    const message =
      reason === 'CURRENCY_MISMATCH'
        ? `${column} differs from the instrument's established currency.`
        : 'The SELL exceeds the available long quantity (oversellPolicy REJECT).';
    rejected.push({
      sequence: candidate.sourceSequence,
      errors: single(reason, message, column),
      rawExcerpt: candidate.row.rawExcerpt,
    });
  }
  rejected.sort((a, b) => a.sequence - b.sequence); // integer sequence order, not a financial value
  return {
    kind: 'CLASSIFIED',
    fileSha256,
    totalRows,
    accepted: chronology.accepted,
    duplicates,
    skipped,
    rejected,
  };
}
