// Task 18.1: structural FIX tokenizer on synthetic messages (no field mapping; OD-9 open).
// No AT-FIX test is claimed, because the supported set is not approved. These tests exercise only
// the structural parts of R2.1 and R2.4, so the coverage report keeps R2 as blocked by OD-9.
// Validates: Requirements 28.10, 29.12
import { describe, expect, it } from 'vitest';
import { FIX_MAPPING_TABLE, fixQuarantineRecords, tokenizeFix } from '../../../src/ingestion/index.js';
import type { FixDelimiter, FixEvent } from '../../../src/ingestion/index.js';
import { InMemoryUnitOfWork } from '../../../src/persistence/index.js';
import { sequentialIds } from '../../../src/shared/index.js';

const OPTS = { delimiter: 'SOH' as FixDelimiter, maxFileBytes: 1_000_000, maxRows: 1000, maxFieldLength: 64 };
const SOH = '\x01';

/**
 * A message with a correct BodyLength and CheckSum, computed here independently: the body is
 * everything after `9=n<SOH>` up to the checksum field; the checksum is the byte sum of the
 * SOH-delimited text before `10=`, modulo 256.
 */
function fixMessage(
  body: readonly [number, string][],
  options: {
    begin?: string;
    delimiter?: FixDelimiter;
    bodyLength?: (n: number) => string;
    checksum?: (n: number) => string;
  } = {},
): string {
  const bodyText = body.map(([tag, value]) => `${tag}=${value}${SOH}`).join('');
  const length = Buffer.byteLength(bodyText, 'latin1');
  const head = `8=${options.begin ?? 'FIX.4.4'}${SOH}9=${options.bodyLength?.(length) ?? String(length)}${SOH}`;
  const beforeChecksum = head + bodyText;
  let sum = 0;
  for (const byte of Buffer.from(beforeChecksum, 'latin1')) sum = (sum + byte) % 256;
  const checksum = options.checksum?.(sum) ?? String(sum).padStart(3, '0');
  const text = `${beforeChecksum}10=${checksum}${SOH}`;
  return options.delimiter === '|' ? text.replaceAll(SOH, '|') : text;
}

const EXEC: [number, string][] = [
  [35, '8'],
  [49, 'SENDER'],
  [56, 'TARGET'],
  [1, 'ACCT-SECRET-123'],
  [17, 'EXEC-1'],
  [55, 'AAA'],
  [54, '1'],
  [32, '10'],
  [31, '100.25'],
  [15, 'USD'],
  [60, '20261106-14:30:00.000'],
];

const bytes = (text: string): Uint8Array => Buffer.from(text, 'latin1');
const run = (text: string, opts = OPTS) => {
  const result = tokenizeFix(bytes(text), opts);
  if (result.kind !== 'MESSAGES') throw new Error(result.reason);
  return result.events;
};
const kinds = (events: readonly FixEvent[]) =>
  events.map((e) => (e.kind === 'MESSAGE' ? `MESSAGE:${e.message.sequence}` : `${e.detail}:${e.sequence}`));

describe('delimiters and tag -> value parsing', () => {
  it('SOH: concatenated and line-separated messages parse in order with every field', () => {
    const one = fixMessage(EXEC);
    const two = fixMessage([
      [35, 'D'],
      [11, 'ORD-1'],
    ]);
    const events = run(`${one}${two}\r\n${one}\n`);
    expect(kinds(events)).toEqual(['MESSAGE:1', 'MESSAGE:2', 'MESSAGE:3']);
    const first = events[0];
    expect(first?.kind === 'MESSAGE' && first.message).toMatchObject({
      beginString: 'FIX.4.4',
      msgType: '8',
      fields: expect.arrayContaining([
        { tag: 55, value: 'AAA' },
        { tag: 31, value: '100.25' },
      ]),
    });
    expect(first?.kind === 'MESSAGE' && first.message.fields.map((f) => f.tag)).toEqual([
      8, 9, 35, 49, 56, 1, 17, 55, 54, 32, 31, 15, 60, 10,
    ]);
  });

  it('| logs: the checksum counts each | as SOH; one message per line', () => {
    const line = fixMessage(EXEC, { delimiter: '|' });
    const events = run(`${line}\n${line}\n`, { ...OPTS, delimiter: '|' });
    expect(kinds(events)).toEqual(['MESSAGE:1', 'MESSAGE:2']);
  });

  it('the delimiter must match the configuration: an SOH message read as | is malformed', () => {
    const events = run(fixMessage(EXEC), { ...OPTS, delimiter: '|' });
    expect(events).toEqual([expect.objectContaining({ kind: 'MESSAGE_REJECTED', reason: 'FIX_MALFORMED' })]);
  });

  it('values are kept as exact text (no trimming or number conversion)', () => {
    const events = run(
      fixMessage([
        [35, '8'],
        [31, '0100.2500'],
        [58, ' padded '],
      ]),
    );
    const message = events[0]?.kind === 'MESSAGE' ? events[0].message : undefined;
    expect(message?.fields.find((f) => f.tag === 31)?.value).toBe('0100.2500');
    expect(message?.fields.find((f) => f.tag === 58)?.value).toBe(' padded ');
  });
});

