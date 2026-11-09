// OD-21 (approved 2026-11-09): the deterministic static-replay exporter. It records the real
// backend in demo mode with deterministic fixtures and the fixed reference clock, never calls a
// live provider, writes exactly the format the dashboard replay reader accepts, refuses partial
// output, and produces identical files for identical inputs.
// Validates: Requirements 17.10, 30.14, 35.1, 25.4
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEMO_PORTFOLIOS,
  REPLAY_CLOCK,
  REPLAY_ECB_RESPONSE,
  ReplayExportError,
  exportDashboardReplay,
  startApplication,
} from '../../../src/main/index.js';
import { riskEngine } from '../../../src/risk/index.js';
import { DashboardReplayManifestSchema, FakeClock, sequentialIds } from '../../../src/shared/index.js';
import { createReplaySource } from '../../../src/web/data/source.js';
import { csvOk, recorded } from '../../helpers/ecb.js';
import { repoPath, tempDir } from '../../helpers/repo.js';

const ECB_DIR = repoPath('test', 'fixtures', 'fx', 'ecb');

async function exportTo(): Promise<{ dir: string; files: Record<string, Buffer> }> {
  const temp = tempDir('replay');
  const dir = path.join(temp.dir, 'replay');
  await exportDashboardReplay({ ecbFixturesDir: ECB_DIR, outDir: dir });
  const files = Object.fromEntries(
    readdirSync(dir).map((name) => [name, readFileSync(path.join(dir, name))]),
  );
  return { dir, files };
}

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('replay exporter', () => {
  it('writes the manifest, one recorded view per demo portfolio, and the recorded ECB response', async () => {
    const { files } = await exportTo();
    expect(Object.keys(files).sort()).toEqual(
      [
        'demo-eur-only.json',
        'demo-eur-usd-gbp.json',
        'ecb-exr-gbp-usd-2026-11-06.csv',
        'manifest.json',
      ].sort(),
    );
    const manifest = DashboardReplayManifestSchema.parse(
      JSON.parse(files['manifest.json']?.toString('utf8') ?? ''),
    );
    expect(manifest).toMatchObject({
      recordedAt: REPLAY_CLOCK,
      dataMode: 'DEMO',
      live: false,
      reference: { clock: REPLAY_CLOCK, marketDataAsOf: '2026-11-06', fxReferenceDate: '2026-11-06' },
      source: {
        runMode: 'DEMO_FIXTURES',
        configProfile: 'KIROWEEN_2026_DEMO',
        marketData: 'DEMO_FIXTURES',
        fx: {
          provider: 'ECB-EXR',
          recordedResponse: 'ecb-exr-gbp-usd-2026-11-06.csv',
          sha256: REPLAY_ECB_RESPONSE.sha256,
        },
      },
    });
    expect(manifest.note).toMatch(/Recorded DEMO replay/);
    expect(manifest.index.portfolios.map((p) => p.id)).toEqual(DEMO_PORTFOLIOS.map((p) => p.id));
    // Every file hash in the manifest matches the bytes written.
    for (const entry of manifest.portfolios) {
      expect(sha(files[entry.file] as Buffer), entry.file).toBe(entry.sha256);
      expect(entry.freshness).toEqual({
        summary: 'CURRENT',
        asOfDate: '2026-11-06',
        calculatedAt: REPLAY_CLOCK,
      });
    }
    // The ECB response is copied unmodified (Source: ECB statistics.).
    expect(
      files['ecb-exr-gbp-usd-2026-11-06.csv']?.equals(Buffer.from(recorded(REPLAY_ECB_RESPONSE.file))),
    ).toBe(true);
  });

  it('is deterministic: two exports produce identical bytes', async () => {
    const first = await exportTo();
    const second = await exportTo();
    expect(Object.keys(second.files).sort()).toEqual(Object.keys(first.files).sort());
    for (const [name, bytes] of Object.entries(first.files)) {
      expect(second.files[name]?.equals(bytes), name).toBe(true);
    }
  });

  it('the recorded views equal the actual backend responses at the same reference clock', async () => {
    const { files } = await exportTo();
    const temp = tempDir('replay-live');
    const running = await startApplication({
      argv: ['--demo-fixtures', '--port', '0', '--allowed-origin', 'http://127.0.0.1'],
      env: {
        SRC_CONFIG_FILE: repoPath('config', 'demo', 'kiroween-2026.demo.jsonc'),
        SRC_DATABASE_FILE: path.join(temp.dir, 'demo.db'),
      },
      clock: new FakeClock(REPLAY_CLOCK),
      ids: sequentialIds('replay'),
      random: () => 0.5,
      sink: () => undefined,
      compute: (input) => Promise.resolve(riskEngine.compute(input)),
      fxTransport: () => Promise.resolve(csvOk(recorded(REPLAY_ECB_RESPONSE.file))),
    });
    try {
      for (const definition of DEMO_PORTFOLIOS) await running.app.components.scheduler.idle(definition.id);
      for (const definition of DEMO_PORTFOLIOS) {
        const served = await (await fetch(`${running.address}/dashboard/portfolios/${definition.id}`)).text();
        expect(files[`${definition.id}.json`]?.toString('utf8'), definition.id).toBe(served);
      }
    } finally {
      await running.stop();
      temp.cleanup();
    }
  });

  it('the export loads unchanged through the dashboard replay reader, with GET requests only', async () => {
    const { dir } = await exportTo();
    const methods: string[] = [];
    const reader = createReplaySource((url, init) => {
      methods.push(init.method);
      const file = path.join(dir, url.replace(/^\.\/replay\//, ''));
      return Promise.resolve(
        existsSync(file)
          ? {
              ok: true,
              status: 200,
              json: () => Promise.resolve(JSON.parse(readFileSync(file, 'utf8')) as unknown),
            }
          : { ok: false, status: 404, json: () => Promise.resolve({}) },
      );
    });
    const info = await reader.info();
    expect(info).toMatchObject({ ok: true, value: { kind: 'REPLAY', recordedAt: REPLAY_CLOCK } });
    const multi = await reader.view('demo-eur-usd-gbp');
    expect(multi.ok).toBe(true);
    if (multi.ok) {
      expect(multi.value).toMatchObject({ dataMode: 'DEMO', runMode: 'DEMO_FIXTURES' });
      expect(multi.value.view.baseVaR.validity).toBe('CURRENT');
      expect(multi.value.adjustedVaRAvailability.reasonCode).toBe('AGGREGATION_NOT_APPROVED');
      expect(multi.value.fx.find((f) => f.currency === 'USD')?.rate?.quote).toMatchObject({
        pair: 'EURUSD',
        rate: '1.1165',
        referenceDate: '2026-11-06',
      });
    }
    expect((await reader.view('demo-eur-only')).ok).toBe(true);
    expect(new Set(methods)).toEqual(new Set(['GET']));
  });

  it('the output contains no database, log, absolute path, or credential', async () => {
    const { files } = await exportTo();
    for (const [name, bytes] of Object.entries(files)) {
      const text = bytes.toString('utf8');
      expect(name).not.toMatch(/\.(db|log|sqlite)/);
      expect(text, name).not.toMatch(
        /[A-Za-z]:\\|\/home\/|\/tmp\/|\/Users\/|SRC_DATABASE_FILE|correlationId|API_KEY/,
      );
    }
  });

  it('fails without writing anything when the recorded ECB fixture is missing or altered', async () => {
    const temp = tempDir('replay-fail');
    const out = path.join(temp.dir, 'replay');
    await expect(exportDashboardReplay({ ecbFixturesDir: temp.dir, outDir: out })).rejects.toBeInstanceOf(
      ReplayExportError,
    );
    expect(existsSync(out)).toBe(false);
    // An altered copy (one byte changed) is refused by its SHA-256.
    const altered = path.join(temp.dir, 'altered');
    cpSync(ECB_DIR, altered, { recursive: true });
    const file = path.join(altered, REPLAY_ECB_RESPONSE.file);
    writeFileSync(file, readFileSync(file, 'utf8').replace('1.1165', '1.1166'));
    await expect(exportDashboardReplay({ ecbFixturesDir: altered, outDir: out })).rejects.toThrow(/SHA-256/);
    expect(existsSync(out)).toBe(false);
  });

  it('fails and keeps the previous replay when the demo configuration cannot seed the portfolios', async () => {
    const { dir } = await exportTo();
    const before = readFileSync(path.join(dir, 'manifest.json'));
    const temp = tempDir('replay-noconfig');
    const config = path.join(temp.dir, 'empty.json');
    writeFileSync(config, '{}');
    await expect(
      exportDashboardReplay({ ecbFixturesDir: ECB_DIR, outDir: dir, configFile: config }),
    ).rejects.toBeInstanceOf(ReplayExportError);
    expect(readFileSync(path.join(dir, 'manifest.json')).equals(before)).toBe(true);
  });
});
