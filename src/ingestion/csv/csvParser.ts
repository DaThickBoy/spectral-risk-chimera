/**
 * CSV pre-checks and streaming parsing (task 7.1; design: CSV Parser; R1.1, R1.5,
 * R28.3 to R28.6, R28.8; AT-CSV-06, AT-CSV-07, AT-CSV-08, AT-CSV-15, AT-CSV-18,
 * AT-CSV-22).
 *
 * `createCsvParser().parse(input, mapping, opts)` returns an async iterable of
 * events. Every file-level problem is reported before any record is emitted:
 *
 * 0. `FILE_TOO_LARGE`: `input.length > maxFileBytes` (no decoding happens).
 * 1. `INVALID_ENCODING`: the whole input is checked as UTF-8 first (fatal
 *    streaming decoder; the BOM is stripped).
 * 2. A validation pass parses the whole file without emitting anything:
 *    `MALFORMED_CSV` for a structural error (an unclosed or misplaced quote, with
 *    `relax_quotes` disabled, or a row whose field count differs from the
 *    header, which would misalign columns); `INVALID_HEADER` for an empty file
 *    or header, a header with an empty or duplicate name, or a missing mapped
 *    required column (each offending column named); `TOO_MANY_ROWS` for more
 *    than `maxRows` data rows (empty rows count). The pass stops early once a
 *    decision is certain.
 * 3. Only a file that passed is parsed again and emitted, record by record, in
 *    data-row order (`sequence` 1, 2, ...):
 *    - `SKIPPED` for an entirely empty row (no characters, or only separators);
 *    - `ROW_REJECTED` (`FIELD_TOO_LONG`, naming the column) when any field has
 *      more than `maxFieldLength` characters (code points);
 *    - `RECORD` otherwise, holding the mapped canonical fields only (other
 *      columns are ignored and not kept, R28.1) and a bounded `rawExcerpt`.
 *
 * Every field is text: nothing is trimmed, cast, evaluated, or interpreted, so
 * formula-like content stays as data (R28.8). Decoding and parsing are
 * incremental (64 KiB chunks), so no copy of the whole file as text is made.
 * Programmer errors (invalid options or mapping, input that is not bytes) throw
 * `TypeError`; file content never makes `parse` throw (R1.5).
 */
import { Readable } from 'node:stream';
import { CsvError, parse } from 'csv-parse';
import type { Options } from 'csv-parse';
import { isValidUtf8, utf8Chunks } from './decode.js';
import { CANONICAL_FIELDS, CsvColumnMappingSchema, REQUIRED_CANONICAL_FIELDS, headerFor } from './schema.js';
import type { CanonicalField, CsvColumnMapping, CsvOptions } from './schema.js';

export type FileRejectReason =
  'FILE_TOO_LARGE' | 'INVALID_ENCODING' | 'MALFORMED_CSV' | 'INVALID_HEADER' | 'TOO_MANY_ROWS';

/** One parsed data row (design: RawRecord). */
export interface RawRecord {
  readonly sourceKind: 'CSV';
  /** One-based data row number (the header is not counted). */
  readonly sequence: number;
  /** Mapped canonical fields only, exact text. */
  readonly fields: Readonly<Partial<Record<CanonicalField, string>>>;
  /** At most `RAW_EXCERPT_MAX` characters, each field cut to `RAW_EXCERPT_FIELD_MAX`. */
  readonly rawExcerpt: string;
}

export type CsvEvent =
  | { readonly kind: 'RECORD'; readonly record: RawRecord }
  | { readonly kind: 'SKIPPED'; readonly sequence: number }
  | {
      readonly kind: 'ROW_REJECTED';
      readonly sequence: number;
      readonly reason: 'FIELD_TOO_LONG';
      /** The source header of the first offending column. */
      readonly column: string;
      readonly rawExcerpt: string;
    }
  | {
      readonly kind: 'FILE_REJECTED';
      readonly reason: FileRejectReason;
      readonly message: string;
      /** For `INVALID_HEADER`: each offending column (source names, `(empty)` for a blank one). */
      readonly columns?: readonly string[];
    };

