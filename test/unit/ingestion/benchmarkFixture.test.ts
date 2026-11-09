// Task 7.7: the committed NFR-PERF-1 benchmark fixture (AT-CSV-01). The fixture has exactly
// 10,000 data rows, 10 columns, and 0 invalid rows, and equals the committed generator output.
// Tests: AT-CSV-01
// Validates: Requirements 1.3, 27.11
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createCsvParser, prepareImport } from '../../../src/ingestion/index.js';
import { OPTS, fixture } from '../../helpers/csv.js';

const FILE = 'benchmark-10k.csv';

describe('benchmark fixture (AT-CSV-01)', () => {
  it('has 10,000 data rows and 10 columns', () => {
    const lines = new TextDecoder().decode(fixture(FILE)).split('\n');
    expect(lines.at(-1)).toBe('');
    expect(lines).toHaveLength(10_002); // header, 10,000 rows, final newline
    expect(lines[0]?.split(',')).toHaveLength(10);
  });

  it('has 0 invalid rows under the import rules', async () => {
    const prepared = await prepareImport(
      { bytes: fixture(FILE), portfolioId: 'pf-bench', source: 'BENCH', mapping: {} },
      { csv: OPTS, supportedCurrencies: ['USD', 'EUR'], oversellPolicy: 'REJECT' },
      [],
      createCsvParser(),
    );
    expect(prepared.kind).toBe('CLASSIFIED');
    if (prepared.kind === 'CLASSIFIED') {
      expect([prepared.totalRows, prepared.accepted.length, prepared.rejected.length]).toEqual([
        10_000, 10_000, 0,
      ]);
      expect([prepared.duplicates.length, prepared.skipped.length]).toEqual([0, 0]);
    }
  });

  it('equals the committed generator output', () => {
    const out = execFileSync(process.execPath, ['scripts/generate-csv-fixture.mjs', '--check'], {
      encoding: 'utf8',
    });
    expect(out).toMatch(/matches the generator/);
  });
});
