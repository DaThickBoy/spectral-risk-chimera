// Entry point (src/main/start.ts): strict options, refusals, and an in-process start and graceful
// stop of the DEMO fixture mode against a temporary SQLite file. The compiled executable, its exit
// codes, and process shutdown are covered by test/integration/build.test.ts.
// Validates: Requirements 25.4, 26.8, 30.11
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDemoFixtures,
  parseStartArguments,
  PROVISIONAL_OPERATIONAL_VALUES,
  startApplication,
  StartRefusedError,
} from '../../../src/main/index.js';
import type { RunningApplication, StartOptions } from '../../../src/main/index.js';
import { SqliteUnitOfWork } from '../../../src/persistence/index.js';
import { riskEngine } from '../../../src/risk/index.js';
import { FakeClock, sequentialIds } from '../../../src/shared/index.js';
import { completeTestConfig, withKey, writeConfig } from '../../helpers/config.js';
import { multipart } from '../../helpers/multipart.js';
import { tempDir } from '../../helpers/repo.js';

const NOW = '2026-11-08T12:00:00.000Z'; // a Sunday: the last trading day is 2026-11-06
const ORIGIN = 'http://127.0.0.1:5173';
const DEMO_ARGS = ['--demo-fixtures', '--port', '0', '--allowed-origin', ORIGIN];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function workspace(): { configFile: string; dbFile: string; dir: string } {
  const temp = tempDir('start');
  cleanups.push(temp.cleanup);
  const values = withKey(
    withKey(withKey(completeTestConfig(), 'var.lookbackReturns', 30), 'var.minObservations', 20),
    'alerts.var.metric',
    'BASE',
  );
  return {
    dir: temp.dir,
    configFile: writeConfig(temp.dir, 'config.json', values),
    dbFile: path.join(temp.dir, 'app.db'),
  };
}

function options(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): StartOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    argv,
    env,
    clock: new FakeClock(NOW),
    ids: sequentialIds('id'),
    random: () => 0.5,
    sink: (line) => lines.push(line),
    compute: (input) => Promise.resolve(riskEngine.compute(input)),
  };
}

const records = (lines: readonly string[]) =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>);

async function refusal(promise: Promise<unknown>): Promise<StartRefusedError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(StartRefusedError);
  return error as StartRefusedError;
}

