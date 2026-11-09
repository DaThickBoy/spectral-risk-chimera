/**
 * Structural FIX tokenizer (task 18.1; design: FIX Parser; R2.1, R2.4, R29.12,
 * R33.2). OD-9 is open: there is no field mapping, no supported message set,
 * and no transaction is produced here.
 *
 * `tokenizeFix(input, opts)` splits a FIX log into messages and each message
 * into ordered `tag -> value` fields, working on bytes:
 * - Fields end with the configured delimiter (`fix.delimiter`): SOH (0x01) or
 *   `|` for logs. Line breaks (CR, LF) between messages are skipped; a line
 *   break inside a message truncates it.
 * - A message is `8=BeginString`, `9=BodyLength`, `35=MsgType`, body fields,
 *   and `10=CheckSum` last. Tags are 1 to 9 digits without a leading zero;
 *   values are non-empty printable ASCII (0x20 to 0x7E) of at most
 *   `maxFieldLength` characters. Tags 8, 9, 35, and 10 appear once.
 * - BodyLength must equal the byte count from the field after `9=` up to and
 *   including the delimiter before `10=`. CheckSum must be three digits equal
 *   to the byte sum, modulo 256, of everything before `10=`. With the `|`
 *   delimiter each delimiter counts as SOH (0x01), because logs replace SOH
 *   with `|` after the checksum was computed.
 * - Every structural failure is `FIX_MALFORMED` with a fixed detail code; the
 *   tokenizer then resynchronises at the next `8=` that starts a line or
 *   follows a delimiter, so one bad message never stops the file (R2.4).
 * - File-level limits (checked first): `FILE_TOO_LARGE` above `maxFileBytes`,
 *   `TOO_MANY_ROWS` above `maxRows` messages. A message has at most
 *   `MAX_FIELDS_PER_MESSAGE` fields.
 * - `rawExcerpt` is bounded (512 characters, 64 per field), shows the delimiter
 *   as `|`, replaces non-printable bytes with `?`, and never contains the value
 *   of tag 1 (Account), which is replaced by `[REDACTED]` (R29.12).
 * Messages never echo values; programmer errors (invalid options) throw.
 */
import { RAW_EXCERPT_FIELD_MAX, RAW_EXCERPT_MAX } from '../csv/csvParser.js';

export type FixDelimiter = 'SOH' | '|';

export interface FixTokenizerOptions {
  /** `fix.delimiter`. */
  readonly delimiter: FixDelimiter;
  /** `import.maxFileBytes`. */
  readonly maxFileBytes: number;
  /** `import.maxRows`: messages at most. */
  readonly maxRows: number;
  /** `import.maxFieldLength`: characters per value at most. */
  readonly maxFieldLength: number;
}

export const MAX_FIELDS_PER_MESSAGE = 512;

export type FixMalformedDetail =
  | 'BEGIN_STRING_MISSING'
  | 'BODY_LENGTH_MISSING'
  | 'BODY_LENGTH_INVALID'
  | 'BODY_LENGTH_MISMATCH'
  | 'MSG_TYPE_MISSING'
  | 'CHECKSUM_INVALID'
  | 'CHECKSUM_MISMATCH'
  | 'DUPLICATE_HEADER_TAG'
  | 'FIELD_SYNTAX'
  | 'VALUE_TOO_LONG'
  | 'TOO_MANY_FIELDS'
  | 'TRUNCATED';

export interface FixField {
  /** Tag number: an identifier, not a financial value. */
  readonly tag: number;
  /** Exact value text. */
  readonly value: string;
}

export interface FixMessage {
  /** One-based message number in the file. */
  readonly sequence: number;
  readonly beginString: string;
  readonly msgType: string;
  /** Every field in order, including 8, 9, 35, and 10. */
  readonly fields: readonly FixField[];
  readonly rawExcerpt: string;
}

export type FixEvent =
  | { readonly kind: 'MESSAGE'; readonly message: FixMessage }
  | {
      readonly kind: 'MESSAGE_REJECTED';
      readonly sequence: number;
      readonly reason: 'FIX_MALFORMED';
      readonly detail: FixMalformedDetail;
      /** The tag concerned, when one is (for example 9 for BodyLength). */
      readonly tag?: number;
      readonly rawExcerpt: string;
    };

export type FixTokenizeResult =
  | { readonly kind: 'MESSAGES'; readonly events: readonly FixEvent[] }
  | {
      readonly kind: 'FILE_REJECTED';
      readonly reason: 'FILE_TOO_LARGE' | 'TOO_MANY_ROWS';
      readonly message: string;
    };

