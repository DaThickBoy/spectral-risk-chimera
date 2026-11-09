// Task 7.1: CSV pre-checks and streaming parsing (design: CSV Parser, Implementation).
// Committed fixtures: test/fixtures/csv/. Byte-exact cases (encoding, BOM, chunk boundaries) are
// built inline.
// Tests: AT-CSV-06, AT-CSV-07, AT-CSV-08, AT-CSV-15, AT-CSV-18, AT-CSV-22
// Validates: Requirements 1.1, 1.5, 28.1, 28.3, 28.4, 28.5, 28.6, 28.8
import { describe, expect, it } from 'vitest';
import { DECODE_CHUNK_BYTES, RAW_EXCERPT_MAX, createCsvParser } from '../../../src/ingestion/index.js';
import type { CsvColumnMapping, CsvOptions } from '../../../src/ingestion/index.js';
import { HEADER, OPTS, ROW, bytes, collect, fileRejection, fixture, recordsOf } from '../../helpers/csv.js';

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

describe('parsing valid files (R1.1, R28.1)', () => {
  it('emits one RECORD per data row with mapped canonical fields only, exact text, in order', async () => {
    const events = await collect(fixture('valid-basic.csv'));
    expect(events.map((e) => e.kind)).toEqual(['RECORD', 'RECORD']);
    const [first, second] = recordsOf(events);
    expect(first).toMatchObject({
      sourceKind: 'CSV',
      sequence: 1,
      fields: {
        external_id: 'T-1',
        trade_timestamp: '2026-11-02T14:30:00Z',
        ticker: 'AAA',
        type: 'BUY',
        quantity: '10',
        price: '150.25',
        currency: 'USD',
      },
    });
    // Decimal text is kept exactly (no canonicalization here); the extra "notes" column is not kept.
    expect(second?.fields).toMatchObject({ quantity: '0010.500', price: '45.5' });
    expect(Object.keys(second?.fields ?? {})).not.toContain('notes');
    expect(second?.rawExcerpt).toContain('note, with comma');
  });

  it('renamed columns are mapped (R1.2); the mapped header is required', async () => {
    const csv = 'Date,Symbol,Side,Qty,Px,Ccy\n2026-11-02T14:30:00Z,AAA,BUY,10,1.5,USD\n';
    const mapping: CsvColumnMapping = {
      trade_timestamp: 'Date',
      ticker: 'Symbol',
      type: 'Side',
      quantity: 'Qty',
      price: 'Px',
      currency: 'Ccy',
    };
    expect(recordsOf(await collect(bytes(csv), mapping))[0]?.fields).toEqual({
      trade_timestamp: '2026-11-02T14:30:00Z',
      ticker: 'AAA',
      type: 'BUY',
      quantity: '10',
      price: '1.5',
      currency: 'USD',
    });
    const missing = fileRejection(await collect(bytes(csv), { ...mapping, price: 'Price' }));
    expect(missing).toMatchObject({ reason: 'INVALID_HEADER', columns: ['Price'] });
  });

  it('a header-only file is valid and has no records', async () => {
    expect(await collect(bytes(`${HEADER}\n`))).toEqual([]);
  });

  it('nothing is trimmed: whitespace and case stay as data', async () => {
    const [record] = recordsOf(await collect(bytes(`${HEADER}\n 2026-11-02 , aaa ,buy,1,1,usd\n`)));
    expect(record?.fields).toMatchObject({ trade_timestamp: ' 2026-11-02 ', ticker: ' aaa ', type: 'buy' });
  });
});

