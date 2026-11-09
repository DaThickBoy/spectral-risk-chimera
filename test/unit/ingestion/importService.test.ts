// Task 7.5: the import service (design: Import pipeline, Quarantine and Audit Log, Import summary).
// Uses the real CSV parser and the in-memory unit of work; settings are TEST values.
// Atomicity is shown against the fake here; AT-CSV-12 runs against the SQLite adapter in
// test/integration/sqlitePersistence.test.ts (OD-12 resolved).
// Tests: AT-CSV-04, AT-CSV-05, AT-CSV-14, AT-CSV-15, AT-CSV-16, AT-CSV-24, AT-AUD-01, AT-FX-06 (import part)
// Validates: Requirements 1.4, 3.2, 3.3, 3.4, 3.5, 22.1, 28.9, 28.10, 28.13, 28.15, 28.16, 28.20
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bytes } from '../../helpers/csv.js';
import { csv } from '../../helpers/importRows.js';
import { NOW, PF, TEST_SECRET_VALUE, importHarness } from '../../helpers/importService.js';

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

const MIXED = csv(
  '2026-11-02T14:30:00Z,AAA,BUY,10,150.2500,USD', // 1 valid
  '2026-11-02T14:31:00Z,AAA,HOLD,1,1,USD', // 2 UNSUPPORTED_TRANSACTION_TYPE
  ',,,,,', // 3 skipped
  '2026-11-02T14:32:00Z,bbb,BUY,1e5,1,USD', // 4 INVALID_TICKER + MALFORMED_NUMBER
  '2026-11-02T14:33:00Z,BBB,BUY,2,45.5,EUR', // 5 valid
  '2026-11-02T14:34:00Z,CCC,BUY,2,1,GBP', // 6 UNSUPPORTED_CURRENCY (not supported)
  '2026-11-02T14:35:00Z,AAA,SELL,11,1,USD', // 7 OVERSELL
);