describe('parseStartArguments', () => {
  it('parses the demo flag, the port, and repeated origins', () => {
    expect(
      parseStartArguments([
        '--port',
        '8080',
        '--allowed-origin',
        ORIGIN,
        '--demo-fixtures',
        '--allowed-origin',
        'https://a.test',
      ]),
    ).toEqual({ demoFixtures: true, port: 8080, allowedOrigins: [ORIGIN, 'https://a.test'] });
    expect(parseStartArguments(['--port', '0', '--allowed-origin', ORIGIN]).demoFixtures).toBe(false);
  });

  it.each([
    [[], 'port is required'],
    [['--allowed-origin', ORIGIN], 'port is required'],
    [['--port'], '--port must be'],
    [['--port', '65536', '--allowed-origin', ORIGIN], '--port must be'],
    [['--port', '-1', '--allowed-origin', ORIGIN], '--port must be'],
    [['--port', '80.5', '--allowed-origin', ORIGIN], '--port must be'],
    [['--port', '0'], 'allowed-origin is required'],
    [['--port', '0', '--allowed-origin'], 'needs a value'],
    [['--port', '0', '--allowed-origin', '--demo-fixtures'], 'needs a value'],
    [['--port', '0', '--allowed-origin', ORIGIN, '--host', '0.0.0.0'], 'Unknown option'],
    [['--port', '0', '--allowed-origin', ORIGIN, '--in-memory'], 'Unknown option'],
  ])('refuses %j with USAGE', (argv, message) => {
    let error: unknown;
    try {
      parseStartArguments(argv);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(StartRefusedError);
    expect(error).toMatchObject({ reason: 'USAGE' });
    expect((error as Error).message).toContain(message);
  });
});

describe('startApplication refusals', () => {
  it('without --demo-fixtures: PROVIDERS_NOT_CONFIGURED, and no database file is created', async () => {
    const w = workspace();
    const o = options(['--port', '0', '--allowed-origin', ORIGIN], {
      SRC_CONFIG_FILE: w.configFile,
      SRC_DATABASE_FILE: w.dbFile,
    });
    expect((await refusal(startApplication(o))).reason).toBe('PROVIDERS_NOT_CONFIGURED');
    expect(existsSync(w.dbFile)).toBe(false);
  });

  it('without SRC_DATABASE_FILE (demo mode too): DATABASE_CONFIG_MISSING, no in-memory fallback', async () => {
    const w = workspace();
    const o = options(DEMO_ARGS, { SRC_CONFIG_FILE: w.configFile });
    expect((await refusal(startApplication(o))).reason).toBe('DATABASE_CONFIG_MISSING');
  });

  it('an in-memory database path is refused as DATABASE_CONFIG_INVALID', async () => {
    const w = workspace();
    const o = options(DEMO_ARGS, { SRC_CONFIG_FILE: w.configFile, SRC_DATABASE_FILE: ':memory:' });
    expect((await refusal(startApplication(o))).reason).toBe('DATABASE_CONFIG_INVALID');
  });

  it('a usage error is refused before configuration or database are touched', async () => {
    const w = workspace();
    const o = options(['--demo-fixtures'], { SRC_CONFIG_FILE: w.configFile, SRC_DATABASE_FILE: w.dbFile });
    expect((await refusal(startApplication(o))).reason).toBe('USAGE');
    expect(o.lines).toEqual([]);
    expect(existsSync(w.dbFile)).toBe(false);
  });
});

describe('DEMO fixture mode: start and graceful stop on a temporary database', () => {
  it('starts on loopback, seeds DEMO history, labels results DEMO_DATA, and closes the database on stop', async () => {
    const w = workspace();
    const o = options(DEMO_ARGS, { SRC_CONFIG_FILE: w.configFile, SRC_DATABASE_FILE: w.dbFile });
    const running: RunningApplication = await startApplication(o);
    cleanups.push(() => running.stop());
    expect(running.mode).toBe('DEMO_FIXTURES');
    expect(running.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(running.app.state).toBe('RUNNING');

    const log = records(o.lines);
    expect(log.find((r) => r['msg'] === 'start.demo_mode')).toMatchObject({
      level: 'warn',
      mode: 'DEMO_FIXTURES',
    });
    expect(log.filter((r) => r['msg'] === 'start.demo_history')).toEqual(
      ['DEMO-A', 'DEMO-B', 'DEMO-EU', 'DEMO-US', 'DEMO-UK'].map((ticker) =>
        expect.objectContaining({ ticker, stored: true }),
      ),
    );
    // A USD-base configuration seeds no demo portfolio (H6 needs the EUR base).
    expect(log.filter((r) => r['msg'] === 'start.demo_portfolio').map((r) => r['reason'])).toEqual([
      'REQUIRES_EUR_BASE',
      'REQUIRES_EUR_BASE',
    ]);
    expect(log.find((r) => r['msg'] === 'start.ready')).toMatchObject({
      address: running.address,
      provisionalOperationalValues: { ...PROVISIONAL_OPERATIONAL_VALUES },
    });
    const stored = running.app.components.seriesStore.latestFor('DEMO-A', 'DEMO');
    expect(stored.ok).toBe(true);
    expect(running.app.components.seriesStore.latestFor('DEMO-A', 'REAL').ok).toBe(false);

    const created = await fetch(`${running.address}/portfolios`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'pf-demo', base_currency: 'USD', cash: '0' }),
    });
    expect(created.status).toBe(201);
    const csv =
      'trade_timestamp,ticker,type,quantity,price,currency\n2026-11-02T14:30:00Z,DEMO-A,BUY,10,90,USD\n';
    const { headers, payload } = multipart([{ name: 'file', filename: 'trades.csv', content: csv }]);
    const imported = await fetch(`${running.address}/portfolios/pf-demo/imports`, {
      method: 'POST',
      headers,
      body: payload,
    });
    expect(imported.status).toBe(201);
    await running.app.components.scheduler.idle('pf-demo');

    const risk = (await (await fetch(`${running.address}/portfolios/pf-demo/risk`)).json()) as Record<
      string,
      unknown
    >;
    expect(risk).toMatchObject({ status: 'OK', baseVaR: { validity: 'CURRENT' } });
    expect(risk['flags']).toContain('DEMO_DATA');

    await running.stop();
    expect(running.app.state).toBe('STOPPED');
    await expect(fetch(`${running.address}/providers/status`)).rejects.toThrow();

    // The file holds what the stopped instance wrote; nothing was kept in memory only.
    const reopened = SqliteUnitOfWork.open(w.dbFile, { busyTimeoutMs: 500 });
    try {
      const snapshot = reopened.snapshot();
      expect(snapshot.portfolios.map((p) => p.id)).toEqual(['pf-demo']);
      expect(snapshot.riskResults.length).toBeGreaterThan(0);
      expect(snapshot.audit.some((a) => a.type === 'ALERT_SKIPPED')).toBe(true); // DEMO_DATA, never an alert
      expect(snapshot.alerts).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it('a port already in use fails start-up (not a refusal) and releases the database', async () => {
    const first = workspace();
    const running = await startApplication(
      options(DEMO_ARGS, { SRC_CONFIG_FILE: first.configFile, SRC_DATABASE_FILE: first.dbFile }),
    );
    cleanups.push(() => running.stop());
    const port = new URL(running.address).port;
    const second = workspace();
    const error = await startApplication(
      options(['--demo-fixtures', '--port', port, '--allowed-origin', ORIGIN], {
        SRC_CONFIG_FILE: second.configFile,
        SRC_DATABASE_FILE: second.dbFile,
      }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StartRefusedError);
    // The failed instance closed its connection: the file can be reopened and removed (Windows
    // refuses to remove a file another handle keeps open).
    const reopened = SqliteUnitOfWork.open(second.dbFile, { busyTimeoutMs: 500 });
    expect(reopened.snapshot().portfolios).toEqual([]);
    reopened.close();
    for (const suffix of ['', '-wal', '-shm']) {
      expect(() => rmSync(`${second.dbFile}${suffix}`, { force: true })).not.toThrow();
    }
  });
});

describe('createDemoFixtures', () => {
  it('generates weekday observations ending on the last trading day, DEMO-kind providers', async () => {
    const fixtures = createDemoFixtures({ clock: new FakeClock(NOW), currency: 'USD', observations: 6 });
    expect(fixtures.tickers).toEqual(['DEMO-A', 'DEMO-B', 'DEMO-EU', 'DEMO-US', 'DEMO-UK']);
    expect(fixtures.currencies).toEqual({
      'DEMO-A': 'USD',
      'DEMO-B': 'USD',
      'DEMO-EU': 'EUR',
      'DEMO-US': 'USD',
      'DEMO-UK': 'GBP',
    });
    expect(fixtures.range).toEqual({ from: '2026-10-30', to: '2026-11-06' });
    expect(fixtures.marketData.kind).toBe('DEMO');
    expect(fixtures.fx.kind).toBe('DEMO');
    const series = await fixtures.marketData.getDailySeries('DEMO-A', fixtures.range);
    // Hand-calculated: each close = previous * (1 + r), r = returns[index mod 8], rounded half-up to 4 dp.
    expect(series.ok && series.value.observations.map((o) => [o.date, o.adjustedClose])).toEqual([
      ['2026-10-30', '100'],
      ['2026-11-02', '99.2'], // 100 * 0.992
      ['2026-11-03', '99.696'], // 99.2 * 1.005
      ['2026-11-04', '98.2006'], // 99.696 * 0.985 = 98.20056
      ['2026-11-05', '99.0844'], // 98.2006 * 1.009 = 99.0844054
      ['2026-11-06', '98.7871'], // 99.0844 * 0.997 = 98.7871468
    ]);
    const quote = await fixtures.marketData.getLatestPrice('DEMO-A');
    expect(quote).toMatchObject({
      ok: true,
      value: { price: '98.7871', asOf: '2026-11-06', sourceKind: 'DEMO' },
    });
  });
});
