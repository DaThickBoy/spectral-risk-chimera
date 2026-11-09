/**
 * Quarantine records for malformed FIX messages (task 18.1; R2.4, R3.3,
 * R28.10, R29.12). One `FIX` quarantine row per rejected message, with reason
 * `FIX_MALFORMED`, a fixed message naming the structural check (never a
 * value), the tag concerned as `columnName`, and the redacted excerpt from the
 * tokenizer. Accepted messages are not touched; the file continues.
 */
import type { QuarantineRecordRow } from '../../persistence/ports.js';
import type { IdGenerator } from '../../shared/index.js';
import type { FixEvent, FixMalformedDetail } from './tokenizer.js';

const DETAIL_TEXT: Readonly<Record<FixMalformedDetail, string>> = {
  BEGIN_STRING_MISSING: 'BeginString (8) is not the first field',
  BODY_LENGTH_MISSING: 'BodyLength (9) is not the second field',
  BODY_LENGTH_INVALID: 'BodyLength (9) is not a non-negative integer',
  BODY_LENGTH_MISMATCH: 'BodyLength (9) does not match the message',
  MSG_TYPE_MISSING: 'MsgType (35) is not the third field',
  CHECKSUM_INVALID: 'CheckSum (10) is not three digits',
  CHECKSUM_MISMATCH: 'CheckSum (10) does not match the message',
  DUPLICATE_HEADER_TAG: 'a header or trailer tag is repeated',
  FIELD_SYNTAX: 'a field is not tag=value with a printable, non-empty value',
  VALUE_TOO_LONG: 'a value exceeds the maximum field length',
  TOO_MANY_FIELDS: 'the message has too many fields',
  TRUNCATED: 'the message ends before its CheckSum (10)',
};

export function fixQuarantineRecords(
  importId: string,
  events: readonly FixEvent[],
  ids: IdGenerator,
  createdAt: string,
): QuarantineRecordRow[] {
  const rows: QuarantineRecordRow[] = [];
  for (const event of events) {
    if (event.kind !== 'MESSAGE_REJECTED') {
      continue;
    }
    rows.push({
      id: ids.next(),
      importId,
      sourceKind: 'FIX',
      sequence: event.sequence,
      reasonCode: event.reason,
      message: `FIX message ${event.sequence} is malformed: ${DETAIL_TEXT[event.detail]}.`,
      ...(event.tag === undefined ? {} : { columnName: String(event.tag) }),
      rawExcerpt: event.rawExcerpt,
      createdAt,
    });
  }
  return rows;
}
