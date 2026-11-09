// Validates: Requirements 3.1, 3.2, 3.4, 28.17
// Property 20: Valid rows survive invalid rows (task 7.6; design: Correctness Properties).
// For any generated file, the accepted transactions equal those of the same file with every
// rejected row removed, compared as a multiset of external id and canonical fields, and the
// rebuilt positions are the same: rejected rows never reach the ledger or positions. Keys are not
// compared: removing a rejected row legitimately renumbers the occurrence of an identical later
// row (R28.11 counts identical rows within the file).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fileLinesArb, fileOf } from '../helpers/importArbs.js';
import { useCaseHarness } from '../helpers/importService.js';

type Harness = ReturnType<typeof useCaseHarness>;

const accepted = (h: Harness) =>
  h.inner
    .snapshot()
    .transactions.map((t) =>
      [t.externalId ?? '', t.ticker, t.type, t.quantity, t.price, t.currency, t.tradeTimestamp].join('|'),
    )
    .sort();
const positions = (h: Harness) =>
  h.inner
    .snapshot()
    .positions.map((p) => [p.ticker, p.currency, p.signedQuantity, p.averagePrice, p.isShort].join('|'))
    .sort();

describe('Property 20: Valid rows survive invalid rows', () => {
  it('removing the rejected rows does not change the accepted transactions or positions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fileLinesArb,
        fc.constantFrom('REJECT' as const, 'ALLOW_SHORT' as const),
        async (lines, policy) => {
          const full = useCaseHarness({ policy });
          const result = await full.runCsv(fileOf(lines));
          if (result.status !== 'DONE') {
            throw new Error(result.status);
          }
          const rejected = new Set(full.inner.snapshot().quarantine.map((q) => q.sequence));
          const kept = lines.filter((_, index) => !rejected.has(index + 1));
          const clean = useCaseHarness({ policy });
          const cleanResult = await clean.runCsv(fileOf(kept));
          if (cleanResult.status !== 'DONE') {
            throw new Error(cleanResult.status);
          }
          expect(cleanResult.summary.rejected).toBe(0);
          expect(accepted(clean)).toEqual(accepted(full));
          expect(positions(clean)).toEqual(positions(full));
        },
      ),
      { numRuns: 60 },
    );
  });
});
