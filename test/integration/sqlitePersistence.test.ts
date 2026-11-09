// OD-12 (task 5.3): SQLite-specific guarantees beyond the shared repository contract, which
// already runs on every adapter (test/unit/persistence). Durability across close and reopen,
// exact decimal text, migrations, append-only triggers through direct SQL, read integrity,
// bounded busy handling within one process and across processes, and recovery after a process
// is killed inside a transaction. AT-CSV-12 runs here against the real adapter.
// Tests: AT-CSV-12
// Validates: Requirements 4.3, 22.6, 28.15, 28.16, 32.4, 12.6
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, PersistenceError, SqliteUnitOfWork } from '../../src/persistence/index.js';
import type { Repositories } from '../../src/persistence/index.js';
import { brandDecimalString, canonicalJson, sha256Hex } from '../../src/shared/index.js';
import { useCaseHarness } from '../helpers/importService.js';
import { openSqlite, tempDir } from '../helpers/persistenceAdapters.js';
import { auditEntry, importSummary, position, quarantined, transaction } from '../helpers/persistence.js';

const AT = '2026-11-08T12:00:00.000Z';
const dec = brandDecimalString;
const FIXTURES = fileURLToPath(new URL('../fixtures/persistence/', import.meta.url));

const observations = [
  { date: '2026-11-03', adjustedClose: dec('100.0') }, // exact text kept (C2)
  { date: '2026-11-04', adjustedClose: dec('0.10') },
];
const seriesHash = sha256Hex(canonicalJson({ ticker: 'AAA', currency: 'USD', observations }));

/** One record of every kind, with decimal text that a float or re-formatting would change. */
function writeEverything(tx: Repositories): void {
  tx.portfolios.insert({ id: 'pf-1', baseCurrency: 'USD', cash: dec('-250.5') });
  tx.imports.insert(importSummary());
  tx.transactions.insert(transaction({ quantity: dec('0.1'), price: dec('100.25'), externalId: 'x-1' }));
  tx.quarantine.insert(quarantined());
  tx.positions.upsert(
    position({ signedQuantity: dec('0.30000000000000000001'), averagePrice: dec('99.999') }),
  );
  tx.audit.append(auditEntry());
  tx.series.insertContent({ contentHash: seriesHash, ticker: 'AAA', currency: 'USD', observations });
  tx.series.appendRetrieval({
    contentHash: seriesHash,
    ticker: 'AAA',
    source: 'md',
    sourceKind: 'REAL',
    retrievedAt: AT,
  });
  tx.fxRates.append({
    id: 'fx-1',
    pair: 'EURUSD',
    rate: dec('1.0857'),
    observedAt: AT,
    observedAtBasis: 'PUBLICATION_CONVENTION',
    conventionId: 'ECB-1600-CET',
    source: 'fx',
    sourceKind: 'REAL',
    recordedAt: AT,
  });
  const body = canonicalJson({ kind: 'CALCULATED', result: { absolute: '80.125', observations: 3 } });
  tx.snapshots.insert({
    id: 'snap-1',
    portfolioId: 'pf-1',
    hash: 'c'.repeat(64),
    createdAt: AT,
    evaluatedAt: AT,
    snapshot: body,
    inputsCanonical: body,
  });
  tx.riskResults.append({
    id: 'rr-1',
    portfolioId: 'pf-1',
    calculatedAt: AT,
    status: 'OK',
    configVersionSeq: 1,
    configVersionHash: 'd'.repeat(64),
    snapshotHash: 'c'.repeat(64),
    snapshotId: 'snap-1',
    body,
  });
  tx.alertState.upsert({
    type: 'VAR',
    portfolioId: 'pf-1',
    ticker: null,
    phase: 'BREACHED',
    lastSeverity: 'HIGH',
    lastAlertAt: AT,
    lastAlertId: 'alert-1',
    updatedAt: AT,
  });
  tx.alerts.insert({
    id: 'alert-1',
    type: 'VAR',
    source: 'var-alert-evaluator',
    portfolioId: 'pf-1',
    ticker: null,
    severity: 'HIGH',
    metric: 'BASE_VAR_PCT_NAV',
    observed: dec('19.0000000001'),
    threshold: dec('15'),
    triggeredTickers: ['AAA'],
    createdAt: AT,
    description: 'HIGH: test.',
    state: 'OPEN',
    stateChangedAt: null,
    delivery: 'PENDING',
    deliveryAttempts: 0,
    lastAttemptAt: null,
  });
}

