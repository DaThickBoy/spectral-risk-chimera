// AT-ARC-03 (build part): tsc builds ES modules into an output directory, and the
// compiled entry point runs on Node.js without a TypeScript loader. Task 12.4: the
// compiled risk worker starts from `risk/riskWorker.js` without a TypeScript loader.
// Tests: AT-ARC-03
// Validates: Requirements 26.6, 26.8, 23.4
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteUnitOfWork } from '../../src/persistence/index.js';
import { completeTestConfig, withKey, writeConfig } from '../helpers/config.js';
import { multipart } from '../helpers/multipart.js';
import { REPO_ROOT, runNode, tempDir } from '../helpers/repo.js';

const tsc = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const temp = tempDir('build');
// Inside the repository's (ignored) node_modules so runtime dependencies resolve; dist/ is untouched.
const outDir = path.join(REPO_ROOT, 'node_modules', '.cache', `src-build-test-${process.pid}`);

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );
}

let build = { code: null as number | null, stdout: '', stderr: '' };

beforeAll(() => {
  build = runNode(tsc, ['-p', 'tsconfig.build.json', '--outDir', outDir]);
});
afterAll(() => {
  temp.cleanup();
  rmSync(outDir, { recursive: true, force: true });
});

describe('AT-ARC-03 (build part)', () => {
  it('compiles with tsc', () => {
    expect(build.code, build.stdout + build.stderr).toBe(0);
  });

  it('emits JavaScript ES modules only, mirroring src/', () => {
    const files = listFiles(outDir).map((file) => path.relative(outDir, file).replaceAll('\\', '/'));
    expect(files).toContain('index.js');
    expect(files).toContain('shared/decimal.js');
    expect(files).toContain('config/loader.js');
    expect(files.filter((file) => file.endsWith('.ts'))).toEqual([]);
    const source = readFileSync(path.join(outDir, 'config', 'loader.js'), 'utf8');
    expect(source).toMatch(/^import /m);
    expect(source).not.toMatch(/\brequire\(|module\.exports|exports\./);
  });

  it('starts the compiled risk worker without a TypeScript loader and computes Base VaR (task 12.4)', () => {
    expect(existsSync(path.join(outDir, 'risk', 'riskWorker.js'))).toBe(true);
    const url = (file: string) => pathToFileURL(path.join(outDir, file)).href;
    // E = -1 (one short unit at 1), so each loss equals its return: [0.1, 0.3, 0.2] sorted, n = 3,
    // p = 0.95: h = 2.9, VaR = 0.1 * 0.2 + 0.9 * 0.3 = 0.29.
    const script = [
      `import { createRiskWorkerClient } from ${JSON.stringify(url('app/index.js'))};`,
      `import { InMemoryUnitOfWork } from ${JSON.stringify(url('persistence/index.js'))};`,
      `import { FakeClock, sequentialIds } from ${JSON.stringify(url('shared/index.js'))};`,
      `const client = createRiskWorkerClient({ unitOfWork: new InMemoryUnitOfWork(), clock: new FakeClock('2026-11-08T12:00:00.000Z'), ids: sequentialIds('w') });`,
      `const fx = { kind: 'IDENTITY', pair: 'USDUSD', rate: '1', observedAt: null, source: 'BASE_CURRENCY', sourceKind: 'IDENTITY', status: 'CURRENT' };`,
      `const input = { portfolioId: 'pf-1', baseCurrency: 'USD', cash: '10', sentiment: [], adjustmentConfigMissing: ['adjustment.multiplier'], marketDataStale: false, evaluatedAt: '2026-11-08T12:00:00.000Z',`,
      `  params: { confidence: '0.95', horizonDays: 1, lookbackReturns: 3, minObservations: 2, adjustment: null },`,
      `  positions: [{ ticker: 'AAA', signedQuantity: '-1', marketPrice: '1', currency: 'USD', fx, historySourceKind: 'REAL' }],`,
      `  returns: { asOfDate: '2026-11-06', dates: ['2026-11-04', '2026-11-05', '2026-11-06'], returns: { AAA: ['0.1', '0.3', '0.2'] }, n: 3, status: 'COMPLETE', limitingTicker: 'AAA', multiDayReturnCount: 0, seriesHashes: { AAA: '${'a'.repeat(64)}' } } };`,
      `const result = await client.compute(input);`,
      `process.stdout.write(JSON.stringify({ status: result.status, var: result.baseVaR.absolute, starts: client.starts }));`,
      `await client.close();`,
    ].join('\n');
    const file = path.join(temp.dir, 'run-risk-worker.mjs');
    writeFileSync(file, script, 'utf8');
    const run = runNode(file, [], temp.dir, {});
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ status: 'OK', var: '0.29', starts: 1 });
  });

  it('runs the compiled entry point with plain Node.js and no configuration', () => {
    expect(existsSync(path.join(outDir, 'index.js'))).toBe(true);
    const run = runNode(path.join(outDir, 'index.js'), [], temp.dir, {
      SRC_CONFIG_FILE: undefined,
      SEC_USER_AGENT: undefined,
    });
    expect(run.code, run.stderr).toBe(0);
    const records = run.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const summary = records.find((record) => record['msg'] === 'config.loaded');
    expect(summary?.['availableFeatures']).toEqual(['api']);
    expect(summary?.['missingFinancialKeys']).toHaveLength(25);
  });
});

