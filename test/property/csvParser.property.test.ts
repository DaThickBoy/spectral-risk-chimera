// Validates: Requirements 1.5, 28.3, 28.8
// Task 7.1 property tests (design: CSV Parser, Implementation).
// - Robustness: arbitrary bytes never make the parser throw; the result is either exactly one
//   FILE_REJECTED, or only row events with consecutive sequence numbers.
// - Field fidelity: any fields (commas, quotes, CR/LF, formula characters, non-ASCII text)
//   written with standard CSV quoting are read back exactly, as text, in order.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REQUIRED_CANONICAL_FIELDS } from '../../src/ingestion/index.js';
import type { CsvEvent } from '../../src/ingestion/index.js';
import { bytes, collect, recordsOf } from '../helpers/csv.js';

const quote = (field: string): string => `"${field.replace(/"/g, '""')}"`;

const fieldArb = fc.string({
  unit: fc.constantFrom('a', 'Z', '0', ',', '"', '\n', '\r', ' ', '=', '+', '-', '@', 'é', '😀', '\t', ';'),
  maxLength: 20,
});

const sequenceOf = (event: CsvEvent): number =>
  event.kind === 'RECORD' ? event.record.sequence : event.kind === 'FILE_REJECTED' ? 0 : event.sequence;

describe('robustness: arbitrary bytes never throw', () => {
  it('one FILE_REJECTED, or row events with sequences 1..n', async () => {
    const header = bytes(`${REQUIRED_CANONICAL_FIELDS.join(',')}\n`);
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 300 }), fc.boolean(), async (tail, withHeader) => {
        const input = withHeader ? new Uint8Array([...header, ...tail]) : tail;
        const events = await collect(input, {}, { maxRows: 50, maxFieldLength: 64 });
        if (events.some((e) => e.kind === 'FILE_REJECTED')) {
          expect(events).toHaveLength(1);
          return;
        }
        expect(events.map(sequenceOf)).toEqual(events.map((_, i) => i + 1));
      }),
      { numRuns: 400 },
    );
  });
});

describe('field fidelity: quoted CSV round trip', () => {
  it('every field is read back exactly as written', async () => {
    const rowArb = fc.array(fieldArb, { minLength: 6, maxLength: 6 });
    await fc.assert(
      fc.asyncProperty(fc.array(rowArb, { minLength: 1, maxLength: 8 }), async (rows) => {
        // Rows whose fields are all empty are SKIPPED by design; keep at least one non-empty field.
        const data = rows.map((row) => (row.every((f) => f.length === 0) ? ['x', ...row.slice(1)] : row));
        const text = [
          REQUIRED_CANONICAL_FIELDS.join(','),
          ...data.map((row) => row.map(quote).join(',')),
        ].join('\r\n');
        const records = recordsOf(await collect(bytes(text)));
        expect(records.map((r) => REQUIRED_CANONICAL_FIELDS.map((f) => r.fields[f]))).toEqual(data);
      }),
      { numRuns: 300 },
    );
  });
});