function caught(fn: () => unknown): PersistenceError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PersistenceError);
    return error as PersistenceError;
  }
  throw new Error('expected a PersistenceError');
}

function runChild(script: string, args: readonly string[], until: string) {
  const child = spawn(process.execPath, [path.join(FIXTURES, script), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const reached = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes(until)) resolve();
    });
    child.on('error', reject);
    child.on('exit', () =>
      output.includes(until) ? resolve() : reject(new Error(`child exited early: ${output}`)),
    );
  });
  // 'close' fires after the output streams ended, so all output has been read.
  const exited = new Promise<void>((resolve) => child.on('close', () => resolve()));
  return { reached, exited, output: () => output };
}

describe('durability and exact text', () => {
  it('every record survives close and reopen unchanged, including decimal text, JSON bodies, and provenance', () => {
    const file = path.join(tempDir(), 'durable.db');
    const first = openSqlite(file);
    first.run(writeEverything);
    const before = first.snapshot();
    first.close();
    const reopened = openSqlite(file);
    expect(reopened.snapshot()).toEqual(before);
    const stored = reopened.run((tx) => ({
      cash: tx.portfolios.get('pf-1')?.cash,
      quantity: tx.transactions.findByKey('pf-1', 'a'.repeat(64))?.quantity,
      prices: tx.series.getContent(seriesHash)?.observations.map((o) => o.adjustedClose),
      retrieval: tx.series.listRetrievalsByHash(seriesHash),
      body: tx.riskResults.listByPortfolio('pf-1')[0]?.body,
    }));
    expect(stored).toEqual({
      cash: '-250.5',
      quantity: '0.1',
      prices: ['100.0', '0.10'],
      retrieval: [
        { seq: 1, contentHash: seriesHash, ticker: 'AAA', source: 'md', sourceKind: 'REAL', retrievedAt: AT },
      ],
      body: canonicalJson({ kind: 'CALCULATED', result: { absolute: '80.125', observations: 3 } }),
    });
    // Financial columns are TEXT in the file itself, never REAL.
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      expect(raw.prepare('SELECT typeof(quantity) AS t, quantity FROM transactions').get()).toEqual({
        t: 'text',
        quantity: '0.1',
      });
      expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    } finally {
      raw.close();
    }
  });

  it('a failed commit at every write position leaves the file unchanged after reopen', () => {
    const file = path.join(tempDir(), 'faults.db');
    const probe = openSqlite(path.join(tempDir(), 'probe.db'));
    probe.run(writeEverything);
    const writes = probe.lastAttempt?.writes.length ?? 0;
    expect(writes).toBe(13);
    for (let atWrite = 0; atWrite <= writes; atWrite += 1) {
      const uow = openSqlite(file);
      uow.failNextCommit({ atWrite });
      expect(caught(() => uow.run(writeEverything)).code).toBe('COMMIT_FAILED');
      uow.close();
      expect(openSqlite(file).snapshot().transactions).toEqual([]);
    }
  });

  it('after close, every call fails safely with COMMIT_FAILED', () => {
    const uow = openSqlite(':memory:');
    uow.close();
    uow.close(); // idempotent
    expect(caught(() => uow.run((tx) => tx.portfolios.get('pf-1'))).code).toBe('COMMIT_FAILED');
  });
});