describe('quoted, escaped, and multiline fields', () => {
  it('commas, escaped quotes, and line breaks inside quotes stay in one field', async () => {
    const csv = `${HEADER},external_id\n2026-11-02T14:30:00Z,AAA,BUY,10,1.5,USD,"a, ""b""\nline 2\r\nline 3"\n${ROW},x\n`;
    const records = recordsOf(await collect(bytes(csv)));
    expect(records).toHaveLength(2);
    expect(records[0]?.fields.external_id).toBe('a, "b"\nline 2\r\nline 3');
    expect(records[1]).toMatchObject({ sequence: 2, fields: { external_id: 'x' } });
  });

  it('CRLF line endings and a missing final newline are accepted', async () => {
    expect(recordsOf(await collect(bytes(`${HEADER}\r\n${ROW}\r\n${ROW}`)))).toHaveLength(2);
  });

  it.each([
    ['an unclosed quote', `${HEADER}\n"2026-11-02,AAA,BUY,10,1.5,USD\n`],
    [
      'a quote inside an unquoted field (relax_quotes disabled)',
      `${HEADER}\n2026-11-02,A"A,BUY,10,1.5,USD\n`,
    ],
    ['text after a closing quote', `${HEADER}\n"2026-11-02"x,AAA,BUY,10,1.5,USD\n`],
    ['a row with too few fields', `${HEADER}\n${ROW}\n2026-11-02,AAA,BUY\n`],
    ['a row with too many fields', `${HEADER}\n${ROW},extra\n`],
  ])('%s is a file-level MALFORMED_CSV with no record emitted', async (_name, csv) => {
    const rejection = fileRejection(await collect(bytes(csv)));
    expect(rejection.reason).toBe('MALFORMED_CSV');
    expect(rejection.message.length).toBeGreaterThan(0);
  });
});

describe('AT-CSV-06: malformed or duplicate headers are rejected with INVALID_HEADER', () => {
  it('a duplicate header name is named', async () => {
    expect(fileRejection(await collect(fixture('duplicate-header.csv')))).toMatchObject({
      reason: 'INVALID_HEADER',
      columns: ['ticker'],
    });
  });

  it('an empty header name, a missing required column, and duplicates are all named', async () => {
    const rejection = fileRejection(await collect(bytes('trade_timestamp,,type,type,price,currency\n')));
    expect(rejection).toMatchObject({
      reason: 'INVALID_HEADER',
      columns: ['(empty)', 'quantity', 'ticker', 'type'],
    });
  });

  it('a duplicate of an unmapped extra column is also rejected', async () => {
    expect(fileRejection(await collect(bytes(`${HEADER},notes,notes\n`)))).toMatchObject({
      columns: ['notes'],
    });
  });

  it('an entirely empty header row is INVALID_HEADER', async () => {
    expect(fileRejection(await collect(bytes(',,,\n')))).toMatchObject({
      reason: 'INVALID_HEADER',
      columns: ['(empty)'],
    });
  });
});

describe('AT-CSV-07: invalid UTF-8 is rejected; UTF-8 with BOM is accepted', () => {
  it('a BOM is stripped, so the first header name matches exactly', async () => {
    const withBom = concat(new Uint8Array([0xef, 0xbb, 0xbf]), bytes(`${HEADER}\n${ROW}\n`));
    expect(recordsOf(await collect(withBom))[0]?.fields.trade_timestamp).toBe('2026-11-02T14:30:00Z');
  });

  it.each([
    ['a lone 0xFF byte', new Uint8Array([0xff])],
    ['an overlong encoding', new Uint8Array([0xc0, 0x80])],
    ['a truncated multi-byte sequence at the end', new Uint8Array([0xe2, 0x82])],
    ['an unpaired surrogate encoding', new Uint8Array([0xed, 0xa0, 0x80])],
  ])('%s anywhere gives INVALID_ENCODING and no record, even after valid rows', async (_name, bad) => {
    const file = concat(bytes(`${HEADER}\n${ROW}\n${ROW}\n`), bad);
    expect(fileRejection(await collect(file)).reason).toBe('INVALID_ENCODING');
  });

  it('a multi-byte character split across the 64 KiB decode boundary is decoded correctly', async () => {
    const prefix = `${HEADER},external_id\n2026-11-02T14:30:00Z,AAA,BUY,1,1,USD,`;
    const padding = 'x'.repeat(DECODE_CHUNK_BYTES - prefix.length - 1);
    const csv = bytes(`${prefix}${padding}€\n`); // "€" is 3 bytes and starts 1 byte before the boundary
    const events = await collect(csv, {}, { maxFieldLength: 100_000 });
    expect(recordsOf(events)[0]?.fields.external_id).toBe(`${padding}€`);
  });
});

