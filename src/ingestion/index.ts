// Public API of src/ingestion/. ingestion/ imports only shared/, config/, audit/, portfolio/ types,
// and persistence ports.
export { DECODE_CHUNK_BYTES, isValidUtf8, utf8Chunks } from './csv/decode.js';
export {
  CANONICAL_FIELDS,
  CanonicalField,
  CsvColumnMappingSchema,
  REQUIRED_CANONICAL_FIELDS,
  headerFor,
} from './csv/schema.js';
export type { CsvColumnMapping, CsvOptions } from './csv/schema.js';
export { RAW_EXCERPT_FIELD_MAX, RAW_EXCERPT_MAX, createCsvParser } from './csv/csvParser.js';
export type { CsvEvent, CsvParser, FileRejectReason, RawRecord } from './csv/csvParser.js';
export { normalizeTradeTimestamp } from './csv/timestamps.js';
export { validateRow } from './csv/rowValidation.js';
export type { RowError, RowResult, RowValidationOptions, ValidRow } from './csv/rowValidation.js';
export { canonicalFields, normalizeRows, transactionKey } from './normalize.js';
export type { Candidate, NormalizeContext, NormalizeOutcome } from './normalize.js';
export { applyChronology } from './chronology.js';
export type { ChronologyRejection, ChronologyResult, OversellPolicy } from './chronology.js';
export { prepareImport } from './prepareImport.js';
export { MAX_FIELDS_PER_MESSAGE, tokenizeFix } from './fix/tokenizer.js';
export type {
  FixDelimiter,
  FixEvent,
  FixField,
  FixMalformedDetail,
  FixMessage,
  FixTokenizeResult,
  FixTokenizerOptions,
} from './fix/tokenizer.js';
export { FIX_MAPPING_TABLE } from './fix/mapping.js';
export type { FixMappingTable } from './fix/mapping.js';
export { fixQuarantineRecords } from './fix/quarantine.js';
export type { ImportInput, ImportSettings, Prepared, RowRejection } from './prepareImport.js';
export { createImportService } from './importService.js';
export type {
  ImportFileInput,
  ImportService,
  ImportServiceDependencies,
  ImportSummary,
} from './importService.js';