describe('BodyLength and CheckSum checks give FIX_MALFORMED', () => {
  it.each([
    ['BodyLength one too small', { bodyLength: (n: number) => String(n - 1) }, 'BODY_LENGTH_MISMATCH', 9],
    ['BodyLength one too large', { bodyLength: (n: number) => String(n + 1) }, 'BODY_LENGTH_MISMATCH', 9],
    ['BodyLength not a number', { bodyLength: () => 'abc' }, 'BODY_LENGTH_INVALID', 9],
    ['BodyLength with a sign', { bodyLength: (n: number) => `+${n}` }, 'BODY_LENGTH_INVALID', 9],
    ['BodyLength with a leading zero', { bodyLength: (n: number) => `0${n}` }, 'BODY_LENGTH_INVALID', 9],
    [
      'CheckSum off by one',
      { checksum: (s: number) => String((s + 1) % 256).padStart(3, '0') },
      'CHECKSUM_MISMATCH',
      10,
    ],
    ['CheckSum of two digits', { checksum: (s: number) => String(s % 100) }, 'CHECKSUM_INVALID', 10],
    [
      'CheckSum of four digits',
      { checksum: (s: number) => `0${String(s).padStart(3, '0')}` },
      'CHECKSUM_INVALID',
      10,
    ],
  ])('%s', (_name, options, detail, tag) => {
    expect(run(fixMessage(EXEC, options))).toEqual([
      expect.objectContaining({ kind: 'MESSAGE_REJECTED', reason: 'FIX_MALFORMED', detail, tag }),
    ]);
  });

  it('a changed body byte is caught by the checksum, not silently accepted', () => {
    const text = fixMessage(EXEC).replace('55=AAA', '55=AAB');
    expect(run(text)).toEqual([expect.objectContaining({ detail: 'CHECKSUM_MISMATCH' })]);
  });
});

describe('header and field structure', () => {
  it.each([
    ['no BeginString first', `9=5${SOH}35=8${SOH}10=000${SOH}`, 'BEGIN_STRING_MISSING'],
    ['no BodyLength second', `8=FIX.4.4${SOH}35=8${SOH}10=000${SOH}`, 'BODY_LENGTH_MISSING'],
    ['no MsgType third', `8=FIX.4.4${SOH}9=5${SOH}49=X${SOH}10=000${SOH}`, 'MSG_TYPE_MISSING'],
    [
      'a repeated MsgType',
      fixMessage([
        [35, '8'],
        [35, 'D'],
      ]),
      'DUPLICATE_HEADER_TAG',
    ],
    [
      'an empty value',
      fixMessage([
        [35, '8'],
        [55, ''],
      ]),
      'FIELD_SYNTAX',
    ],
    ['a tag with a leading zero', fixMessage([[35, '8']]).replace(`${SOH}35=`, `${SOH}035=`), 'FIELD_SYNTAX'],
    ['a non-numeric tag', `8=FIX.4.4${SOH}9=5${SOH}35=8${SOH}AB=1${SOH}10=000${SOH}`, 'FIELD_SYNTAX'],
    [
      'a control byte in a value',
      fixMessage([
        [35, '8'],
        [58, 'a\x02b'],
      ]),
      'FIELD_SYNTAX',
    ],
    [
      'a value over maxFieldLength',
      fixMessage([
        [35, '8'],
        [58, 'x'.repeat(65)],
      ]),
      'VALUE_TOO_LONG',
    ],
    ['no CheckSum before the end', `8=FIX.4.4${SOH}9=5${SOH}35=8${SOH}`, 'TRUNCATED'],
    ['a line break inside a message', `8=FIX.4.4${SOH}9=5${SOH}35=8\n${SOH}10=000${SOH}`, 'TRUNCATED'],
  ])('%s', (_name, text, detail) => {
    expect(run(text)[0]).toMatchObject({ kind: 'MESSAGE_REJECTED', reason: 'FIX_MALFORMED', detail });
  });

  it('a value of exactly maxFieldLength is accepted', () => {
    expect(
      kinds(
        run(
          fixMessage([
            [35, '8'],
            [58, 'x'.repeat(64)],
          ]),
        ),
      ),
    ).toEqual(['MESSAGE:1']);
  });

  it('more than MAX_FIELDS_PER_MESSAGE fields is TOO_MANY_FIELDS', () => {
    const many = Array.from({ length: 600 }, (_, i): [number, string] => [5000 + i, 'v']);
    expect(run(fixMessage([[35, '8'], ...many]))[0]).toMatchObject({ detail: 'TOO_MANY_FIELDS' });
  });
});