describe('AT-CSV-08: oversized file and too many rows are rejected', () => {
  it('a file of exactly maxFileBytes is accepted; one byte more is FILE_TOO_LARGE', async () => {
    const file = bytes(`${HEADER}\n${ROW}\n`);
    expect(recordsOf(await collect(file, {}, { maxFileBytes: file.length }))).toHaveLength(1);
    expect(fileRejection(await collect(file, {}, { maxFileBytes: file.length - 1 })).reason).toBe(
      'FILE_TOO_LARGE',
    );
  });

  it('the size check comes first: an oversized file with invalid bytes is FILE_TOO_LARGE', async () => {
    const file = new Uint8Array(100).fill(0xff);
    expect(fileRejection(await collect(file, {}, { maxFileBytes: 99 })).reason).toBe('FILE_TOO_LARGE');
  });

  it('exactly maxRows data rows are accepted; one more is TOO_MANY_ROWS with no record emitted', async () => {
    const rows = (n: number) => bytes(`${HEADER}\n${Array.from({ length: n }, () => ROW).join('\n')}\n`);
    expect(recordsOf(await collect(rows(3), {}, { maxRows: 3 }))).toHaveLength(3);
    expect(fileRejection(await collect(rows(4), {}, { maxRows: 3 })).reason).toBe('TOO_MANY_ROWS');
  });

  it('empty rows count toward maxRows', async () => {
    expect(fileRejection(await collect(bytes(`${HEADER}\n${ROW}\n\n\n`), {}, { maxRows: 2 })).reason).toBe(
      'TOO_MANY_ROWS',
    );
  });
});