describe('migrations', () => {
  it('a new database is created at the latest schema version; reopening migrates nothing again', () => {
    const file = path.join(tempDir(), 'm.db');
    openSqlite(file).close();
    const raw = new DatabaseSync(file);
    const version = raw.prepare('PRAGMA user_version').get();
    const objects = raw
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type IN ('table', 'trigger', 'index')")
      .get();
    raw.close();
    expect(version).toEqual({ user_version: LATEST_SCHEMA_VERSION });
    const again = openSqlite(file);
    again.close();
    const raw2 = new DatabaseSync(file);
    expect(
      raw2
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type IN ('table', 'trigger', 'index')")
        .get(),
    ).toEqual(objects);
    raw2.close();
  });

  it('a database with a newer schema version is refused (INTEGRITY_ERROR) and left untouched', () => {
    const file = path.join(tempDir(), 'newer.db');
    openSqlite(file).close();
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${String(LATEST_SCHEMA_VERSION + 1)}`);
    raw.close();
    const error = caught(() => SqliteUnitOfWork.open(file, { busyTimeoutMs: 100 }));
    expect(error.code).toBe('INTEGRITY_ERROR');
    expect(error.message).toBe('The database schema version is newer than this application supports.');
  });

  it('a file that is not a database is refused (INTEGRITY_ERROR)', () => {
    const file = path.join(tempDir(), 'garbage.db');
    writeFileSync(file, 'this is not a database, it holds the secret 123.45 '.repeat(200));
    const error = caught(() => SqliteUnitOfWork.open(file, { busyTimeoutMs: 100 }));
    expect(error.code).toBe('INTEGRITY_ERROR');
    expect(error.message).not.toContain('123.45');
  });

  it('options are validated', () => {
    expect(() => SqliteUnitOfWork.open('', { busyTimeoutMs: 100 })).toThrow(TypeError);
    expect(() => SqliteUnitOfWork.open(':memory:', { busyTimeoutMs: 0 })).toThrow(TypeError);
  });
});

describe('append-only through direct SQL', () => {
  const statements: readonly [string, string][] = [
    ['transactions update', "UPDATE transactions SET quantity = '1'"],
    ['transactions delete', 'DELETE FROM transactions'],
    ['audit update', "UPDATE audit_log SET type = 'X'"],
    ['audit delete', 'DELETE FROM audit_log'],
    ['imports delete', 'DELETE FROM imports'],
    ['portfolios update', "UPDATE portfolios SET cash = '1'"],
    ['series content update', "UPDATE price_series SET observations_json = '[]'"],
    ['series retrieval delete', 'DELETE FROM series_retrievals'],
    ['fx update', "UPDATE fx_rates SET rate = '2'"],
    ['risk result update', "UPDATE risk_results SET status = 'X'"],
    ['snapshot delete', 'DELETE FROM calc_snapshots'],
    ['quarantine delete', 'DELETE FROM quarantine_records'],
    ['alert delete', 'DELETE FROM alerts'],
    ['alert content update', "UPDATE alerts SET observed = '1'"],
    ['alert delivery back to PENDING', "UPDATE alerts SET delivery = 'PENDING'"],
    ['alert attempts decrease', 'UPDATE alerts SET delivery_attempts = 0'],
    ['alert state delete', 'DELETE FROM alert_state'],
  ];

  it.each(statements)('%s is refused by the database', (_name, sql) => {
    const file = path.join(tempDir(), 'append.db');
    const uow = openSqlite(file);
    uow.run(writeEverything);
    // The alert is delivered first, so going back from DELIVERED is what one case tests.
    uow.run((tx) => {
      const current = tx.alerts.get('alert-1');
      if (current !== undefined) {
        tx.alerts.update({ ...current, delivery: 'DELIVERED', deliveryAttempts: 1, lastAttemptAt: AT });
      }
    });
    uow.close();
    const raw = new DatabaseSync(file);
    try {
      expect(() => raw.exec(sql)).toThrow();
    } finally {
      raw.close();
    }
  });

  it('positions remain a projection that may be updated and deleted', () => {
    const file = path.join(tempDir(), 'positions.db');
    const uow = openSqlite(file);
    uow.run(writeEverything);
    uow.close();
    const raw = new DatabaseSync(file);
    expect(() => raw.exec('DELETE FROM positions')).not.toThrow();
    raw.close();
  });
});

describe('read integrity', () => {
  it.each([
    [
      'a non-canonical quantity',
      'transactions_no_update',
      "UPDATE transactions SET quantity = '1e5'",
      (tx: Repositories) => tx.transactions.listByPortfolio('pf-1'),
      '1e5',
    ],
    [
      'an invalid observations body',
      'price_series_no_update',
      "UPDATE price_series SET observations_json = '{broken 777.7'",
      (tx: Repositories) => tx.series.getContent(seriesHash),
      '777.7',
    ],
    [
      'a non-canonical alert value',
      null,
      "UPDATE alerts SET observed = '19.00000000010'",
      (tx: Repositories) => tx.alerts.get('alert-1'),
      '19.00000000010',
    ],
  ] as const)(
    '%s read back is INTEGRITY_ERROR and nothing is returned',
    (_name, trigger, sql, read, secret) => {
      const file = path.join(tempDir(), 'tamper.db');
      const uow = openSqlite(file);
      uow.run(writeEverything);
      uow.close();
      const raw = new DatabaseSync(file);
      raw.exec('DROP TRIGGER IF EXISTS alerts_content_fixed');
      if (trigger !== null) raw.exec(`DROP TRIGGER ${trigger}`);
      raw.exec(sql);
      raw.close();
      const reopened = openSqlite(file);
      const error = caught(() => reopened.run((tx) => read(tx)));
      expect(error.code).toBe('INTEGRITY_ERROR');
      expect(error.message).not.toContain(secret);
    },
  );

  it('a database constraint failure is CONSTRAINT_VIOLATION without the driver message or values', () => {
    const file = path.join(tempDir(), 'constraint.db');
    const uow = openSqlite(file);
    uow.run(writeEverything);
    // A record that passes the shared rules but violates a database CHECK (an unknown import
    // status, which the types forbid) shows the mapping of a driver error.
    const error = caught(() =>
      uow.run((tx) =>
        tx.imports.insert(
          importSummary({ id: 'imp-2', fileName: 'secret-777.csv', status: 'BOGUS' as never }),
        ),
      ),
    );
    expect(error.code).toBe('CONSTRAINT_VIOLATION');
    expect(error.message).toBe('imports write violates a database constraint');
    expect(uow.snapshot().imports.map((i) => i.id)).toEqual(['imp-1']);
  });
});

describe('contention and recovery', () => {
  it('within one process: a second connection waits at most the busy timeout, then COMMIT_FAILED; nothing is written', () => {
    const file = path.join(tempDir(), 'busy.db');
    const holder = openSqlite(file, 2000);
    const waiter = openSqlite(file, 200);
    holder.run((tx) => {
      tx.portfolios.insert({ id: 'pf-holder', baseCurrency: 'USD', cash: dec('1') });
      const started = performance.now();
      const error = caught(() =>
        waiter.run((other) =>
          other.portfolios.insert({ id: 'pf-waiter', baseCurrency: 'USD', cash: dec('2') }),
        ),
      );
      const waited = performance.now() - started;
      expect(error.code).toBe('COMMIT_FAILED');
      expect(waited).toBeGreaterThanOrEqual(150);
      expect(waited).toBeLessThan(5000);
    });
    expect(holder.snapshot().portfolios.map((p) => p.id)).toEqual(['pf-holder']);
    // Once the lock is free the waiter writes normally.
    waiter.run((tx) => tx.portfolios.insert({ id: 'pf-waiter', baseCurrency: 'USD', cash: dec('2') }));
    expect(waiter.snapshot().portfolios.map((p) => p.id)).toEqual(['pf-holder', 'pf-waiter']);
  });

  it('across processes: an exhausted busy timeout is COMMIT_FAILED; a longer one waits and succeeds', async () => {
    const file = path.join(tempDir(), 'multi.db');
    openSqlite(file).close();
    const child = runChild('holdWriteLock.mjs', [file, '1500'], 'LOCKED');
    await child.reached;
    const short = openSqlite(file, 200);
    expect(
      caught(() =>
        short.run((tx) => tx.portfolios.insert({ id: 'pf-short', baseCurrency: 'USD', cash: dec('1') })),
      ).code,
    ).toBe('COMMIT_FAILED');
    const patient = openSqlite(file, 10_000);
    patient.run((tx) => tx.portfolios.insert({ id: 'pf-patient', baseCurrency: 'USD', cash: dec('1') }));
    await child.exited;
    expect(child.output()).toContain('RELEASED');
    expect(patient.snapshot().portfolios.map((p) => p.id)).toEqual(['pf-other-process', 'pf-patient']);
  });

  it('a process killed inside a transaction leaves only committed data; the file stays usable', async () => {
    const file = path.join(tempDir(), 'crash.db');
    openSqlite(file).close();
    const child = runChild('crashMidTransaction.mjs', [file], 'IN_TRANSACTION');
    await child.reached;
    await child.exited;
    const recovered = openSqlite(file); // runs quick_check
    expect(recovered.snapshot().portfolios.map((p) => p.id)).toEqual(['pf-committed']);
    recovered.run((tx) => tx.portfolios.insert({ id: 'pf-after', baseCurrency: 'USD', cash: dec('1') }));
    expect(recovered.snapshot().portfolios.map((p) => p.id)).toEqual(['pf-committed', 'pf-after']);
  });

  it('AT-CSV-12: a real persistence failure (write lock held by another connection) leaves no partial import', async () => {
    const file = path.join(tempDir(), 'import.db');
    const inner = openSqlite(file, 150);
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA busy_timeout = 2000');
    // Runs: 0 portfolio lookup, 1 ledger read, 2 import commit (as in Property 21). During the
    // commit another connection holds the write lock, so the commit's transaction cannot start.
    let runs = 0;
    let armed = false;
    const uow = {
      run: <T>(work: (tx: Repositories) => T): T => {
        const index = runs;
        runs += 1;
        if (armed && index === 2) {
          raw.exec('BEGIN IMMEDIATE');
          try {
            return inner.run(work);
          } finally {
            raw.exec('ROLLBACK');
          }
        }
        return inner.run(work);
      },
      failNextCommit: (fault: { atWrite: number }) => inner.failNextCommit(fault),
      get lastAttempt() {
        return inner.lastAttempt;
      },
      snapshot: () => inner.snapshot(),
    };
    const h = useCaseHarness({ uow });
    await h.runCsv(
      'trade_timestamp,ticker,type,quantity,price,currency\n2026-11-01T10:00:00Z,AAA,BUY,10,1,USD\n',
    );
    const before = inner.snapshot();
    runs = 0;
    armed = true;
    const result = await h.runCsv(
      'trade_timestamp,ticker,type,quantity,price,currency\n2026-11-02T10:00:00Z,AAA,BUY,5,2,USD\n2026-11-03T10:00:00Z,AAA,SELL,1,2,USD\n',
    );
    raw.close();
    expect(result).toMatchObject({
      status: 'DONE',
      summary: { status: 'FAILED', failureReason: 'COMMIT_FAILED', persisted: false },
    });
    const after = inner.snapshot();
    expect(after.transactions).toEqual(before.transactions);
    expect(after.imports).toEqual(before.imports);
    expect(after.quarantine).toEqual(before.quarantine);
    expect(after.positions).toEqual(before.positions);
    expect(after.audit.slice(before.audit.length).map((a) => [a.type, a.details.reason])).toEqual([
      ['IMPORT_FAILED', 'COMMIT_FAILED'],
    ]);
  });
});