const SOH = 0x01;
const PIPE = 0x7c;
const EQUALS = 0x3d;
const CR = 0x0d;
const LF = 0x0a;
const ZERO = 0x30;
const NINE = 0x39;
const HEADER_TAGS = new Set([8, 9, 35, 10]);

const isDigit = (byte: number): boolean => byte >= ZERO && byte <= NINE;
const isLineBreak = (byte: number | undefined): boolean => byte === CR || byte === LF;

type Parsed =
  | { readonly ok: true; readonly end: number; readonly message: Omit<FixMessage, 'sequence' | 'rawExcerpt'> }
  | { readonly ok: false; readonly detail: FixMalformedDetail; readonly tag?: number };

/** The integer of a digit-only string: a tag, byte count, or checksum, never a financial value. */
function digitsValue(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    n = n * 10 + (text.charCodeAt(i) - ZERO);
  }
  return n;
}

/** ASCII text of `bytes[from, to)`; callers have checked the bytes are printable ASCII. */
function ascii(bytes: Uint8Array, from: number, to: number): string {
  let text = '';
  for (let i = from; i < to; i += 1) {
    text += String.fromCharCode(bytes[i] ?? 0);
  }
  return text;
}

function parseMessage(bytes: Uint8Array, start: number, delim: number, maxFieldLength: number): Parsed {
  const fields: FixField[] = [];
  let p = start;
  let bodyStart = -1;
  let bodyLength = -1;
  while (true) {
    // Tag: 1 to 9 digits, no leading zero, then '='.
    const tagStart = p;
    while (p < bytes.length && isDigit(bytes[p] ?? 0)) {
      p += 1;
    }
    const tagLength = p - tagStart;
    if (p >= bytes.length || isLineBreak(bytes[p])) {
      return { ok: false, detail: 'TRUNCATED' };
    }
    if (bytes[p] !== EQUALS || tagLength === 0 || tagLength > 9 || bytes[tagStart] === ZERO) {
      return { ok: false, detail: 'FIELD_SYNTAX' };
    }
    const tag = digitsValue(ascii(bytes, tagStart, p)); // an identifier of at most 9 digits
    p += 1;
    // Value: printable ASCII up to the delimiter.
    const valueStart = p;
    while (p < bytes.length && bytes[p] !== delim) {
      const byte = bytes[p] ?? 0;
      if (isLineBreak(byte)) {
        return { ok: false, detail: 'TRUNCATED', tag };
      }
      if (byte < 0x20 || byte > 0x7e) {
        return { ok: false, detail: 'FIELD_SYNTAX', tag };
      }
      p += 1;
    }
    if (p >= bytes.length) {
      return { ok: false, detail: 'TRUNCATED', tag };
    }
    const valueLength = p - valueStart;
    if (valueLength === 0) {
      return { ok: false, detail: 'FIELD_SYNTAX', tag };
    }
    if (valueLength > maxFieldLength) {
      return { ok: false, detail: 'VALUE_TOO_LONG', tag };
    }
    const value = ascii(bytes, valueStart, p);
    p += 1; // past the delimiter
    const position = fields.length; // index, not a financial value
    if (position === 0 && tag !== 8) {
      return { ok: false, detail: 'BEGIN_STRING_MISSING', tag: 8 };
    }
    if (position === 1) {
      if (tag !== 9) {
        return { ok: false, detail: 'BODY_LENGTH_MISSING', tag: 9 };
      }
      if (!/^(0|[1-9]\d{0,8})$/.test(value)) {
        return { ok: false, detail: 'BODY_LENGTH_INVALID', tag: 9 };
      }
      bodyLength = digitsValue(value); // a byte count
      bodyStart = p;
    }
    if (position === 2 && tag !== 35) {
      return { ok: false, detail: 'MSG_TYPE_MISSING', tag: 35 };
    }
    if (position > 2 && HEADER_TAGS.has(tag) && tag !== 10) {
      return { ok: false, detail: 'DUPLICATE_HEADER_TAG', tag };
    }
    fields.push({ tag, value });
    if (tag === 10) {
      const checksumStart = tagStart;
      if (checksumStart - bodyStart !== bodyLength) {
        return { ok: false, detail: 'BODY_LENGTH_MISMATCH', tag: 9 };
      }
      if (!/^\d{3}$/.test(value)) {
        return { ok: false, detail: 'CHECKSUM_INVALID', tag: 10 };
      }
      let sum = 0; // byte sum modulo 256: integers, not financial values
      for (let i = start; i < checksumStart; i += 1) {
        const byte = bytes[i] ?? 0;
        sum = (sum + (byte === delim ? SOH : byte)) % 256;
      }
      if (sum !== digitsValue(value)) {
        return { ok: false, detail: 'CHECKSUM_MISMATCH', tag: 10 };
      }
      const beginString = fields[0]?.value ?? '';
      const msgType = fields[2]?.value ?? '';
      return { ok: true, end: p, message: { beginString, msgType, fields } };
    }
    if (fields.length >= MAX_FIELDS_PER_MESSAGE) {
      return { ok: false, detail: 'TOO_MANY_FIELDS' };
    }
  }
}

