// Validates: Requirements 28.11, 28.12, 28.13, 28.14
// Property 18: Import idempotency (task 7.6; design: Correctness Properties).
// Importing the same generated file any number of times yields the same ledger as importing it
// once; every later import accepts nothing and reports every non-rejected row as a duplicate
// (R28.13), including each row the first import accepted or found duplicate; later imports agree
// with each other. Identical rows in one file both persist (occurrence 1 and 2).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fileLinesArb, fileOf, lineOf, tradeArb } from '../helpers/importArbs.js';
import { importHarness } from '../helpers/importService.js';

const ledgerOf = (h: ReturnType<typeof importHarness>) =>
  h.inner
    .snapshot()
    .transactions.map((t) => [
      t.transactionKey,
      t.ticker,
      t.type,
      t.quantity,
      t.price,
      t.currency,
      t.tradeTimestamp,
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

describe('Property 18: Import idempotency', () => {
  it('re-importing a file changes nothing and reports duplicates', async () => {
    await fc.assert(
      fc.asyncProperty(fileLinesArb, fc.integer({ min: 2, max: 3 }), async (lines, times) => {
        const h = importHarness();
        const text = fileOf(lines);
        const first = await h.importCsv(text);
        const once = ledgerOf(h);
        let previous: Awaited<ReturnType<typeof h.importCsv>> | undefined;
        for (let i = 1; i < times; i += 1) {
          const again = await h.importCsv(text);
          expect(again.accepted).toBe(0);
          expect(again.skipped).toBe(first.skipped);
          // Every row the first import created or found duplicate is a duplicate now. A row the
          // first import rejected may now be a duplicate too, when its key exists (R28.12).
          expect(again.duplicates).toBeGreaterThanOrEqual(first.accepted + first.duplicates);
          expect(again.duplicates + again.rejected).toBe(first.accepted + first.duplicates + first.rejected);
          if (previous !== undefined) {
            expect([again.duplicates, again.rejected]).toEqual([previous.duplicates, previous.rejected]);
          }
          previous = again;
        }
        expect(ledgerOf(h)).toEqual(once);
        expect(once).toHaveLength(first.accepted);
      }),
      { numRuns: 60 },
    );
  });

  it('identical rows without external_id in one file all persist', async () => {
    await fc.assert(
      fc.asyncProperty(tradeArb(['USD']), fc.integer({ min: 2, max: 4 }), async (trade, copies) => {
        const h = importHarness({ policy: 'ALLOW_SHORT' });
        const line = lineOf({ ...trade, externalId: '' });
        const summary = await h.importCsv(fileOf(Array.from({ length: copies }, () => line)));
        expect(summary).toMatchObject({ accepted: copies, duplicates: 0 });
        expect(new Set(h.inner.snapshot().transactions.map((t) => t.transactionKey)).size).toBe(copies);
      }),
      { numRuns: 30 },
    );
  });
});
