// Validates: Requirements 3.2, 3.3, 3.5, 28.9, 28.10
// Property 19: Import classification completeness (task 7.6; design: Correctness Properties).
// For any generated file, every data row is classified exactly once as accepted, rejected,
// duplicate, or skipped; accepted + rejected + duplicates + skipped = totalRows; and every
// rejected row has exactly one quarantine record and one audit entry with a reason code.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createCsvParser, prepareImport } from '../../src/ingestion/index.js';
import { OPTS, bytes } from '../helpers/csv.js';
import { fileLinesArb, fileOf } from '../helpers/importArbs.js';
import { PF, importHarness } from '../helpers/importService.js';

describe('Property 19: Import classification completeness', () => {
  it('prepareImport classifies every row exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fileLinesArb,
        fc.constantFrom('REJECT' as const, 'ALLOW_SHORT' as const),
        async (lines, policy) => {
          const prepared = await prepareImport(
            { bytes: bytes(fileOf(lines)), portfolioId: PF, source: 'CSV', mapping: {} },
            { csv: OPTS, supportedCurrencies: ['USD', 'EUR'], oversellPolicy: policy },
            [],
            createCsvParser(),
          );
          if (prepared.kind !== 'CLASSIFIED') {
            throw new Error(`unexpected file rejection ${prepared.reason}`);
          }
          const all = [
            ...prepared.accepted.map((c) => c.sourceSequence),
            ...prepared.rejected.map((r) => r.sequence),
            ...prepared.duplicates,
            ...prepared.skipped,
          ].sort((a, b) => a - b);
          expect(prepared.totalRows).toBe(lines.length);
          expect(all).toEqual(Array.from({ length: lines.length }, (_, i) => i + 1));
          for (const rejection of prepared.rejected) {
            expect(rejection.errors.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('the stored summary sums to totalRows with one quarantine record and one audit entry per rejected row', async () => {
    await fc.assert(
      fc.asyncProperty(fileLinesArb, async (lines) => {
        const h = importHarness();
        const s = await h.importCsv(fileOf(lines));
        expect(s.accepted + s.rejected + s.duplicates + s.skipped).toBe(s.totalRows);
        const snap = h.inner.snapshot();
        expect(snap.transactions).toHaveLength(s.accepted);
        const quarantined = snap.quarantine.map((q) => q.sequence);
        expect(quarantined).toHaveLength(s.rejected);
        expect(new Set(quarantined).size).toBe(s.rejected);
        const audited = snap.audit.filter((a) => a.type === 'ROW_REJECTED');
        expect(audited.map((a) => a.details.sequence)).toEqual(quarantined.map(String));
        for (const [index, entry] of audited.entries()) {
          expect(entry.details.reason).toBe(snap.quarantine[index]?.reasonCode);
          expect(entry.details.reason).toMatch(/^[A-Z_]+$/);
        }
      }),
      { numRuns: 60 },
    );
  });
});