// Executable smoke test of src/main/start.ts: the compiled entry point as a real child process on
// a temporary SQLite file, with the compiled risk worker. Shutdown over IPC because Windows signals
// terminate the child without running handlers.
// Validates: Requirements 25.4, 26.8, 30.11
interface Child {
  readonly records: Record<string, unknown>[];
  readonly exited: Promise<number | null>;
  send(message: unknown): void;
  kill(): void;
  waitFor(msg: string, ms?: number): Promise<Record<string, unknown>>;
}

function startExecutable(args: readonly string[], env: Record<string, string | undefined>): Child {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    SRC_CONFIG_FILE: undefined,
    SRC_DATABASE_FILE: undefined,
    ...env,
  };
  const child = spawn(process.execPath, [path.join(outDir, 'main', 'start.js'), ...args], {
    cwd: temp.dir,
    env: Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const { stdout, stderr: errors } = child;
  if (stdout === null || errors === null) throw new Error('child output is not piped');
  const records: Record<string, unknown>[] = [];
  let buffer = '';
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines.filter((l) => l.trim() !== ''))
      records.push(JSON.parse(line) as Record<string, unknown>);
  });
  errors.setEncoding('utf8');
  let stderr = '';
  errors.on('data', (chunk: string) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  return {
    records,
    exited,
    send: (message) => child.send(message as object),
    kill: () => child.kill(),
    waitFor: async (msg, ms = 30_000) => {
      const end = Date.now() + ms;
      for (;;) {
        const found = records.find((r) => r['msg'] === msg);
        if (found !== undefined) return found;
        if (child.exitCode !== null || Date.now() > end) {
          throw new Error(`no ${msg} log (exit ${String(child.exitCode)}): ${stderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

describe('executable entry point (src/main/start.ts, compiled)', () => {
  const ORIGIN = 'http://127.0.0.1:5173';
  let configs = 0;
  const config = () =>
    writeConfig(
      temp.dir,
      `start-config-${(configs += 1)}.json`,
      withKey(withKey(completeTestConfig(), 'var.lookbackReturns', 30), 'var.minObservations', 20),
    );

  it('starts in DEMO fixture mode, serves import and risk, and stops gracefully on IPC shutdown', async () => {
    const dbFile = path.join(temp.dir, 'smoke.db');
    const child = startExecutable(['--demo-fixtures', '--port', '0', '--allowed-origin', ORIGIN], {
      SRC_CONFIG_FILE: config(),
      SRC_DATABASE_FILE: dbFile,
    });
    try {
      const ready = await child.waitFor('start.ready');
      const address = String(ready['address']);
      expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(child.records.find((r) => r['msg'] === 'start.demo_mode')).toMatchObject({ level: 'warn' });
      expect(child.records.filter((r) => r['msg'] === 'start.demo_history').map((r) => r['stored'])).toEqual([
        true,
        true,
        true,
        true,
        true,
      ]);

      // Gateway rule 9 in the compiled entry point: a write without an allowed Origin is refused.
      const forbidden = await fetch(`${address}/portfolios`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'pf-smoke', base_currency: 'USD', cash: '0' }),
      });
      expect(forbidden.status).toBe(403);
      const created = await fetch(`${address}/portfolios`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ id: 'pf-smoke', base_currency: 'USD', cash: '0' }),
      });
      expect(created.status).toBe(201);
      const csv =
        'trade_timestamp,ticker,type,quantity,price,currency\n2026-01-05T14:30:00Z,DEMO-A,BUY,10,90,USD\n';
      const { headers, payload } = multipart([{ name: 'file', filename: 'trades.csv', content: csv }]);
      const imported = await fetch(`${address}/portfolios/pf-smoke/imports`, {
        method: 'POST',
        headers: { ...headers, origin: ORIGIN },
        body: payload,
      });
      expect(imported.status).toBe(201);

      let risk: Record<string, unknown> = {};
      const end = Date.now() + 30_000;
      while (Date.now() < end) {
        const response = await fetch(`${address}/portfolios/pf-smoke/risk`);
        if (response.status === 200) {
          risk = (await response.json()) as Record<string, unknown>;
          if (risk['status'] === 'OK') break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(risk).toMatchObject({ status: 'OK', baseVaR: { validity: 'CURRENT' } });
      expect(risk['flags']).toContain('DEMO_DATA');

      child.send({ type: 'shutdown' });
      expect(await child.exited).toBe(0);
      expect(child.records.find((r) => r['msg'] === 'start.shutdown')).toMatchObject({ trigger: 'IPC' });
      expect(child.records.some((r) => r['msg'] === 'app.stopped')).toBe(true);
    } finally {
      child.kill();
      await child.exited;
    }

    const reopened = SqliteUnitOfWork.open(dbFile, { busyTimeoutMs: 1000 });
    try {
      const snapshot = reopened.snapshot();
      expect(snapshot.portfolios.map((p) => p.id)).toEqual(['pf-smoke']);
      expect(snapshot.riskResults.length).toBeGreaterThan(0);
    } finally {
      reopened.close();
    }
  }, 90_000);

  it('refuses to start without --demo-fixtures (exit 2, PROVIDERS_NOT_CONFIGURED) and creates no database', async () => {
    const dbFile = path.join(temp.dir, 'refused.db');
    const child = startExecutable(['--port', '0', '--allowed-origin', ORIGIN], {
      SRC_CONFIG_FILE: config(),
      SRC_DATABASE_FILE: dbFile,
    });
    expect(await child.exited).toBe(2);
    expect(child.records.find((r) => r['msg'] === 'start.refused')).toMatchObject({
      reason: 'PROVIDERS_NOT_CONFIGURED',
    });
    expect(existsSync(dbFile)).toBe(false);
  });

  it('refuses demo mode without SRC_DATABASE_FILE (exit 2, DATABASE_CONFIG_MISSING)', async () => {
    const child = startExecutable(['--demo-fixtures', '--port', '0', '--allowed-origin', ORIGIN], {
      SRC_CONFIG_FILE: config(),
    });
    expect(await child.exited).toBe(2);
    expect(child.records.find((r) => r['msg'] === 'start.refused')).toMatchObject({
      reason: 'DATABASE_CONFIG_MISSING',
    });
  });

  it('refuses unknown options (exit 2, USAGE)', async () => {
    const child = startExecutable(
      ['--demo-fixtures', '--port', '0', '--allowed-origin', ORIGIN, '--host', '0.0.0.0'],
      {},
    );
    expect(await child.exited).toBe(2);
    expect(child.records.find((r) => r['msg'] === 'start.refused')).toMatchObject({ reason: 'USAGE' });
  });
});
