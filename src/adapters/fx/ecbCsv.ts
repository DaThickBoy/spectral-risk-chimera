/**
 * Dedicated fixed-format parser for the ECB EXR `csvdata` response (task 10.2;
 * design: ECB adapter rule 4; R4.6, R30.3). No CSV library and no general CSV
 * rules: only this exact format is accepted, and any deviation rejects the WHOLE
 * response as `INVALID_RESPONSE` (nothing is skipped, repaired, or defaulted).
 *
 * Rejected: a body larger than `maxBytes`, not valid UTF-8, or starting with a
 * byte-order mark; a `Content-Type` other than `text/csv` (optionally with
 * `charset=utf-8`); a header other than exactly
 * `KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE`;
 * any quote character; a row without exactly 8 fields (an empty line included);
 * `KEY` other than `EXR.D.<CURRENCY>.EUR.SP00.A`; `FREQ` not `D`, `CURRENCY_DENOM`
 * not `EUR`, `EXR_TYPE` not `SP00`, `EXR_SUFFIX` not `A`; a currency that was not
 * requested; a `TIME_PERIOD` that is not a valid date or is after `asOf`; an
 * `OBS_VALUE` that is not a positive fixed-grammar decimal (empty, exponent,
 * `NaN`, separators rejected); a repeated (currency, date).
 * Accepted: LF or CRLF line endings and one trailing line ending. `OBS_VALUE`
 * text is kept exactly; FxService canonicalizes it (FX rule 9).
 */
import { isIsoDate } from '../../fx/index.js';
import { PositiveDecimalString } from '../../shared/index.js';
import type { DecimalString } from '../../shared/index.js';

export const ECB_CSV_HEADER = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE';

export interface EcbRow {
  /** ISO 4217 code of the quoted currency X (units of X per one EUR). */
  readonly currency: string;
  /** Reference date `YYYY-MM-DD`. */
  readonly date: string;
  /** Exact published `OBS_VALUE` text. */
  readonly value: DecimalString;
}

export interface EcbCsvOptions {
  readonly contentType: string | undefined;
  /** Currencies requested in the query (codes other than EUR). */
  readonly requested: readonly string[];
  /** The query's `endPeriod`. */
  readonly asOf: string;
  readonly maxBytes: number;
}

const CONTENT_TYPE = /^text\/csv(?:\s*;\s*charset\s*=\s*utf-8)?$/i;

const invalid = (): { readonly ok: false; readonly error: 'INVALID_RESPONSE' } => ({
  ok: false,
  error: 'INVALID_RESPONSE',
});

export type EcbCsvResult =
  | { readonly ok: true; readonly value: readonly EcbRow[] }
  | { readonly ok: false; readonly error: 'INVALID_RESPONSE' };

export function parseEcbCsv(body: Uint8Array, options: EcbCsvOptions): EcbCsvResult {
  if (!(body instanceof Uint8Array) || body.length > options.maxBytes) {
    return invalid();
  }
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    return invalid();
  }
  if (options.contentType === undefined || !CONTENT_TYPE.test(options.contentType.trim())) {
    return invalid();
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return invalid();
  }
  if (text.includes('"')) {
    return invalid();
  }
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  // One trailing line ending is accepted: it leaves exactly one empty last element.
  if (lines.length > 1 && lines.at(-1) === '') {
    lines.pop();
  }
  const [header, ...rows] = lines;
  if (header !== ECB_CSV_HEADER) {
    return invalid();
  }
  const requested = new Set(options.requested);
  const seen = new Set<string>();
  const parsed: EcbRow[] = [];
  for (const row of rows) {
    const fields = row.split(',');
    if (fields.length !== 8) {
      return invalid();
    }
    const [key, freq, currency, denom, type, suffix, period, value] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (
      !requested.has(currency) ||
      key !== `EXR.D.${currency}.EUR.SP00.A` ||
      freq !== 'D' ||
      denom !== 'EUR' ||
      type !== 'SP00' ||
      suffix !== 'A' ||
      !isIsoDate(period) ||
      period > options.asOf // fixed-width dates compare chronologically
    ) {
      return invalid();
    }
    const decimal = PositiveDecimalString.safeParse(value);
    if (!decimal.success) {
      return invalid();
    }
    const id = `${currency}|${period}`;
    if (seen.has(id)) {
      return invalid();
    }
    seen.add(id);
    parsed.push(Object.freeze({ currency, date: period, value: decimal.data }));
  }
  return { ok: true, value: Object.freeze(parsed) };
}
