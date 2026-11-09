// Task 7.3: transaction keys, occurrence counting, deduplication, sourceId, supported currencies
// (design: Normalizer and Deduper). Expected keys are SHA-256 of hand-written key text (node:crypto).
// Tests: AT-CSV-04, AT-CSV-13, AT-CSV-14, AT-FX-06 (import part)
// Validates: Requirements 28.11, 28.12, 28.13, 28.14, 28.18, 30.2
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalFields, normalizeRows, transactionKey } from '../../../src/ingestion/index.js';
import type { NormalizeContext } from '../../../src/ingestion/index.js';
import { brandDecimalString } from '../../../src/shared/index.js';
import { FILE_SHA, SOURCE_ID, validRow } from '../../helpers/importRows.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const ctx = (overrides: Partial<NormalizeContext> = {}): NormalizeContext => ({
  portfolioId: 'pf-1',
  source: 'CSV',
  fileSha256: FILE_SHA,
  supportedCurrencies: new Set(['USD', 'EUR']),
  ledgerKeys: new Set(),
  ...overrides,
});

const FIELDS = '2026-11-02T14:30:00.000Z|AAA|BUY|10|150.25|USD';

describe('transactionKey (R28.11)', () => {
  it('without external_id: CNT, portfolio, canonical fields, occurrence', () => {
    expect(canonicalFields(validRow())).toBe(FIELDS);
    expect(transactionKey('pf-1', 'CSV', validRow(), 1)).toBe(sha(`CNT|pf-1|${FIELDS}|1`));
    expect(transactionKey('pf-1', 'CSV', validRow(), 2)).toBe(sha(`CNT|pf-1|${FIELDS}|2`));
  });

  it('with external_id: EXT, portfolio, source, external id (other fields ignored)', () => {
    const row = validRow({ externalId: 'ext-9', quantity: brandDecimalString('99') });
    expect(transactionKey('pf-1', 'BROKER', row, 1)).toBe(sha('EXT|pf-1|BROKER|ext-9'));
  });

  it('differs by portfolio and source', () => {
    const row = validRow({ externalId: 'e' });
    expect(transactionKey('pf-1', 'A', row, 1)).not.toBe(transactionKey('pf-2', 'A', row, 1));
    expect(transactionKey('pf-1', 'A', row, 1)).not.toBe(transactionKey('pf-1', 'B', row, 1));
  });
});

describe('normalizeRows', () => {
  it('two identical rows in one file are both kept with occurrence 1 and 2 (AT-CSV-13)', () => {
    const out = normalizeRows([validRow({ sequence: 1 }), validRow({ sequence: 2 })], ctx());
    expect(out.map((o) => o.kind)).toEqual(['CANDIDATE', 'CANDIDATE']);
    expect(out.map((o) => (o.kind === 'CANDIDATE' ? o.candidate.transactionKey : ''))).toEqual([
      sha(`CNT|pf-1|${FIELDS}|1`),
      sha(`CNT|pf-1|${FIELDS}|2`),
    ]);
  });

  it('occurrence counts only identical canonical fields, in file order', () => {
    const other = validRow({ sequence: 2, quantity: brandDecimalString('11') });
    const out = normalizeRows([validRow({ sequence: 1 }), other, validRow({ sequence: 3 })], ctx());
    const keys = out.map((o) => (o.kind === 'CANDIDATE' ? o.candidate.transactionKey : ''));
    expect(keys[1]).toBe(sha('CNT|pf-1|2026-11-02T14:30:00.000Z|AAA|BUY|11|150.25|USD|1'));
    expect(keys[2]).toBe(sha(`CNT|pf-1|${FIELDS}|2`));
  });

  it('every candidate carries sourceId CSV:<sha> and sourceSequence = row number (R28.18)', () => {
    const out = normalizeRows([validRow({ sequence: 4 })], ctx());
    expect(out[0]).toMatchObject({
      kind: 'CANDIDATE',
      candidate: { sourceId: SOURCE_ID, sourceSequence: 4 },
    });
  });

  it('a key already in the ledger is a duplicate (AT-CSV-04)', () => {
    const key = sha(`CNT|pf-1|${FIELDS}|1`);
    const out = normalizeRows(
      [validRow({ sequence: 1 }), validRow({ sequence: 2 })],
      ctx({ ledgerKeys: new Set([key]) }),
    );
    expect(out[0]).toEqual({ kind: 'DUPLICATE', sequence: 1, transactionKey: key });
    expect(out[1]?.kind).toBe('CANDIDATE'); // occurrence 2 is not in the ledger
  });

  it('external_id deduplicates within the file and against the ledger (AT-CSV-14)', () => {
    const a = validRow({ sequence: 1, externalId: 'x-1' });
    const b = validRow({ sequence: 2, externalId: 'x-1', quantity: brandDecimalString('3') });
    const out = normalizeRows([a, b], ctx());
    expect(out.map((o) => o.kind)).toEqual(['CANDIDATE', 'DUPLICATE']);
    const again = normalizeRows([b], ctx({ ledgerKeys: new Set([sha('EXT|pf-1|CSV|x-1')]) }));
    expect(again.map((o) => o.kind)).toEqual(['DUPLICATE']);
  });

  it('a row with external_id does not advance the occurrence count of identical rows', () => {
    const out = normalizeRows([validRow({ sequence: 1, externalId: 'x' }), validRow({ sequence: 2 })], ctx());
    expect(out[1]).toMatchObject({ candidate: { transactionKey: sha(`CNT|pf-1|${FIELDS}|1`) } });
  });

  it('a currency outside fx.supportedCurrencies is UNSUPPORTED_CURRENCY (AT-FX-06)', () => {
    const out = normalizeRows([validRow({ currency: 'GBP' }), validRow({ sequence: 2 })], ctx());
    expect(out.map((o) => o.kind)).toEqual(['UNSUPPORTED_CURRENCY', 'CANDIDATE']);
  });
});