describe('AT-CSV-15 and AT-CSV-18: empty rows, long fields, formula-like content', () => {
  it('the fixture: formulas stay as text, a long field rejects its row, empty rows are skipped', async () => {
    const events = await collect(fixture('formula-and-long.csv'));
    expect(events.map((e) => e.kind)).toEqual(['RECORD', 'SKIPPED', 'ROW_REJECTED', 'SKIPPED', 'RECORD']);
    expect(
      events.map((e) => ('sequence' in e ? e.sequence : e.kind === 'RECORD' ? e.record.sequence : 0)),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(recordsOf(events)[0]?.fields).toEqual({
      trade_timestamp: '2026-11-02T14:30:00Z',
      ticker: '=HYPERLINK("http://evil.example")',
      type: 'BUY',
      quantity: '+1',
      price: '-2+3',
      currency: '@SUM(A1)',
      external_id: "=cmd|' /C calc'!A0",
    });
    expect(events[2]).toMatchObject({
      kind: 'ROW_REJECTED',
      reason: 'FIELD_TOO_LONG',
      column: 'external_id',
    });
    expect(recordsOf(events)[1]?.sequence).toBe(5);
  });

  it('a field of exactly maxFieldLength code points is accepted; one more is FIELD_TOO_LONG', async () => {
    const at = (value: string) => bytes(`${HEADER},external_id\n${ROW},${value}\n`);
    // Limit 20: the row's longest other field (the 20-character timestamp) is exactly at the limit.
    expect(recordsOf(await collect(at('a'.repeat(20)), {}, { maxFieldLength: 20 }))).toHaveLength(1);
    expect((await collect(at('a'.repeat(21)), {}, { maxFieldLength: 20 }))[0]).toMatchObject({
      kind: 'ROW_REJECTED',
      column: 'external_id',
    });
    // Code points, not UTF-16 units: 20 astral characters are 40 units but 20 code points.
    expect(recordsOf(await collect(at('😀'.repeat(20)), {}, { maxFieldLength: 20 }))).toHaveLength(1);
    expect((await collect(at('😀'.repeat(21)), {}, { maxFieldLength: 20 }))[0]?.kind).toBe('ROW_REJECTED');
  });

  it('the field-length limit applies to unmapped columns too', async () => {
    const events = await collect(bytes(`${HEADER},notes\n${ROW},${'n'.repeat(300)}\n`));
    expect(events[0]).toMatchObject({ kind: 'ROW_REJECTED', column: 'notes' });
  });
});

describe('AT-CSV-22: empty or unreadable files give a descriptive error without crashing', () => {
  it.each([
    ['an empty file', new Uint8Array()],
    ['a BOM only', new Uint8Array([0xef, 0xbb, 0xbf])],
  ])('%s is INVALID_HEADER "The file is empty."', async (_name, file) => {
    expect(fileRejection(await collect(file))).toMatchObject({
      reason: 'INVALID_HEADER',
      message: 'The file is empty.',
      columns: ['(empty)'],
    });
  });

  it('binary content gives a descriptive file-level error, never an exception', async () => {
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const rejection = fileRejection(await collect(binary));
    expect(rejection.reason).toBe('INVALID_ENCODING');
    expect(rejection.message).toBe('The file is not valid UTF-8.');
  });
});

describe('adversarial input', () => {
  it('NUL and control characters stay as data inside fields', async () => {
    const [record] = recordsOf(await collect(bytes(`${HEADER},external_id\n${ROW},a\u0000b\u0007c\n`)));
    expect(record?.fields.external_id).toBe('a\u0000b\u0007c');
  });

  it('a single huge field (1 MiB) rejects only its row and the excerpt stays bounded', async () => {
    const huge = 'z'.repeat(1024 * 1024);
    const events = await collect(bytes(`${HEADER},external_id\n${ROW},${huge}\n${ROW},ok\n`));
    expect(events.map((e) => e.kind)).toEqual(['ROW_REJECTED', 'RECORD']);
    const rejected = events[0];
    expect(rejected?.kind === 'ROW_REJECTED' && rejected.rawExcerpt.length).toBeLessThanOrEqual(
      RAW_EXCERPT_MAX,
    );
  });

  it('raw excerpts are at most 512 characters with each field cut to 64', async () => {
    const wide = Array.from({ length: 40 }, (_, i) => `c${i}`).join(',');
    const values = Array.from({ length: 40 }, () => 'v'.repeat(100)).join(',');
    const events = await collect(
      bytes(`${HEADER},${wide}\n${ROW},${values}\n`),
      {},
      { maxFieldLength: 1000 },
    );
    const excerpt = recordsOf(events)[0]?.rawExcerpt ?? '';
    expect(excerpt.length).toBe(RAW_EXCERPT_MAX);
    expect(excerpt).not.toMatch(/v{65}/);
  });

  it('the result is lazy: nothing is parsed until iteration starts', () => {
    expect(() => createCsvParser().parse(new Uint8Array([0xff]), {}, OPTS)).not.toThrow();
  });
});

describe('programmer errors throw TypeError; content never does', () => {
  it.each([
    ['input that is not bytes', 'text' as unknown as Uint8Array, {}, OPTS],
    ['a zero row limit', bytes(HEADER), {}, { ...OPTS, maxRows: 0 }],
    ['a fractional field limit', bytes(HEADER), {}, { ...OPTS, maxFieldLength: 1.5 }],
    ['an unknown mapping key', bytes(HEADER), { nope: 'x' } as unknown as CsvColumnMapping, OPTS],
    ['two fields mapped to one column', bytes(HEADER), { ticker: 'X', currency: 'X' }, OPTS],
  ])('%s', (_name, input, mapping, opts) => {
    expect(() => createCsvParser().parse(input, mapping, opts as CsvOptions)).toThrow(TypeError);
  });
});
