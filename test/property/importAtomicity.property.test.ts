// Validates: Requirements 28.15, 28.16, 28.17, 5.4
// Property 21: Import atomicity (task 7.6; design: Correctness Properties).
// Fault injection against every adapter (in-memory, SQLite memory, SQLite file; OD-12), not fast-check.
// For fixed files, the import commit is failed at every write position, including the final
// publish step. Each time the ledger, summaries, quarantine, positions, and audit log are exactly
// as before the import except for the separate IMPORT_FAILED audit entry, and the status is
// FAILED. Positions change only after a successful commit.
import { describe, expect, it } from 'vitest';
import { fileOf } from '../helpers/importArbs.js';
import { useCaseHarness } from '../helpers/importService.js';
import { ADAPTERS } from '../helpers/persistenceAdapters.js';

const SEED = fileOf(['x-0,2026-11-01T10:00:00Z,AAA,BUY,10,1,USD']);

const FILES: Record<string, string> = {
  'valid rows only': fileOf([
    ',2026-11-02T10:00:00Z,AAA,BUY,5,2,USD',
    ',2026-11-02T10:00:00Z,AAA,BUY,5,2,USD',
    ',2026-11-03T10:00:00Z,BBB,BUY,1,3,EUR',
  ]),
  'mixed rows': fileOf([
    ',2026-11-02T10:00:00Z,AAA,SELL,4,2,USD',
    ',2026-11-02T10:00:00Z,AAA,HOLD,4,2,USD',
    ',,,,,,',
    ',2026-11-03T10:00:00Z,AAA,SELL,50,2,USD',
    'x-0,2026-11-01T10:00:00Z,AAA,BUY,10,1,USD',
    ',2026-11-03T10:00:00Z,CCC,BUY,1,1,GBP',
  ]),
};

/** Runs: 0 portfolio lookup, 1 ledger read, 2 import commit. */
const COMMIT_RUN = 2;

describe.each(ADAPTERS)('Property 21: Import atomicity (%s)', (_adapter, createUow) => {
  for (const [name, file] of Object.entries(FILES)) {
    it(`${name}: a commit failure at any write leaves no partial import`, async () => {
      const probe = useCaseHarness({ uow: createUow() });
      await probe.runCsv(SEED);
      await probe.useCase.run({
        portfolioId: 'pf-1',
        fileName: 'probe.csv',
        bytes: new TextEncoder().encode(file),
        columns: {},
      });
      // The import commit is the attempt before the position rebuild; count its writes.
      const probeImport = probe.inner.snapshot().imports.at(-1);
      expect(probeImport?.status).toMatch(/^COMMITTED/);
      // transactions + summary + (quarantine record + audit entry) per rejected row + IMPORT_COMMITTED
      const writeCount = (probeImport?.accepted ?? 0) + 1 + 2 * (probeImport?.rejected ?? 0) + 1;
      expect(writeCount).toBeGreaterThan(2);

      for (let atWrite = 0; atWrite <= writeCount; atWrite += 1) {
        const h = useCaseHarness({ uow: createUow() });
        await h.runCsv(SEED);
        const before = h.inner.snapshot();
        h.uow.armRun(COMMIT_RUN, atWrite);
        const result = await h.runCsv(file);
        expect(result.status).toBe('DONE');
        if (result.status !== 'DONE') {
          return;
        }
        expect(result.summary).toMatchObject({
          status: 'FAILED',
          failureReason: 'COMMIT_FAILED',
          persisted: false,
        });
        expect(result).not.toHaveProperty('positions');
        const after = h.inner.snapshot();
        expect(after.transactions).toEqual(before.transactions);
        expect(after.imports).toEqual(before.imports);
        expect(after.quarantine).toEqual(before.quarantine);
        expect(after.positions).toEqual(before.positions);
        expect(after.audit.slice(0, before.audit.length)).toEqual(before.audit);
        expect(after.audit.slice(before.audit.length).map((a) => [a.type, a.details.reason])).toEqual([
          ['IMPORT_FAILED', 'COMMIT_FAILED'],
        ]);
      }
    });
  }

  it('the write count used above matches the commit attempt', async () => {
    const h = useCaseHarness({ uow: createUow() });
    await h.runCsv(SEED);
    await h.importCsv(FILES['mixed rows'] ?? '');
    const imported = h.inner.snapshot().imports.at(-1);
    expect(h.inner.lastAttempt?.outcome).toBe('COMMITTED');
    expect(h.inner.lastAttempt?.writes).toHaveLength(
      (imported?.accepted ?? 0) + 1 + 2 * (imported?.rejected ?? 0) + 1,
    );
  });
});