describe('importFile: classification and storage', () => {
  it('isolates and audits invalid rows while valid rows are committed (AT-CSV-05, AT-FX-06)', async () => {
    const h = importHarness();
    const summary = await h.importCsv(MIXED);
    expect(summary).toMatchObject({
      status: 'COMMITTED_WITH_REJECTIONS',
      totalRows: 7,
      accepted: 2,
      rejected: 4,
      duplicates: 0,
      skipped: 1,
      persisted: true,
    });
    const snap = h.inner.snapshot();
    expect(snap.transactions.map((t) => [t.sourceSequence, t.ticker, t.quantity, t.price])).toEqual([
      [1, 'AAA', '10', '150.25'],
      [5, 'BBB', '2', '45.5'],
    ]);
    expect(snap.quarantine.map((q) => [q.sequence, q.reasonCode, q.columnName])).toEqual([
      [2, 'UNSUPPORTED_TRANSACTION_TYPE', 'type'],
      [4, 'INVALID_TICKER', 'ticker'],
      [6, 'UNSUPPORTED_CURRENCY', 'currency'],
      [7, 'OVERSELL', 'quantity'],
    ]);
    // Row 4 keeps both errors: the primary reason and every message.
    expect(snap.quarantine[1]?.message).toContain('ticker');
    expect(snap.quarantine[1]?.message).toContain('quantity');
    const rejectedAudit = snap.audit.filter((a) => a.type === 'ROW_REJECTED');
    expect(rejectedAudit.map((a) => [a.category, a.details.sequence, a.details.reason])).toEqual([
      ['VALIDATION', '2', 'UNSUPPORTED_TRANSACTION_TYPE'],
      ['VALIDATION', '4', 'INVALID_TICKER'],
      ['VALIDATION', '6', 'UNSUPPORTED_CURRENCY'],
      ['VALIDATION', '7', 'OVERSELL'],
    ]);
    expect(rejectedAudit[1]?.details.reasons).toBe('INVALID_TICKER,MALFORMED_NUMBER');
    expect(snap.audit.filter((a) => a.type === 'IMPORT_COMMITTED')).toHaveLength(1);
  });

  it('the summary carries counts, timestamp, and the file SHA-256 (AT-CSV-16, AT-CSV-15)', async () => {
    const h = importHarness();
    const summary = await h.importCsv(MIXED);
    expect(summary.fileSha256).toBe(sha(bytes(MIXED)));
    expect(summary.importedAt).toBe(NOW);
    expect(summary.fileName).toBe('trades.csv');
    expect(summary.accepted + summary.rejected + summary.duplicates + summary.skipped).toBe(
      summary.totalRows,
    );
    const [stored] = h.inner.snapshot().imports;
    expect(stored).toEqual({
      id: summary.importId,
      fileName: 'trades.csv',
      fileSha256: summary.fileSha256,
      importedAt: NOW,
      totalRows: 7,
      accepted: 2,
      rejected: 4,
      duplicates: 0,
      skipped: 1,
      status: 'COMMITTED_WITH_REJECTIONS',
    });
  });

  it('transactions retain source, trade timestamp, and the source file hash (AT-AUD-01)', async () => {
    const h = importHarness();
    const summary = await h.importCsv(MIXED, { source: 'BROKER-X' });
    for (const tx of h.inner.snapshot().transactions) {
      expect(tx).toMatchObject({
        portfolioId: PF,
        source: 'BROKER-X',
        sourceId: `CSV:${summary.fileSha256}`,
        importId: summary.importId,
        createdAt: NOW,
      });
    }
    expect(h.inner.snapshot().transactions[0]?.tradeTimestamp).toBe('2026-11-02T14:30:00.000Z');
  });

  it('a file with only valid rows is COMMITTED', async () => {
    const h = importHarness();
    const summary = await h.importCsv(csv('2026-11-02T14:30:00Z,AAA,BUY,10,1,USD'));
    expect(summary.status).toBe('COMMITTED');
    expect(summary).not.toHaveProperty('failureReason');
  });

  it('redacts secrets and bounds quarantine excerpts', async () => {
    const h = importHarness();
    await h.importCsv(csv(`2026-11-02T14:30:00Z,AAA,BUY,${TEST_SECRET_VALUE},1,USD`));
    const [record] = h.inner.snapshot().quarantine;
    expect(record?.rawExcerpt).not.toContain(TEST_SECRET_VALUE);
    expect(record?.rawExcerpt.length).toBeLessThanOrEqual(512);
    expect(JSON.stringify(h.inner.snapshot().audit)).not.toContain(TEST_SECRET_VALUE);
  });
});

describe('importFile: duplicates', () => {
  it('importing the same file twice creates no duplicate transactions (AT-CSV-04)', async () => {
    const h = importHarness();
    const text = csv('2026-11-02T14:30:00Z,AAA,BUY,10,1,USD', '2026-11-02T14:30:00Z,AAA,BUY,10,1,USD');
    const first = await h.importCsv(text);
    const second = await h.importCsv(text);
    expect(first).toMatchObject({ accepted: 2, duplicates: 0 });
    expect(second).toMatchObject({ accepted: 0, duplicates: 2, status: 'COMMITTED' });
    expect(h.inner.snapshot().transactions).toHaveLength(2);
    expect(h.inner.snapshot().imports).toHaveLength(2);
  });

  it('external_id deduplicates across files (AT-CSV-14)', async () => {
    const h = importHarness();
    const header = 'external_id,trade_timestamp,ticker,type,quantity,price,currency';
    await h.importCsv(`${header}\nx-1,2026-11-02T14:30:00Z,AAA,BUY,10,1,USD\n`);
    const second = await h.importCsv(`${header}\nx-1,2026-11-05T09:00:00Z,AAA,BUY,99,2,USD\n`);
    expect(second).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(h.inner.snapshot().transactions.map((t) => t.quantity)).toEqual(['10']);
  });

  it('a row rejected in 7.4 does not make a later row with the same external_id a duplicate (R28.12)', async () => {
    const h = importHarness();
    const header = 'external_id,trade_timestamp,ticker,type,quantity,price,currency';
    const summary = await h.importCsv(
      [
        header,
        'x-1,2026-11-04T10:00:00Z,AAA,BUY,1,1,EUR', // 1: CURRENCY_MISMATCH (USD established by row 2)
        ',2026-11-02T10:00:00Z,AAA,BUY,1,1,USD', // 2: accepted
        'x-1,2026-11-03T10:00:00Z,AAA,BUY,2,1,USD', // 3: accepted, not a duplicate of row 1
        'x-1,2026-11-05T10:00:00Z,AAA,BUY,3,1,USD', // 4: duplicate of row 3
      ].join('\n') + '\n',
    );
    expect(summary).toMatchObject({ accepted: 2, rejected: 1, duplicates: 1 });
    expect(h.inner.snapshot().transactions.map((t) => t.sourceSequence)).toEqual([2, 3]);
    expect(h.inner.snapshot().quarantine.map((q) => [q.sequence, q.reasonCode])).toEqual([
      [1, 'CURRENCY_MISMATCH'],
    ]);
  });

  it('concurrent imports of one portfolio run one at a time, so the second sees the first', async () => {
    const h = importHarness();
    const text = csv('2026-11-02T14:30:00Z,AAA,BUY,10,1,USD');
    const [a, b] = await Promise.all([h.importCsv(text), h.importCsv(text)]);
    expect([a.accepted, b.accepted]).toEqual([1, 0]);
    expect(b.duplicates).toBe(1);
    expect(h.inner.snapshot().transactions).toHaveLength(1);
  });

  it('a SELL in a second file uses the committed ledger', async () => {
    const h = importHarness();
    await h.importCsv(csv('2026-11-02T14:30:00Z,AAA,BUY,10,1,USD'));
    const sell = await h.importCsv(
      csv('2026-11-03T14:30:00Z,AAA,SELL,10,1,USD', '2026-11-04T14:30:00Z,AAA,SELL,1,1,USD'),
    );
    expect(sell).toMatchObject({ accepted: 1, rejected: 1 });
  });
});