export interface CsvParser {
  parse(input: Uint8Array, mapping: CsvColumnMapping, opts: CsvOptions): AsyncIterable<CsvEvent>;
}

export const RAW_EXCERPT_MAX = 512;
export const RAW_EXCERPT_FIELD_MAX = 64;

/** Fixed parser options: strict quotes, every value text, nothing trimmed or skipped. */
const PARSE_OPTIONS: Options = {
  delimiter: ',',
  quote: '"',
  escape: '"',
  relax_quotes: false,
  relax_column_count: true, // field-count mismatches are classified here (MALFORMED_CSV)
  skip_empty_lines: false,
  skip_records_with_error: false,
  ltrim: false,
  rtrim: false,
  trim: false,
  cast: false,
  bom: false, // the decoder already stripped it
  columns: false,
};

function assertOptions(opts: CsvOptions): void {
  for (const key of ['maxFileBytes', 'maxRows', 'maxFieldLength'] as const) {
    const value = (opts as Partial<CsvOptions> | undefined)?.[key];
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      throw new TypeError(`${key} must be a positive integer.`);
    }
  }
}

/** Records of `input`, parsed incrementally; throws `CsvError` on a structural error. */
function records(input: Uint8Array): AsyncIterable<string[]> {
  const parser = parse(PARSE_OPTIONS);
  const source = Readable.from(utf8Chunks(input), { objectMode: false });
  source.on('error', (error) => parser.destroy(error));
  source.pipe(parser);
  return parser as AsyncIterable<string[]>;
}

const isEmptyRow = (row: readonly string[]): boolean => row.every((field) => field.length === 0);

/** True when `text` has more than `limit` code points (stops counting early). */
function longerThan(text: string, limit: number): boolean {
  if (text.length <= limit) {
    return false; // code points <= UTF-16 code units
  }
  // Count code points without copying: a high surrogate followed by a low one is one.
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
      }
    }
    count += 1;
    if (count > limit) {
      return true;
    }
  }
  return false;
}

function excerpt(row: readonly string[]): string {
  let out = '';
  for (const [index, field] of row.entries()) {
    const piece = (index === 0 ? '' : ',') + field.slice(0, RAW_EXCERPT_FIELD_MAX);
    if (out.length + piece.length > RAW_EXCERPT_MAX) {
      return out + piece.slice(0, RAW_EXCERPT_MAX - out.length);
    }
    out += piece;
  }
  return out;
}

const shown = (name: string): string => (name.length === 0 ? '(empty)' : name);

/** INVALID_HEADER problems of `header` under `mapping`, or undefined when it is valid. */
function headerProblems(header: readonly string[], mapping: CsvColumnMapping): string[] | undefined {
  if (isEmptyRow(header)) {
    return ['(empty)'];
  }
  const counts = new Map<string, number>();
  for (const name of header) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const problems = new Set<string>();
  for (const [name, count] of counts) {
    if (name.length === 0 || count > 1) {
      problems.add(shown(name));
    }
  }
  for (const field of REQUIRED_CANONICAL_FIELDS) {
    const expected = headerFor(mapping, field);
    if (!counts.has(expected)) {
      problems.add(expected);
    }
  }
  return problems.size === 0 ? undefined : [...problems].sort();
}

type Validation =
  | { readonly ok: true; readonly header: readonly string[] }
  | { readonly ok: false; readonly event: Extract<CsvEvent, { kind: 'FILE_REJECTED' }> };

const rejected = (reason: FileRejectReason, message: string, columns?: readonly string[]): Validation => ({
  ok: false,
  event: Object.freeze({
    kind: 'FILE_REJECTED',
    reason,
    message,
    ...(columns === undefined ? {} : { columns: Object.freeze([...columns]) }),
  }),
});