/** The next message start after `from`: `8=` at a line start or after a delimiter. */
function resync(bytes: Uint8Array, from: number, delim: number): number {
  for (let q = from < 1 ? 1 : from; q + 1 < bytes.length; q += 1) {
    const before = bytes[q - 1];
    if (bytes[q] === 0x38 && bytes[q + 1] === EQUALS && (before === delim || isLineBreak(before))) {
      return q;
    }
  }
  return bytes.length;
}

/** Bounded, redacted excerpt of `bytes[from, to)`; tag 1 (Account) values never appear. */
function excerpt(bytes: Uint8Array, from: number, to: number, delim: number): string {
  let out = '';
  let segment = '';
  const flush = (last: boolean): boolean => {
    const redacted = segment.startsWith('1=') ? '1=[REDACTED]' : segment.slice(0, RAW_EXCERPT_FIELD_MAX);
    const piece = redacted + (last ? '' : '|');
    segment = '';
    if (out.length + piece.length > RAW_EXCERPT_MAX) {
      out += piece.slice(0, RAW_EXCERPT_MAX - out.length);
      return false;
    }
    out += piece;
    return true;
  };
  for (let i = from; i < to; i += 1) {
    const byte = bytes[i] ?? 0;
    if (isLineBreak(byte)) {
      break;
    }
    if (byte === delim) {
      if (!flush(false)) {
        return out;
      }
      continue;
    }
    segment += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '?';
  }
  if (segment.length > 0) {
    flush(true);
  }
  return out;
}

function assertOptions(opts: FixTokenizerOptions): void {
  if (opts.delimiter !== 'SOH' && opts.delimiter !== '|') {
    throw new TypeError('delimiter must be SOH or |.');
  }
  for (const key of ['maxFileBytes', 'maxRows', 'maxFieldLength'] as const) {
    if (!Number.isSafeInteger(opts[key]) || opts[key] <= 0) {
      throw new TypeError(`${key} must be a positive integer.`);
    }
  }
}

export function tokenizeFix(input: Uint8Array, opts: FixTokenizerOptions): FixTokenizeResult {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError('input must be bytes.');
  }
  assertOptions(opts);
  if (input.length > opts.maxFileBytes) {
    return { kind: 'FILE_REJECTED', reason: 'FILE_TOO_LARGE', message: 'The file exceeds the size limit.' };
  }
  const delim = opts.delimiter === 'SOH' ? SOH : PIPE;
  const events: FixEvent[] = [];
  let pos = 0;
  let sequence = 0; // message count, not a financial value
  while (pos < input.length) {
    if (isLineBreak(input[pos])) {
      pos += 1;
      continue;
    }
    sequence += 1;
    if (sequence > opts.maxRows) {
      return { kind: 'FILE_REJECTED', reason: 'TOO_MANY_ROWS', message: 'The file has too many messages.' };
    }
    const start = pos;
    const parsed = parseMessage(input, start, delim, opts.maxFieldLength);
    if (parsed.ok) {
      events.push({
        kind: 'MESSAGE',
        message: { sequence, ...parsed.message, rawExcerpt: excerpt(input, start, parsed.end, delim) },
      });
      pos = parsed.end;
      continue;
    }
    const next = resync(input, start + 1, delim);
    events.push({
      kind: 'MESSAGE_REJECTED',
      sequence,
      reason: 'FIX_MALFORMED',
      detail: parsed.detail,
      ...(parsed.tag === undefined ? {} : { tag: parsed.tag }),
      rawExcerpt: excerpt(input, start, next, delim),
    });
    pos = next;
  }
  return { kind: 'MESSAGES', events };
}
