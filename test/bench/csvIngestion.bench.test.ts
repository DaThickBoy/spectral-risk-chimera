// Task 7.7: CSV ingestion benchmark (NFR-PERF-1; R1.3, R33.1). Run with `npm run bench:csv`;
// never part of `npm test` or CI. The budget (p95 <= 500 ms) is reported, not enforced, until
// task 25.1 and the reference environment (OD-2, AT-CSV-21 Blocked).
//
// Timed scope (NFR-PERF-1 item 2): from the fixture bytes already in memory to the classified,
// normalized transaction list and the import summary counts: UTF-8 decoding, parsing, column
// mapping, per-row validation, Decimal construction, normalization, and chronology
// (`prepareImport`). Excluded: persistence, upload transfer, fixture reading, and setup.
// Procedure: 3 warm-up runs, then 20 measured runs in one process, timed with the monotonic
// `performance.now()`. Statistic: p95 by nearest rank, the 19th of the 20 sorted durations.
// Every run writes an environment record (CPU model, cores, RAM, OS and version, Node.js) to
// bench-results/ (gitignored); results are valid for the recorded local environment only.
// Tests: AT-CSV-02, AT-CSV-03
// Validates: Requirements 1.3, 33.1
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { createCsvParser, prepareImport } from '../../src/ingestion/index.js';
import type { Prepared } from '../../src/ingestion/index.js';
import { OPTS, fixture } from '../helpers/csv.js';

const WARM_UP = 3;
const MEASURED = 20;
const BUDGET_MS = 500;

it('CSV ingestion benchmark (NFR-PERF-1)', async () => {
  const bytes = fixture('benchmark-10k.csv');
  const parser = createCsvParser();
  const once = async (): Promise<{ ms: number; summary: Record<string, number> }> => {
    const start = performance.now();
    const prepared: Prepared = await prepareImport(
      { bytes, portfolioId: 'pf-bench', source: 'BENCH', mapping: {} },
      { csv: OPTS, supportedCurrencies: ['USD', 'EUR'], oversellPolicy: 'REJECT' },
      [],
      parser,
    );
    if (prepared.kind !== 'CLASSIFIED') {
      throw new Error(`fixture rejected: ${prepared.reason}`);
    }
    const summary = {
      totalRows: prepared.totalRows,
      accepted: prepared.accepted.length,
      rejected: prepared.rejected.length,
      duplicates: prepared.duplicates.length,
      skipped: prepared.skipped.length,
    };
    return { ms: performance.now() - start, summary };
  };

  for (let i = 0; i < WARM_UP; i += 1) {
    await once();
  }
  const durations: number[] = [];
  let summary: Record<string, number> = {};
  for (let i = 0; i < MEASURED; i += 1) {
    const run = await once();
    durations.push(run.ms);
    summary = run.summary;
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const p95 = sorted[18]; // nearest rank: ceil(0.95 * 20) = 19th value
  if (p95 === undefined) {
    throw new Error('missing measured runs');
  }
  const cpus = os.cpus();
  const record = {
    benchmark: 'csv-ingestion',
    fixture: 'test/fixtures/csv/benchmark-10k.csv',
    timedScope:
      'prepareImport (decode, parse, map, validate, Decimal, normalize, chronology, summary counts)',
    warmUpRuns: WARM_UP,
    measuredRuns: MEASURED,
    durationsMs: durations.map((ms) => ms.toFixed(3)), // timing, not a financial value
    p95Ms: p95.toFixed(3),
    budgetMs: String(BUDGET_MS),
    withinBudget: p95 <= BUDGET_MS,
    enforced: false,
    summary,
    environment: {
      cpuModel: cpus[0]?.model ?? 'unknown',
      cores: os.availableParallelism(),
      ramBytes: String(os.totalmem()),
      os: `${os.type()} ${os.release()} (${os.version()})`,
      arch: os.arch(),
      node: process.version,
    },
    recordedAt: new Date().toISOString(),
  };
  mkdirSync('bench-results', { recursive: true });
  const file = `bench-results/csv-ingestion-${record.recordedAt.replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `CSV ingestion p95 ${record.p95Ms} ms (budget ${BUDGET_MS} ms, not enforced); record: ${file}\n`,
  );

  expect(durations).toHaveLength(MEASURED);
  expect(summary).toEqual({ totalRows: 10_000, accepted: 10_000, rejected: 0, duplicates: 0, skipped: 0 });
}, 300_000);