describe('importFile: refusals and failures', () => {
  it('is refused without import.oversellPolicy, before any row is read (AT-CSV-24)', async () => {
    const h = importHarness({ policy: 'MISSING' });
    const summary = await h.importCsv(MIXED);
    expect(summary).toMatchObject({
      status: 'FAILED',
      failureReason: 'CONFIG_MISSING: import.oversellPolicy',
      totalRows: 0,
      accepted: 0,
      persisted: true,
    });
    const snap = h.inner.snapshot();
    expect(snap.transactions).toEqual([]);
    expect(snap.quarantine).toEqual([]);
    expect(snap.imports.map((i) => i.status)).toEqual(['FAILED']);
    expect(snap.audit.map((a) => [a.category, a.type, a.details.key])).toEqual([
      ['IMPORT', 'IMPORT_REFUSED', 'import.oversellPolicy'],
    ]);
  });

  it('a file-level rejection stores a FAILED summary and one audit entry, no rows', async () => {
    const h = importHarness();
    const summary = await h.importCsv('');
    expect(summary).toMatchObject({
      status: 'FAILED',
      failureReason: 'INVALID_HEADER',
      totalRows: 0,
      persisted: true,
    });
    const snap = h.inner.snapshot();
    expect(snap.transactions).toEqual([]);
    expect(snap.audit.map((a) => [a.type, a.details.reason])).toEqual([['FILE_REJECTED', 'INVALID_HEADER']]);
  });

  it('a commit failure leaves nothing from the import and is audited separately (R28.15, R28.16)', async () => {
    const h = importHarness();
    h.uow.armRun(1, 0); // run 0 reads the ledger; run 1 is the import commit
    const summary = await h.importCsv(MIXED);
    expect(summary).toMatchObject({
      status: 'FAILED',
      failureReason: 'COMMIT_FAILED',
      persisted: false,
      accepted: 0,
    });
    const snap = h.inner.snapshot();
    expect(snap.transactions).toEqual([]);
    expect(snap.imports).toEqual([]);
    expect(snap.quarantine).toEqual([]);
    expect(snap.audit.map((a) => [a.type, a.details.reason])).toEqual([['IMPORT_FAILED', 'COMMIT_FAILED']]);
  });

  it('rejects invalid input shapes as programmer errors', () => {
    const h = importHarness();
    expect(() => h.importCsv('x', { portfolioId: '' })).toThrow(TypeError);
    expect(() => h.importCsv('x', { bytes: 'x' as unknown as Uint8Array })).toThrow(TypeError);
  });
});
