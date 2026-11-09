// Test helpers for task 7.1 (CSV parsing).
import { readFileSync } from 'node:fs';
import { createCsvParser } from '../../src/ingestion/index.js';
import type { CsvColumnMapping, CsvEvent, CsvOptions } from '../../src/ingestion/index.js';

/** TEST options: the documented class O defaults unless overridden. */
export const OPTS: CsvOptions = { maxFileBytes: 10 * 1024 * 1024, maxRows: 100_000, maxFieldLength: 256 };

export const HEADER = 'trade_timestamp,ticker,type,quantity,price,currency';
export const ROW = '2026-11-02T14:30:00Z,AAA,BUY,10,150.25,USD';

export const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
export const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(`test/fixtures/csv/${name}`));

export async function collect(
  input: Uint8Array,
  mapping: CsvColumnMapping = {},
  opts: Partial<CsvOptions> = {},
): Promise<CsvEvent[]> {
  const out: CsvEvent[] = [];
  for await (const event of createCsvParser().parse(input, mapping, { ...OPTS, ...opts })) {
    out.push(event);
  }
  return out;
}

export function fileRejection(events: readonly CsvEvent[]): Extract<CsvEvent, { kind: 'FILE_REJECTED' }> {
  const [only] = events;
  if (events.length !== 1 || only?.kind !== 'FILE_REJECTED') {
    throw new Error(`expected exactly one FILE_REJECTED, got ${events.map((e) => e.kind).join(', ')}`);
  }
  return only;
}

export const recordsOf = (events: readonly CsvEvent[]) =>
  events.flatMap((event) => (event.kind === 'RECORD' ? [event.record] : []));
