/**
 * Row validation (task 7.2; design: CSV Parser; R1.2, R3.1, R28.1, R28.2, R28.7,
 * AT-CSV-09, AT-CSV-17, AT-CSV-23).
 *
 * Each canonical field of a `RawRecord` (7.1) is checked independently, so every
 * invalid field produces exactly one row error with the row number, the source
 * column name, and a reason code:
 *
 * | Field | Rule | Reason |
 * |---|---|---|
 * | required field empty | non-empty text | `MISSING_REQUIRED_FIELD` |
 * | `trade_timestamp` | ISO 8601 with zone, or a date in `import.defaultTimezone` | `INVALID_DATE` |
 * | `ticker` | shared `TickerSchema` (fixed pattern) | `INVALID_TICKER` |
 * | `type` | exactly `BUY` or `SELL` | `UNSUPPORTED_TRANSACTION_TYPE` |
 * | `quantity`, `price` | fixed decimal grammar and > 0 | `MALFORMED_NUMBER` |
 * | `currency` | known ISO 4217 code | `UNSUPPORTED_CURRENCY` |
 * | `portfolio_id` | absent, empty, or equal to the import's portfolio | `PORTFOLIO_MISMATCH` |
 *
 * Nothing is normalized except the timestamp (to the fixed UTC form) and the
 * decimals, which become Canonical Decimal Strings with the same value (R4.3).
 * There is no trimming or case folding, so " AAA" or "buy" is rejected rather
 * than repaired. An empty `external_id` counts as absent. Unknown columns never
 * reach this point (7.1 keeps mapped canonical fields only).
 */
import type { RejectReason } from '../../persistence/ports.js';
import { DECIMAL_TEXT_PATTERN, d, isKnownCurrency, isTicker, toCanonical } from '../../shared/index.js';
import type { DecimalString } from '../../shared/index.js';
import type { RawRecord } from './csvParser.js';
import { REQUIRED_CANONICAL_FIELDS, headerFor } from './schema.js';
import type { CanonicalField, CsvColumnMapping } from './schema.js';
import { normalizeTradeTimestamp } from './timestamps.js';

export interface ValidRow {
  readonly sequence: number;
  readonly externalId?: string;
  /** `YYYY-MM-DDTHH:mm:ss.sssZ`. */
  readonly tradeTimestamp: string;
  readonly ticker: string;
  readonly type: 'BUY' | 'SELL';
  /** Canonical Decimal Strings, > 0. */
  readonly quantity: DecimalString;
  readonly price: DecimalString;
  readonly currency: string;
  readonly rawExcerpt: string;
}

export interface RowError {
  readonly sequence: number;
  /** The source column name (after mapping). */
  readonly column: string;
  readonly reason: RejectReason;
  readonly message: string;
}

export type RowResult =
  | { readonly ok: true; readonly row: ValidRow }
  | { readonly ok: false; readonly errors: readonly RowError[]; readonly rawExcerpt: string };

export interface RowValidationOptions {
  readonly mapping: CsvColumnMapping;
  readonly portfolioId: string;
  /** `import.defaultTimezone`; date-only timestamps are `INVALID_DATE` without it. */
  readonly defaultTimezone?: string;
}

const MESSAGES: Readonly<Record<string, string>> = {
  MISSING_REQUIRED_FIELD: 'is required',
  INVALID_DATE: 'must be an ISO 8601 timestamp with a time zone, or a date with import.defaultTimezone set',
  INVALID_TICKER: 'must match the ticker pattern ^[A-Z0-9][A-Z0-9.-]{0,14}$',
  UNSUPPORTED_TRANSACTION_TYPE: 'must be BUY or SELL',
  MALFORMED_NUMBER: 'must be a positive decimal without exponent',
  UNSUPPORTED_CURRENCY: 'must be an ISO 4217 currency code',
  PORTFOLIO_MISMATCH: 'must be empty or equal to the import portfolio',
};

/** A positive decimal as a Canonical Decimal String, or undefined. */
function positiveDecimal(text: string): DecimalString | undefined {
  if (!DECIMAL_TEXT_PATTERN.test(text)) {
    return undefined;
  }
  const value = d(text);
  return value.greaterThan(0) ? toCanonical(value) : undefined;
}

export function validateRow(record: RawRecord, opts: RowValidationOptions): RowResult {
  const errors: RowError[] = [];
  const fail = (field: CanonicalField, reason: RejectReason): undefined => {
    const column = headerFor(opts.mapping, field);
    errors.push({
      sequence: record.sequence,
      column,
      reason,
      message: `${column} ${MESSAGES[reason] ?? 'is invalid'}.`,
    });
    return undefined;
  };
  const value = (field: CanonicalField): string | undefined => {
    const text = record.fields[field] ?? '';
    if (text.length === 0) {
      return REQUIRED_CANONICAL_FIELDS.includes(field) ? fail(field, 'MISSING_REQUIRED_FIELD') : undefined;
    }
    return text;
  };

  const rawTimestamp = value('trade_timestamp');
  const tradeTimestamp =
    rawTimestamp === undefined
      ? undefined
      : (normalizeTradeTimestamp(rawTimestamp, opts.defaultTimezone) ??
        fail('trade_timestamp', 'INVALID_DATE'));
  const rawTicker = value('ticker');
  const ticker =
    rawTicker === undefined ? undefined : isTicker(rawTicker) ? rawTicker : fail('ticker', 'INVALID_TICKER');
  const rawType = value('type');
  const type =
    rawType === undefined
      ? undefined
      : rawType === 'BUY' || rawType === 'SELL'
        ? rawType
        : fail('type', 'UNSUPPORTED_TRANSACTION_TYPE');
  const rawQuantity = value('quantity');
  const quantity =
    rawQuantity === undefined
      ? undefined
      : (positiveDecimal(rawQuantity) ?? fail('quantity', 'MALFORMED_NUMBER'));
  const rawPrice = value('price');
  const price =
    rawPrice === undefined ? undefined : (positiveDecimal(rawPrice) ?? fail('price', 'MALFORMED_NUMBER'));
  const rawCurrency = value('currency');
  const currency =
    rawCurrency === undefined
      ? undefined
      : /^[A-Z]{3}$/.test(rawCurrency) && isKnownCurrency(rawCurrency)
        ? rawCurrency
        : fail('currency', 'UNSUPPORTED_CURRENCY');
  const portfolio = value('portfolio_id');
  if (portfolio !== undefined && portfolio !== opts.portfolioId) {
    fail('portfolio_id', 'PORTFOLIO_MISMATCH');
  }
  const externalId = value('external_id');

  if (
    errors.length > 0 ||
    tradeTimestamp === undefined ||
    ticker === undefined ||
    type === undefined ||
    quantity === undefined ||
    price === undefined ||
    currency === undefined
  ) {
    return { ok: false, errors: Object.freeze(errors), rawExcerpt: record.rawExcerpt };
  }
  return {
    ok: true,
    row: Object.freeze({
      sequence: record.sequence,
      ...(externalId === undefined ? {} : { externalId }),
      tradeTimestamp,
      ticker,
      type,
      quantity,
      price,
      currency,
      rawExcerpt: record.rawExcerpt,
    }),
  };
}