/** Steps 1 and 2: nothing is emitted unless the whole file passes. */
async function validate(input: Uint8Array, mapping: CsvColumnMapping, opts: CsvOptions): Promise<Validation> {
  if (!isValidUtf8(input)) {
    return rejected('INVALID_ENCODING', 'The file is not valid UTF-8.');
  }
  let header: readonly string[] | undefined;
  let dataRows = 0;
  let headerIssue: string[] | undefined;
  try {
    for await (const row of records(input)) {
      if (header === undefined) {
        header = row;
        headerIssue = headerProblems(row, mapping);
        continue;
      }
      if (row.length !== header.length && !isEmptyRow(row)) {
        return rejected(
          'MALFORMED_CSV',
          `Data row ${dataRows + 1} has a different number of fields than the header.`,
        );
      }
      dataRows += 1;
      if (headerIssue === undefined && dataRows > opts.maxRows) {
        return rejected('TOO_MANY_ROWS', `The file has more than ${opts.maxRows} data rows.`);
      }
    }
  } catch (error) {
    if (error instanceof CsvError) {
      return rejected('MALFORMED_CSV', 'The file is not well-formed CSV.');
    }
    throw error;
  }
  if (header === undefined) {
    return rejected('INVALID_HEADER', 'The file is empty.', ['(empty)']);
  }
  if (headerIssue !== undefined) {
    return rejected('INVALID_HEADER', 'The header row is invalid.', headerIssue);
  }
  return { ok: true, header };
}

async function* events(
  input: Uint8Array,
  mapping: CsvColumnMapping,
  opts: CsvOptions,
): AsyncGenerator<CsvEvent> {
  if (input.length > opts.maxFileBytes) {
    yield Object.freeze({
      kind: 'FILE_REJECTED',
      reason: 'FILE_TOO_LARGE',
      message: `The file is larger than ${opts.maxFileBytes} bytes.`,
    });
    return;
  }
  const checked = await validate(input, mapping, opts);
  if (!checked.ok) {
    yield checked.event;
    return;
  }
  const header = checked.header;
  const positions = CANONICAL_FIELDS.flatMap((field) => {
    const index = header.indexOf(headerFor(mapping, field));
    return index === -1 ? [] : [[field, index] as const];
  });
  let sequence = 0;
  let first = true;
  for await (const row of records(input)) {
    if (first) {
      first = false;
      continue; // the header
    }
    sequence += 1;
    if (isEmptyRow(row)) {
      yield Object.freeze({ kind: 'SKIPPED', sequence });
      continue;
    }
    const tooLong = row.findIndex((field) => longerThan(field, opts.maxFieldLength));
    if (tooLong !== -1) {
      yield Object.freeze({
        kind: 'ROW_REJECTED',
        sequence,
        reason: 'FIELD_TOO_LONG',
        column: shown(header[tooLong] ?? ''),
        rawExcerpt: excerpt(row),
      });
      continue;
    }
    const fields: Partial<Record<CanonicalField, string>> = {};
    for (const [field, index] of positions) {
      fields[field] = row[index] ?? '';
    }
    yield Object.freeze({
      kind: 'RECORD',
      record: Object.freeze({
        sourceKind: 'CSV',
        sequence,
        fields: Object.freeze(fields),
        rawExcerpt: excerpt(row),
      }),
    });
  }
}

export function createCsvParser(): CsvParser {
  return {
    parse: (input, mapping, opts) => {
      if (!(input instanceof Uint8Array)) {
        throw new TypeError('input must be a Uint8Array.');
      }
      assertOptions(opts);
      const parsedMapping = CsvColumnMappingSchema.safeParse(mapping);
      if (!parsedMapping.success) {
        throw new TypeError('mapping must be a valid CsvColumnMapping.');
      }
      return events(input, parsedMapping.data, opts);
    },
  };
}