describe('invalid messages never stop the file', () => {
  it('bad messages are rejected with reasons; the tokenizer resynchronises at the next message', () => {
    const good = fixMessage(EXEC);
    const badChecksum = fixMessage(EXEC, { checksum: (s) => String((s + 7) % 256).padStart(3, '0') });
    const truncated = `8=FIX.4.4${SOH}9=12${SOH}35=8${SOH}55=AA`;
    const events = run(`${good}\n${badChecksum}\n${truncated}\n${good}${good}`);
    expect(kinds(events)).toEqual([
      'MESSAGE:1',
      'CHECKSUM_MISMATCH:2',
      'TRUNCATED:3',
      'MESSAGE:4',
      'MESSAGE:5',
    ]);
  });

  it('a malformed SOH message followed directly by another resynchronises at its 8=', () => {
    const bad = fixMessage(EXEC, { bodyLength: (n) => String(n + 3) });
    expect(kinds(run(`${bad}${fixMessage(EXEC)}`))).toEqual(['BODY_LENGTH_MISMATCH:1', 'MESSAGE:2']);
  });

  it('quarantine rows: FIX source, FIX_MALFORMED, a fixed message, the tag, and no Account value', () => {
    const bad = fixMessage(EXEC, { checksum: () => '999' });
    const events = run(`${fixMessage(EXEC)}\n${bad}\n`);
    const rows = fixQuarantineRecords('imp-1', events, sequentialIds('q'), '2026-11-08T12:00:00.000Z');
    expect(rows).toEqual([
      {
        id: 'q-1',
        importId: 'imp-1',
        sourceKind: 'FIX',
        sequence: 2,
        reasonCode: 'FIX_MALFORMED',
        message: 'FIX message 2 is malformed: CheckSum (10) does not match the message.',
        columnName: '10',
        rawExcerpt: expect.stringContaining('1=[REDACTED]|17=EXEC-1|55=AAA'),
        createdAt: '2026-11-08T12:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain('ACCT-SECRET-123');
    // The rows are storable as they are.
    const uow = new InMemoryUnitOfWork();
    uow.run((tx) => {
      for (const row of rows) tx.quarantine.insert(row);
    });
    expect(uow.snapshot().quarantine).toHaveLength(1);
  });

  it('accepted messages also never expose the Account value in their excerpt', () => {
    const [event] = run(fixMessage(EXEC));
    expect(event?.kind === 'MESSAGE' && event.message.rawExcerpt).toContain('1=[REDACTED]');
    expect(JSON.stringify(event)).toContain('ACCT-SECRET-123'); // the field itself is data for 18.2
    expect(event?.kind === 'MESSAGE' && event.message.rawExcerpt).not.toContain('ACCT-SECRET-123');
  });

  it('excerpts are bounded to 512 characters and 64 per field', () => {
    const long = Array.from({ length: 40 }, (_, i): [number, string] => [6000 + i, 'y'.repeat(60)]);
    const [event] = run(fixMessage([[35, '8'], ...long]), { ...OPTS, maxFieldLength: 100 });
    const text = event?.kind === 'MESSAGE' ? event.message.rawExcerpt : '';
    expect(text.length).toBe(512);
  });
});

describe('file limits and options', () => {
  it('FILE_TOO_LARGE above maxFileBytes, before any parsing', () => {
    expect(tokenizeFix(bytes(fixMessage(EXEC)), { ...OPTS, maxFileBytes: 10 })).toMatchObject({
      kind: 'FILE_REJECTED',
      reason: 'FILE_TOO_LARGE',
    });
  });

  it('TOO_MANY_ROWS above maxRows messages', () => {
    const two = `${fixMessage(EXEC)}\n${fixMessage(EXEC)}\n`;
    expect(tokenizeFix(bytes(two), { ...OPTS, maxRows: 2 }).kind).toBe('MESSAGES');
    expect(tokenizeFix(bytes(two + fixMessage(EXEC)), { ...OPTS, maxRows: 2 })).toMatchObject({
      reason: 'TOO_MANY_ROWS',
    });
  });

  it('an empty file has no messages', () => {
    expect(run('')).toEqual([]);
    expect(run('\r\n\n')).toEqual([]);
  });

  it.each([
    [{ ...OPTS, delimiter: ';' as FixDelimiter }],
    [{ ...OPTS, maxRows: 0 }],
    [{ ...OPTS, maxFieldLength: 1.5 }],
  ])('invalid options throw TypeError', (opts) => {
    expect(() => tokenizeFix(bytes(''), opts)).toThrow(TypeError);
  });

  it('the mapping table is empty while OD-9 is open', () => {
    expect(FIX_MAPPING_TABLE).toEqual({ beginStrings: [], msgTypes: [], execTypes: [] });
    expect(Object.isFrozen(FIX_MAPPING_TABLE)).toBe(true);
  });
});
